// Where a block of code ends. Pure; shared by the prompt repair, the code index and the walkthrough steps.
// Braces are counted only in code: never inside strings, template literals (which can span lines), regular expression
// literals or comments, so a `{` in "a { string" or /[{]/ can't end a function early or late.

type State = 'code' | 'block' | 'template';

/**
 * Reads lines one at a time and gives each line's code characters (strings, comments, template text and regex
 * literals blanked), carrying state across lines. Lazy, so finding a block's end costs only the block's own lines.
 */
export function codeLines(lines: readonly string[], from: number, to: number, hashComments = false): Iterable<string> {
	return { *[Symbol.iterator]() {
		let state: State = 'code';
		const templateDepth: number[] = []; // brace depth inside each open `${ … }`
		for (let i = from; i <= to; i++) {
			const l = lines[i] ?? '';
			let kept = '';
			let prev = ''; // last code character that isn't a space, to tell a regex from a division
			for (let k = 0; k < l.length; k++) {
				const c = l[k], n = l[k + 1];
				if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; k++; } continue; }
				if (state === 'template') {
					if (c === '\\') { k++; continue; }
					if (c === '`') { state = 'code'; continue; }
					if (c === '$' && n === '{') { templateDepth.push(0); state = 'code'; kept += '{'; k++; continue; }
					continue;
				}
				if (c === '/' && n === '/') break;
				if (hashComments && c === '#') break;
				if (c === '/' && n === '*') { state = 'block'; k++; continue; }
				if (c === '"' || c === "'") { // a string: skip to its closing quote on this line
					for (k++; k < l.length && l[k] !== c; k++) if (l[k] === '\\') k++;
					prev = c;
					continue;
				}
				if (c === '`') { state = 'template'; continue; }
				if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|in|of)$/.test(kept.trimEnd()))) {
					// A regular expression literal: skip to its closing slash (classes like [/] included).
					let inClass = false;
					for (k++; k < l.length; k++) {
						if (l[k] === '\\') { k++; continue; }
						if (l[k] === '[') inClass = true; else if (l[k] === ']') inClass = false; else if (l[k] === '/' && !inClass) break;
					}
					prev = '/';
					continue;
				}
				if (templateDepth.length) {
					if (c === '{') templateDepth[templateDepth.length - 1]++;
					if (c === '}') {
						if (templateDepth[templateDepth.length - 1] === 0) { templateDepth.pop(); state = 'template'; kept += '}'; continue; }
						templateDepth[templateDepth.length - 1]--;
					}
				}
				kept += c;
				if (c.trim()) prev = c;
			}
			yield kept;
		}
	} };
}

/** All the code lines at once (for short ranges). */
export function codeOnly(lines: readonly string[], from: number, to: number, hashComments = false): string[] {
	return [...codeLines(lines, from, to, hashComments)];
}

/** Last line (0-based) of the block that starts at `start`: matching braces, else the indented body. Capped, so a miss stays small. */
export function blockEnd(lines: readonly string[], start: number, max = 150): number {
	const cap = Math.min(lines.length - 1, start + max);
	let depth = 0, opened = false;
	const python = /^\s*(async\s+)?(def|class)\b|:\s*$/.test(lines[start] ?? '') && !/[{]\s*$/.test(lines[start] ?? '');
	const head = codeOnly(lines, start, Math.min(cap, start + 2), python);
	// A statement that ends on its own line (";") has no body of its own; brace-matching would run into the next block.
	const braced = !python && !/;\s*$/.test(head[0]) && head.some(l => l.includes('{'));
	if (braced) {
		let i = start;
		for (const line of codeLines(lines, start, cap)) {
			for (const ch of line) {
				if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
			}
			if (opened && depth <= 0) return i;
			i++;
		}
	}
	// No braces (Python, YAML, a one-liner): the block is what is indented deeper than its first line.
	const indent = (l: string) => l.length - l.trimStart().length;
	let end = start;
	for (let i = start + 1; i <= cap; i++) {
		if (!lines[i].trim()) continue;
		if (indent(lines[i]) <= indent(lines[start])) break;
		end = i;
	}
	// A multi-line statement without braces (`const x = items\n  .map(...)\n  .filter(...);`) runs to its semicolon.
	if (end === start && !braced && !python && !/[;{}]\s*$/.test(head[0])) {
		let i = start;
		for (const line of codeLines(lines, start, Math.min(cap, start + 30))) { if (i > start && /;\s*$/.test(line)) return i; i++; }
	}
	return end;
}
