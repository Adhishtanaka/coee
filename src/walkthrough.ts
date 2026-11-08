import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import {
	CodeContext, Diagram, FolderFile, HelpMode, Scene, SystemMap, Turn, Walkthrough, buildAskPrompt, buildExplainPrompt, buildMorePrompt, buildTourOverviewPrompt,
	buildPlanPickPrompt, buildPlanPrompt, buildReviewPrompt, buildTourPartPrompt, buildTourUseCasesPrompt, withMapDiagram, endLine, packChapters, repair, repairPick, repairPlan, placeSnippet, isTestFile,
} from './prompt';
import { Lm, Prompt, isCancel, log } from './lm';
import { diagramSvg } from './layout';
import { MANIFEST, MapController, pickProject, read, sourceFiles } from './map';
import { codeColumn, createPanel, page } from './ui';
import { addCode, fileText } from './apply';
import { Review, ReviewFile, ReviewTarget, collect, openDiff, pickReview, repoRoot, useCommitMessage } from './git';

const MAX_LINES = 3000; // ponytail: whole files fit; beyond this select a part
const CHAPTER_LINES = 150; // one model request explains at most this many lines
const ASK_LINES = 800;
const TOUR_PARTS = 10;
export const TOUR_CHARS = 400_000; // ponytail: code read per tour; budgets in prompt.ts decide what the model sees
const CACHE_SIZE = 40;
const CACHE_KEY = 'coee.walkthroughs';
const RECENT_KEY = 'coee.recent';

/** How to reopen a walkthrough: run it again, which the cache answers at once. */
interface Recent { id: string; label: string; sub: string; kind: 'range' | 'folder' | 'tour' | 'plan' | 'review'; uri: string; start?: number; end?: number; question?: string; target?: ReviewTarget; t: number }
const SHORTCUT = process.platform === 'darwin' ? '⌘⌥E' : 'Ctrl+Alt+E';
const IMPORT = /^\s*(import\b|from\s+\S+\s+import\b|#include\b|using\b|use\b|package\b|require\b)|\brequire\(/;

/** One part of a project to walk through: a component of the map, or a use case from the architecture page. */
export type TourPart = { id: string } | { name: string; steps: string[]; files: string[] };

type Part = { q?: boolean; text: string };
type ViewScene = Scene & { svg?: string; failed?: boolean };
type ViewWalkthrough = Walkthrough & { scenes: ViewScene[] };

/** Everything the walkthrough tab renders. The extension owns it; the webview only draws it. */
interface ViewState {
	status: 'empty' | 'planning' | 'loading' | 'ready' | 'answer' | 'error';
	heading?: string;
	source?: string;
	w?: ViewWalkthrough;
	i: number;
	/** Per scene: follow-up questions and answers. */
	extras: Part[][];
	/** The chat in answer mode. */
	thread: Part[];
	busy: boolean;
	stale: boolean;
	error?: string;
	/** "part 2 of 4" while later parts of a long range are still being read. */
	reading?: string;
	/** Parts of a multi-part walkthrough read so far, while the rest are still being read. */
	progress?: { done: number; total: number };
	/** Heading of each part (chapter or tour stop), when there's more than one. */
	parts?: string[];
	/** Prefills the "Plan a change" field. */
	planDraft?: string;
	/** Bumped to make the webview focus the question box. */
	focusAsk: number;
	shortcut: string;
	/** Editor-tab walkthroughs: the current step's code, shown with the explanation under its lines. */
	code?: CodeView;
	/** Show the intro (what you'll learn, words you'll meet) before step 1. */
	intro?: boolean;
	/** Plans: where each snippet ("scene:index") stands in the files now. */
	snippets?: Record<string, { status: 'ready' | 'added' | 'error'; reason?: string }>;
}

interface CodeView {
	file: string;
	lang: string;
	/** Path segments, then the enclosing symbols: server › middleware › rateLimit.js › rateLimit */
	crumbs: string[];
	/** 1-based number of lines[0]. */
	first: number;
	lines: string[];
	total: number;
	/** Reviews: lines added or changed, and removed blocks placed after the line they followed. */
	added?: number[];
	removed?: Array<{ after: number; lines: string[] }>;
}

/** One model request that yields a part of the walkthrough. `earlier` summarizes the parts before it. */
interface Job {
	run(earlier: string[]): Promise<Walkthrough>;
	/** Where a failure of this part points, so its "try again" step has lines to show. */
	where: { file?: string; startLine: number; endLine: number; what: string };
}

interface Session {
	uri: vscode.Uri;
	range: vscode.Range;
	jobs: Job[];
	/** Single-file walkthroughs: the code of each part, for follow-up questions. */
	parts: CodeContext[];
	summaries: string[];
	whole?: CodeContext;
	/** Tours and plans can be re-run on another codebase. */
	switchable?: boolean;
	/** Set for change plans: the proposed change. */
	plan?: string;
	/** Folder walkthroughs: workspace-relative path → file. */
	files?: Map<string, vscode.Uri>;
	/** Reviews: what is compared, and each changed file's new text and diff. */
	review?: { target: ReviewTarget; files: Map<string, ReviewFile> };
}

const fresh = (patch: Partial<ViewState> = {}): ViewState =>
	({ status: 'empty', i: 0, extras: [], thread: [], busy: false, stale: false, focusAsk: 0, shortcut: SHORTCUT, ...patch });

export class WalkthroughController implements vscode.Disposable {
	/** The walkthrough's editor tab: the only place coee shows anything. */
	private panel?: vscode.WebviewPanel;
	private state = fresh();
	private session?: Session;
	private gen = 0;
	private readonly lm = new Lm('coee answers a question about your code.');
	private readonly reader = new Lm('coee explains the code you selected.');
	private readonly cache = new Map<string, Walkthrough>();
	private readonly svgs = new Map<string, string>(); // diagram + theme → SVG
	private flushTimer?: NodeJS.Timeout;
	private snipTimer?: NodeJS.Timeout;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly highlight = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('coee.highlightBackground'),
		borderColor: new vscode.ThemeColor('coee.highlightBorder'),
		borderStyle: 'solid',
		borderWidth: '0 0 0 2px',
		isWholeLine: true,
		overviewRulerColor: new vscode.ThemeColor('coee.highlightBorder'),
		overviewRulerLane: vscode.OverviewRulerLane.Center,
	});

	constructor(private readonly extensionUri: vscode.Uri, private readonly maps: MapController, private readonly store: vscode.Memento) {
		this.disposables.push(
			this.highlight,
			vscode.workspace.onDidChangeTextDocument(e => {
				// A plan watches its snippets instead: code added (by coee or by hand) shows as added, not as a stale plan.
				if (this.session?.plan && e.contentChanges.length && this.inSession(e.document.uri)) {
					clearTimeout(this.snipTimer);
					this.snipTimer = setTimeout(() => void this.refreshSnippets(), 400);
					return;
				}
				if (this.session && !this.state.stale && e.contentChanges.length && this.inSession(e.document.uri)) {
					this.state.stale = true;
					this.push();
				}
			}),
			vscode.window.onDidChangeVisibleTextEditors(() => this.paintEditor()),
			vscode.window.onDidChangeActiveColorTheme(() => this.push()),
		);
	}

	dispose() {
		this.lm.cancel();
		this.reader.cancel();
		clearTimeout(this.flushTimer);
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	// -------------------------------------------------------------------------
	// The tab

	private setup(webview: vscode.Webview) {
		webview.options = { enableScripts: true, localResourceRoots: [] };
		webview.html = page(webview, { css: CSS, body: '<main id="root" aria-live="polite"></main>', script: SCRIPT });
		webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => this.fail(err)));
	}

	/** Open the tab beside the code, or bring it forward. */
	/**
	 * The Walkthrough tab, without questions: the walkthrough that's open; else the last one (reopened from the cache,
	 * so it's instant); else a tour of the project.
	 */
	async openWalkthrough(root?: vscode.Uri) {
		const walking = this.panel && this.state.w && !this.session?.plan && !this.session?.review && this.state.status !== 'planning';
		if (walking) return this.panel!.reveal(this.panel!.viewColumn, false);
		const last = this.store.get<Recent[]>(RECENT_KEY, []).find(r => r.kind !== 'plan' && r.kind !== 'review');
		return last ? this.reopen(last.id) : this.tour(root);
	}

	private openPanel() {
		if (this.panel) return this.panel.reveal(this.panel.viewColumn, true);
		const panel = this.panel = createPanel('coee.walkthroughPanel', 'Walkthrough', { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
		this.setup(panel.webview);
		// Closing the tab ends the walkthrough.
		panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.close(); } });
	}

	private async onMessage(m: { type: string; to?: string; i?: number; n?: number; text?: string; part?: number; mode?: string; act?: string; id?: string }) {
		switch (m.type) {
			case 'ready': return this.flush();
			case 'go': return this.go(m.i ?? 0);
			case 'more': return this.more((['simpler', 'deeper', 'lines'] as const).find(x => x === m.mode) ?? 'deeper');
			case 'start': this.set({ intro: false }); return this.showScene();
			case 'startNow': this.stopReading(); this.set({ intro: false }); return this.showScene();
			case 'intro': return this.set({ intro: true });
			case 'openPlan': return this.openPlan(this.session?.uri);
			case 'ask': return this.ask(String(m.text ?? '').trim());
			case 'cancel': return this.cancel();
			case 'stopReading': return this.stopReading();
			case 'reexplain': return this.reexplain();
			case 'retryPart': return this.retryPart(m.part ?? -1);
			case 'reveal': {
				const r = this.session?.review, s = this.state.w?.scenes[this.state.i];
				return r && s?.file ? openDiff(r.target, s.file, r.files.get(s.file)?.diff.oldPath) : this.showScene(true);
			}
			case 'useMessage': {
				const r = this.session?.review, msg = this.state.w?.commitMessage;
				return r && msg ? useCommitMessage(r.target, msg) : undefined;
			}
			case 'snippet': return this.snippet(m.i ?? -1, m.n ?? -1, m.act === 'insert');
			case 'nav': return vscode.commands.executeCommand('coee.go', m.to, this.session?.uri);
			case 'bigDiagram': return this.bigDiagram();
			case 'close': return this.close();
			case 'switch': {
				const root = await pickProject('Which codebase?', { ask: true });
				if (!root) return;
				return this.session?.plan ? this.plan(this.session.plan, root) : this.tour(root);
			}
			case 'plan': return this.plan(String(m.text ?? '').trim());
		}
	}

	private inSession(uri: vscode.Uri) {
		const s = this.session;
		return !!s && (s.files ? [...s.files.values()].some(u => u.toString() === uri.toString()) : s.uri.toString() === uri.toString());
	}

	private sceneUri(s?: Scene) {
		return (s?.file && this.session?.files?.get(s.file)) || this.session!.uri;
	}

	private svgFor(d: Diagram, maxWidth = 640) {
		const theme = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
		const key = theme + maxWidth + JSON.stringify(d);
		let svg = this.svgs.get(key);
		if (!svg) {
			svg = diagramSvg(d, theme, maxWidth).svg;
			this.svgs.set(key, svg);
			if (this.svgs.size > 60) this.svgs.delete(this.svgs.keys().next().value!);
		}
		return svg;
	}

	/** Coalesce rapid updates (streamed chunks) into one post per frame-ish. */
	private push() {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => this.flush(), 40);
	}

	private flush() {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		const w = this.state.w, cur = w?.scenes[this.state.i];
		// Only the open step shows its diagram, so only it carries the SVG (bigger in the editor tab).
		const withSvg = (max: number) => w && cur?.diagram ? { ...this.state, w: { ...w, scenes: w.scenes.map((s, k) => k === this.state.i ? { ...s, svg: this.svgFor(s.diagram!, max) } : s) } } : this.state;
		const switchable = !!this.session?.switchable;
		const r = this.session?.review;
		const review = r && { note: r.target.note, stats: Object.fromEntries([...r.files].map(([p, f]) => [p, `${f.diff.status === 'added' ? 'new · ' : ''}+${f.plus} −${f.minus}`])) };
		if (this.panel) {
			this.panel.webview.postMessage({ type: 'state', state: { ...withSvg(1000), switchable, review, isPlan: !!this.session?.plan } });
			const title = w?.title ?? this.state.heading ?? 'Walkthrough';
			this.panel.title = title.length > 40 ? title.slice(0, 39) + '…' : title;
		}
		this.paintEditor();
		vscode.commands.executeCommand('setContext', 'coee.active', this.state.status === 'ready');
	}

	private set(patch: Partial<ViewState>) {
		Object.assign(this.state, patch);
		this.push();
	}

	// -------------------------------------------------------------------------
	// Walkthroughs, in parts for long ranges

	async explainEditor(editor: vscode.TextEditor) {
		const symbols = await symbolsOf(editor.document);
		await this.explainRange(editor.document, targetRange(editor, symbols), symbols);
	}

	private async reexplain() {
		if (!this.session) return vscode.commands.executeCommand('coee.explain');
		if (this.session.review) return this.review(undefined, undefined, this.session.review.target);
		if (this.session.plan) return this.plan(this.session.plan, this.session.uri);
		if (this.session.files) return this.tour(this.session.uri);
		const doc = await vscode.workspace.openTextDocument(this.session.uri);
		// The old range may have moved; re-explain the same lines, clamped to the file.
		const last = Math.min(this.session.range.end.line, doc.lineCount - 1);
		await this.explainRange(doc, new vscode.Range(Math.min(this.session.range.start.line, last), 0, last, 0));
	}

	private async explainRange(doc: vscode.TextDocument, range: vscode.Range, symbols?: vscode.DocumentSymbol[]) {
		const gen = this.restart();
		symbols ??= await symbolsOf(doc);
		const { first, last } = span(doc, range, MAX_LINES);
		const flat = flatten(symbols);
		const cuts = flat.length ? flat.map(s => s.range.start.line) : blankLines(doc, first, last);
		const spans = packChapters(first, last, cuts, CHAPTER_LINES);
		const n = spans.length;
		const wholeFile = first === 0 && last >= doc.lineCount - 1;
		const testFile = isTestFile(vscode.workspace.asRelativePath(doc.uri), doc.getText());
		// The outline gives a slice its surroundings, and gives a whole file the list of its classes, functions and globals.
		const outline = outlineOf(doc, symbols);
		const parts = spans.map((p, k) => ({ ...contextFor(doc, p.start, p.end, outline, n > 1 ? { index: k, count: n, earlier: [] } : undefined), wholeFile: wholeFile || undefined, testFile: testFile || undefined }));
		const jobs: Job[] = parts.map(base => ({
			where: { startLine: base.startLine, endLine: endLine(base), what: `lines ${base.startLine}–${endLine(base)}` },
			run: earlier => this.cached({ explain: base, earlier }, () => {
				const ctx: CodeContext = base.part ? { ...base, part: { ...base.part, earlier } } : base;
				return this.reader.json<Walkthrough>(b => buildExplainPrompt(ctx, b), d => repair(d, ctx.startLine, endLine(ctx)));
			}),
		}));
		this.session = { uri: doc.uri, range, jobs, parts, summaries: [] };
		const name = path.basename(doc.fileName);
		await this.runJobs(gen, `Reading ${name}`, `${name}:${first + 1}–${last + 1}`, n > 1 ? spans.map((p, k) => `Part ${k + 1} · lines ${p.start + 1}–${p.end + 1}`) : undefined, n > 1);
	}

	/** Cancel whatever is running and start a new walkthrough generation. */
	private restart() {
		this.lm.cancel();
		this.reader.cancel();
		return ++this.gen;
	}

	/**
	 * Walkthroughs are cached by a hash of everything the model would see (the code itself, not just its path),
	 * in memory and in workspace storage, so reopening is instant and any edit to the code misses the cache.
	 */
	/** Forget saved walkthroughs and the recent list. Returns how many saved items went. */
	async clearCache() {
		const n = Object.keys(this.store.get(CACHE_KEY, {})).length + this.store.get<unknown[]>(RECENT_KEY, []).length;
		this.cache.clear();
		await this.store.update(CACHE_KEY, undefined);
		await this.store.update(RECENT_KEY, undefined);
		return n;
	}

	private async cached(key: object, make: () => Promise<Walkthrough>): Promise<Walkthrough> {
		if (!vscode.workspace.getConfiguration('coee').get('cache', true)) return make();
		const hash = createHash('sha256').update(JSON.stringify(key)).digest('hex');
		const saved = this.store.get<Record<string, { w: Walkthrough; t: number }>>(CACHE_KEY, {});
		let w = this.cache.get(hash) ?? saved[hash]?.w;
		if (!w) {
			w = await make();
			// ponytail: keeps the newest 40 walkthroughs; an LRU on read if reopening old ones matters
			const next = Object.fromEntries(Object.entries({ ...saved, [hash]: { w, t: Date.now() } }).sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_SIZE));
			await this.store.update(CACHE_KEY, next);
		}
		this.cache.set(hash, w);
		if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
		return w;
	}

	/** Show part 1 as soon as it's ready, then add the other parts while the reader reads. */
	private async runJobs(gen: number, heading: string, source: string, parts?: string[], wide = true) {
		const n = this.session!.jobs.length;
		this.state = fresh({ status: 'loading', heading, source, busy: true, parts, reading: n > 1 ? `part 1 of ${n}` : undefined });
		this.flush();
		this.openPanel();
		let w: Walkthrough;
		try {
			w = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'coee is reading' }, () => this.explainPart(0));
		} catch (err) {
			if (gen !== this.gen) return; // superseded by a newer request
			if (isCancel(err)) return this.close();
			throw err;
		}
		if (gen !== this.gen) return;
		const scenes = w.scenes.map(s => viewScene(s, 0));
		this.state = fresh({ status: 'ready', source, w: { ...w, scenes }, extras: scenes.map(() => []), parts, reading: n > 1 ? `part 2 of ${n}` : undefined, progress: n > 1 ? { done: 1, total: n } : undefined, intro: !!(w.learn?.length || w.terms?.length) || n > 1 });
		this.flush();
		await this.remember(w.title, source);
		await this.showScene();
		for (let k = 1; k < n; k++) {
			if (gen !== this.gen) return;
			this.set({ reading: `part ${k + 1} of ${n}` });
			const more = await this.partScenes(k);
			if (gen !== this.gen) return;
			if (!more) break; // stopped
			this.state.w!.scenes.push(...more.scenes);
			this.state.w!.terms = [...(this.state.w!.terms ?? []), ...(more.terms ?? []).filter(t => !this.state.w!.terms?.some(o => o.name.toLowerCase() === t.name.toLowerCase()))].slice(0, 16);
			this.state.extras.push(...more.scenes.map(() => []));
			this.state.progress = { done: k + 1, total: n };
			this.push();
		}
		this.set({ reading: undefined, progress: undefined });
	}

	/** A file or folder from the Explorer: a file is explained whole (in parts if long); a folder in one pass, or as a tour if it's big. */
	/** One function or class, from the Explain link above it. */
	async explainLines(uri: vscode.Uri, start: number, end: number) {
		const doc = await vscode.workspace.openTextDocument(uri);
		await this.explainRange(doc, new vscode.Range(start, 0, Math.min(end, doc.lineCount - 1), 0));
	}

	async explainResource(uri: vscode.Uri) {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type & vscode.FileType.Directory) return this.explainFolder(uri);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn: codeColumn() });
		await this.explainRange(doc, new vscode.Range(0, 0, doc.lineCount - 1, 0));
	}

	/** Any folder gets the tour: the map first, then an overview, then each part from its own code. */
	explainFolder(folder: vscode.Uri) {
		return this.tour(folder);
	}

	/**
	 * The codebase tour: an overview of the whole system, then one part per component of the system map,
	 * each explained from that component's own code.
	 */
	async tour(root?: vscode.Uri, only?: TourPart) {
		root ??= await pickProject('Explain which codebase?');
		if (!root) return;
		const gen = this.restart();
		const name = path.basename(root.path);
		this.state = fresh({ status: 'loading', heading: `Touring ${name}`, source: `${name}/`, busy: true, reading: 'the project\'s parts' });
		this.flush();
		this.openPanel();
		let map: SystemMap;
		try {
			map = await this.maps.mapFor(root);
		} catch (err) {
			if (gen !== this.gen) return;
			if (isCancel(err)) return this.close();
			throw err;
		}
		if (gen !== this.gen) return;
		const all = await sourceFiles(root);
		// One part only (from the architecture page): a component by id, or a use case, walked like a part.
		const one = only && ('id' in only ? map.components.find(c => c.id === only.id) : { id: `use-case:${only.name}`, name: only.name, summary: only.steps.join(' → '), files: only.files.map(path => ({ path })) });
		const components = one ? [one] : map.components.filter(c => c.files.length).slice(0, TOUR_PARTS);
		if (only && !one) throw new Error('That part is no longer in the project map. Regenerate the architecture page.');
		if (one && !one.files.length) throw new Error(`${one.name} has no files to walk through.`);
		const { overviewPaths, wanted } = projectFiles(all, components);
		const { files, lines } = await readFiles(root, wanted, TOUR_CHARS);
		if (gen !== this.gen) return;
		const byPath = new Map(files.map(f => [f.path, f]));
		const pick = (paths: string[]) => paths.map(p => byPath.get(p)).filter((f): f is FolderFile => !!f);
		const first = (paths: string[]) => ({ file: paths[0], startLine: 1, endLine: 1 });
		const jobs: Job[] = [
			...(one ? [] : [
			{ where: { ...first(overviewPaths), what: 'the overview' }, run: async () => withMapDiagram(await this.cached({ tour: root!.toString(), map, overview: true, code: digest(pick(overviewPaths)) }, () =>
				this.reader.json<Walkthrough>(b => buildTourOverviewPrompt(map, pick(overviewPaths), b), d => repair(d, 1, 1, lines))), map) },
			// Use cases see the entry points first, then each part's own files; the budget decides how much fits.
			{ where: { ...first(overviewPaths), what: 'the use cases' }, run: (earlier: string[]) => this.cached({ tour: root!.toString(), map, useCases: true, earlier, code: digest(pick(wanted)) }, () =>
				this.reader.json<Walkthrough>(b => buildTourUseCasesPrompt(map, pick(wanted), b), d => repair(d, 1, 1, lines))) },
			]),
			...components.map(c => ({
				where: { ...first(c.files.map(f => f.path)), what: c.name },
				run: (earlier: string[]) => this.cached({ tour: root!.toString(), map, c: c.id, earlier, code: digest(pick(c.files.map(f => f.path))) }, () =>
					this.reader.json<Walkthrough>(b => buildTourPartPrompt(map, c, pick(c.files.map(f => f.path)), earlier, b), d => repair(d, 1, 1, lines))),
			})),
		];
		this.session = { uri: root, range: new vscode.Range(0, 0, 0, 0), parts: [], summaries: [], files: uriMap(root, wanted), jobs, switchable: true };
		await this.runJobs(gen, one ? `Walking through ${one.name}` : `Touring ${name}`, `${map.title} · ${one ? one.name : `${components.length} parts`}`, [...one ? [] : ['Overview', 'Use cases'], ...components.map(c => c.name)]);
	}

	private diagramPanel?: vscode.WebviewPanel;

	/** The current step's diagram at full size, in an editor tab beside the code. */
	private bigDiagram() {
		const s = this.state.w?.scenes[this.state.i];
		if (!s?.diagram) return;
		const theme = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
		const svg = diagramSvg(s.diagram, theme, 4000).svg;
		const caption = [s.diagram.illustrative ? 'Illustrative model' : '', s.diagram.caption ?? ''].filter(Boolean).join(' · ');
		if (!this.diagramPanel) {
			const panel = this.diagramPanel = createPanel('coee.diagram', 'Diagram', { localResourceRoots: [] });
			panel.onDidDispose(() => { if (this.diagramPanel === panel) this.diagramPanel = undefined; });
		}
		this.diagramPanel.title = `Diagram · ${s.title}`;
		this.diagramPanel.webview.html = page(this.diagramPanel.webview, {
			css: 'body{padding:24px;display:grid;gap:14px;justify-items:center;background:var(--vscode-editor-background)} .pic{max-width:100%;overflow:auto} h2{font-size:1.1em;text-align:center}',
			body: `<h2>${escapeHtml(s.title)}</h2><div class="pic">${svg}</div><p class="muted">${escapeHtml(caption)}</p>`,
			script: '',
		});
		this.diagramPanel.reveal(this.diagramPanel.viewColumn, true);
	}

	/**
	 * Review a change: staged work before a commit, a commit, a branch, a range or a GitHub PR.
	 * The walkthrough points at the new version of each file, with what was added and removed marked.
	 */
	async review(dir?: vscode.Uri, preset?: 'staged' | 'commit', given?: ReviewTarget) {
		let target = given;
		if (!target) {
			const root = dir ?? await pickProject('Review changes in which codebase?');
			if (!root) return;
			target = await pickReview(await repoRoot(root), preset);
		}
		if (!target) return;
		const t = target, gen = this.restart();
		this.session = undefined;
		this.state = fresh({ status: 'loading', heading: t.header, source: t.header, busy: true, reading: 'the changes' });
		this.openPanel();
		this.flush();
		let review: Review;
		try {
			review = await collect(t);
		} catch (err) {
			if (gen !== this.gen) return;
			throw err;
		}
		if (gen !== this.gen) return;
		const files = new Map(review.files.map(f => [f.diff.path, f]));
		const lines = Object.fromEntries(review.files.filter(f => f.text !== undefined).map(f => [f.diff.path, f.text!.split('\n').length]));
		const repo = vscode.Uri.file(t.repo);
		this.session = {
			uri: repo, range: new vscode.Range(0, 0, 0, 0), parts: [], summaries: [], files: uriMap(repo, [...files.keys()]), review: { target: t, files },
			jobs: [{ where: { file: review.files[0].diff.path, startLine: 1, endLine: 1, what: 'the changes' }, run: () => this.cached({ review: review.key, what: t.what, precommit: !!t.precommit, message: t.message }, () =>
				this.reader.json<Walkthrough>(b => buildReviewPrompt({ what: t.what, precommit: t.precommit, message: t.message }, review.files.map(f => f.diff), b), d => repair(d, 1, 1, lines))) }],
		};
		const n = review.files.length;
		await this.runJobs(gen, t.header, `${n} file${n === 1 ? '' : 's'} · +${review.plus} −${review.minus}${review.skipped ? ` · ${review.skipped} more not shown` : ''}`);
	}

	private planRoot?: vscode.Uri;

	/** Open the tab on "Plan a change", optionally for one project and with a starting description. */
	async openPlan(root?: vscode.Uri, draft?: string) {
		this.close();
		this.planRoot = root;
		this.state = fresh({ status: 'planning', planDraft: draft, focusAsk: Date.now() });
		this.openPanel();
		this.flush();
		this.panel?.reveal(this.panel.viewColumn, false); // take focus so the question can be typed straight away
	}

	/**
	 * Plan a change: map the project, let the model pick the files that matter, then explain how the
	 * change would fit, pointing at the existing lines it touches, without writing it.
	 */
	async plan(question: string, root?: vscode.Uri) {
		if (!question) return;
		root ??= this.planRoot ?? await pickProject('Plan the change in which codebase?');
		if (!root) return;
		const gen = this.restart();
		const name = path.basename(root.path);
		this.state = fresh({ status: 'loading', heading: question, source: `${name}/`, busy: true, reading: 'the project\'s parts' });
		this.flush();
		this.openPanel();
		let map: SystemMap, picked: { approach: string; files: string[] };
		try {
			map = await this.maps.mapFor(root);
			if (gen !== this.gen) return;
			this.set({ reading: 'which files the change touches' });
			const tree = (await sourceFiles(root)).slice(0, 800);
			try {
				picked = await this.reader.json(b => buildPlanPickPrompt(map, tree, question, b), d => repairPick(d, tree));
			} catch (err) {
				if (isCancel(err)) throw err;
				log.warn(`file pick failed, using the map's files: ${err}`);
				picked = { approach: '', files: map.components.flatMap(c => c.files.map(f => f.path)).slice(0, 15) };
			}
		} catch (err) {
			if (gen !== this.gen) return;
			if (isCancel(err)) return this.close();
			throw err;
		}
		if (gen !== this.gen) return;
		const { files, lines } = await readFiles(root, picked.files, TOUR_CHARS);
		if (!files.length) throw new Error('coee couldn\'t read the files this change would touch.');
		this.session = {
			uri: root, range: new vscode.Range(0, 0, 0, 0), parts: [], summaries: [], files: uriMap(root, picked.files), plan: question, switchable: true,
			jobs: [{ where: { file: files[0].path, startLine: 1, endLine: 1, what: 'the plan' }, run: () => this.cached({ plan: question, v: 2, root: root!.toString(), map, approach: picked.approach, code: digest(files) }, () => // v: bump when what a saved plan holds changes (2: code and tests)
				this.reader.json<Walkthrough>(b => buildPlanPrompt(map, question, picked.approach, files, b), d => repairPlan(d, lines, files))) }],
		};
		await this.runJobs(gen, question, `Change plan · ${name} · ${files.length} files`);
		void this.refreshSnippets();
	}

	/** Explain one part; later parts are told what the earlier ones covered. */
	private async explainPart(k: number): Promise<Walkthrough> {
		const s = this.session!;
		const w = await s.jobs[k].run(s.summaries.slice(0, k).filter(Boolean));
		if (this.session === s) s.summaries[k] = `${w.title}: ${w.summary}`;
		return w;
	}

	/** A later part's scenes. A failure becomes one scene saying so (with a retry) instead of ending the walkthrough. */
	private async partScenes(k: number): Promise<{ scenes: ViewScene[]; terms?: Walkthrough['terms'] } | undefined> {
		const where = this.session!.jobs[k].where;
		try {
			const w = await this.explainPart(k);
			return { scenes: w.scenes.map(s => viewScene(s, k)), terms: w.terms };
		} catch (err) {
			if (isCancel(err)) return undefined;
			const msg = err instanceof Error ? err.message : String(err);
			log.error(`part ${k + 1}: ${msg}`);
			return { scenes: [{ title: `Couldn't explain ${where.what}`, text: msg, file: where.file, startLine: where.startLine, endLine: where.endLine, part: k, failed: true }] };
		}
	}

	private async retryPart(k: number) {
		const w = this.state.w;
		if (!w || this.state.reading || !this.session?.jobs[k]) return;
		const at = w.scenes.findIndex(s => s.part === k);
		if (at < 0) return;
		const gen = this.gen;
		this.set({ reading: `part ${k + 1} again` });
		const scenes = (await this.partScenes(k))?.scenes;
		if (gen !== this.gen) return;
		if (scenes) {
			const count = w.scenes.filter(s => s.part === k).length;
			w.scenes.splice(at, count, ...scenes);
			this.state.extras.splice(at, count, ...scenes.map(() => []));
			if (this.state.i >= w.scenes.length) this.state.i = w.scenes.length - 1;
		}
		this.set({ reading: undefined });
		await this.showScene();
	}

	private stopReading() {
		this.reader.cancel();
		this.set({ reading: undefined, progress: undefined });
	}

	async go(i: number) {
		const w = this.state.w;
		if (this.state.status !== 'ready' || !w || i < 0 || i >= w.scenes.length || (i === this.state.i && !this.state.intro)) return;
		this.lm.cancel();
		this.set({ i, busy: false, code: undefined, intro: false });
		await this.showScene();
	}

	next() { return this.go(this.state.i + 1); }
	prev() { return this.go(this.state.i - 1); }

	/** The code a follow-up about a step should see: its part, or (folder walkthroughs) its whole file. */
	private async sceneCtx(s: Scene): Promise<CodeContext> {
		if (!s.file || !this.session?.files) return this.session!.parts[s.part ?? 0];
		const doc = await vscode.workspace.openTextDocument(this.sceneUri(s));
		return contextFor(doc, 0, doc.lineCount - 1, outlineOf(doc, await symbolsOf(doc)));
	}

	/** More help on the current step, at the reader's level: simpler, deeper, or line by line. */
	async more(mode: HelpMode = 'deeper') {
		const { w, i } = this.state;
		if (!this.session || !w || this.state.busy || w.scenes[i].failed) return;
		const part: Part = { text: '' };
		this.state.extras[i].push({ q: true, text: { simpler: 'Explain it more simply', deeper: 'Go deeper', lines: 'Walk me through it line by line' }[mode] }, part);
		const ctx = await this.sceneCtx(w.scenes[i]);
		await this.stream(b => buildMorePrompt(ctx, w.scenes[i], b, mode), t => { part.text += t; });
	}

	/** Note a finished walkthrough in Recent, so it can be reopened (from the cache, instantly). */
	private async remember(label: string, sub: string) {
		const s = this.session;
		if (!s) return;
		const kind: Recent['kind'] = s.review ? 'review' : s.plan ? 'plan' : s.files ? (s.jobs.length > 1 || s.switchable ? 'tour' : 'folder') : 'range';
		const r: Recent = { id: '', label, sub, kind, uri: s.uri.toString(), question: s.plan ?? s.review?.target.header, target: s.review?.target, t: Date.now() };
		if (kind === 'range') { r.start = s.range.start.line; r.end = s.range.end.line; }
		r.id = createHash('sha256').update(JSON.stringify([kind, r.uri, r.start, r.end, r.question])).digest('hex').slice(0, 16);
		const list = [r, ...this.store.get<Recent[]>(RECENT_KEY, []).filter(x => x.id !== r.id)].slice(0, 8);
		await this.store.update(RECENT_KEY, list);
	}

	/** "Reopen a recent walkthrough": pick one; the cache answers at once. */
	async pickRecent() {
		const list = this.store.get<Recent[]>(RECENT_KEY, []);
		if (!list.length) return vscode.window.showInformationMessage('coee: no walkthroughs yet. Right-click in a file and choose coee to start one.');
		const pick = await vscode.window.showQuickPick(list.map(r => ({ label: r.label, description: r.sub, id: r.id })), { placeHolder: 'Reopen a walkthrough' });
		if (pick) await this.reopen(pick.id);
	}

	private async reopen(id: string) {
		const r = this.store.get<Recent[]>(RECENT_KEY, []).find(x => x.id === id);
		if (!r) return;
		const uri = vscode.Uri.parse(r.uri);
		if (r.kind === 'review' && r.target) return this.review(undefined, undefined, r.target);
		if (r.kind === 'plan' && r.question) return this.plan(r.question, uri);
		if (r.kind === 'tour') return this.tour(uri);
		if (r.kind === 'folder') return this.explainFolder(uri);
		const doc = await vscode.workspace.openTextDocument(uri);
		const last = Math.min(r.end ?? doc.lineCount - 1, doc.lineCount - 1);
		return this.explainRange(doc, new vscode.Range(Math.min(r.start ?? 0, last), 0, last, 0));
	}

	// -------------------------------------------------------------------------
	// Questions: about the current step, or a chat about the selected lines

	async askEditor(editor: vscode.TextEditor) {
		const symbols = await symbolsOf(editor.document);
		const { first, last } = span(editor.document, targetRange(editor, symbols), ASK_LINES);
		const whole = contextFor(editor.document, first, last, outlineOf(editor.document, symbols));
		this.gen++;
		this.lm.cancel();
		this.reader.cancel();
		this.session = { uri: editor.document.uri, range: new vscode.Range(first, 0, last, 0), jobs: [], parts: [], summaries: [], whole };
		this.state = fresh({ status: 'answer', heading: 'Ask about this code', source: `${path.basename(editor.document.fileName)}:${first + 1}–${last + 1}`, focusAsk: Date.now() });
		this.flush();
		this.openPanel();
		this.panel?.reveal(this.panel.viewColumn, false); // take focus so the question box can be typed into
	}

	private async ask(question: string) {
		if (!question || !this.session || this.state.busy) return;
		const { status, w, i } = this.state;
		const list = status === 'answer' ? this.state.thread : status === 'ready' && w ? this.state.extras[i] : undefined;
		if (!list) return;
		const scene = status === 'ready' ? w!.scenes[i] : undefined;
		const ctx = scene ? await this.sceneCtx(scene) : this.session.whole;
		if (!ctx) return;
		const history = turns(list);
		const answer: Part = { text: '' };
		list.push({ q: true, text: question }, answer);
		await this.stream(b => buildAskPrompt(ctx, question, scene, history, b), t => { answer.text += t; });
	}

	private async stream(prompt: Prompt, onText: (t: string) => void) {
		this.set({ busy: true });
		try {
			await this.lm.ask(prompt, t => { onText(t); this.push(); });
		} catch (err) {
			if (!isCancel(err)) throw err;
		} finally {
			this.set({ busy: false });
		}
	}

	cancel() {
		this.lm.cancel();
		if (this.state.status === 'loading') this.reader.cancel();
	}

	close() {
		const p = this.panel;
		this.panel = undefined;
		p?.dispose();
		this.gen++;
		this.lm.cancel();
		this.reader.cancel();
		this.session = undefined;
		this.state = fresh();
		this.flush();
	}

	fail(err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(msg);
		if (this.state.status === 'loading') {
			this.set({ status: 'error', error: msg, busy: false, reading: undefined });
		} else {
			const list = this.state.status === 'answer' ? this.state.thread : this.state.extras[this.state.i];
			const last = list?.at(-1);
			if (last && !last.q && !last.text) last.text = `*${msg}*`;
			else vscode.window.showErrorMessage(`coee: ${msg}`);
			this.set({ busy: false });
		}
	}

	// -------------------------------------------------------------------------
	// Editor: highlighted lines + the explanation (and its diagram) inline under them

	/** Load the step's code into the walkthrough tab; with `openEditor` ("Open file"), also show it in a real editor. */
	private async showScene(openEditor = !this.panel) {
		if (!this.session) return;
		const s = this.state.w?.scenes[this.state.i];
		const lines = s ? [s.startLine - 1, s.endLine - 1] : this.state.status === 'answer' ? [this.session.range.start.line, this.session.range.end.line] : undefined;
		if (!lines) return;
		const uri = this.sceneUri(s);
		if (this.panel && s) {
			const i = this.state.i, code = await this.codeView(uri, s);
			if (this.state.i === i && this.state.w?.scenes[i] === s) this.set({ code });
		}
		if (!openEditor) return this.paintEditor();
		let editor = this.editorFor(uri);
		if (!editor) {
			const doc = await vscode.workspace.openTextDocument(uri);
			editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true, viewColumn: codeColumn() });
		}
		this.paintEditor();
		const last = editor.document.lineCount - 1;
		editor.revealRange(new vscode.Range(Math.min(lines[0], last), 0, Math.min(lines[1] + 6, last), 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	/** The step's lines with some context around them, and where they sit (path and enclosing symbols). */
	private async codeView(uri: vscode.Uri, s: Scene): Promise<CodeView | undefined> {
		const rf = s.file ? this.session?.review?.files.get(s.file) : undefined;
		if (rf?.text !== undefined) return reviewView(s, rf);
		let doc: vscode.TextDocument;
		try { doc = await vscode.workspace.openTextDocument(uri); } catch { return undefined; }
		const total = doc.lineCount;
		const a = Math.max(1, Math.min(s.startLine, total)), b = Math.max(a, Math.min(s.endLine, total));
		const first = Math.max(1, a - 12), last = Math.min(total, b + 8, first + 260); // ponytail: very long steps are cut at 260 lines
		const lines: string[] = [];
		for (let n = first; n <= last; n++) lines.push(doc.lineAt(n - 1).text);
		const rel = s.file ?? vscode.workspace.asRelativePath(uri, false);
		const chain: string[] = [];
		for (let list = await symbolsOf(doc), hit; (hit = list.find(x => x.range.contains(new vscode.Position(a - 1, 0))));) { chain.push(hit.name); list = hit.children; }
		return { file: rel, lang: doc.languageId, crumbs: [...rel.split('/'), ...chain.slice(0, 3)], first, lines, total };
	}

	private editorFor(uri: vscode.Uri) {
		return vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
	}

	/** Highlight the step's lines in any editor showing its file (the tab shows the explanation itself). */
	/** Where each of the plan's snippets stands in the files now: ready to add, already added, or with nowhere to go. */
	private async refreshSnippets() {
		const w = this.state.w, root = this.session?.uri;
		if (!w || !root || !this.session?.plan) return;
		const out: NonNullable<ViewState['snippets']> = {};
		for (const [k, s] of w.scenes.entries()) {
			for (const [n, sn] of (s.snippets ?? []).entries()) {
				const p = placeSnippet(await fileText(vscode.Uri.joinPath(root, sn.file)), sn);
				out[`${k}:${n}`] = p.status === 'error' ? { status: 'error', reason: p.reason } : { status: p.status };
			}
		}
		if (this.state.w === w) { this.state.snippets = out; this.push(); }
	}

	/** A plan's code: Copy puts it on the clipboard; Add goes through the shared preview, apply and check. */
	private async snippet(k: number, n: number, insert: boolean) {
		const sn = this.state.w?.scenes[k]?.snippets?.[n], root = this.session?.uri;
		if (!sn || !root) return;
		if (!insert) {
			await vscode.env.clipboard.writeText(sn.code);
			return void vscode.window.showInformationMessage(`coee: code for ${sn.file} copied.`);
		}
		await addCode(root, sn, "the plan's code");
		void this.refreshSnippets();
	}

	/** Told where the walkthrough is (file and line), so the architecture page can light up that part. */
	onStep?: (file: string, line: number) => void;
	private stepAt = '';

	private paintEditor() {
		const { w, i, status } = this.state;
		const s = w?.scenes[i];
		const at = status === 'ready' && s?.file ? `${s.file}:${s.startLine}` : '';
		if (at && at !== this.stepAt) this.onStep?.(s!.file!, s!.startLine);
		this.stepAt = at;
		const uri = this.session && this.sceneUri(s);
		for (const e of vscode.window.visibleTextEditors) if (e.document.uri.toString() !== uri?.toString()) e.setDecorations(this.highlight, []);
		const editor = uri && this.editorFor(uri);
		if (!editor || !this.session) return;
		if (status === 'answer') return editor.setDecorations(this.highlight, [this.session.range]);
		if (status !== 'ready' || !s) return editor.setDecorations(this.highlight, []);
		const last = editor.document.lineCount - 1;
		editor.setDecorations(this.highlight, [new vscode.Range(Math.min(s.startLine - 1, last), 0, Math.min(s.endLine - 1, last), 0)]);
	}
}

// ---------------------------------------------------------------------------

function viewScene(s: Scene, part: number): ViewScene {
	return { ...s, part };
}

/** Hash of file contents, for cache keys that change whenever the code does. */
export function digest(files: FolderFile[]) {
	const h = createHash('sha256');
	for (const f of files) h.update(f.path).update('\0').update(f.text).update('\0');
	return h.digest('hex');
}

const LANG_BY_EXT: Record<string, string> = { '.py': 'python', '.sh': 'shellscript', '.rb': 'ruby', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.pl': 'perl', '.r': 'r', '.ex': 'elixir', '.exs': 'elixir' };

/** A review step's code: the file as the change leaves it (not the working tree), with additions and removals marked. */
function reviewView(s: Scene, f: ReviewFile): CodeView {
	const all = f.text!.split('\n'), total = all.length;
	const a = Math.max(1, Math.min(s.startLine, total)), b = Math.max(a, Math.min(s.endLine, total));
	const first = Math.max(1, a - 12), last = Math.min(total, b + 8, first + 260);
	return {
		file: f.diff.path, lang: LANG_BY_EXT[path.extname(f.diff.path).toLowerCase()] ?? 'code', crumbs: f.diff.path.split('/'),
		first, lines: all.slice(first - 1, last), total,
		added: f.added.filter(n => n >= first && n <= last),
		removed: f.removed.filter(r => r.after >= first - 1 && r.after <= last),
	};
}

function escapeHtml(t: string) {
	return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Read files under `root` (relative paths) up to `budget` chars in all; big or unreadable files are skipped. */
export async function readFiles(root: vscode.Uri, paths: string[], budget: number) {
	const files: FolderFile[] = [];
	const lines: Record<string, number> = {};
	let used = 0;
	for (const p of paths) {
		if (used >= budget) break;
		const text = await read(vscode.Uri.joinPath(root, p));
		if (!text || text.length > 300_000) continue;
		files.push({ path: p, text });
		lines[p] = text.split('\n').length;
		used += text.length;
	}
	return { files, lines };
}

function uriMap(root: vscode.Uri, paths: string[]) {
	return new Map(paths.map(p => [p, vscode.Uri.joinPath(root, p)]));
}

/** What a project-wide explanation reads: entry points and manifests first, then each part's own files. */
export function projectFiles(all: string[], components: SystemMap['components']) {
	const overviewPaths = [...new Set([...all.filter(p => rank(p) < 3), ...components.flatMap(c => c.files.slice(0, 1).map(f => f.path))])].slice(0, 30);
	const wanted = [...new Set([...overviewPaths, ...components.flatMap(c => c.files.map(f => f.path))])];
	return { overviewPaths, wanted };
}

/** Folder walkthroughs see the files that say what the project is first, then likely entry points. */
function rank(p: string): number {
	const base = path.basename(p).toLowerCase();
	if (/^readme/.test(base)) return 0;
	if (MANIFEST.test(p)) return 1;
	if (/^(index|main|app|server|cli|__init__|mod|lib)\./.test(base)) return 2;
	return 3;
}

/** Question/answer pairs from a thread, for follow-up context. */
function turns(list: Part[]): Turn[] {
	const out: Turn[] = [];
	for (let k = 0; k + 1 < list.length; k++) if (list[k].q && !list[k + 1].q) out.push({ q: list[k].text, a: list[k + 1].text });
	return out;
}

export async function symbolsOf(doc: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
	try {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri) ?? [];
		return Array.isArray(symbols) && symbols[0] && 'children' in symbols[0] ? symbols : [];
	} catch {
		return []; // no symbol provider for this language
	}
}

function flatten(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
	return symbols.flatMap(s => [s, ...flatten(s.children)]);
}

/** Selection, else the innermost function/class around the cursor, else the whole file. */
function targetRange(editor: vscode.TextEditor, symbols: vscode.DocumentSymbol[]): vscode.Range {
	if (!editor.selection.isEmpty) return editor.selection;
	const kinds = [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class, vscode.SymbolKind.Constructor, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct];
	let found: vscode.DocumentSymbol | undefined;
	let list = symbols;
	for (let hit; (hit = list.find(s => s.range.contains(editor.selection.active)));) {
		if (kinds.includes(hit.kind)) found = hit;
		list = hit.children;
	}
	return found?.range ?? new vscode.Range(0, 0, editor.document.lineCount - 1, 0);
}

/** 0-based first/last line of a range, capped at `max` lines. */
function span(doc: vscode.TextDocument, range: vscode.Range, max: number) {
	// A selection ending at column 0 of the next line doesn't include that line.
	let last = range.end.line > range.start.line && range.end.character === 0 ? range.end.line - 1 : range.end.line;
	const first = range.start.line;
	last = Math.min(last, doc.lineCount - 1);
	if (last - first + 1 > max) {
		last = first + max - 1;
		vscode.window.showInformationMessage(`coee covers the first ${max} lines. Select a smaller part for the rest.`);
	}
	return { first, last };
}

function blankLines(doc: vscode.TextDocument, first: number, last: number): number[] {
	const out: number[] = [];
	for (let l = first; l <= last; l++) if (!doc.lineAt(l).text.trim()) out.push(l + 1 <= last ? l + 1 : l);
	return out;
}

/** Imports plus the symbol tree (two levels), so a part of a big file knows what it's surrounded by. */
function outlineOf(doc: vscode.TextDocument, symbols: vscode.DocumentSymbol[]): string {
	const imports: string[] = [];
	for (let l = 0; l < Math.min(doc.lineCount, 120) && imports.length < 25; l++) {
		const t = doc.lineAt(l).text;
		if (IMPORT.test(t)) imports.push(t.trim().slice(0, 160));
	}
	const skip = [vscode.SymbolKind.Variable, vscode.SymbolKind.Field, vscode.SymbolKind.Property, vscode.SymbolKind.EnumMember, vscode.SymbolKind.Key, vscode.SymbolKind.String];
	const lines: string[] = [];
	const walk = (list: vscode.DocumentSymbol[], depth: number) => {
		for (const s of list) {
			if (lines.length >= 80) return; // ponytail: fixed cap keeps the prompt small on huge files
			if (depth > 0 && skip.includes(s.kind)) continue;
			lines.push(`${'  '.repeat(depth)}${vscode.SymbolKind[s.kind].toLowerCase()} ${s.name} (lines ${s.range.start.line + 1}-${s.range.end.line + 1})`);
			if (depth < 1) walk(s.children, depth + 1);
		}
	};
	walk(symbols, 0);
	return [imports.length ? `Imports:\n${imports.join('\n')}` : '', lines.length ? `Symbols:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n');
}

function contextFor(doc: vscode.TextDocument, first: number, last: number, outline?: string, part?: CodeContext['part']): CodeContext {
	const code = doc.getText(new vscode.Range(first, 0, last, doc.lineAt(last).text.length));
	if (!code.trim()) throw new Error('There is no code there to explain. Select some code first.');
	return { file: vscode.workspace.asRelativePath(doc.uri), lang: doc.languageId, code, startLine: first + 1, outline: outline || undefined, part };
}

// ---------------------------------------------------------------------------
// Sidebar UI

export const CSS = /* css */ `
body { padding: 0; }
main { padding: 12px 14px 0; min-height: 100vh; display: flex; flex-direction: column; }
.head { display: grid; gap: 4px; margin-bottom: 14px; }
.head h2 { font-size: 1.12em; }
.source { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.stale { border-left: 2px solid var(--vscode-textLink-foreground); padding: 2px 0 2px 8px; margin-bottom: 12px; }

.lines { font-size: .86em; color: var(--muted); }
.eyebrow { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.kind { font-size: .74em; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
.tag { font-size: .74em; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--mark); }
.diagram { margin: 0; overflow-x: auto; padding: 10px; border: 1px solid var(--line); border-radius: 6px; display: grid; gap: 8px; }
.diagram svg { max-width: none; height: auto; display: block; margin: 0 auto; } /* natural size (≤640px), scrolls sideways; Open larger for the rest */
.diagram .pic { overflow-x: auto; }
.diagram .bar { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.diagram figcaption { font-size: .88em; text-align: center; }
.actions { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.thinking { display: flex; gap: 10px; align-items: center; }
.thinking .sweep { flex: 1; max-width: 120px; }

/* Questions and answers */
.thread { display: grid; gap: 12px; }
.bubble { justify-self: end; max-width: 90%; background: var(--hl); border-radius: 12px 12px 3px 12px; padding: 6px 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
.reply { display: grid; gap: 4px; }
.who { font-size: .78em; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.composer { display: flex; gap: 6px; align-items: flex-end; border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); border-radius: 8px; padding: 4px 4px 4px 10px; }
.composer:focus-within { border-color: var(--vscode-focusBorder); }
.composer textarea, .composer textarea:focus { border: 0; outline: none; background: none; padding: 4px 0; resize: none; min-height: 0; max-height: 9em; line-height: 1.45; }
.composer .btn { padding: 3px 12px; border-radius: 6px; flex: none; }
.hint { font-size: .88em; }
.suggest { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: inherit; font-size: .9em; border: 1px solid var(--line); border-radius: 12px; padding: 2px 10px; background: none; }
.chip:hover { background: var(--vscode-list-hoverBackground); }
.chip.mono { font-family: var(--mono); font-size: .86em; color: var(--muted); }

.askview { display: flex; flex-direction: column; gap: 14px; flex: 1; }
.askview .thread { flex: 1; align-content: start; }

main { padding: 20px 28px 0; }
main:has(.walk) { padding: 0; height: 100vh; }
.walk { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--vscode-editor-background); }
.pad { padding: 24px; }
.navrow { padding: 6px 12px; border-bottom: 1px solid var(--line); display: flex; }
.tabbar { display: flex; flex-wrap: wrap; align-items: stretch; border-bottom: 1px solid var(--line); background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background)); min-height: 34px; }
.ftabs { display: flex; overflow-x: auto; flex: 1; min-width: 0; scrollbar-width: none; }
.ftab { border: 0; background: none; color: var(--muted); padding: 0 14px; white-space: nowrap; border-right: 1px solid var(--line); font-size: .92em; }
.ftab.on { color: var(--vscode-foreground); background: var(--vscode-editor-background); box-shadow: inset 0 -2px 0 var(--vscode-textLink-foreground); }
.tabbar .tools { display: flex; align-items: center; gap: 2px; padding: 0 8px; }
.tool { border: 0; background: none; color: var(--vscode-foreground); padding: 3px 8px; border-radius: 4px; white-space: nowrap; font-size: .92em; }
.tool:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.crumbs { display: flex; gap: 6px; align-items: center; padding: 5px 16px; font-size: .9em; color: var(--muted); border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; }
.crumbs .sep { opacity: .6; }
.crumbs .grow { flex: 1; }
.wtitle { overflow: hidden; text-overflow: ellipsis; }
.codeview { flex: 1; overflow: auto; background: var(--vscode-editor-background); font: var(--vscode-editor-font-size, 13px)/1.6 var(--mono); padding: 8px 0 40px; }
.ln { display: flex; white-space: pre; min-width: max-content; }
.ln .no { width: 4.2em; flex: none; text-align: right; padding-right: 1.6em; color: var(--vscode-editorLineNumber-foreground, var(--muted)); user-select: none; }
.ln.hl { background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent); }
.ln.hl .no { color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-foreground)); }
.ln.add .no { box-shadow: inset -3px 0 0 var(--vscode-gitDecoration-addedResourceForeground, #3fb950); color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
.ln.add:not(.hl) { background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #3fb950) 10%, transparent); }
.ln.del { background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f85149) 13%, transparent); }
.ln.del .no { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); box-shadow: inset -3px 0 0 var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
.ln.del .src { opacity: .75; }
.fstat { margin-left: 8px; font-size: .85em; font-family: var(--mono); color: var(--muted); }
.commitmsg { display: grid; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.commitmsg pre { margin: 0; padding: 10px 12px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); font: .95em/1.5 var(--mono); white-space: pre-wrap; }
.fold { color: var(--muted); padding: 2px 0 2px 5.8em; font-size: .9em; }
.tk { color: #569cd6; } .ts { color: #6aab73; } .tn { color: #9cdcfe; } .tc { color: #7f848e; font-style: italic; } .tt { color: #4fc1ff; } .tf { color: #e6e6e6; }
body.vscode-light .tk { color: #0b5cad; } body.vscode-light .ts { color: #1a7f37; } body.vscode-light .tn { color: #0550ae; } body.vscode-light .tc { color: #6e7781; } body.vscode-light .tt { color: #0969da; } body.vscode-light .tf { color: #1f2328; }
.zone { font-family: var(--vscode-font-family); white-space: normal; margin: 10px 24px 14px 4.2em; padding: 18px 26px 22px; display: grid; gap: 12px; max-width: 1040px;
  background: color-mix(in srgb, var(--vscode-textLink-foreground) 7%, var(--vscode-editor-background)); border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 0 6px 6px 0; }
.zhead { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.zlabel { font-size: .78em; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.zpart { font-size: .78em; color: var(--muted); border-left: 2px solid var(--mark); padding-left: 6px; }
.zacts { display: flex; gap: 6px; flex-wrap: wrap; }
.zbtn { border: 1px solid var(--line); background: var(--vscode-editor-background); color: var(--vscode-foreground); border-radius: 4px; padding: 3px 10px; font-size: .92em; }
.zbtn:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
.ztitle { font-size: 1.45em; font-weight: 500; line-height: 1.3; }
.zsub { font-size: .76em; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-top: -6px; }
.zprose .md { font-size: 1.1em; line-height: 1.7; max-width: 72ch; }
.snips { display: grid; gap: 12px; max-width: 80ch; }
.snip { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.snhead { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 6px 10px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--line); font-size: .88em; }
.snfile { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.snmode { color: var(--muted); flex: 1; min-width: 8em; }
.snacts { display: flex; gap: 6px; }
.snacts .btn { padding: 2px 10px; }
.snacts { align-items: center; }
.snmode code { font-family: var(--mono); margin-left: 4px; }
.snstate { font-size: .9em; font-weight: 600; }
.snstate.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.snstate.bad { color: var(--vscode-editorWarning-foreground); }
.snip.done .sncode { opacity: .65; }
.snwhy { padding: 6px 10px; font-size: .9em; color: var(--vscode-editorWarning-foreground); border-bottom: 1px solid var(--line); }
.sncode { margin: 0; padding: 10px 12px; overflow: auto; max-height: 320px; font-family: var(--vscode-editor-font-family); font-size: .92em; line-height: 1.5; tab-size: 2; }
.zone .diagram { border: 0; background: transparent; padding: 6px 0 0; }
.zone .composer { max-width: 72ch; }
.navbar { display: flex; gap: 10px; align-items: center; justify-content: center; padding: 8px 16px; border-top: 1px solid var(--line); background: var(--vscode-editor-background); }
.navbar .btn { padding: 5px 18px; }
.navbar .nextbtn { min-width: 220px; }
.navbar .count { font-variant-numeric: tabular-nums; min-width: 3.5em; }

.planbox { display: grid; gap: 8px; }
.pinput { width: 100%; resize: none; min-height: 0; padding: 8px 10px; line-height: 1.45; border-radius: 6px; border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); }
.pinput:focus { outline: none; border-color: var(--vscode-focusBorder); }
.plabel { font-weight: 600; font-size: .95em; }
.covers { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; line-height: 1.5; }
.covers li { padding-left: 14px; border-left: 2px solid var(--line); }
.planrow { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.askview .dock { position: sticky; bottom: 0; padding: 8px 0 12px; background: var(--vscode-editor-background); }
.small { font-size: .88em; }

/* Words explained in place */
.term { text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-color: var(--vscode-textLink-foreground); cursor: help; position: relative; }
.term:hover::after, .term:focus::after { content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); z-index: 5; width: max-content; max-width: 280px;
  padding: 8px 10px; border-radius: 6px; font-size: .88rem; line-height: 1.45; font-weight: 400; font-style: normal; white-space: normal;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--line)); box-shadow: 0 4px 14px rgba(0,0,0,.3); }


/* Intro and finish */
.introwrap { flex: 1; overflow: auto; padding: 36px 40px 48px; }
.intro { max-width: 760px; margin: 0 auto; display: grid; gap: 18px; }
.intro h1 { font-size: 1.9em; font-weight: 600; line-height: 1.25; }
.intro .lede { font-size: 1.15em; line-height: 1.6; }
.intro h3 { font-size: .78em; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; }
.learn { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.learn li::before { content: '✓  '; color: var(--vscode-textLink-foreground); font-weight: 600; }
.terms { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.terms dt { font-weight: 600; }
.terms dd { margin: 0; }
.outline { margin: 0; padding-left: 22px; display: grid; gap: 6px; }
.outline .link { text-align: left; }
.btn.big { padding: 7px 26px; font-size: 1.05em; }
.progress { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-left: 2px solid var(--mark); border-radius: 4px; }
.pbar { height: 4px; border-radius: 2px; background: var(--hl); overflow: hidden; }
.pbar > i { display: block; height: 100%; background: var(--mark); border-radius: 2px; transition: width .4s ease; }
.outline .pending { color: var(--muted); }
.outline .pending .now { color: var(--mark); }
.navbar .pbar { position: absolute; left: 0; right: 0; top: -1px; height: 2px; border-radius: 0; }
.navbar { position: relative; }
.navbar .nextbtn.wait { display: inline-flex; gap: 8px; align-items: center; justify-content: center; }
.navbar .nextbtn.wait .sweep { width: 40px; height: 3px; }
@media (prefers-reduced-motion: reduce) { .pbar > i { transition: none; } }
.finish { display: grid; gap: 8px; margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--line); }
.finish h3 { font-size: 1.1em; }
.finish ol { margin: 0; padding-left: 22px; display: grid; gap: 4px; }
main .head h2 { font-size: 1.3em; }

.loading { display: grid; gap: 12px; }
kbd { font-family: var(--mono); font-size: .9em; padding: 0 4px; border: 1px solid var(--line); border-radius: 3px; }
`;

// String.raw so regexes and escapes below reach the webview as written.
export const SCRIPT = String.raw`
const root = document.getElementById('root');
// Every walkthrough screen starts with the switcher between coee's pages.
const navRow = () => el('div', { className: 'navrow' }, coeeNav(st.status === 'planning' || st.isPlan ? 'plan' : st.review ? 'changes' : 'walkthrough'));
const show = (...kids) => root.replaceChildren(navRow(), ...kids.filter(k => k != null && k !== false));
let st = null, draft = '', seenFocus = 0;
const send = (type, extra) => vscode.postMessage({ type, ...extra });

function thinking() {
  return el('div', { className: 'thinking muted' }, el('div', { className: 'sweep', 'aria-hidden': 'true' }), 'Thinking',
    el('button', { className: 'link', onclick: () => send('cancel') }, 'Stop'));
}

function header() {
  return el('div', { className: 'head' },
    st.w ? el('h2', {}, st.w.title) : el('h2', {}, st.heading),
    st.w && st.w.summary ? el('p', {}, st.w.summary) : null,
    el('div', { className: 'source muted' },
      el('button', { className: 'chip mono', title: 'Show these lines', onclick: () => send('reveal') }, st.source),
      st.status === 'ready' ? el('button', { className: 'link', onclick: () => send('reexplain') }, 'Re-explain') : null,
      st.switchable ? el('button', { className: 'link', onclick: () => send('switch') }, 'Other codebase…') : null,
      el('button', { className: 'link', onclick: () => send('close') }, 'Close')));
}

/** The extension draws the SVG (escaped, no scripts), so it can go straight in. */
function diagram(s) {
  if (!s.svg) return null;
  const pic = el('div', { className: 'pic' });
  pic.innerHTML = s.svg;
  // Fit the width when the text stays readable; past that keep a readable size and scroll (Open larger shows it whole).
  requestAnimationFrame(() => {
    const svg = pic.querySelector('svg'), natural = svg && svg.width.baseVal.value, room = pic.clientWidth;
    if (!svg || !natural || natural <= room) return;
    svg.style.width = (room / natural >= 0.45 ? room : Math.round(natural * 0.45)) + 'px';
  });
  const d = s.diagram || {};
  return el('figure', { className: 'diagram' }, pic,
    el('figcaption', { className: 'bar muted' },
      el('span', {}, d.illustrative ? el('span', { className: 'chip mono' }, 'Illustrative model') : null, d.caption ? ' ' + d.caption : null),
      el('button', { className: 'link', onclick: () => send('bigDiagram') }, 'Open larger')));
  return box;
}

function composer(placeholder, type = 'ask') {
  const ta = el('textarea', { id: 'ask', rows: 1, placeholder, value: draft, 'aria-label': placeholder });
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  const submit = () => {
    if (st.busy) return send('cancel');
    const text = ta.value.trim();
    if (!text) return;
    draft = '';
    send(type, { text });
  };
  ta.addEventListener('input', () => { draft = ta.value; fit(); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) submit(); } });
  requestAnimationFrame(fit);
  return el('form', { className: 'composer', onsubmit: e => { e.preventDefault(); submit(); } }, ta,
    el('button', { className: 'btn' + (st.busy ? ' quiet' : ''), type: 'submit', 'aria-label': st.busy ? 'Stop answering' : 'Send question' }, st.busy ? 'Stop' : type === 'plan' ? 'Explain' : 'Ask'));
}

function thread(parts) {
  const items = parts.map((p, k) => p.q
    ? el('div', { className: 'bubble' }, p.text)
    : (p.text ? el('div', { className: 'reply' }, el('span', { className: 'who' }, 'coee'), withTerms(md(p.text))) : null));
  const waiting = st.busy && parts.length && !parts[parts.length - 1].q && !parts[parts.length - 1].text;
  return items.some(Boolean) || waiting ? el('div', { className: 'thread' }, ...items, waiting ? thinking() : null) : null;
}

// ---- Editor tab: the code itself, with the explanation under the step's lines

const KW = new Set('abstract and as assert async await break case catch class const continue def default defer del delete do elif else enum except export extends false final finally fn for from func function go if impl import in instanceof interface is lambda let match mod module mut new nil none None not null of or package pass private protected pub public raise readonly return self static struct super switch this throw throws true True false False try type typeof undefined use var void where while with yield'.split(' '));
const HASH = /^(python|shellscript|ruby|perl|r|yaml|toml|dockerfile|makefile|elixir|coffeescript|powershell)$/;
/** One line, lightly coloured: comments, strings, numbers, keywords, types, calls. ponytail: per-line regex, so multi-line strings and block comments are only coloured on their first line */
function hl(line, lang) {
  const re = HASH.test(lang)
    ? /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\w.]*\b)|([A-Za-z_][\w]*)/g
    : /(\/\/.*$|\/\*.*?(?:\*\/|$)|^\s*\*.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\x60(?:[^\x60\\]|\\.)*\x60?)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    const t = esc(m[0]);
    out += m[1] ? '<span class="tc">' + t + '</span>' : m[2] ? '<span class="ts">' + t + '</span>' : m[3] ? '<span class="tn">' + t + '</span>'
      : KW.has(m[0]) ? '<span class="tk">' + t + '</span>' : /^[A-Z]/.test(m[0]) ? '<span class="tt">' + t + '</span>'
      : line[re.lastIndex] === '(' ? '<span class="tf">' + t + '</span>' : t;
    last = re.lastIndex;
  }
  return out + esc(line.slice(last));
}

let askOpen = -1, codeKey = '';
const base = p => p.split('/').pop();

function zone(s, k) {
  const extras = st.extras[k] || [];
  const kind = s.diagram ? (s.diagram.kind || 'flow') + ' diagram' : '';
  if (s.failed) return el('section', { className: 'zone' }, el('h2', { className: 'ztitle' }, s.title), el('p', { className: 'error' }, s.text),
    el('div', {}, el('button', { className: 'btn quiet', disabled: !!st.reading, onclick: () => send('retryPart', { part: s.part }) }, 'Try this part again')));
  return el('section', { className: 'zone', 'aria-live': 'polite' },
    el('div', { className: 'zhead' },
      el('div', { className: 'eyebrow' }, el('span', { className: 'zlabel' }, s.label || 'Step ' + (k + 1)),
        st.parts ? el('span', { className: 'zpart' }, st.parts[s.part || 0]) : null),
      helpButtons(k)),
    el('h2', { className: 'ztitle' }, s.title),
    el('div', { className: 'zsub' }, 'lines ' + s.startLine + '–' + s.endLine + (kind ? ' · ' + kind : '')),
    el('div', { className: 'zprose' }, withTerms(md(s.text))),
    diagram(s),
    snippets(s, k),
    thread(extras),
    st.busy && !extras.length ? thinking() : null,
    askOpen === k || extras.length ? composer('Ask about this step') : null,
    finish());
}

/** Code a plan proposes, with where it stands: Add (previewed first), Added, or Copy only when its place can't be found. */
function snippets(s, k) {
  if (!s.snippets || !s.snippets.length) return null;
  const first = t => (t || '').split('\n').find(l => l.trim()) || '';
  const how = x => x.mode === 'new' ? 'new file' : x.mode === 'replace' ? 'replaces ' : x.after ? 'goes after ' : 'at the top';
  const anchor = x => x.mode === 'replace' ? first(x.find) : x.mode === 'insert' ? first(x.after) : '';
  return el('div', { className: 'snips' }, ...s.snippets.map((x, n) => {
    const pre = el('pre', { className: 'sncode' });
    pre.innerHTML = x.code.split('\n').map(l => hl(l, x.lang || '')).join('\n');
    const at = (st.snippets || {})[k + ':' + n] || { status: 'ready' };
    const state = at.status === 'added' ? el('span', { className: 'snstate ok', title: 'This code is in the file' }, '✓ Added')
      : at.status === 'error' ? el('span', { className: 'snstate bad', title: at.reason }, "Can't place") : null;
    return el('div', { className: 'snip' + (at.status === 'added' ? ' done' : '') },
      el('div', { className: 'snhead' }, el('span', { className: 'snfile' }, x.file),
        el('span', { className: 'snmode' }, how(x), anchor(x) ? el('code', {}, anchor(x).trim().slice(0, 60)) : null),
        el('span', { className: 'snacts' }, state,
          el('button', { className: 'btn quiet', onclick: () => send('snippet', { i: k, n, act: 'copy' }) }, 'Copy'),
          at.status === 'ready' ? el('button', { className: 'btn', title: 'Shows the file before and after first; Undo takes it back', onclick: () => send('snippet', { i: k, n, act: 'insert' }) }, 'Add…') : null)),
      at.status === 'error' ? el('p', { className: 'snwhy' }, at.reason + ' Copy it and place it yourself.') : null,
      pre);
  }));
}

function tabbar(tabs) {
  const link = (label, type, title) => el('button', { className: 'tool', title, onclick: () => send(type) }, label);
  return el('div', { className: 'tabbar' }, tabs || el('div', { className: 'ftabs' }, el('span', { className: 'ftab on' }, 'Overview')),
    el('div', { className: 'tools' },
      tabs ? link('Overview', 'intro', 'What this walkthrough covers') : null,
      st.review ? link('Open diff', 'reveal', "Show this file's change in VS Code's diff view") : link('Open file', 'reveal', 'Show these lines in the real editor'),
      st.switchable ? link('Other codebase…', 'switch') : null,
      link('Re-explain', 'reexplain', 'Explain it again from scratch'),
      link('✕', 'close', 'Close the walkthrough')));
}

function codeWalk() {
  const w = st.w, s = w.scenes[st.i], c = st.code, n = w.scenes.length;
  const fileOf = x => x.file || c.file;
  const files = [...new Set(w.scenes.map(fileOf))];
  const tabs = el('div', { className: 'ftabs', role: 'tablist' }, ...files.map(f => el('button', {
    className: 'ftab' + (f === fileOf(s) ? ' on' : ''), role: 'tab', title: f, 'aria-selected': f === fileOf(s) ? 'true' : 'false',
    onclick: () => send('go', { i: w.scenes.findIndex(x => fileOf(x) === f) }) }, base(f),
    st.review && st.review.stats[f] ? el('span', { className: 'fstat' }, st.review.stats[f]) : null)));
  const bar = tabbar(tabs);
  const crumbs = el('div', { className: 'crumbs' }, ...c.crumbs.flatMap((p, i) => [i ? el('span', { className: 'sep' }, '›') : null, el('span', {}, p)]),
    el('span', { className: 'grow' }), el('span', { className: 'muted wtitle', title: w.summary || '' }, w.title));
  const a = Math.max(s.startLine, c.first), b = Math.min(s.endLine, c.first + c.lines.length - 1);
  const rows = [], added = new Set(c.added || []);
  // Removed lines (reviews) show where they used to be: red, with no line number.
  const gone = after => (c.removed || []).filter(r => r.after === after).forEach(r => r.lines.forEach(t => {
    const row = el('div', { className: 'ln del' }, el('span', { className: 'no' }, '−'));
    const code = el('span', { className: 'src' });
    code.innerHTML = hl(t, c.lang) || ' '; // escaped by hl()
    row.append(code);
    rows.push(row);
  }));
  if (c.first > 1) rows.push(el('div', { className: 'fold' }, '⋯ ' + (c.first - 1) + ' lines above'));
  gone(c.first - 1);
  c.lines.forEach((text, j) => {
    const no = c.first + j, on = no >= a && no <= b;
    const row = el('div', { className: 'ln' + (on ? ' hl' : '') + (on && no === a ? ' top' : '') + (added.has(no) ? ' add' : ''), 'data-no': no }, el('span', { className: 'no' }, String(no)));
    const code = el('span', { className: 'src' });
    code.innerHTML = hl(text, c.lang) || ' '; // escaped by hl()
    row.append(code);
    rows.push(row);
    if (no !== b) gone(no);
    if (no === b) { rows.push(zone(s, st.i)); gone(no); }
  });
  const below = c.total - (c.first + c.lines.length - 1);
  if (below > 0) rows.push(el('div', { className: 'fold' }, '⋯ ' + below + ' lines below'));
  const view = el('div', { className: 'codeview', id: 'codeview' }, ...rows);
  const waiting = st.reading && st.progress && st.i === n - 1;
  const nav = el('div', { className: 'navbar' },
    st.reading && st.progress ? pbar() : null,
    el('button', { className: 'btn quiet', disabled: st.i === 0, onclick: () => send('go', { i: st.i - 1 }) }, '← Previous'),
    waiting
      ? el('button', { className: 'btn nextbtn wait', disabled: true }, el('span', { className: 'sweep', 'aria-hidden': 'true' }), 'Writing the next steps…')
      : el('button', { className: 'btn nextbtn', disabled: st.i === n - 1, onclick: () => send('go', { i: st.i + 1 }) }, 'Next →'),
    el('span', { className: 'count muted' }, (st.i + 1) + ' / ' + n + (st.reading ? '+' : '')),
    st.reading ? el('span', { className: 'muted small' }, 'reading ' + st.reading + '… ', el('button', { className: 'link', onclick: () => send('stopReading') }, 'Stop')) : null);
  return el('div', { className: 'walk' }, bar, crumbs, view, nav);
}


/** Plan a change: one labelled field, the analysis it produces, and one clear action. */
function planBox() {
  const ta = el('textarea', { id: 'ask', className: 'pinput', rows: 3, placeholder: 'Example: Add GitHub sign-in to the web app', value: draft, 'aria-labelledby': 'plan-label' });
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, 76) + 'px'; };
  const submit = () => { const text = ta.value.trim(); if (!text) return ta.focus(); draft = ''; send('plan', { text }); };
  ta.addEventListener('input', () => { draft = ta.value; fit(); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  requestAnimationFrame(fit);
  return el('form', { className: 'planbox', onsubmit: e => { e.preventDefault(); submit(); } },
    el('label', { id: 'plan-label', className: 'plabel' }, 'Proposed change'), ta,
    el('div', { className: 'planrow' }, el('span', { className: 'muted small' }, 'Enter to analyze · Shift+Enter for a new line'),
      el('div', { className: 'actions' }, el('button', { className: 'btn quiet', type: 'button', onclick: () => send('close') }, 'Cancel'),
        el('button', { className: 'btn', type: 'submit' }, 'Analyze change'))));
}

function planScreen() {
  const item = (title, text) => el('li', {}, el('strong', {}, title), el('span', { className: 'muted' }, ' — ' + text));
  return el('div', { className: 'walk' }, el('div', { className: 'introwrap' }, el('div', { className: 'intro' },
    el('span', { className: 'zlabel' }, 'Change planning'),
    el('h1', {}, 'Plan a change'),
    el('p', { className: 'lede' }, 'Describe a feature or technology you want to introduce. coee analyzes this codebase and explains how the change would integrate, step by step, against the real code. No code is written or modified.'),
    planBox(),
    el('section', {}, el('h3', {}, 'What the analysis covers'),
      el('ul', { className: 'covers' },
        item('Integration points', 'where the change connects to existing code, and why there'),
        item('Proposed flow', 'how requests and data would move once it exists'),
        item('Affected components', 'what each part would need to do differently'),
        item('Risks and implementation order', 'what could go wrong, and a safe sequence of work'))))));
}

// ---- Learning aids: words explained in place, the intro and the finish

/** Underline the first use of each term in an explanation; hover or focus shows its meaning. */
function withTerms(node) {
  const terms = (st.w && st.w.terms) || [];
  if (!terms.length) return node;
  const seen = new Set();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: t => t.parentElement.closest('code, pre, .term') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const t of texts) {
    for (const term of terms) {
      if (seen.has(term.name)) continue;
      const m = new RegExp('\\b' + term.name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '\\b', 'i').exec(t.data);
      if (!m) continue;
      seen.add(term.name);
      const after = t.splitText(m.index), rest = after.splitText(m[0].length);
      const span = el('span', { className: 'term', tabindex: '0', 'data-tip': term.meaning, 'aria-label': m[0] + ': ' + term.meaning }, m[0]);
      after.replaceWith(span);
      texts.push(rest); // keep looking for other terms in what follows
      break;
    }
  }
  return node;
}

/** How much of a multi-part walkthrough is ready, as a fraction bar. */
function pbar() {
  const p = st.progress;
  const i = el('i');
  i.style.width = (p ? Math.round(100 * p.done / p.total) : 100) + '%';
  return el('div', { className: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': p ? String(p.total) : '1', 'aria-valuenow': p ? String(p.done) : '1', 'aria-label': 'Parts read' }, i);
}

/** The parts not read yet, as greyed outline rows after the steps that are ready. */
function pendingRows() {
  const p = st.progress;
  if (!st.reading || !p) return [];
  const names = (st.parts || []).slice(p.done);
  const rows = names.length ? names : ['More steps'];
  return rows.map((name, j) => el('li', { className: 'pending' }, name, ' ',
    el('span', { className: j === 0 ? 'now small' : 'small' }, j === 0 ? '· being written…' : '· waiting')));
}

function minutes(w) {
  const words = w.scenes.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  return Math.max(1, Math.round(words / 160 + w.scenes.length * 0.3));
}

function intro() {
  const w = st.w, files = [...new Set(w.scenes.map(x => x.file).filter(Boolean))];
  const loading = !!(st.reading && st.progress);
  return el('div', { className: 'intro' },
    el('span', { className: 'zlabel' }, 'Walkthrough · ' + st.source),
    el('h1', {}, w.title),
    w.summary ? el('p', { className: 'lede' }, w.summary) : null,
    st.review && st.review.note ? el('p', { className: 'stale' }, st.review.note) : null,
    el('p', { className: 'meta muted' }, w.scenes.length + ' steps' + (st.reading ? ' so far' : '') + ' · about ' + minutes(w) + ' min' + (files.length > 1 ? ' · ' + files.length + ' files' : '')),
    w.learn && w.learn.length ? el('section', {}, el('h3', {}, "You'll understand"), el('ul', { className: 'learn' }, ...w.learn.map(x => el('li', {}, x)))) : null,
    w.terms && w.terms.length ? el('section', {}, el('h3', {}, "Words you'll meet"),
      el('dl', { className: 'terms' }, ...w.terms.flatMap(t => [el('dt', {}, t.name), el('dd', { className: 'muted' }, t.meaning)]))) : null,
    loading ? el('div', { className: 'progress', role: 'status' }, pbar(),
      el('span', {}, 'Read ' + st.progress.done + ' of ' + st.progress.total + ' parts. ' + w.scenes.length + ' steps are ready; the rest are still being written.')) : null,
    el('section', {}, el('h3', {}, 'The steps'), el('ol', { className: 'outline' }, ...w.scenes.map((x, k) => el('li', {},
      el('button', { className: 'link', onclick: () => send('go', { i: k }) }, x.title), x.label ? el('span', { className: 'muted small' }, '  ' + x.label) : null)), ...pendingRows())),
    loading
      ? el('div', { className: 'actions' },
          el('button', { className: 'btn big', disabled: true, 'aria-label': 'Start: waiting for all steps' }, 'Preparing steps…'),
          el('button', { className: 'link small', onclick: () => send('startNow') }, 'Stop reading and start with the ' + w.scenes.length + ' ready steps'))
      : el('div', { className: 'actions' }, el('button', { className: 'btn big', onclick: () => send('start') }, 'Start →'),
          el('span', { className: 'muted small' }, 'Use ← and → to move between steps. Dotted words explain themselves.')));
}

/** After the last step: what it all adds up to, and where to go next. */
function finish() {
  if (st.reading || st.i !== st.w.scenes.length - 1) return null;
  const msg = st.w.commitMessage;
  return el('section', { className: 'finish' },
    msg ? el('div', { className: 'commitmsg' }, el('span', { className: 'zlabel' }, 'Suggested commit message'),
      el('pre', {}, msg),
      el('div', { className: 'actions' }, el('button', { className: 'btn', onclick: () => send('useMessage') }, 'Use as commit message'),
        el('span', { className: 'muted small' }, 'Puts it in the Source Control box. Nothing is committed.'))) : null,
    el('span', { className: 'zlabel' }, 'Done'),
    el('h3', {}, 'What you just learned'),
    el('ol', {}, ...st.w.scenes.filter(x => !x.failed).map(x => el('li', {}, x.title))),
    el('div', { className: 'actions' },
      el('button', { className: 'zbtn', onclick: () => { askOpen = st.i; render(); document.getElementById('ask')?.focus(); } }, 'Ask about any of it'),
      el('button', { className: 'zbtn', onclick: () => send('openPlan') }, 'Plan a change'),
      el('button', { className: 'zbtn', onclick: () => send('close') }, 'Explain something else')));
}

function helpButtons(k) {
  const b = (label, mode, title) => el('button', { className: 'zbtn', title, disabled: st.busy, onclick: () => send('more', { mode }) }, label);
  return el('div', { className: 'zacts' },
    b('Simpler', 'simpler', 'Explain it again with an analogy and no jargon'),
    b('Deeper', 'deeper', 'Why it is written this way, alternatives, what would break'),
    b('Line by line', 'lines', 'Go through these lines one small group at a time'),
    el('button', { className: 'zbtn', onclick: () => { askOpen = k; render(); document.getElementById('ask')?.focus(); } }, 'Ask'));
}

function askView() {
  const empty = !st.thread.length;
  const suggest = q => el('button', { className: 'chip', onclick: () => send('ask', { text: q }) }, q);
  return el('section', { className: 'askview' }, header(),
    empty ? el('div', { className: 'loading' },
      el('p', { className: 'muted hint' }, 'Ask anything about the highlighted lines. Follow-up questions keep the conversation going.'),
      el('div', { className: 'suggest' }, suggest('What does this do?'), suggest('Why is it written this way?'), suggest('What could go wrong here?'))) : thread(st.thread),
    el('div', { className: 'dock' }, composer(empty ? 'Ask about this code' : 'Ask a follow-up')));
}

function render() {
  if (!st) return;
  if (st.status === 'planning') { show(planScreen()); return; }
  if (st.status === 'empty') { show(); return; }
  if (st.status === 'loading') {
    show(el('section', { className: 'loading' }, header(), el('div', { className: 'sweep', 'aria-hidden': 'true' }),
      el('p', { className: 'muted' }, st.reading ? 'Reading ' + st.reading + '. The rest follows while you read.' : 'Working out what to explain first.'),
      el('div', {}, el('button', { className: 'btn quiet', onclick: () => send('cancel') }, 'Stop'))));
    return;
  }
  if (st.status === 'error') {
    show(el('section', { className: 'loading' }, header(),
      el('p', { className: 'error', role: 'alert' }, st.error),
      el('div', {}, el('button', { className: 'btn', onclick: () => send('reexplain') }, 'Try again'))));
    return;
  }
  if (st.status === 'answer') { show(askView()); return; }
  if (st.intro) {
    show(el('div', { className: 'walk' }, tabbar(), el('div', { className: 'introwrap' }, intro())));
    codeKey = '';
    return;
  }
  {
    const key = st.i + '|' + (st.code ? st.code.file + st.code.first : '');
    if (key !== codeKey && askOpen !== st.i) askOpen = -1;
    if (!st.code) { show(el('div', { className: 'walk' }, el('div', { className: 'loading pad' }, el('div', { className: 'sweep', 'aria-hidden': 'true' })))); return; }
    const prev = document.getElementById('codeview'), keep = prev && key === codeKey ? prev.scrollTop : null;
    show(codeWalk());
    const view = document.getElementById('codeview');
    if (keep !== null) view.scrollTop = keep;
    else { // frame it: the step's first lines in view and its explanation around the middle
      const z = view.querySelector('.zone');
      if (z) view.scrollTop = Math.max(0, z.offsetTop - view.clientHeight * 0.45);
    }
    codeKey = key;
  }
}

window.addEventListener('message', ({ data: m }) => {
  if (m.type !== 'state') return;
  const a = document.activeElement;
  const focusedLabel = a && a.id !== 'ask' && a.getAttribute('aria-label');
  const caret = a && a.id === 'ask' ? [a.selectionStart, a.selectionEnd] : null;
  if (m.state.status !== (st && st.status) || (st && m.state.i !== st.i)) draft = '';
  if (m.state.planDraft && m.state.focusAsk > seenFocus) draft = m.state.planDraft;
  st = m.state; render();
  const ask = document.getElementById('ask');
  if (ask && (caret || st.focusAsk > seenFocus)) { ask.focus(); if (caret) ask.setSelectionRange(caret[0], caret[1]); }
  else if (focusedLabel) document.querySelector('[aria-label="' + focusedLabel + '"]')?.focus();
  seenFocus = st.focusAsk;
});
document.addEventListener('keydown', e => {
  if (!st || st.status !== 'ready' || e.target.closest('input, textarea')) return;
  if (st.intro && (e.key === 'Enter' || e.key === 'ArrowRight')) { e.preventDefault(); return st.reading && st.progress ? null : send('start'); }
  if (e.key === 'ArrowRight') { e.preventDefault(); send('go', { i: st.i + 1 }); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); send('go', { i: st.i - 1 }); }
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); send('go', { i: st.i + 1 }); }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); send('go', { i: st.i - 1 }); }
  if (e.key === 'Escape' && st.busy) send('cancel');
});
send('ready');
`;
