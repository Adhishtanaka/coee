// What the model sees of a codebase, for a given budget (characters). After pr-agent's compression strategy:
// rank the files, show the most important ones whole, the rest as outlines from the code index (signatures, routes,
// data shapes, rules, with real line numbers), then just their names. Nothing is silently dropped.
// Pure, so the harness can check that every expected fact reaches the prompt at any budget.
import { FileIndex, ProjectIndex, indexProject, langOf, outline } from './codeindex';

export interface PackedContext {
	text: string;
	full: string[];
	outlined: string[];
	named: string[];
}

const numbered = (text: string) => text.split('\n').map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.map)$/;

/**
 * Most important first: files the task is about, entry points, files many others import (core), then the project's
 * main language before the rest, then smaller before bigger (more of the codebase fits).
 */
export function rankFiles(files: ReadonlyArray<{ path: string; text: string }>, idx: ProjectIndex, focus: readonly string[] = []): string[] {
	const langs = new Map<string, number>();
	for (const f of files) { const l = langOf(f.path); if (l !== 'other') langs.set(l, (langs.get(l) ?? 0) + f.text.length); }
	const main = [...langs].sort((a, b) => b[1] - a[1])[0]?.[0];
	const score = (f: { path: string; text: string }) => {
		const fi = idx.files.get(f.path);
		return (focus.includes(f.path) ? 1000 - focus.indexOf(f.path) : 0)
			+ (fi?.entry ? 300 : 0)
			+ Math.min(200, (idx.importedBy.get(f.path)?.length ?? 0) * 40)
			+ (fi && (fi.routes.length || fi.dtos.length) ? 60 : 0)
			+ (langOf(f.path) === main ? 50 : 0)
			- (/\.(md|json|ya?ml|toml|lock)$/i.test(f.path) ? 40 : 0)
			- (/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\./i.test(f.path) ? 30 : 0);
	};
	return [...files].filter(f => !NOISE.test(f.path)).sort((a, b) => score(b) - score(a) || a.text.length - b.text.length).map(f => f.path);
}

/**
 * Files into `room` characters. Outlines of everything are reserved first (so structure is never lost), then files
 * are upgraded to whole in rank order while that still fits; a file shown whole doesn't need its outline.
 */
export function packContext(files: ReadonlyArray<{ path: string; text: string }>, room: number, focus: readonly string[] = [], idx = indexProject(files)): PackedContext {
	const byPath = new Map(files.map(f => [f.path, f]));
	const order = rankFiles(files, idx, focus);
	// One file's outline gets at most a fair share of the room (a 3,000-function file would otherwise crowd out the rest).
	const n = Math.max(1, order.length), headers = order.reduce((t, p) => t + p.length + 70, 0);
	const share = Math.max(200, Math.min(room - headers, Math.max(1200, Math.floor(room / n) * 3)));
	const cut = (text: string) => {
		if (text.length <= share) return text;
		const kept = text.slice(0, share).split('\n').slice(0, -1);
		return `${kept.join('\n')}\n… ${text.split('\n').length - kept.length} more declarations`;
	};
	const outlines = new Map(order.map(p => [p, `--- ${p} (outline: what it declares, with real line numbers)\n${cut(outline(idx.files.get(p) as FileIndex)) || '(nothing declared)'}`]));
	const fulls = new Map(order.map(p => [p, `--- ${p}\n${numbered(byPath.get(p)!.text)}`]));
	// Structure first: every file's outline, in rank order, while it fits (a big one is skipped, smaller ones still go).
	const outlined = new Set<string>();
	let reserve = 0;
	for (const p of order) { const n = outlines.get(p)!.length + 2; if (reserve + n > room) continue; outlined.add(p); reserve += n; }
	// Whole files: in rank order, while the file plus the outlines still to show fit.
	const full: string[] = [];
	let used = 0;
	for (const p of order) {
		const cost = fulls.get(p)!.length + 2 - (outlined.has(p) ? outlines.get(p)!.length + 2 : 0);
		if (used + reserve + cost > room) continue;
		full.push(p);
		used += fulls.get(p)!.length + 2;
		if (outlined.has(p)) { reserve -= outlines.get(p)!.length + 2; outlined.delete(p); }
	}
	const named = order.filter(p => !full.includes(p) && !outlined.has(p));
	const parts = [...order.filter(p => full.includes(p)).map(p => fulls.get(p)!), ...order.filter(p => outlined.has(p)).map(p => outlines.get(p)!)];
	if (named.length) parts.push(`Other files (not shown): ${named.join(', ')}`);
	return { text: parts.join('\n\n'), full, outlined: [...outlined], named };
}

/** One line for the page: how much of the code the model saw, and how. */
export function coverageNote(p: PackedContext): string {
	const total = p.full.length + p.outlined.length + p.named.length;
	if (p.full.length === total) return `Read all ${total} files in full.`;
	return `Read all ${total} files: ${p.full.length} in full, ${p.outlined.length} as outlines (functions, routes, data shapes and rules)${p.named.length ? `, ${p.named.length} by name only` : ''}.`;
}
