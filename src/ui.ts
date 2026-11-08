import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { chooseColumns } from './columns';

/**
 * Shared webview shell. Everything themes off VS Code's variables. The one brand colour is the amber
 * highlighter (`coee.highlightBackground/Border`): the same amber marks the lines in the editor, so the UI
 * and the code it talks about visibly belong together.
 */
export const BASE_CSS = /* css */ `
:root {
  --hl: var(--vscode-coee-highlightBackground);
  --mark: var(--vscode-coee-highlightBorder);
  --muted: var(--vscode-descriptionForeground);
  --line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  --mono: var(--vscode-editor-font-family);
  --link: var(--vscode-textLink-foreground);
}
* { box-sizing: border-box; }
body { margin: 0; font: var(--vscode-font-size)/1.55 var(--vscode-font-family); color: var(--vscode-foreground); }
h1, h2, h3 { margin: 0; font-weight: 600; line-height: 1.3; }
p { margin: 0; }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.btn { border: 0; border-radius: 3px; padding: 4px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.btn.quiet { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.quiet:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.link { border: 0; background: none; padding: 0; color: var(--link); }
.link:hover:not(:disabled) { text-decoration: underline; }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); font-size: .92em; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; }
.md { overflow-wrap: anywhere; min-width: 0; }
.md p, .md ul, .md pre { margin: 0 0 8px; }
.md > :last-child { margin-bottom: 0; }
.md ul { padding-left: 18px; }
.md li + li { margin-top: 2px; }
.md code { font-family: var(--mono); font-size: .92em; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
.md pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.error { color: var(--vscode-errorForeground); }
.warn { color: var(--vscode-textLink-foreground); }
textarea, input[type=text], select {
  width: 100%; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 2px; padding: 4px 6px;
}
textarea { resize: vertical; min-height: 3.2em; }
textarea:focus, input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* The highlighter sweep: the single motion used while coee is reading code. */
.sweep { height: 4px; border-radius: 2px; background: var(--hl); position: relative; overflow: hidden; }
.sweep::after { content: ''; position: absolute; inset: 0; width: 40%; background: var(--mark); border-radius: 2px; animation: sweep 1.4s ease-in-out infinite; }
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) { .sweep::after { animation: none; width: 100%; opacity: .5; } }
/* The same switcher on every coee page: the pages are one tool, not five. */
.coeenav { display: flex; gap: 2px; flex-wrap: wrap; padding: 2px; border: 1px solid var(--line); border-radius: 6px; }
.coeenav button { border: 0; background: none; padding: 2px 9px; border-radius: 4px; color: var(--muted); font-size: .92em; white-space: nowrap; }
.coeenav button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.coeenav button[aria-current="page"] { color: var(--vscode-foreground); background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); font-weight: 600; }
`;

/** Light, safe markdown for model replies (shared by every webview). */
const MD = String.raw`
// Light, safe markdown: escape everything, then allow code blocks, inline code, bold and lists.
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = s => esc(s).replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, '$1<em>$2</em>');
const BULLET = /^\s*([-*•]|\d+[.)])\s+/;
function md(text) {
  const out = [];
  text.split(/\x60\x60\x60[\w+-]*\n?/).forEach((block, k) => {
    if (k % 2) { out.push('<pre><code>' + esc(block.replace(/\n$/, '')) + '</code></pre>'); return; }
    for (const para of block.split(/\n\s*\n/)) {
      const lines = para.split('\n').filter(l => l.trim());
      if (!lines.length) continue;
      if (lines.every(l => BULLET.test(l))) out.push('<ul>' + lines.map(l => '<li>' + inline(l.replace(BULLET, '')) + '</li>').join('') + '</ul>');
      else out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
    }
  });
  const d = el('div', { className: 'md' });
  d.innerHTML = out.join('');
  return d;
}

// The switcher between coee's pages; the extension opens the page (for the same project) when one is picked.
const PAGES = [['architecture', 'Architecture'], ['changes', 'Changes'], ['security', 'Security'], ['plan', 'Plan'], ['walkthrough', 'Walkthrough']];
function coeeNav(current) {
  return el('nav', { className: 'coeenav', 'aria-label': 'coee pages' }, ...PAGES.map(([id, label]) =>
    el('button', { 'aria-current': id === current ? 'page' : null, onclick: () => id !== current && vscode.postMessage({ type: 'nav', to: id }) }, label)));
}

`;

export function page(webview: vscode.Webview, opts: { css: string; body: string; script: string; scripts?: vscode.Uri[] }): string {
	const nonce = randomBytes(16).toString('base64');
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${BASE_CSS}${opts.css}</style></head>
<body>${opts.body}
${(opts.scripts ?? []).map(u => `<script nonce="${nonce}" src="${webview.asWebviewUri(u)}"></script>`).join('\n')}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'className' || k === 'textContent' || k === 'value' || k === 'checked' || k === 'disabled') e[k] = v; else e.setAttribute(k, v === true ? '' : v); } e.append(...kids.filter(k => k != null && k !== false)); return e; };
${MD}
${opts.script}
</script></body></html>`;
}

/** Open `path` (relative to `root`) beside the editor with lines `start`-`end` selected, the whole last line included. */
export async function showLines(root: vscode.Uri, path: string, start?: number, end?: number) {
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, path));
	const last = doc.lineCount - 1;
	const a = Math.max(0, Math.min((start ?? 1) - 1, last)), b = Math.max(a, Math.min((end ?? start ?? 1) - 1, last));
	await vscode.window.showTextDocument(doc, { viewColumn: codeColumn(), preview: true, selection: start ? new vscode.Range(a, 0, b, doc.lineAt(b).range.end.character) : undefined });
}

const panels = new Set<vscode.WebviewPanel>();
/** Text editor groups, most recently focused first (only VS Code knows the order; this remembers it). */
let recent: number[] = [];
export function watchEditors(): vscode.Disposable {
	const note = (e?: vscode.TextEditor) => { if (e?.viewColumn && e.document.uri.scheme !== 'output') recent = [e.viewColumn, ...recent.filter(c => c !== e.viewColumn)]; };
	note(vscode.window.activeTextEditor);
	return vscode.window.onDidChangeActiveTextEditor(note);
}

function columns() {
	const open = new Set(vscode.window.visibleTextEditors.map(e => e.viewColumn).filter((c): c is vscode.ViewColumn => !!c));
	const editors = [...recent.filter(c => open.has(c)), ...[...open].filter(c => !recent.includes(c))];
	return chooseColumns([...panels].map(p => p.viewColumn).filter((c): c is vscode.ViewColumn => !!c), editors);
}
/** The group coee's pages live in, as tabs. */
export const coeeColumn = (): vscode.ViewColumn => columns().coee;
/** The group code opens in: never coee's. */
export const codeColumn = (): vscode.ViewColumn => columns().code;

/** A coee page, created in coee's group without taking focus. */
export function createPanel(type: string, title: string, opts: vscode.WebviewPanelOptions & vscode.WebviewOptions): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel(type, title, { viewColumn: coeeColumn(), preserveFocus: true }, opts);
	panels.add(panel);
	panel.onDidDispose(() => panels.delete(panel));
	return panel;
}
