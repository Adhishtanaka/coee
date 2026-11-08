// Where coee's pages and the code go. Pure, so it's unit-testable; ui.ts feeds it the live editor state.

/**
 * coee keeps to one editor group (its pages are tabs there) and the code to another.
 * `panels`: groups holding a coee page now. `editors`: groups holding a text editor, most recently used first.
 */
export function chooseColumns(panels: readonly number[], editors: readonly number[]): { coee: number; code: number } {
	const coee = panels[0] ?? Math.max(1, ...editors.slice(0, 1)) + 1;
	const code = editors.find(c => c !== coee) ?? (coee === 1 ? 2 : 1);
	return { coee, code };
}
