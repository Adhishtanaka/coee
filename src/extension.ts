import * as vscode from 'vscode';
import { log } from './lm';
import { MapController } from './map';
import { watchEditors } from './ui';
import { registerPreviews } from './apply';
import { SecurityController } from './security';
import { ChangesController } from './changes';
import { ArchitectureController } from './architecture';
import { TourPart, WalkthroughController, symbolsOf } from './walkthrough';
import { commit, repoRoot } from './git';

const LENS_KINDS = [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class, vscode.SymbolKind.Constructor, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum];

/** "Explain" above every function, method and class: one click, no selecting. */
class ExplainLens implements vscode.CodeLensProvider {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;
	refresh() { this.changed.fire(); }

	async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		if (!vscode.workspace.getConfiguration('coee').get('codeLens', true)) return [];
		const out: vscode.CodeLens[] = [];
		const walk = (list: vscode.DocumentSymbol[], depth: number) => {
			for (const s of list) {
				if (out.length >= 150) return; // ponytail: cap for huge generated files
				if (LENS_KINDS.includes(s.kind) && s.range.end.line - s.range.start.line >= 2) {
					out.push(new vscode.CodeLens(new vscode.Range(s.range.start, s.range.start), {
						title: '$(book) Explain', tooltip: `Explain ${s.name} step by step`,
						command: 'coee.explainLines', arguments: [doc.uri, s.range.start.line, s.range.end.line],
					}));
				}
				if (depth < 2) walk(s.children, depth + 1);
			}
		};
		walk(await symbolsOf(doc), 0);
		return out;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const map = new MapController(context);
	const walkthrough = new WalkthroughController(context.extensionUri, map, context.workspaceState);
	const architecture = new ArchitectureController(context, map);
	const security = new SecurityController(context);
	context.subscriptions.push(security);
	walkthrough.onStep = (file, line) => architecture.follow(file, line);
	const changes = new ChangesController(context, t => walkthrough.review(undefined, undefined, t).catch(err => walkthrough.fail(err)));
	context.subscriptions.push(changes);
	void changes.start();

	const withEditor = (fn: (e: vscode.TextEditor) => Promise<unknown>) => async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return void vscode.window.showWarningMessage('coee: open a file and select some code first.');
		try { await fn(editor); } catch (err) { walkthrough.fail(err); }
	};
	const safe = <A extends unknown[]>(fn: (...args: A) => unknown) => async (...args: A) => {
		try { await fn(...args); } catch (err) {
			log.error(String(err));
			vscode.window.showErrorMessage(`coee: ${err instanceof Error ? err.message : err}`);
		}
	};

	const lens = new ExplainLens();
	const activeUri = () => vscode.window.activeTextEditor?.document.uri ?? vscode.window.visibleTextEditors[0]?.document.uri;

	context.subscriptions.push(watchEditors(), registerPreviews(),
		log, walkthrough, map, architecture,
		vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], lens),
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('coee.codeLens')) lens.refresh(); }),
		vscode.commands.registerCommand('coee.explainLines', (uri: vscode.Uri, start: number, end: number) => walkthrough.explainLines(uri, start, end).catch(err => walkthrough.fail(err))),
		vscode.commands.registerCommand('coee.explainFile', (uri?: vscode.Uri) => {
			const target = uri instanceof vscode.Uri ? uri : activeUri();
			if (!target) return vscode.window.showInformationMessage('coee: open a file first, then explain it.');
			return walkthrough.explainResource(target).catch(err => walkthrough.fail(err));
		}),
		vscode.commands.registerCommand('coee.explain', withEditor(e => walkthrough.explainEditor(e))),
		vscode.commands.registerCommand('coee.explainResource', (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!target) return vscode.window.showWarningMessage('coee: right-click a file or folder in the Explorer.');
			return walkthrough.explainResource(target).catch(err => walkthrough.fail(err));
		}),
		vscode.commands.registerCommand('coee.ask', withEditor(e => walkthrough.askEditor(e))),
		vscode.commands.registerCommand('coee.next', safe(() => walkthrough.next())),
		vscode.commands.registerCommand('coee.prev', safe(() => walkthrough.prev())),
		vscode.commands.registerCommand('coee.more', () => walkthrough.more().catch(err => walkthrough.fail(err))),
		vscode.commands.registerCommand('coee.close', () => walkthrough.close()),
		vscode.commands.registerCommand('coee.cancel', () => walkthrough.cancel()),
		vscode.commands.registerCommand('coee.security', safe(async (arg?: unknown) => security.open(arg instanceof vscode.Uri ? arg : undefined))),
		vscode.commands.registerCommand('coee.clearCache', async () => {
			const n = await walkthrough.clearCache() + await map.clearCache() + await architecture.clearCache() + await security.clearCache();
			vscode.window.showInformationMessage(n ? `coee: cache cleared (${n} saved item${n === 1 ? '' : 's'}).` : 'coee: the cache was already empty.');
		}),
		vscode.commands.registerCommand('coee.plan', async (uri?: unknown, draft?: string) => walkthrough.openPlan(await folderOf(uri), typeof draft === 'string' ? draft : undefined)),
		vscode.commands.registerCommand('coee.walkPart', async (uri?: unknown, part?: TourPart) => walkthrough.tour(await folderOf(uri), part).catch(err => walkthrough.fail(err))),
		vscode.commands.registerCommand('coee.tour', async (uri?: unknown) => walkthrough.tour(await folderOf(uri)).catch(err => walkthrough.fail(err))),
		vscode.commands.registerCommand('coee.changes', safe(async (arg?: unknown) => changes.open(await dirOf(arg)))),
		vscode.commands.registerCommand('coee.reviewCommit', async (...args: unknown[]) => {
			try {
				// From the Source Control Graph: (repository, commit). Elsewhere: pick a commit.
				const sha = args.map(a => (a as { id?: unknown } | undefined)?.id).find((id): id is string => typeof id === 'string' && /^[0-9a-f]{7,40}$/i.test(id));
				const dir = (await Promise.all(args.map(dirOf))).find(Boolean);
				if (sha && dir) return await walkthrough.review(undefined, undefined, await commit(await repoRoot(dir), sha));
				await walkthrough.review(dir, 'commit');
			} catch (err) { walkthrough.fail(err); }
		}),
		vscode.commands.registerCommand('coee.architecture', safe(async (arg?: unknown, focus?: unknown) => architecture.open(await dirOf(arg), false, typeof focus === 'string' ? focus : undefined))),
		// The page switcher on every coee page.
		vscode.commands.registerCommand('coee.go', safe(async (to?: unknown, root?: unknown) => {
			const r = root instanceof vscode.Uri ? root : undefined;
			switch (to) {
				case 'architecture': return architecture.open(r);
				case 'changes': return vscode.commands.executeCommand('coee.changes', r);
				case 'security': return security.open(r);
				case 'plan': return walkthrough.openPlan(r);
				case 'walkthrough': if (!walkthrough.show()) vscode.window.showInformationMessage('coee: no walkthrough yet. Click Explain above a function, or Walk me through on the architecture page.'); return;
			}
		})),
		vscode.commands.registerCommand('coee.exportSarif', () => security.exportSarif()),
		vscode.commands.registerCommand('coee.recent', () => walkthrough.pickRecent().catch(err => walkthrough.fail(err))),
	);
}

export function deactivate() {}

/** The folder a menu passed: an Explorer folder, or a Source Control repository's root. */
async function dirOf(arg: unknown): Promise<vscode.Uri | undefined> {
	const scmRoot = (arg as { rootUri?: unknown } | undefined)?.rootUri;
	return scmRoot instanceof vscode.Uri ? scmRoot : folderOf(arg);
}

/** A folder passed by a menu (Explorer, map), else undefined so coee picks the project holding the open file. */
async function folderOf(uri: unknown): Promise<vscode.Uri | undefined> {
	if (!(uri instanceof vscode.Uri)) return undefined;
	const stat = await vscode.workspace.fs.stat(uri).then(x => x, () => undefined);
	return stat && stat.type & vscode.FileType.Directory ? uri : undefined;
}
