// The steps of a walkthrough, decided by coee rather than the model: "Start here", then every function, class and
// method in the order the code runs (call order), then "How it fits together". Each step has its exact lines, what it
// calls, what calls it, and the rules (guards, validation) inside it. The model only writes the words.
// Pure, so the harness checks that every function gets a step and every range is exact.
import { indexProject } from './codeindex';

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

export interface SymbolSpan { name: string; kind: 'function' | 'method' | 'class'; line: number; end: number; signature?: string }

const MAX_STEPS = 12;

/**
 * Steps for lines `first`..`last` (1-based, inclusive) of a file. `symbols` (from the editor's language server, when
 * there is one) win over the index's own; `firstPart`/`lastPart` say whether this range starts or ends the walkthrough.
 */
export function planSteps(file: string, text: string, first: number, last: number, opts: { firstPart?: boolean; lastPart?: boolean; symbols?: SymbolSpan[] } = {}): Step[] {
	const fi = indexProject([{ path: file, text }]).files.get(file)!; // the project index also works out who calls whom
	const all = (opts.symbols?.length ? opts.symbols : fi.symbols).filter(s => s.line >= first && s.line <= last);
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
		return [{ names: [s.name], startLine: s.line, endLine: Math.min(s.end, last), label: `${s.kind} ${s.name}`, signature: s.signature, kind: 'symbol' }];
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
	const lines = text.split('\n');
	if (opts.firstPart) {
		// What comes before the first symbol: imports, constants, module state, and how the file starts.
		const top = Math.min(...units.map(u => u.startLine));
		const pre = lines.slice(first - 1, top - 1);
		const lastReal = pre.map(l => l.trim()).reduce((k, l, i) => (l ? i : k), -1);
		if (lastReal >= 0) steps.push({ id: '', kind: 'start', label: 'Start here', names: [], startLine: first, endLine: first + lastReal, calls: [], calledBy: [], rules: rulesIn(first, first + lastReal) });
		else units[0] = { ...units[0], label: `Start here · ${units[0].label}` };
	}
	for (const u of units) {
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
