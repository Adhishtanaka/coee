import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import {
	ArchDoc, Behavior, DataModel, Diagram, FolderFile, SystemMap, buildArchitecturePrompt, buildBehaviorPrompt, buildDataModelPrompt, mapDiagram,
	repairArchitecture, repairBehavior, repairDataModel, snapRefs,
} from './prompt';
import { diagramSvg, erSvg } from './layout';
import { Lm, isCancel, log } from './lm';
import { MapController, SOURCE, pickProject, read, sourceFiles } from './map';
import { BIG, Subsystem, detectSubsystems } from './subsystems';
import { TOUR_CHARS, digest, projectFiles, readFiles } from './walkthrough';
import { createPanel, page, showLines } from './ui';

const CACHE_KEY = 'coee.architecture';
const CACHE_SIZE = 15;
const VERSION = 2; // bump when what a saved page holds changes (2: code ranges are checked against the file)

/** What the page shows. Diagrams arrive as SVG drawn here, in the current theme. */
interface PageState {
	root?: string;
	map?: SystemMap;
	archSvg?: string;
	doc?: ArchDoc;
	behavior?: Behavior & { svgs: { useCases: string[]; states: string[] } };
	data?: DataModel & { svg: string };
	reading?: string;
	error?: string;
	behaviorNote?: string;
	/** Big repositories: the packages this one is made of (the page starts here; each opens as its own architecture). */
	subsystems?: Subsystem[];
	/** Where this page sits: system › package. */
	crumbs?: Array<{ name: string; path: string }>;
	/** How much code the page read. */
	coverage?: { read: number; total: number };
	answer?: { q: string; text?: string; refs: Array<{ path: string; line: number; text: string }>; busy?: boolean; error?: string };
}

/**
 * The architecture page: how the whole project works, in one place. Every part and how they connect,
 * each use case with its sequence diagram, the lifecycles as state diagrams, and the data model as an ER diagram.
 * It is coee's hub: walkthroughs start from it and light it up as they go, and big repositories start at their packages.
 */
export class ArchitectureController implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private root?: vscode.Uri;
	private state: PageState = {};
	private gen = 0;
	private readonly lm = new Lm('coee describes how your project works.');
	private readonly askLm = new Lm('coee answers where something is handled.');
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly ext: vscode.ExtensionContext, private readonly maps: MapController) {
		this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => this.redraw()));
	}

	dispose() {
		this.lm.cancel();
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	/** Open (or bring back) the page; `focus` scrolls to one component. */
	async open(root?: vscode.Uri, fresh = false, focus?: string) {
		root ??= await pickProject('Describe which codebase?');
		if (!root) return;
		const same = this.panel && this.root?.toString() === root.toString() && this.state.map && !this.state.error;
		this.root = root;
		if (!this.panel) {
			const panel = this.panel = createPanel('coee.architecture', 'Architecture', { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
			panel.iconPath = vscode.Uri.joinPath(this.ext.extensionUri, 'media', 'icon.png');
			panel.webview.html = page(panel.webview, { css: CSS, body: '<main id="root"></main>', script: SCRIPT });
			panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => this.show({ error: err instanceof Error ? err.message : String(err), reading: undefined })));
			panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.lm.cancel(); this.gen++; this.state = {}; } });
		}
		this.panel.title = `Architecture · ${path.basename(root.path)}`;
		this.panel.reveal(this.panel.viewColumn, true);
		if (focus) this.panel.webview.postMessage({ type: 'focus', id: focus });
		if (same && !fresh) return; // already showing this project: just come back to it
		await this.generate(root, fresh);
	}

	/** Forget saved pages. Returns how many went. */
	async clearCache() {
		const n = Object.keys(this.ext.workspaceState.get(CACHE_KEY, {})).length;
		await this.ext.workspaceState.update(CACHE_KEY, undefined);
		return n;
	}

	/** A walkthrough moved to `file:line`: light up the use case or component that code belongs to, without taking focus. */
	follow(file: string, line: number) {
		const { map, doc, behavior } = this.state;
		if (!this.panel || !map) return;
		const covers = (r: { path: string; startLine?: number; endLine?: number }) => r.path === file && (!r.startLine || (line >= r.startLine && line <= (r.endLine ?? r.startLine)));
		const k = behavior?.useCases.findIndex(u => u.files.some(covers)) ?? -1;
		const c = map.components.find(x => doc?.components.find(d => d.id === x.id)?.keyFiles.some(covers) || x.files.some(covers))
			?? map.components.find(x => x.files.some(f => f.path === file));
		this.panel.webview.postMessage({ type: 'follow', id: k >= 0 ? `uc-${k}` : c && `c-${c.id}` });
	}

	private async onMessage(m: { type: string; id?: string; to?: string; q?: string; useCase?: number; path?: string; startLine?: number; endLine?: number }) {
		switch (m.type) {
			case 'ready': return this.post();
			case 'regenerate': return this.root && this.open(this.root, true);
			case 'switch': { const r = await pickProject('Describe which codebase?', { ask: true }); return r && this.open(r); }
			case 'tour': return vscode.commands.executeCommand('coee.tour', this.root);
			case 'nav': return vscode.commands.executeCommand('coee.go', m.to, this.root);
			case 'zoom': { const base = this.system?.root ?? this.root; return base && this.open(m.path ? vscode.Uri.joinPath(base, m.path) : base); }
			case 'ask': return m.q ? this.ask(m.q) : undefined;
			case 'walk': {
				const u = m.useCase === undefined ? undefined : this.state.behavior?.useCases[m.useCase];
				return vscode.commands.executeCommand('coee.walkPart', this.root, u ? { name: u.name, steps: u.steps, files: u.files.map(f => f.path) } : m.id && { id: m.id });
			}
			case 'open': {
				if (!m.path || !this.root) return;
				return showLines(this.root, m.path, m.startLine, m.endLine);
			}
		}
	}

	private show(patch: Partial<PageState>) {
		Object.assign(this.state, patch);
		this.post();
	}

	private post() { this.panel?.webview.postMessage({ type: 'state', state: this.state }); }

	private theme(): 'dark' | 'light' {
		return [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
	}

	private svg(d: Diagram) {
		return diagramSvg(d, this.theme(), 1000).svg;
	}

	private withSvgs(b: Behavior): PageState['behavior'] {
		return { ...b, svgs: { useCases: b.useCases.map(u => this.svg(u.sequence)), states: b.states.map(s => this.svg(s.diagram)) } };
	}

	private withErSvg(d: DataModel): PageState['data'] {
		return { ...d, svg: erSvg(d, this.theme(), 1000).svg };
	}

	private archSvg(map: SystemMap) {
		const d = mapDiagram(map);
		return d && this.svg(d);
	}

	private redraw() {
		const { map, behavior, data } = this.state;
		if (map) this.state.archSvg = this.archSvg(map);
		if (behavior) this.state.behavior = this.withSvgs(behavior);
		if (data) this.state.data = this.withErSvg(data);
		this.post();
	}

	/** The repository a big-codebase page started from, so packages opened from it get breadcrumbs back. */
	private system?: { root: vscode.Uri; name: string };
	/** The code the page read, for "where is X handled?". */
	private files: FolderFile[] = [];

	private async generate(root: vscode.Uri, fresh: boolean) {
		const gen = ++this.gen;
		this.lm.cancel();
		this.askLm.cancel();
		if (this.system && !root.path.startsWith(this.system.root.path)) this.system = undefined;
		const rel = this.system ? path.posix.relative(this.system.root.path, root.path) : '';
		const crumbs = this.system && rel ? [{ name: this.system.name, path: '' }, ...rel.split('/').map((p, i, a) => ({ name: p, path: a.slice(0, i + 1).join('/') }))] : undefined;
		this.state = { root: path.basename(root.path), reading: 'the project', crumbs };
		this.post();
		try {
			const all = await sourceFiles(root);
			if (gen !== this.gen) return;
			// A big repository starts at its packages: each one is mapped and explained on its own when opened.
			if (all.filter(p => SOURCE.test(p)).length > BIG) {
				const manifests = all.filter(p => /(^|\/)(package\.json|go\.mod|go\.work|Cargo\.toml|pnpm-workspace\.yaml|settings\.gradle(\.kts)?|pom\.xml|README\.md)$/.test(p) && p.split('/').length <= 4).slice(0, 400);
				const texts = new Map<string, string>();
				for (const p of manifests) texts.set(p, (await read(vscode.Uri.joinPath(root, p))).slice(0, 20_000));
				const subs = detectSubsystems(all, p => texts.get(p), p => SOURCE.test(p));
				if (subs.length >= 2) return await this.systemLevel(root, subs, all, texts, fresh, gen);
			}
			this.state.reading = 'the project\'s parts';
			this.post();
			const map = await this.maps.mapFor(root);
			if (gen !== this.gen) return;
			this.state.map = map;
			this.show({ archSvg: this.archSvg(map), reading: 'how it works' });
			const { wanted } = projectFiles(all, map.components);
			// The whole project (the parts' own files first): the packer shows what fits whole and outlines the rest.
			const { files } = await readFiles(root, [...new Set([...wanted, ...all])], TOUR_CHARS);
			this.files = files;
			this.state.coverage = { read: files.length, total: all.length };
			const known = files.map(f => f.path);
			const key = { v: VERSION, root: root.toString(), map, code: digest(files) };
			const doc = await this.cached({ ...key, part: 'doc' }, fresh, async () => { const d = await this.lm.json<ArchDoc>(b => buildArchitecturePrompt(map, files, b), d => repairArchitecture(d, map, known)); return { ...d, components: d.components.map(c => ({ ...c, keyFiles: snapRefs(c.keyFiles, files) })) }; });
			if (gen !== this.gen) return;
			this.show({ doc, reading: 'use cases and lifecycles' });
			const behavior = await this.cached({ ...key, part: 'behavior' }, fresh, async () => { const b = await this.lm.json<Behavior>(b => buildBehaviorPrompt(map, files, b), d => repairBehavior(d, known)); return { ...b, useCases: b.useCases.map(u => ({ ...u, files: snapRefs(u.files, files) })) }; });
			if (gen !== this.gen) return;
			const missing = [behavior.useCases.length < 2 ? 'fewer than two use cases' : '', behavior.states.length ? '' : 'no state diagram'].filter(Boolean);
			this.show({ behavior: this.withSvgs(behavior), reading: 'the data model', behaviorNote: missing.length ? `The model came back with ${missing.join(' and ')}. Regenerate to try again.` : undefined });
			const data = await this.cached({ ...key, part: 'data' }, fresh, () => this.lm.json<DataModel>(b => buildDataModelPrompt(map, files, b), d => repairDataModel(d, known)));
			if (gen !== this.gen) return;
			this.show({ data: this.withErSvg(data), reading: undefined });
		} catch (err) {
			if (gen !== this.gen || isCancel(err)) return;
			const msg = err instanceof Error ? err.message : String(err);
			log.error(msg);
			this.show({ error: msg, reading: undefined });
		}
	}

	/**
	 * The top of a big repository: its packages as the parts (from manifests, no model), how they depend on each other,
	 * and a "how it works" written from the manifests and READMEs. Use cases, states and data come per package.
	 */
	private async systemLevel(root: vscode.Uri, subs: Subsystem[], all: string[], texts: Map<string, string>, fresh: boolean, gen: number) {
		this.system = { root, name: path.basename(root.path) };
		const map: SystemMap = {
			title: path.basename(root.path), summary: `${subs.length} packages, ${all.length} files.`,
			components: subs.map(s => ({ id: s.path, name: s.name, summary: s.description ?? `${s.files} source files in ${s.path}`, files: [...texts.keys()].filter(p => p.startsWith(s.path + '/')).slice(0, 3).map(p => ({ path: p })) })),
			connections: subs.flatMap(s => s.uses.map(u => ({ from: s.path, to: u, label: 'uses' }))),
		};
		const files: FolderFile[] = [...texts].map(([p, text]) => ({ path: p, text }));
		this.files = files;
		this.show({ map, subsystems: subs, archSvg: this.archSvg(map), coverage: { read: files.length, total: all.length }, reading: 'how the packages fit together', crumbs: [{ name: this.system.name, path: '' }] });
		const known = files.map(f => f.path);
		const doc = await this.cached({ v: VERSION, root: root.toString(), map, code: digest(files), part: 'system' }, fresh, () => this.lm.json<ArchDoc>(b => buildArchitecturePrompt(map, files, b), d => repairArchitecture(d, map, known)));
		if (gen !== this.gen) return;
		this.show({ doc, reading: undefined });
	}

	/** "Where is X handled?": the lines that mention it, and a short answer from the model that points at them. */
	private async ask(q: string) {
		const words = q.toLowerCase().match(/[a-z0-9_]{3,}/g)?.filter(w => !['where', 'what', 'how', 'the', 'and', 'does', 'handled', 'handle', 'happen', 'this', 'that', 'with'].includes(w)) ?? [];
		if (!words.length || !this.state.map) return;
		const refs: Array<{ path: string; line: number; text: string; score: number }> = [];
		for (const f of this.files) f.text.split('\n').forEach((l, i) => {
			const low = l.toLowerCase(), score = words.filter(w => low.includes(w)).length;
			if (score) refs.push({ path: f.path, line: i + 1, text: l.trim().slice(0, 160), score: score + (/\b(function|def|class|router?\.|app\.|export)\b/.test(l) ? 1 : 0) });
		});
		const top = refs.sort((a, b) => b.score - a.score).slice(0, 12).map(({ score, ...r }) => r);
		this.show({ answer: { q, refs: top, busy: true } });
		const map = this.state.map;
		const prompt = `Project: ${map.title}. Parts: ${map.components.map(c => `${c.name} (${c.summary})`).join('; ')}
A developer asks: "${q}"
Lines in the code that mention it:
${top.map(r => `${r.path}:${r.line}: ${r.text}`).join('\n') || '(none found)'}
Answer in under 120 words, plainly: which part handles it and where to start reading (file:line). If the lines above don't answer it, say what to search for instead.`;
		try {
			const text = await this.askLm.ask(prompt);
			this.show({ answer: { q, refs: top, text } });
		} catch (err) {
			if (!isCancel(err)) this.show({ answer: { q, refs: top, error: err instanceof Error ? err.message : String(err) } });
		}
	}

	/** Saved per project and code version (a hash of the files), like walkthroughs; `coee.cache` turns it off. */
	private async cached<T>(key: object, fresh: boolean, make: () => Promise<T>): Promise<T> {
		const on = vscode.workspace.getConfiguration('coee').get('cache', true);
		const hash = createHash('sha256').update(JSON.stringify(key)).digest('hex');
		const saved = this.ext.workspaceState.get<Record<string, { v: T; t: number }>>(CACHE_KEY, {});
		if (on && !fresh && saved[hash]) return saved[hash].v;
		const v = await make();
		if (on) await this.ext.workspaceState.update(CACHE_KEY, Object.fromEntries(Object.entries({ ...saved, [hash]: { v, t: Date.now() } }).sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_SIZE)));
		return v;
	}
}

// ---------------------------------------------------------------------------

export const CSS = /* css */ `
html, body { height: 100%; }
body { background: var(--vscode-editor-background); }
main { height: 100vh; display: flex; flex-direction: column; }
.bar { display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.bar h1 { min-width: 8em; }
.bar h1 { font-size: 1.05em; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool { border: 0; background: none; color: var(--vscode-foreground); padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
.tool:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.wrap { flex: 1; overflow: auto; display: grid; align-items: start; grid-template-columns: 200px minmax(0, 1fr); gap: 40px; padding: 28px 36px 60px; }
nav.toc { position: sticky; top: 0; align-self: start; display: grid; gap: 4px; font-size: .92em; }
nav.toc .link { text-align: left; color: var(--muted); }
nav.toc .link:hover { color: var(--vscode-foreground); }
article { max-width: 920px; display: grid; gap: 44px; min-width: 0; align-content: start; }
section { display: grid; gap: 12px; align-content: start; scroll-margin-top: 12px; }
.eyebrow { font-size: .78em; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
h1.title { font-size: 2em; line-height: 1.2; }
h2 { font-size: 1.35em; }
h3 { font-size: 1.08em; }
.lede { font-size: 1.12em; line-height: 1.6; }
.prose .md { font-size: 1.05em; line-height: 1.7; }
figure { margin: 0; padding: 14px; border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 8px; overflow-x: auto; }
figure svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
figcaption { font-size: .88em; color: var(--muted); text-align: center; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.card { display: grid; gap: 8px; align-content: start; padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--vscode-editorWidget-background); scroll-margin: 80px; }
.card .link.small { justify-self: start; font-size: .88em; }
.flash { animation: flash 1.6s ease-out; }
.crumbs { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: .92em; }
.ask { display: flex; gap: 8px; }
.ask input { flex: 1; }
.answer { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; }
.answer .files { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.note { font-size: .88em; color: var(--muted); }
.uc .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.following { outline: 2px solid var(--vscode-textLink-foreground); outline-offset: 2px; transition: outline-color .3s; }
@keyframes flash { 0%, 30% { box-shadow: 0 0 0 2px var(--vscode-focusBorder); } 100% { box-shadow: 0 0 0 0 transparent; } }
.switch { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; padding: 2px; gap: 2px; flex: none; }
.switch button { border: 0; background: none; color: var(--muted); padding: 2px 12px; border-radius: 5px; font-size: .92em; }
.switch button.on { background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch button:not(.on):hover { color: var(--vscode-foreground); }
.card p { line-height: 1.55; }
.files { display: grid; gap: 4px; }
.files .link { text-align: left; font-family: var(--mono); font-size: .88em; overflow-wrap: anywhere; }
.links { font-size: .88em; color: var(--muted); }
.uc { display: grid; gap: 12px; padding: 18px 20px; border-radius: 8px; border-left: 3px solid var(--vscode-textLink-foreground);
  background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, var(--vscode-editor-background)); }
.uc ol { margin: 0; padding-left: 22px; display: grid; gap: 4px; line-height: 1.55; }
.who { font-size: .85em; color: var(--muted); }
.note { border-left: 2px solid var(--vscode-errorForeground); padding: 4px 10px; color: var(--vscode-errorForeground); }
.terms { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.terms dt { font-weight: 600; } .terms dd { margin: 0; color: var(--muted); }
ul.conv { margin: 0; padding-left: 20px; display: grid; gap: 6px; line-height: 1.55; }
.reading { display: flex; gap: 12px; align-items: center; color: var(--muted); }
.reading .sweep { width: 160px; }
.error { color: var(--vscode-errorForeground); }
.term { text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-color: var(--vscode-textLink-foreground); cursor: help; }
@media (max-width: 760px) { .wrap { grid-template-columns: 1fr; padding: 20px; } nav.toc { display: none; } }
`;

export const SCRIPT = String.raw`
const root = document.getElementById('root');
const send = (type, extra) => vscode.postMessage({ type, ...extra });
const kids = (...k) => k.filter(x => x != null && x !== false);
let st = {}, focusId = null;

function figure(svg, caption) {
  if (!svg) return null;
  const pic = el('div', {});
  pic.innerHTML = svg; // drawn by the extension, all text escaped
  return el('figure', {}, pic, caption ? el('figcaption', {}, caption) : null);
}
const fileLink = f => el('button', { className: 'link', title: f.why || '', onclick: () => send('open', f) },
  f.path + (f.startLine ? ':' + f.startLine + (f.endLine && f.endLine !== f.startLine ? '–' + f.endLine : '') : ''));
const reading = what => el('div', { className: 'reading' }, el('div', { className: 'sweep', 'aria-hidden': 'true' }), 'Reading ' + what + '…');
const go = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

function render() {
  const { map, doc, behavior } = st;
  const name = id => (map.components.find(c => c.id === id) || { name: id }).name;
  const bar = el('div', { className: 'bar' }, coeeNav('architecture'),
    el('h1', {}, (doc && doc.title) || (map && map.title) || st.root || 'Architecture'),
    map ? el('button', { className: 'tool', title: 'Walk through the whole project, part by part', onclick: () => send('tour') }, 'Tour this codebase') : null,
    el('button', { className: 'tool', onclick: () => send('switch') }, 'Other codebase…'),
    el('button', { className: 'tool', title: 'Read the code again and rewrite this page', onclick: () => send('regenerate') }, '↻ Regenerate'));
  if (!map) { root.replaceChildren(bar, el('div', { className: 'wrap' }, el('span'), st.error ? el('p', { className: 'error' }, st.error) : reading(st.reading || 'the project'))); return; }
  const subs = st.subsystems;
  const toc = el('nav', { className: 'toc' }, ...(subs ? [['overview', 'Overview'], ['ask', 'Find'], ['how', 'How it works'], ['arch', 'Architecture'], ['packages', 'Packages'], ['conv', 'Conventions']]
    : [['overview', 'Overview'], ['ask', 'Find'], ['how', 'How it works'], ['arch', 'Architecture'], ['parts', 'Components'], ['uses', 'Use cases'], ['states', 'States'], ['data', 'Data model'], ['conv', 'Conventions']])
    .map(([id, label]) => el('button', { className: 'link', onclick: () => go(id) }, label)));
  const a = st.answer;
  const askBox = el('form', { className: 'ask', onsubmit: e => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) send('ask', { q }); } },
    el('input', { type: 'text', name: 'q', placeholder: subs ? 'Where is login handled? Which package owns billing?' : 'Where is X handled? e.g. "where are todos saved"', value: a ? a.q : '', 'aria-label': 'Ask where something is handled' }),
    el('button', { className: 'btn', type: 'submit' }, 'Find'));
  const sections = kids(
    st.crumbs && st.crumbs.length > 1 ? el('nav', { className: 'crumbs', 'aria-label': 'Where you are' }, ...st.crumbs.flatMap((c, i) => [i ? el('span', { className: 'muted' }, '›') : null,
      i < st.crumbs.length - 1 ? el('button', { className: 'link', onclick: () => send('zoom', { path: c.path }) }, c.name) : el('strong', {}, c.name)])) : null,
    el('section', { id: 'overview' }, el('span', { className: 'eyebrow' }, subs ? 'System overview' : 'Architecture overview'),
      el('h1', { className: 'title' }, (doc && doc.title) || map.title),
      el('p', { className: 'lede' }, (doc && doc.summary) || map.summary)),
    el('section', { id: 'ask' }, askBox,
      a ? el('div', { className: 'answer' }, a.busy ? reading('the code for an answer') : a.error ? el('p', { className: 'error' }, a.error) : a.text ? md(a.text) : null,
        a.refs.length ? el('div', { className: 'files' }, ...a.refs.map(r => el('button', { className: 'link', title: r.text, onclick: () => send('open', { path: r.path, startLine: r.line, endLine: r.line }) }, r.path + ':' + r.line))) : null) : null),
    el('section', { id: 'how' }, el('h2', {}, 'How it works'),
      doc ? el('div', { className: 'prose' }, withTerms(md(doc.howItWorks))) : reading('how it works'),
      doc && doc.terms ? el('dl', { className: 'terms' }, ...doc.terms.flatMap(t => [el('dt', {}, t.name), el('dd', {}, t.meaning)])) : null),
    el('section', { id: 'arch' }, el('h2', {}, 'Architecture'),
      el('p', { className: 'muted' }, subs ? 'The packages this repository is made of, and which use which.' : 'Every part of the project and what passes between them.'),
      figure(st.archSvg, 'How the parts of ' + map.title + ' connect'),
      st.coverage ? el('p', { className: 'note' }, subs ? 'Read the manifests and READMEs of ' + st.coverage.total + ' files. Open a package for its components, use cases and data.'
        : 'Read ' + (st.coverage.read === st.coverage.total ? 'all ' : st.coverage.read + ' of ') + st.coverage.total + ' files: whole where they fit, the rest as outlines (every function, route, data shape and rule, with its lines).'
          + (st.coverage.read < st.coverage.total ? ' The rest were over the reading limit.' : '')) : null),
    subs ? el('section', { id: 'packages' }, el('h2', {}, 'Packages'),
      el('div', { className: 'cards' }, ...subs.map(p => el('div', { className: 'card', id: 'c-' + p.path }, el('h3', {}, p.name),
        el('p', { className: 'muted mono' }, p.path + ' · ' + p.files + ' source files'),
        p.description ? el('p', {}, p.description) : null,
        p.uses.length ? el('p', { className: 'links' }, '→ ' + p.uses.map(u => (subs.find(x => x.path === u) || { name: u }).name).join(' · ')) : null,
        el('button', { className: 'btn quiet', title: 'Its own architecture: components, use cases, states and data', onclick: () => send('zoom', { path: p.path }) }, 'Open ' + p.name))))) : null,
    subs ? null : el('section', { id: 'parts' }, el('h2', {}, 'Components'),
      el('div', { className: 'cards' }, ...map.components.map(c => {
        const d = doc && doc.components.find(x => x.id === c.id);
        const out = map.connections.filter(e => e.from === c.id), inc = map.connections.filter(e => e.to === c.id);
        const card = el('div', { className: 'card', id: 'c-' + c.id }, el('h3', {}, c.name),
          el('p', {}, (d && d.role) || c.description || c.summary),
          (d && d.keyFiles.length ? d.keyFiles : c.files.slice(0, 3)).length ? el('div', { className: 'files' }, ...(d && d.keyFiles.length ? d.keyFiles : c.files.slice(0, 3)).map(fileLink)) : null,
          out.length || inc.length ? el('p', { className: 'links' }, [...out.map(e => '→ ' + name(e.to) + (e.label ? ' (' + e.label + ')' : '')), ...inc.map(e => '← ' + name(e.from))].join(' · ')) : null,
          el('button', { className: 'link small', title: 'Step through this part in the editor', onclick: () => send('walk', { id: c.id }) }, 'Walk me through'));
        return card;
      }))),
    subs ? null : el('section', { id: 'uses' }, el('h2', {}, 'Use cases'),
      behavior ? el('p', { className: 'muted' }, 'What people do with it, and how each one flows through the code.') : reading(st.reading === 'use cases and lifecycles' ? 'use cases' : 'use cases (after how it works)'),
      ...(behavior ? behavior.useCases.map((u, k) => el('div', { className: 'uc', id: 'uc-' + k },
        el('div', { className: 'head' }, el('h3', {}, u.name), el('button', { className: 'link small', title: 'Step through this in the editor', onclick: () => send('walk', { useCase: k }) }, 'Walk me through')), u.who ? el('span', { className: 'who' }, 'Who: ' + u.who) : null,
        u.steps.length ? el('ol', {}, ...u.steps.map(x => el('li', {}, withTerms(md(x))))) : null,
        figure(behavior.svgs.useCases[k], 'Sequence: ' + u.name),
        u.files.length ? el('div', { className: 'files' }, ...u.files.map(fileLink)) : null)) : [])),
    subs ? null : el('section', { id: 'states' }, el('h2', {}, 'States'),
      behavior ? null : reading('lifecycles'),
      ...(behavior ? behavior.states.map((x, k) => el('div', { className: 'uc' }, el('h3', {}, x.name), x.what ? withTerms(md(x.what)) : null, figure(behavior.svgs.states[k], 'States of ' + x.name))) : []),
      st.behaviorNote ? el('p', { className: 'note' }, st.behaviorNote) : null),
    subs ? null : el('section', { id: 'data' }, el('h2', {}, 'Data model'),
      st.data ? (st.data.what ? el('div', { className: 'prose' }, withTerms(md(st.data.what))) : null) : reading(behavior ? 'the data model' : 'the data model (after use cases)'),
      st.data ? figure(st.data.svg, 'Entities and how they relate (PK: identifier, FK: reference to another entity)') : null,
      st.data && st.data.entities.some(e => e.file) ? el('div', { className: 'files' }, ...st.data.entities.filter(e => e.file).map(e => fileLink({ ...e.file, why: e.name }))) : null),
    doc && doc.conventions.length ? el('section', { id: 'conv' }, el('h2', {}, 'Conventions'), el('ul', { className: 'conv' }, ...doc.conventions.map(x => el('li', {}, withTerms(md(x)))))) : null,
    st.error ? el('p', { className: 'error' }, st.error) : null);
  const prev = root.querySelector('.wrap'), top = prev ? prev.scrollTop : 0;
  root.replaceChildren(bar, el('div', { className: 'wrap' }, toc, el('article', {}, ...sections)));
  root.querySelector('.wrap').scrollTop = top;
  if (focusId) { // arrived from the map: bring that part's card into view once it exists
    const card = document.getElementById('c-' + focusId);
    if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); focusId = null; }
  }
}

/** Underline the doc's terms where they first appear; hover shows the meaning. */
function withTerms(node) {
  const terms = (st.doc && st.doc.terms) || [];
  for (const t of terms) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: x => x.parentElement.closest('code, .term') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const re = new RegExp('\\b' + t.name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '\\b', 'i');
    for (let n; (n = walker.nextNode());) {
      const m = re.exec(n.data);
      if (!m) continue;
      const hit = n.splitText(m.index); hit.splitText(m[0].length);
      hit.replaceWith(el('span', { className: 'term', tabindex: '0', title: t.meaning }, m[0]));
      break;
    }
  }
  return node;
}

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'state') { st = m.state; render(); }
  if (m.type === 'focus') { focusId = m.id; if (st.map) render(); }
  if (m.type === 'follow') { // the walkthrough moved: show where, without stealing the scroll position if it's already in view
    document.querySelectorAll('.following').forEach(x => x.classList.remove('following'));
    const el = m.id && document.getElementById(m.id);
    if (el) { el.classList.add('following'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
});
send('ready');
`;
