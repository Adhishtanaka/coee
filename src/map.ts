import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { FileExcerpt, SystemMap, outermost, buildMapPrompt, excerpt, repairMap } from './prompt';
import { Lm } from './lm';
import { lsFiles } from './git';
import { sampleTree } from './subsystems';

const KEY = 'coee.systemMap';
export const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**,**/vendor/**,**/target/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/*.min.*,**/*.map,**/*.lock,**/package-lock.json,**/.vscode-test/**}';
export const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|h|cc|cpp|hpp|scala|dart|vue|svelte|ex|exs|lua|sh|sql)$/i;
export const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|README\.md|requirements\.txt|Dockerfile|docker-compose\.ya?ml)$/i;
// ponytail: one pass sized to the model (lm.ts fits it); big repos get a subsystem level first (architecture.ts), so this maps one package at a time
const MAX_TREE = 800, MAX_EXCERPTS = 150;

interface Stored {
	map: SystemMap; createdAt: number; fileCount: number;
	/** Hash of every source file's path, size and modified time when the map was drawn. */
	fingerprint?: string;
}

/** The project's map of parts: built once, saved per project, and reused by the architecture page, tours and plans. It has no page of its own. */
export class MapController implements vscode.Disposable {
	private readonly lm = new Lm('coee maps your project.');

	constructor(private readonly ext: vscode.ExtensionContext) {}

	dispose() { this.lm.cancel(); }

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
		return keys.length;
	}

	/** The map of `root`: the saved one while the code is unchanged, else a new one. */
	async mapFor(root: vscode.Uri): Promise<SystemMap> {
		const saved = this.load(root);
		const fresh = saved && saved.fingerprint === await fingerprint(root, await sourceFiles(root));
		const stored = (fresh ? saved : undefined) ?? await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `coee: mapping ${path.basename(root.path)} first`, cancellable: true },
			(progress, token) => this.build(root, token, m => progress.report({ message: m })));
		return stored.map;
	}

	private async build(root: vscode.Uri, token: vscode.CancellationToken, report: (m: string) => void): Promise<Stored> {
		const tree = sampleTree(await sourceFiles(root, token), MAX_TREE);
		if (!tree.length) throw new Error('No source files found in this folder, so there is nothing to map yet.');
		const excerpts = await this.excerpts(root, tree, token);
		report(`Reading ${tree.length} files and grouping them into parts`);
		const map = await this.lm.json<SystemMap>(b => buildMapPrompt(tree, excerpts, b), d => repairMap(d, tree), token);
		const stored = { map, createdAt: Date.now(), fileCount: tree.length, fingerprint: await fingerprint(root, await sourceFiles(root)) };
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

const SKIP = /(^|\/)(node_modules|dist|build|out|vendor|target|\.venv|venv|__pycache__|coverage|\.next|\.git|\.vscode-test)\/|\.min\.|\.map$|\.lock$|(^|\/)package-lock\.json$/;

/**
 * Paths of the source and manifest files under `root`, relative to it, sorted. In a git repository (and a trusted
 * workspace) git lists them: fast, complete, and .gitignore respected. Otherwise a file search, capped at 20,000.
 */
export async function sourceFiles(root: vscode.Uri, token?: vscode.CancellationToken, extra?: RegExp): Promise<string[]> {
	const keep = (p: string) => !SKIP.test(p) && (SOURCE.test(p) || MANIFEST.test(p) || !!extra?.test(p));
	const listed = root.scheme === 'file' ? await lsFiles(root.fsPath).catch(() => undefined) : undefined;
	if (listed?.length) return listed.filter(keep).sort();
	const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE, 20_000, token);
	return uris.map(u => path.posix.relative(root.path, u.path)).filter(keep).sort();
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
