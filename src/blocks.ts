// Where a block of code ends. Pure; shared by the prompt repair and the code index.

/** Last line (0-based) of the block that starts at `start`: matching braces, else the indented body. Capped, so a miss stays small. */
export function blockEnd(lines: readonly string[], start: number, max = 150): number {
	const cap = Math.min(lines.length - 1, start + max);
	let depth = 0, opened = false;
	// A statement that ends on its own line (";") has no body of its own; brace-matching would run into the next block.
	const braced = !/;\s*$/.test(lines[start]) && lines.slice(start, start + 3).some(l => l.includes('{'));
	for (let i = start; braced && i <= cap; i++) {
		for (const ch of lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')) {
			if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
		}
		if (opened && depth <= 0) return i;
	}
	// No braces (Python, YAML, a one-liner): the block is what is indented deeper than its first line.
	const indent = (l: string) => l.length - l.trimStart().length;
	let end = start;
	for (let i = start + 1; i <= cap; i++) {
		if (!lines[i].trim()) continue;
		if (indent(lines[i]) <= indent(lines[start])) break;
		end = i;
	}
	return end;
}
