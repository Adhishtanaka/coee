import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import {
	ArchDoc, Behavior, DataModel, Diagram, SystemMap, buildArchitecturePrompt, buildBehaviorPrompt, buildDataModelPrompt, mapDiagram,
	repairArchitecture, repairBehavior, repairDataModel,
} from './prompt';
import { diagramSvg, erSvg } from './layout';
import { Lm, isCancel, log } from './lm';
import { MapController, pickProject, sourceFiles } from './map';
import { TOUR_CHARS, digest, projectFiles, readFiles } from './walkthrough';
import { page } from './ui';

const CACHE_KEY = 'coee.architecture';
const CACHE_SIZE = 15;

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
}

/**
 * The architecture page: how the whole project works, in one place. Every part and how they connect,
 * each use case with its sequence diagram, the lifecycles as state diagrams, and the data model as an ER diagram.
 * It shares a view switch and cross-links with the system map, so the two read as one.
 */
export class ArchitectureController implements vscode.Disposable {
	private panel?: vscode.WebviewPanel;
	private root?: vscode.Uri;
	private state: PageState = {};
	private gen = 0;
	private readonly lm = new Lm('coee describes how your project works.');
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly ext: vscode.ExtensionContext, private readonly maps: MapController) {
		this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => this.redraw()));
	}

	dispose() {
		this.lm.cancel();
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	/** Open (or bring back) the page; `focus` scrolls to one component, e.g. from the map's "Read in architecture". */
	async open(root?: vscode.Uri, fresh = false, focus?: string) {
		root ??= await pickProject('Describe which codebase?');
		if (!root) return;
		const same = this.panel && this.root?.toString() === root.toString() && this.state.map && !this.state.error;
		this.root = root;
		if (!this.panel) {
			const panel = this.panel = vscode.window.createWebviewPanel('coee.architecture', 'Architecture', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
			panel.iconPath = vscode.Uri.joinPath(this.ext.extensionUri, 'media', 'icon.png');
			panel.webview.html = page(panel.webview, { css: CSS, body: '<main id="root"></main>', script: SCRIPT });
			panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => this.show({ error: err instanceof Error ? err.message : String(err), reading: undefined })));
			panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.lm.cancel(); this.gen++; this.state = {}; } });
		}
		this.panel.title = `Architecture · ${path.basename(root.path)}`;
		this.panel.reveal();
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

	private async onMessage(m: { type: string; id?: string; path?: string; startLine?: number; endLine?: number }) {
		switch (m.type) {
			case 'ready': return this.post();
			case 'regenerate': return this.root && this.open(this.root, true);
			case 'switch': { const r = await pickProject('Describe which codebase?', { ask: true }); return r && this.open(r); }
			case 'map': return vscode.commands.executeCommand('coee.map', this.root, m.id);
			case 'open': {
				if (!m.path || !this.root) return;
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.root, m.path));
				const a = Math.max(0, Math.min((m.startLine ?? 1) - 1, doc.lineCount - 1)), b = Math.max(a, Math.min((m.endLine ?? m.startLine ?? 1) - 1, doc.lineCount - 1));
				return void vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: m.startLine ? new vscode.Range(a, 0, b, 0) : undefined });
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

	private async generate(root: vscode.Uri, fresh: boolean) {
		const gen = ++this.gen;
		this.lm.cancel();
		this.state = { root: path.basename(root.path), reading: 'the system map' };
		this.post();
		try {
			const map = await this.maps.mapFor(root);
			if (gen !== this.gen) return;
			this.state.map = map;
			this.show({ archSvg: this.archSvg(map), reading: 'how it works' });
			const all = await sourceFiles(root);
			const { wanted } = projectFiles(all, map.components);
			const { files } = await readFiles(root, wanted, TOUR_CHARS);
			const known = files.map(f => f.path);
			const key = { root: root.toString(), map, code: digest(files) };
			const doc = await this.cached({ ...key, part: 'doc' }, fresh, () => this.lm.json<ArchDoc>(b => buildArchitecturePrompt(map, files, b), d => repairArchitecture(d, map, known)));
			if (gen !== this.gen) return;
			this.show({ doc, reading: 'use cases and lifecycles' });
			const behavior = await this.cached({ ...key, part: 'behavior' }, fresh, () => this.lm.json<Behavior>(b => buildBehaviorPrompt(map, files, b), d => repairBehavior(d, known)));
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
.bar { display: flex; gap: 12px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); }
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
  const bar = el('div', { className: 'bar' },
    el('div', { className: 'switch', role: 'tablist', 'aria-label': 'View' },
      el('button', { role: 'tab', 'aria-selected': 'false', title: 'The system map: every part and how they connect', onclick: () => send('map') }, 'Map'),
      el('button', { className: 'on', role: 'tab', 'aria-selected': 'true' }, 'Architecture')),
    el('h1', {}, (doc && doc.title) || (map && map.title) || st.root || 'Architecture'),
    el('button', { className: 'tool', onclick: () => send('switch') }, 'Other codebase…'),
    el('button', { className: 'tool', title: 'Read the code again and rewrite this page', onclick: () => send('regenerate') }, '↻ Regenerate'));
  if (!map) { root.replaceChildren(bar, el('div', { className: 'wrap' }, el('span'), st.error ? el('p', { className: 'error' }, st.error) : reading(st.reading || 'the project'))); return; }
  const toc = el('nav', { className: 'toc' }, ...[['overview', 'Overview'], ['how', 'How it works'], ['arch', 'Architecture'], ['parts', 'Components'], ['uses', 'Use cases'], ['states', 'States'], ['data', 'Data model'], ['conv', 'Conventions']]
    .map(([id, label]) => el('button', { className: 'link', onclick: () => go(id) }, label)));
  const sections = kids(
    el('section', { id: 'overview' }, el('span', { className: 'eyebrow' }, 'Architecture overview'),
      el('h1', { className: 'title' }, (doc && doc.title) || map.title),
      el('p', { className: 'lede' }, (doc && doc.summary) || map.summary)),
    el('section', { id: 'how' }, el('h2', {}, 'How it works'),
      doc ? el('div', { className: 'prose' }, withTerms(md(doc.howItWorks))) : reading('how it works'),
      doc && doc.terms ? el('dl', { className: 'terms' }, ...doc.terms.flatMap(t => [el('dt', {}, t.name), el('dd', {}, t.meaning)])) : null),
    el('section', { id: 'arch' }, el('h2', {}, 'Architecture'),
      el('p', { className: 'muted' }, 'Every part of the project and what passes between them.'),
      figure(st.archSvg, 'How the parts of ' + map.title + ' connect')),
    el('section', { id: 'parts' }, el('h2', {}, 'Components'),
      el('div', { className: 'cards' }, ...map.components.map(c => {
        const d = doc && doc.components.find(x => x.id === c.id);
        const out = map.connections.filter(e => e.from === c.id), inc = map.connections.filter(e => e.to === c.id);
        const card = el('div', { className: 'card', id: 'c-' + c.id }, el('h3', {}, c.name),
          el('p', {}, (d && d.role) || c.description || c.summary),
          (d && d.keyFiles.length ? d.keyFiles : c.files.slice(0, 3)).length ? el('div', { className: 'files' }, ...(d && d.keyFiles.length ? d.keyFiles : c.files.slice(0, 3)).map(fileLink)) : null,
          out.length || inc.length ? el('p', { className: 'links' }, [...out.map(e => '→ ' + name(e.to) + (e.label ? ' (' + e.label + ')' : '')), ...inc.map(e => '← ' + name(e.from))].join(' · ')) : null,
          el('button', { className: 'link small', onclick: () => send('map', { id: c.id }) }, 'Show on map'));
        return card;
      }))),
    el('section', { id: 'uses' }, el('h2', {}, 'Use cases'),
      behavior ? el('p', { className: 'muted' }, 'What people do with it, and how each one flows through the code.') : reading(st.reading === 'use cases and lifecycles' ? 'use cases' : 'use cases (after how it works)'),
      ...(behavior ? behavior.useCases.map((u, k) => el('div', { className: 'uc' },
        el('h3', {}, u.name), u.who ? el('span', { className: 'who' }, 'Who: ' + u.who) : null,
        u.steps.length ? el('ol', {}, ...u.steps.map(x => el('li', {}, withTerms(md(x))))) : null,
        figure(behavior.svgs.useCases[k], 'Sequence: ' + u.name),
        u.files.length ? el('div', { className: 'files' }, ...u.files.map(fileLink)) : null)) : [])),
    el('section', { id: 'states' }, el('h2', {}, 'States'),
      behavior ? null : reading('lifecycles'),
      ...(behavior ? behavior.states.map((x, k) => el('div', { className: 'uc' }, el('h3', {}, x.name), x.what ? withTerms(md(x.what)) : null, figure(behavior.svgs.states[k], 'States of ' + x.name))) : []),
      st.behaviorNote ? el('p', { className: 'note' }, st.behaviorNote) : null),
    el('section', { id: 'data' }, el('h2', {}, 'Data model'),
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
});
send('ready');
`;
