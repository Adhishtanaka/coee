import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { FileExcerpt, SystemMap, outermost, buildComponentPrompt, buildMapPrompt, excerpt, repairMap } from './prompt';
import { Cell, layers } from './layout';
import { Lm, isCancel, log } from './lm';
import { page } from './ui';

const KEY = 'coee.systemMap';
export const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**,**/vendor/**,**/target/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/*.min.*,**/*.map,**/*.lock,**/package-lock.json,**/.vscode-test/**}';
export const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|h|cc|cpp|hpp|scala|dart|vue|svelte|ex|exs|lua|sh|sql)$/i;
export const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|README\.md|requirements\.txt|Dockerfile|docker-compose\.ya?ml)$/i;
// ponytail: one pass sized to the model (lm.ts fits it); a "map per folder, then merge" pass if big repos map poorly
const MAX_TREE = 800, MAX_EXCERPTS = 150, COMPONENT_CHARS = 200_000;

interface Stored {
	map: SystemMap; layout: Record<string, Cell>; createdAt: number; fileCount: number;
	/** Hash of every source file's path, size and modified time when the map was drawn. */
	fingerprint?: string;
}

export class MapController implements vscode.Disposable, vscode.FileDecorationProvider {
	private panel?: vscode.WebviewPanel;
	private stored?: Stored;
	private readonly lm = new Lm('coee draws a map of your project.');
	private readonly askLm = new Lm('coee explains a part of your project.');
	private marked = new Map<string, string>(); // uri → component name, for Explorer badges
	private readonly decoChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this.decoChange.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly ext: vscode.ExtensionContext) {
		this.disposables.push(this.decoChange, vscode.window.registerFileDecorationProvider(this));
	}

	dispose() {
		this.lm.cancel();
		this.askLm.cancel();
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const name = this.marked.get(uri.toString());
		return name ? { badge: '●', color: new vscode.ThemeColor('coee.highlightBorder'), tooltip: `Part of “${name}” in the system map` } : undefined;
	}

	/** The folder the map panel shows. */
	private root?: vscode.Uri;

	/** Component to select once the map is drawn (from the architecture page's "Show on map"). */
	private pendingSelect?: string;

	async open(root?: vscode.Uri, select?: string) {
		root ??= await pickProject('Map which codebase?');
		if (!root) return;
		this.pendingSelect = select;
		if (this.panel && this.root?.toString() === root.toString()) {
			this.panel.reveal();
			if (select && this.stored) this.post({ type: 'select', id: select });
			return;
		}
		this.panel?.dispose();
		this.root = root;
		this.stored = undefined;
		this.panel = vscode.window.createWebviewPanel('coee.map', `System map · ${path.basename(root.path)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
		this.panel.iconPath = vscode.Uri.joinPath(this.ext.extensionUri, 'media', 'icon.png');
		this.panel.webview.html = page(this.panel.webview, { css: CSS, body: BODY, script: SCRIPT });
		this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => this.fail(err)));
		const panel = this.panel;
		panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.lm.cancel(); this.askLm.cancel(); this.mark(undefined); } });
	}

	private post(m: object) { this.panel?.webview.postMessage(m); }

	/** Send the map; select the part the architecture page asked for, if any. */
	private postMap() {
		if (!this.stored) return;
		this.post({ type: 'map', ...this.stored });
		if (this.pendingSelect) { this.post({ type: 'select', id: this.pendingSelect }); this.pendingSelect = undefined; }
	}

	private fail(err: unknown) {
		if (isCancel(err)) return this.stored ? this.postMap() : this.post({ type: 'error', text: 'Mapping stopped. Draw the map again when you\'re ready.' });
		const msg = err instanceof Error ? err.message : String(err);
		log.error(msg);
		this.post({ type: 'error', text: msg });
	}

	private load(root: vscode.Uri): Stored | undefined {
		const stored = this.ext.workspaceState.get<Stored>(`${KEY}:${root.toString()}`)
			?? (root.toString() === vscode.workspace.workspaceFolders?.[0]?.uri.toString() ? this.ext.workspaceState.get<Stored>(KEY) : undefined);
		if (!stored) return undefined;
		// Maps saved by older versions listed files as plain paths.
		const paths = stored.map.components.flatMap(c => c.files.map(f => typeof f === 'string' ? f : f.path));
		const map = repairMap(stored.map, paths).value;
		return map && { ...stored, map };
	}

	/** Forget every saved system map. Returns how many went. */
	async clearCache() {
		const keys = this.ext.workspaceState.keys().filter(k => k === KEY || k.startsWith(KEY + ':'));
		for (const k of keys) await this.ext.workspaceState.update(k, undefined);
		this.stored = undefined;
		return keys.length;
	}

	/** The map of `root`: the saved one while the code is unchanged, else a new one (the codebase tour builds on it). */
	async mapFor(root: vscode.Uri): Promise<SystemMap> {
		const saved = this.load(root);
		const fresh = saved && saved.fingerprint === await fingerprint(root, await sourceFiles(root));
		const stored = (fresh ? saved : undefined) ?? await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `coee: mapping ${path.basename(root.path)} first`, cancellable: true },
			(progress, token) => this.build(root, token, m => progress.report({ message: m })));
		return stored.map;
	}

	private async onMessage(m: { type: string; id?: string; path?: string; question?: string; startLine?: number; endLine?: number }) {
		switch (m.type) {
			case 'ready': {
				const root = this.root!;
				this.stored = this.load(root);
				if (!this.stored) return this.generate();
				this.postMap();
				// Show the saved map at once, then say if the code changed since it was drawn.
				const now = await fingerprint(root, await sourceFiles(root));
				if (this.root?.toString() === root.toString() && this.stored.fingerprint !== now) this.post({ type: 'stale' });
				return;
			}
			case 'refresh': return this.generate();
			case 'cancel': this.lm.cancel(); this.askLm.cancel(); return this.stored ? this.postMap() : this.post({ type: 'error', text: 'Mapping stopped.' });
			case 'select': return this.mark(m.id);
			case 'open': {
				if (!m.path || !this.root) return;
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.root, m.path));
				const a = Math.max(0, Math.min((m.startLine ?? 1) - 1, doc.lineCount - 1)), b = Math.max(a, Math.min((m.endLine ?? m.startLine ?? 1) - 1, doc.lineCount - 1));
				const range = new vscode.Range(a, 0, b, doc.lineAt(b).text.length);
				return void vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: m.startLine ? range : undefined });
			}
			case 'explain': return this.explain(m.id!, m.question?.trim() || undefined);
			case 'tour': return vscode.commands.executeCommand('coee.tour', this.root);
			case 'architecture': return vscode.commands.executeCommand('coee.architecture', this.root, m.id);
			case 'plan': {
				const c = this.stored?.map.components.find(x => x.id === m.id);
				return vscode.commands.executeCommand('coee.plan', this.root, c ? `In ${c.name}: ` : undefined);
			}
			case 'stopAnswer': return this.askLm.cancel();
		}
	}

	/** Outline the selected part's files in the Explorer. */
	private mark(id: string | undefined) {
		const c = this.stored?.map.components.find(x => x.id === id);
		const old = [...this.marked.keys()].map(u => vscode.Uri.parse(u));
		this.marked = new Map(c && this.root ? c.files.map(f => [vscode.Uri.joinPath(this.root!, f.path).toString(), c.name]) : []);
		this.decoChange.fire([...old, ...[...this.marked.keys()].map(u => vscode.Uri.parse(u))]);
	}

	private async generate() {
		const root = this.root!;
		this.post({ type: 'loading', text: 'Looking through the project files' });
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'coee: mapping the project', cancellable: true }, async (progress, token) => {
			const stored = await this.build(root, token, m => { this.post({ type: 'loading', text: m }); progress.report({ message: m }); });
			if (this.root?.toString() === root.toString()) { this.stored = stored; this.postMap(); }
		});
	}

	private async build(root: vscode.Uri, token: vscode.CancellationToken, report: (m: string) => void): Promise<Stored> {
		const tree = (await sourceFiles(root, token)).slice(0, MAX_TREE);
		if (!tree.length) throw new Error('No source files found in this folder, so there is nothing to map yet.');
		const excerpts = await this.excerpts(root, tree, token);
		report(`Reading ${tree.length} files and grouping them into parts`);
		const map = await this.lm.json<SystemMap>(b => buildMapPrompt(tree, excerpts, b), d => repairMap(d, tree), token);
		const stored = { map, layout: layers(map.components.map(c => c.id), map.connections), createdAt: Date.now(), fileCount: tree.length, fingerprint: await fingerprint(root, await sourceFiles(root)) };
		await this.ext.workspaceState.update(`${KEY}:${root.toString()}`, stored);
		return stored;
	}

	private async excerpts(root: vscode.Uri, tree: string[], token: vscode.CancellationToken): Promise<FileExcerpt[]> {
		// Manifests first (they say what the project is), then the shallowest source files (entry points live near the top).
		// The prompt builder cuts this list to what the model can take.
		const ranked = [...tree].sort((a, b) => Number(MANIFEST.test(b)) - Number(MANIFEST.test(a)) || a.split('/').length - b.split('/').length);
		const out: FileExcerpt[] = [];
		for (const p of ranked.slice(0, MAX_EXCERPTS)) {
			if (token.isCancellationRequested) break;
			const text = await read(vscode.Uri.joinPath(root, p));
			if (text.trim()) out.push({ path: p, text: MANIFEST.test(p) ? excerpt(text, 40, 0) : excerpt(text) });
		}
		return out;
	}

	private async explain(id: string, question?: string) {
		const map = this.stored?.map;
		const c = map?.components.find(x => x.id === id);
		if (!map || !c || !this.root) return;
		const files: FileExcerpt[] = [];
		let used = 0;
		for (const f of c.files) {
			if (used >= COMPONENT_CHARS) break;
			const text = (await read(vscode.Uri.joinPath(this.root, f.path))).slice(0, COMPONENT_CHARS - used);
			files.push({ path: f.path, text });
			used += text.length;
		}
		this.post({ type: 'answerStart', id, question });
		try {
			await this.askLm.ask(b => buildComponentPrompt(map, c, files, question, b), t => this.post({ type: 'answerChunk', id, text: t }));
		} catch (err) {
			if (!isCancel(err)) this.post({ type: 'answerError', id, text: err instanceof Error ? err.message : String(err) });
		} finally {
			this.post({ type: 'answerDone', id });
		}
	}
}

/** Changes whenever a source file is added, removed or saved: hashes each file's path, size and modified time (no reading). */
export async function fingerprint(root: vscode.Uri, paths: string[]): Promise<string> {
	const h = createHash('sha256');
	for (const p of paths) {
		const st = await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, p)).then(x => x, () => undefined);
		h.update(`${p}:${st?.size}:${st?.mtime}\n`);
	}
	return h.digest('hex');
}

/** Paths of the source and manifest files under `root`, relative to it, sorted. */
export async function sourceFiles(root: vscode.Uri, token?: vscode.CancellationToken): Promise<string[]> {
	const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, 5000, token);
	return uris.map(u => path.posix.relative(root.path, u.path)).filter(p => SOURCE.test(p) || MANIFEST.test(p)).sort();
}

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'requirements.txt'];

/** Project folders in a workspace folder: the folder itself if it has a marker, else marked subfolders up to two levels down. */
async function projectsIn(root: vscode.Uri): Promise<vscode.Uri[]> {
	const found: string[] = [];
	// ponytail: two-level marker scan; deeper monorepo packages are reached by right-clicking their folder
	const scan = async (rel: string, depth: number) => {
		let entries: [string, vscode.FileType][];
		try { entries = await vscode.workspace.fs.readDirectory(rel ? vscode.Uri.joinPath(root, rel) : root); } catch { return; }
		if (entries.some(([n]) => MARKERS.includes(n))) found.push(rel);
		if (depth === 2) return;
		for (const [n, t] of entries) {
			if (t & vscode.FileType.Directory && n !== 'node_modules' && !n.startsWith('.')) await scan(rel ? `${rel}/${n}` : n, depth + 1);
		}
	};
	await scan('', 0);
	const keep = outermost(found);
	// A root that is itself a project hides its sub-projects; a root without a marker isn't offered when it holds projects.
	return (keep.length ? keep : ['']).map(p => p ? vscode.Uri.joinPath(root, p) : root);
}

/**
 * The project to work on. A workspace folder may hold several codebases (found by their .git, package.json, …):
 * the one holding the file you're in wins; otherwise the only one; otherwise you pick.
 */
export async function pickProject(placeHolder: string, opts: { ask?: boolean } = {}): Promise<vscode.Uri | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (!folders.length) throw new Error('Open a folder first.');
	const projects = (await Promise.all(folders.map(f => projectsIn(f.uri)))).flat();
	if (projects.length === 1) return projects[0];
	const active = vscode.window.activeTextEditor?.document.uri ?? vscode.window.visibleTextEditors[0]?.document.uri;
	const holding = active && projects.filter(p => active.path === p.path || active.path.startsWith(p.path.replace(/\/$/, '') + '/'))
		.sort((a, b) => b.path.length - a.path.length)[0];
	if (holding && !opts.ask) return holding;
	const items = await Promise.all(projects.map(async uri => ({
		label: `$(folder) ${path.basename(uri.path)}`,
		description: vscode.workspace.asRelativePath(uri, true),
		detail: `${(await sourceFiles(uri)).length} source files`,
		uri,
	})));
	return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.uri;
}

export async function read(uri: vscode.Uri): Promise<string> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return bytes.length > 1_000_000 ? '' : new TextDecoder().decode(bytes);
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// Map UI: header, pan/zoom canvas of parts, and a drawer for the selected part.

export const BODY = /* html */ `
<header id="bar">
  <div class="switch" role="tablist" aria-label="View"><button class="on" role="tab" aria-selected="true">Map</button><button id="architecture" role="tab" aria-selected="false" title="One page: how it works, every part, each use case, lifecycle and the data model">Architecture</button></div>
  <h1 id="title">System map</h1>
  <span id="meta" class="pill"></span>
  <span class="grow"></span>
  <div class="tools">
    <button class="icon" id="zoomOut" title="Zoom out (-)" aria-label="Zoom out">−</button>
    <span id="zoom" class="muted">100%</span>
    <button class="icon" id="zoomIn" title="Zoom in (+)" aria-label="Zoom in">+</button>
    <button class="tool" id="fit" title="Fit to window (0)">⤢ Fit</button>
    <button class="tool" id="refresh" title="Read the project again and redraw">↻ Redraw</button>
    <button class="btn" id="tour" title="A guided walkthrough of the whole codebase, part by part">Tour this codebase</button>
  </div>
</header>
<div id="canvas">
  <div id="viewport" tabindex="0" aria-label="System map. Drag to pan, scroll to zoom."><div id="stage"></div></div>
  <p id="about" hidden></p>
  <aside id="drawer" hidden></aside>
  <div id="status" role="status"></div>
</div>`;

export const CSS = /* css */ `
html, body { height: 100%; overflow: hidden; }
body { display: grid; grid-template-rows: auto 1fr; background: var(--vscode-editor-background); }
#bar { display: flex; gap: 12px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); min-width: 0; }
#title { font-size: 1.05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.pill { font-size: .85em; padding: 1px 10px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.pill:empty { display: none; }
.pill.stale { border-color: var(--vscode-textLink-foreground); color: var(--vscode-textLink-foreground); }
.pill .link { font-size: inherit; }
.grow { flex: 1; }
.tools { display: flex; gap: 4px; align-items: center; }
.tool, .icon { border: 0; background: none; color: var(--vscode-foreground); padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
.tool:hover, .icon:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.icon { font-size: 1.1em; line-height: 1; padding: 3px 7px; }
#zoom { min-width: 3.4em; text-align: center; font-variant-numeric: tabular-nums; font-size: .92em; }
.tools .btn { margin-left: 6px; }

#canvas { position: relative; overflow: hidden; }
#viewport { position: absolute; inset: 0; overflow: hidden; cursor: grab; outline: none;
  background-image: radial-gradient(color-mix(in srgb, var(--vscode-foreground) 16%, transparent) 1px, transparent 1.2px); background-size: 22px 22px; }
#viewport.dragging { cursor: grabbing; }
#viewport:focus-visible { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
#stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
#stage svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.edge { fill: none; stroke: var(--muted); stroke-width: 1.4; opacity: .5; transition: opacity .15s; }
.edge.on { stroke: var(--vscode-textLink-foreground); stroke-width: 2; opacity: 1; }
.edge.dim { opacity: .12; }
.lbl rect { fill: var(--vscode-editor-background); stroke: var(--line); }
.lbl text { font: 11px var(--vscode-font-family); fill: var(--muted); }
.lbl.on rect { stroke: var(--vscode-textLink-foreground); }
.lbl.on text { fill: var(--vscode-foreground); }
.lbl.dim { opacity: .2; }
.node { position: absolute; width: 220px; height: 78px; padding: 10px 12px; text-align: left; border-radius: 8px; display: grid; align-content: start; gap: 3px;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--line); color: var(--vscode-foreground);
  box-shadow: 0 1px 2px rgba(0,0,0,.18); transition: opacity .15s, border-color .15s, box-shadow .15s; }
.node:hover { border-color: var(--vscode-focusBorder); }
.switch { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; padding: 2px; gap: 2px; flex: none; }
.switch button { border: 0; background: none; color: var(--muted); padding: 2px 12px; border-radius: 5px; font-size: .92em; }
.switch button.on { background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch button:not(.on):hover { color: var(--vscode-foreground); }
.node .name { font-weight: 600; font-size: .95em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node .sum { font-size: .85em; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
.node.on { border-color: var(--vscode-textLink-foreground); box-shadow: 0 0 0 1px var(--vscode-textLink-foreground), 0 4px 16px rgba(0,0,0,.3); }
.node.dim { opacity: .35; }

#about { position: absolute; left: 16px; bottom: 16px; max-width: min(560px, 60%); margin: 0; padding: 10px 14px; border-radius: 8px; line-height: 1.5;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--line); box-shadow: 0 4px 16px rgba(0,0,0,.25); }

#drawer { position: absolute; top: 16px; right: 16px; max-height: calc(100% - 32px); width: min(380px, 46%); display: flex; flex-direction: column;
  border-radius: 10px; border: 1px solid var(--line); background: var(--vscode-editorWidget-background); box-shadow: 0 8px 30px rgba(0,0,0,.35); overflow: hidden; }
#drawer[hidden] { display: none; }
#drawer .scroll { overflow-y: auto; padding: 16px 18px; display: grid; align-content: start; gap: 14px; flex: 1; }
#drawer .top { display: flex; gap: 8px; align-items: start; }
#drawer .top h2 { flex: 1; font-size: 1.1em; }
#drawer .x { border: 0; background: none; color: var(--muted); font-size: 1.25em; line-height: 1; padding: 2px 4px; border-radius: 4px; }
#drawer .x:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-foreground); }
#drawer h3 { font-size: .74em; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; }
#drawer ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
#drawer li .link { text-align: left; overflow-wrap: anywhere; }
.ref, .conn { display: grid; gap: 2px; }
.small { font-size: .9em; }
.evid { display: flex; gap: 8px; flex-wrap: wrap; }
.conn .dir { color: var(--muted); }
.answer { display: grid; gap: 8px; border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 12px; }
.answer .q { font-weight: 600; }
#drawer .foot { border-top: 1px solid var(--line); padding: 10px 12px; display: grid; gap: 8px; }
.composer { display: flex; gap: 6px; align-items: flex-end; border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); border-radius: 8px; padding: 4px 4px 4px 10px; }
.composer:focus-within { border-color: var(--vscode-focusBorder); }
.composer textarea, .composer textarea:focus { border: 0; outline: none; background: none; padding: 4px 0; resize: none; min-height: 0; max-height: 8em; }
.composer .btn { padding: 3px 12px; border-radius: 6px; flex: none; }
.foot .row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }

#status:not(:empty) { position: absolute; inset: 0; display: grid; place-content: center; gap: 14px; justify-items: center; text-align: center; padding: 24px; background: var(--vscode-editor-background); }
#status .sweep { width: 200px; }
#status p { max-width: 46ch; }
@media (max-width: 720px) {
  #drawer { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 55%; }
  #about, #meta, #zoom { display: none; }
}
`;

export const SCRIPT = /* js */ `
const W = 220, H = 78, GX = 110, GY = 34, PAD = 40;
const $ = id => document.getElementById(id);
const viewport = $('viewport'), stage = $('stage'), drawer = $('drawer'), status = $('status');
let data = null, pos = {}, sel = null, view = { x: 0, y: 0, k: 1 }, answer = null, draft = '';

const send = (type, extra) => vscode.postMessage({ type, ...extra });
const comp = id => data.map.components.find(c => c.id === id);
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };

function layout() {
  pos = {};
  const cols = {};
  for (const c of data.map.components) { const cell = data.layout[c.id] || { col: 0, row: 0 }; (cols[cell.col] ||= []).push([c.id, cell.row]); }
  const tallest = Math.max(...Object.values(cols).map(c => c.length));
  for (const [col, members] of Object.entries(cols)) {
    const offset = (tallest - members.length) * (H + GY) / 2;
    for (const [id, row] of members) pos[id] = { x: PAD + col * (W + GX), y: PAD + offset + row * (H + GY) };
  }
}

function edgePath(e) {
  const a = pos[e.from], b = pos[e.to];
  if (b.x > a.x) {
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, dx = (x2 - x1) / 2;
    return [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2];
  }
  // Same column or pointing back: loop underneath.
  const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y + H, drop = 46 + Math.abs(x1 - x2) / 6;
  return [x1, y1, x1, Math.max(y1, y2) + drop, x2, Math.max(y1, y2) + drop, x2, y2];
}

function render() {
  const NS = 'http://www.w3.org/2000/svg';
  const linked = new Set(sel ? data.map.connections.flatMap(e => e.from === sel || e.to === sel ? [e.from, e.to] : []) : []);
  const svg = document.createElementNS(NS, 'svg');
  svg.innerHTML = '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--muted)"/></marker><marker id="arrOn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--vscode-textLink-foreground)"/></marker></defs>';
  const labels = [];
  for (const e of data.map.connections) {
    if (!pos[e.from] || !pos[e.to]) continue;
    const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = edgePath(e);
    const on = sel && (e.from === sel || e.to === sel), dim = sel && !on;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M' + x1 + ' ' + y1 + 'C' + c1x + ' ' + c1y + ' ' + c2x + ' ' + c2y + ' ' + x2 + ' ' + y2);
    p.setAttribute('class', 'edge' + (on ? ' on' : dim ? ' dim' : ''));
    p.setAttribute('marker-end', on ? 'url(#arrOn)' : 'url(#arr)');
    svg.append(p);
    if (e.label) {
      const g = document.createElementNS(NS, 'g'), t = document.createElementNS(NS, 'text');
      g.setAttribute('class', 'lbl' + (on ? ' on' : dim ? ' dim' : ''));
      // Mid-curve, except for edges that skip a column: put those in the last gap so no box covers them.
      const t0 = pos[e.to].x - pos[e.from].x > W + GX ? 0.84 : 0.5, u = 1 - t0;
      const at = (a, b, c, d) => u * u * u * a + 3 * u * u * t0 * b + 3 * u * t0 * t0 * c + t0 * t0 * t0 * d;
      t.setAttribute('x', at(x1, c1x, c2x, x2));
      t.setAttribute('y', at(y1, c1y, c2y, y2) + 4);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = e.label.length > 30 ? e.label.slice(0, 29) + '…' : e.label;
      g.append(document.createElementNS(NS, 'rect'), t);
      labels.push(g);
    }
  }
  const nodes = data.map.components.map(c => {
    const p = pos[c.id];
    const b = el('button', { className: 'node' + (c.id === sel ? ' on' : sel && !linked.has(c.id) ? ' dim' : ''), 'data-id': c.id,
      'aria-pressed': c.id === sel ? 'true' : 'false', title: c.summary + ' (' + c.files.length + ' file' + (c.files.length === 1 ? '' : 's') + ')' },
      el('span', { className: 'name' }, c.name), el('span', { className: 'sum' }, c.summary));
    b.style.left = p.x + 'px'; b.style.top = p.y + 'px';
    return b;
  });
  svg.append(...labels); // labels above every edge
  stage.replaceChildren(svg, ...nodes);
  // Pills behind edge labels, sized to the text now that it's laid out.
  for (const g of labels) {
    const t = g.lastChild, b = t.getBBox(), r = g.firstChild;
    r.setAttribute('x', b.x - 7); r.setAttribute('y', b.y - 3); r.setAttribute('width', b.width + 14); r.setAttribute('height', b.height + 6); r.setAttribute('rx', (b.height + 6) / 2);
  }
  renderDrawer();
}

function apply() {
  stage.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
  $('zoom').textContent = Math.round(view.k * 100) + '%';
}
const kids = (...k) => k.filter(x => x != null && x !== false);

function fit() {
  const xs = Object.values(pos);
  if (!xs.length) return;
  const w = Math.max(...xs.map(p => p.x)) + W + PAD, h = Math.max(...xs.map(p => p.y)) + H + PAD + 60;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  view.k = Math.min(1.15, vw / w, vh / h);
  view.x = (vw - w * view.k) / 2; view.y = Math.max(0, (vh - h * view.k) / 2);
  apply();
}

function zoomAt(f, cx, cy) {
  const k = Math.min(2.5, Math.max(0.25, view.k * f));
  view.x = cx - (cx - view.x) * (k / view.k); view.y = cy - (cy - view.y) * (k / view.k); view.k = k;
  apply();
}

function select(id) {
  sel = id === sel ? null : id;
  answer = null; draft = '';
  send('select', { id: sel });
  render();
  if (sel) keepClear(sel);
}

/** Pan so the selected box isn't hidden under the details card. */
function keepClear(id) {
  const p = pos[id];
  if (!p || drawer.hidden) return;
  const free = viewport.clientWidth - drawer.offsetWidth - 48; // room left of the card
  const right = view.x + (p.x + W) * view.k, left = view.x + p.x * view.k;
  if (free > W * view.k && right > free) { view.x -= right - free + 24; apply(); }
  else if (left < 16) { view.x += 16 - left; apply(); }
}

function renderDrawer() {
  const c = sel && comp(sel);
  drawer.hidden = !c;
  if (!c) return;
  const name = id => (comp(id) || { name: id }).name;
  const out = data.map.connections.filter(e => e.from === c.id), inc = data.map.connections.filter(e => e.to === c.id);
  const ref = f => el('li', { className: 'ref' },
    el('button', { className: 'link mono', onclick: () => send('open', f) }, f.path + (f.startLine ? ':' + f.startLine + (f.endLine && f.endLine !== f.startLine ? '–' + f.endLine : '') : '')),
    f.why ? el('span', { className: 'muted' }, f.why) : null);
  const conn = (e, dir) => el('li', { className: 'conn' },
    el('div', {}, el('span', { className: 'dir', 'aria-hidden': 'true' }, dir === 'out' ? '→ ' : '← '),
      el('button', { className: 'link', onclick: () => select(dir === 'out' ? e.to : e.from) }, name(dir === 'out' ? e.to : e.from)),
      e.label ? el('span', { className: 'muted' }, '  ' + e.label) : null),
    e.detail ? el('p', { className: 'muted small' }, e.detail) : null,
    e.evidence && e.evidence.length ? el('div', { className: 'evid' }, ...e.evidence.map(f => el('button', { className: 'link mono small', onclick: () => send('open', f) }, f.path + (f.startLine ? ':' + f.startLine : '')))) : null);
  const focused = document.activeElement && document.activeElement.id === 'q';
  const busy = !!(answer && answer.busy);
  const q = el('textarea', { id: 'q', rows: 1, placeholder: 'Ask about ' + c.name, value: draft, 'aria-label': 'Ask about ' + c.name });
  const fitQ = () => { q.style.height = 'auto'; q.style.height = q.scrollHeight + 'px'; };
  const ask = () => { if (busy) return send('stopAnswer'); if (!q.value.trim()) return q.focus(); send('explain', { id: c.id, question: q.value.trim() }); draft = ''; };
  q.addEventListener('input', () => { draft = q.value; fitQ(); });
  q.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); ask(); } });
  requestAnimationFrame(fitQ);
  const old = drawer.querySelector('.scroll'), top = old ? old.scrollTop : 0, sameComp = drawer.dataset.id === c.id;
  const scroll = el('div', { className: 'scroll' }, ...kids(
    el('div', { className: 'top' }, el('h2', {}, c.name), el('button', { className: 'x', 'aria-label': 'Close details', onclick: () => select(null) }, '×')),
    c.summary ? el('p', { className: 'muted' }, c.summary) : null,
    c.description ? el('p', {}, c.description) : null,
    c.files.length ? el('section', {}, el('h3', {}, 'Code'), el('ul', {}, ...c.files.map(ref))) : null,
    out.length || inc.length ? el('section', {}, el('h3', {}, 'Connections'), el('ul', {}, ...inc.map(e => conn(e, 'in')), ...out.map(e => conn(e, 'out')))) : null,
    answer && answer.id === c.id ? el('section', { className: 'answer', 'aria-live': 'polite' },
      answer.question ? el('p', { className: 'q' }, answer.question) : null,
      answer.text ? md(answer.text) : null,
      answer.error ? el('p', { className: 'error' }, answer.error) : null,
      busy && !answer.text ? el('div', { className: 'sweep', 'aria-hidden': 'true' }) : null) : null));
  const foot = el('div', { className: 'foot' },
    el('form', { className: 'composer', onsubmit: ev => { ev.preventDefault(); ask(); } }, q,
      el('button', { className: 'btn' + (busy ? ' quiet' : ''), type: 'submit' }, busy ? 'Stop' : 'Ask About This')),
    el('div', { className: 'row' },
      el('button', { className: 'link', disabled: busy, onclick: () => send('explain', { id: c.id }) }, 'Explain this part'),
      el('button', { className: 'link', onclick: () => send('architecture', { id: c.id }) }, 'Read in architecture'),
      el('button', { className: 'link', onclick: () => send('plan', { id: c.id }) }, 'Plan a change')));
  drawer.dataset.id = c.id;
  drawer.replaceChildren(scroll, foot);
  if (sameComp) scroll.scrollTop = answer && answer.busy ? scroll.scrollHeight : top;
  if (focused) q.focus();
}

// Pan (drag) and zoom (wheel / pinch). A drag that barely moves is a click.
let drag = null;
viewport.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target.closest('.node') }; viewport.setPointerCapture(e.pointerId); });
viewport.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true; viewport.classList.add('dragging');
  view.x = drag.vx + dx; view.y = drag.vy + dy; apply();
});
viewport.addEventListener('pointerup', () => {
  if (drag && !drag.moved) { if (drag.target) select(drag.target.dataset.id); else if (sel) select(null); }
  drag = null; viewport.classList.remove('dragging');
});
viewport.addEventListener('wheel', e => { e.preventDefault(); const r = viewport.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
viewport.addEventListener('keydown', e => {
  const r = viewport.getBoundingClientRect();
  if (e.key === '+' || e.key === '=') zoomAt(1.2, r.width / 2, r.height / 2);
  if (e.key === '-') zoomAt(1 / 1.2, r.width / 2, r.height / 2);
  if (e.key === '0') fit();
  if (e.key === 'Enter' && e.target.closest('.node')) select(e.target.closest('.node').dataset.id);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sel && !e.target.closest('textarea')) select(null); });
$('fit').onclick = fit;
$('zoomIn').onclick = () => zoomAt(1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
$('zoomOut').onclick = () => zoomAt(1 / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
$('refresh').onclick = () => send('refresh');
$('tour').onclick = () => send('tour');
$('architecture').onclick = () => send('architecture');
new ResizeObserver(() => data && fit()).observe(viewport);

function showStatus(...k) { status.replaceChildren(...kids(...k)); }

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'loading') {
    showStatus(el('div', { className: 'sweep', 'aria-hidden': 'true' }), el('p', {}, m.text + '…'), el('button', { className: 'btn quiet', onclick: () => send('cancel') }, 'Stop'));
  }
  if (m.type === 'error') {
    showStatus(el('p', { className: 'error', role: 'alert' }, m.text), el('button', { className: 'btn', onclick: () => send('refresh') }, 'Try again'));
  }
  if (m.type === 'map') {
    data = m; sel = null; answer = null; showStatus();
    $('title').textContent = m.map.title;
    $('about').textContent = m.map.summary; $('about').hidden = !m.map.summary;
    $('meta').textContent = m.map.components.length + ' parts · ' + m.fileCount + ' files · drawn ' + ago(m.createdAt);
    $('meta').classList.remove('stale');
    layout(); render(); fit();
  }
  if (m.type === 'select' && data && m.id) { sel = null; select(m.id); }
  if (m.type === 'stale') {
    const meta = $('meta');
    meta.replaceChildren(document.createTextNode('Code changed since this was drawn · '), el('button', { className: 'link', onclick: () => send('refresh') }, 'Update'));
    meta.classList.add('stale');
  }
  if (m.type === 'answerStart') { answer = { id: m.id, question: m.question, text: '', busy: true }; renderDrawer(); }
  if (m.type === 'answerChunk' && answer && answer.id === m.id) { answer.text += m.text; renderDrawer(); }
  if (m.type === 'answerError' && answer && answer.id === m.id) { answer.error = m.text; renderDrawer(); }
  if (m.type === 'answerDone' && answer && answer.id === m.id) { answer.busy = false; renderDrawer(); }
});
send('ready');
`;
