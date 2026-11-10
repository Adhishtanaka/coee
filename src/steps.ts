// The steps of a walkthrough, decided by coee rather than the model: "Start here", then every function, class and
// method in the order the code runs (call order), then "How it fits together". Each step has its exact lines, what it
// calls, what calls it, and the rules (guards, validation) inside it. The model only writes the words.
// Pure, so the harness checks that every function gets a step and every range is exact.
import { indexProject } from './codeindex';
import { blockEnd } from './blocks';

export interface Step {
	id: string;
	kind: 'start' | 'symbol' | 'group' | 'together';
	label: string;
	/** The symbol (or symbols, for a group of small ones) this step explains. */
	names: string[];
	startLine: number;
	endLine: number;
	signature?: string;
	calls: string[];
	calledBy: string[];
	rules: string[];
}

export interface SymbolSpan { name: string; kind: 'function' | 'method' | 'class' | 'route' | 'event'; line: number; end: number; signature?: string }

/**
 * The index's symbols, with the language server's exact ranges where it knows the same symbol (same name, within a few
 * lines: it may start at a decorator). Its pseudo-symbols ("createServer() callback", "<anonymous>") are dropped; inline
 * handlers are covered as routes instead.
 */
export function mergeSymbols(index: readonly SymbolSpan[], server: readonly SymbolSpan[]): SymbolSpan[] {
	const real = server.filter(s => /^[A-Za-z_$][\w$]*$/.test(s.name) && s.end >= s.line);
	const out = index.map(s => {
		const m = real.find(r => r.name === s.name && Math.abs(r.line - s.line) <= 3);
		return m ? { ...s, line: Math.min(s.line, m.line), end: m.end } : s;
	});
	for (const r of real) if (!out.some(o => o.name === r.name && Math.abs(o.line - r.line) <= 3)) out.push(r);
	return out.sort((a, b) => a.line - b.line);
}

/** A symbol's step starts at what belongs to it: decorators or annotations (@app.get(...)) and the doc comment right above. */
export function withHeaders(symbols: readonly SymbolSpan[], lines: readonly string[]): SymbolSpan[] {
	return symbols.map(s => {
		let top = s.line - 1; // 0-based first line
		for (let i = top - 1, n = 0; i >= 0 && n < 20; i--, n++) {
			const l = lines[i].trim();
			if (/^@[\w.]+/.test(l) || /^\[[A-Z]\w*(\(.*\))?\]$/.test(l)) { top = i; continue; } // decorator, annotation, C# attribute
			if (/\*\/$/.test(l)) { // the end of a /** … */ block: take it all
				let j = i;
				while (j > 0 && !/^\/\*/.test(lines[j].trim())) j--;
				top = j; i = j; continue;
			}
			if (/^(\/\/\/?|#(?!include|!))/.test(l) && l.length > 2) { top = i; continue; } // line comments right above
			break;
		}
		return top + 1 < s.line ? { ...s, line: top + 1 } : s;
	});
}

/** Inline route handlers (router.post('/x', (req, res) => { … })) get a step of their own, from the route line to the handler's end. */
export function withRoutes(symbols: readonly SymbolSpan[], routes: ReadonlyArray<{ method: string; path: string; line: number }>, lines: readonly string[], events: ReadonlyArray<{ on: string; line: number }> = []): SymbolSpan[] {
	const inside = (l: number) => symbols.some(s => s.kind !== 'class' && s.line <= l && l <= s.end);
	const span = (name: string, kind: 'route' | 'event', line: number) => ({ name, kind, line, end: blockEnd(lines, line - 1, 400) + 1, signature: lines[line - 1].trim().slice(0, 160) });
	const extra = [...routes.filter(r => !inside(r.line)).map(r => span(`${r.method} ${r.path}`, 'route', r.line)),
		// Top-level UI handlers (button.addEventListener('click', () => { … })): a step each, like inline routes. One-liners stay in "Start here".
		...events.filter(e => !inside(e.line) && !routes.some(r => r.line === e.line)).map(e => span(`on ${e.on}`, 'event', e.line)).filter(e => e.end > e.line)];
	return [...symbols, ...extra].sort((a, b) => a.line - b.line);
}

const MAX_STEPS = 12;

/**
 * Steps for lines `first`..`last` (1-based, inclusive) of a file. `symbols` (from the editor's language server, when
 * there is one) win over the index's own; `firstPart`/`lastPart` say whether this range starts or ends the walkthrough.
 */
export function planSteps(file: string, text: string, first: number, last: number, opts: { firstPart?: boolean; lastPart?: boolean; symbols?: SymbolSpan[] } = {}): Step[] {
	const fi = indexProject([{ path: file, text }]).files.get(file)!; // the project index also works out who calls whom
	const lines = text.split('\n');
	const all = withRoutes(withHeaders(mergeSymbols(fi.symbols, opts.symbols ?? []), lines), fi.routes, lines, fi.events).filter(s => s.line >= first && s.line <= last);
	// Functions nested inside other functions belong to their parent's step; methods stay (they're the class's parts).
	const syms = all.filter(s => !all.some(o => o !== s && o.kind !== 'class' && s.kind !== 'method' && o.line < s.line && s.end <= o.end))
		.sort((a, b) => a.line - b.line);
	if (!syms.length) return [];
	const calledBy = new Map<string, string[]>();
	for (const [from, tos] of Object.entries(fi.calls)) for (const to of tos) calledBy.set(to, [...calledBy.get(to) ?? [], from]);
	const rulesIn = (a: number, b: number) => fi.rules.filter(r => r.line >= a && r.line <= b).map(r => r.text);

	// A class's own step is its head and fields (up to its first method); its methods get steps of their own.
	type Unit = { names: string[]; startLine: number; endLine: number; label: string; signature?: string; kind: Step['kind'] };
	let units: Unit[] = syms.flatMap((s): Unit[] => {
		if (s.kind === 'class') {
			const firstMethod = syms.find(m => m.kind === 'method' && m.line > s.line && m.end <= s.end);
			const end = firstMethod ? Math.max(s.line, firstMethod.line - 1) : s.end;
			return [{ names: [s.name], startLine: s.line, endLine: Math.min(end, last), label: `class ${s.name}`, signature: s.signature, kind: 'symbol' }];
		}
		return [{ names: [s.name], startLine: s.line, endLine: Math.min(s.end, last), label: s.kind === 'route' ? `route ${s.name}` : s.kind === 'event' ? `handler ${s.name}` : `${s.kind} ${s.name}`, signature: s.signature, kind: 'symbol' }];
	});

	// Call order: from the roots (nothing here calls them; exported or first), follow what each calls.
	const byName = new Map(units.map(u => [u.names[0], u]));
	const called = new Set(Object.entries(fi.calls).filter(([f]) => byName.has(f)).flatMap(([, t]) => t));
	const exported = new Set(fi.symbols.filter(s => s.exported).map(s => s.name));
	const roots = units.filter(u => !called.has(u.names[0])).sort((a, b) => Number(exported.has(b.names[0])) - Number(exported.has(a.names[0])) || a.startLine - b.startLine);
	const ordered: Unit[] = [], seen = new Set<Unit>();
	const visit = (u: Unit) => {
		if (seen.has(u)) return;
		seen.add(u);
		ordered.push(u);
		for (const c of fi.calls[u.names[0]] ?? []) { const v = byName.get(c); if (v) visit(v); }
	};
	roots.forEach(visit);
	units.filter(u => !seen.has(u)).sort((a, b) => a.startLine - b.startLine).forEach(visit);
	units = ordered;

	// Too many for one walkthrough part: small neighbours (4 lines or fewer) share a step, in source order.
	const budget = MAX_STEPS - (opts.firstPart ? 1 : 0) - (opts.lastPart ? 1 : 0);
	if (units.length > budget) {
		const small = (u: Unit) => u.endLine - u.startLine < 4;
		const bySource = [...units].sort((a, b) => a.startLine - b.startLine);
		const merged: Unit[] = [];
		for (const u of bySource) {
			const prev = merged[merged.length - 1];
			if (prev && small(u) && (prev.kind === 'group' || small(prev)) && prev.names.length < 5 && units.length - (bySource.length - merged.length) >= 0) {
				Object.assign(prev, { kind: 'group', names: [...prev.names, ...u.names], endLine: u.endLine, label: `Small helpers` });
			} else merged.push({ ...u });
		}
		units = merged.length <= budget ? merged : merged; // a part with more big symbols than steps keeps them all: nothing is skipped
	}

	const steps: Step[] = [];

	if (opts.firstPart) {
		// What comes before the first symbol: imports, constants, module state, and how the file starts.
		const top = Math.min(...units.map(u => u.startLine));
		const pre = lines.slice(first - 1, top - 1);
		const lastReal = pre.map(l => l.trim()).reduce((k, l, i) => (l ? i : k), -1);
		if (lastReal >= 0) steps.push({ id: '', kind: 'start', label: 'Start here', names: [], startLine: first, endLine: first + lastReal, calls: [], calledBy: [], rules: rulesIn(first, first + lastReal) });
		else units[0] = { ...units[0], label: `Start here · ${units[0].label}` };
	}
	for (const u of units) {
		while (u.endLine > u.startLine && !lines[u.endLine - 1]?.trim()) u.endLine--; // never end a highlight on blank lines
		const calls = [...new Set(u.names.flatMap(n => fi.calls[n] ?? []))].filter(c => !u.names.includes(c));
		const by = [...new Set(u.names.flatMap(n => calledBy.get(n) ?? []))].filter(c => !u.names.includes(c));
		steps.push({ id: '', kind: u.kind, label: u.label, names: u.names, startLine: u.startLine, endLine: u.endLine, signature: u.signature, calls, calledBy: by, rules: rulesIn(u.startLine, u.endLine) });
	}
	if (opts.lastPart && steps.length >= 3) {
		const hub = steps.find(s => s.kind !== 'start') ?? steps[0];
		steps.push({ id: '', kind: 'together', label: 'How it fits together', names: [], startLine: hub.startLine, endLine: hub.endLine, calls: [], calledBy: [], rules: [] });
	}
	return steps.map((s, i) => ({ ...s, id: `s${i + 1}` }));
}

/**
 * A step the model placed (tours, plans, folders), made to highlight whole code: a range that starts or ends inside a
 * function grows to that whole function (decorators included), so a highlight never stops halfway through one.
 * Blank lines at the edges are trimmed. A range that would grow past 120 lines keeps its own edges.
 * Also returns key lines: the model's, kept if inside the range; else, for a longer range, the rules in it (the
 * checks it's usually about), so the eye knows where to look.
 */
export function snapRange(file: string, text: string, startLine: number, endLine: number, keyLines: readonly KeyLine[] = []): { startLine: number; endLine: number; keyLines?: KeyLine[] } {
	const lines = text.split('\n');
	const fi = indexProject([{ path: file, text }]).files.get(file)!;
	const syms = withRoutes(withHeaders(fi.symbols, lines), fi.routes, lines, fi.events).filter(s => s.kind !== 'class');
	const innermost = (l: number) => syms.filter(s => s.line <= l && l <= s.end).sort((x, y) => (x.end - x.line) - (y.end - y.line))[0];
	let a = startLine, b = Math.max(startLine, endLine);
	const top = innermost(a), bottom = innermost(b);
	const na = top ? Math.min(a, top.line) : a, nb = bottom ? Math.max(b, bottom.end) : b;
	if (nb - na < 120) { a = na; b = nb; }
	while (a < b && !lines[a - 1]?.trim()) a++;
	while (b > a && !lines[b - 1]?.trim()) b--;
	let keys = anchorKeys(lines, a, b, keyLines).slice(0, 4);
	if (!keys.length && b - a >= 6) {
		keys = fi.rules.filter(r => r.line >= a && r.line <= b).slice(0, 4).map(r => {
			// The error message is usually the longest string on the line ("a paid order cannot be cancelled", not "paid").
			const msg = [...r.text.matchAll(/['"`]([^'"`]{3,70})['"`]/g)].map(m => m[1]).sort((x, y) => y.length - x.length)[0];
			return { line: r.line, note: msg ? `stops it: "${msg}"` : r.kind === 'auth' ? 'checks who is asking' : r.kind === 'limit' ? 'enforces a limit' : 'checks the input' };
		});
	}
	return keys.length ? { startLine: a, endLine: b, keyLines: keys } : { startLine: a, endLine: b };
}

export interface KeyLine { line: number; note: string; code?: string }
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const TRIVIAL = /^[\s{}()[\];,]*$/; // blank, or only braces and brackets: never what a note is about

/**
 * Key lines placed by the code they quote, not by the model's line number (often one or two off): each moves to the line
 * in a..b holding its `code`, the nearest one to the number given. A quote found nowhere in the range drops the key (it
 * would mark the wrong code); without a quote, a key on a blank or brace-only line moves to the nearest real line.
 */
export function anchorKeys(lines: readonly string[], a: number, b: number, keys: readonly KeyLine[]): KeyLine[] {
	const out: KeyLine[] = [];
	const near = (from: number, ok: (l: number) => boolean) => {
		for (let d = 0; d <= b - a; d++) for (const l of [from - d, from + d]) if (l >= a && l <= b && ok(l)) return l;
		return 0;
	};
	for (const k of keys) {
		const at = Math.min(b, Math.max(a, k.line || a));
		const q = squash(k.code ?? '').replace(/^\d+\s*\|\s*/, ''); // a quote copied with its "12 | " gutter
		let line = 0;
		if (q.length >= 3) {
			line = near(at, l => squash(lines[l - 1] ?? '') === q) || near(at, l => { const t = squash(lines[l - 1] ?? ''); return t.length >= 3 && (t.includes(q) || q.includes(t) && t.length >= q.length / 2); });
			if (!line) continue;
		} else if (k.line < a || k.line > b) continue; // no quote and outside the step: there's nothing to place it by
		else line = TRIVIAL.test(lines[at - 1] ?? '') ? near(at, l => !TRIVIAL.test(lines[l - 1] ?? '')) : at;
		if (line && !out.some(o => o.line === line)) out.push({ line, note: k.note });
	}
	return out;
}
