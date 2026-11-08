// Layered left-to-right layout for the system map. Pure, so it's testable.

export interface Cell { col: number; row: number }

/**
 * Column = longest path from a source (cycles are broken where first met).
 * Row order within a column follows the average row of each node's predecessors (one barycenter pass).
 */
export function layers(ids: string[], edges: ReadonlyArray<{ from: string; to: string }>): Record<string, Cell> {
	const succ = new Map<string, string[]>(ids.map(id => [id, []]));
	for (const e of edges) if (succ.has(e.from) && succ.has(e.to) && e.from !== e.to) succ.get(e.from)!.push(e.to);

	// DFS in the given order; an edge back to a node still on the stack closes a cycle and is dropped.
	const preds = new Map<string, string[]>(ids.map(id => [id, []]));
	const seen = new Map<string, 'open' | 'done'>();
	const visit = (u: string) => {
		seen.set(u, 'open');
		for (const v of succ.get(u)!) {
			if (seen.get(v) === 'open') continue;
			preds.get(v)!.push(u);
			if (!seen.has(v)) visit(v);
		}
		seen.set(u, 'done');
	};
	ids.forEach(id => seen.has(id) || visit(id));

	const col = new Map<string, number>();
	const depth = (id: string): number => {
		if (!col.has(id)) col.set(id, Math.max(-1, ...preds.get(id)!.map(depth)) + 1);
		return col.get(id)!;
	};
	ids.forEach(depth);

	const out: Record<string, Cell> = {};
	const columns: string[][] = [];
	for (const id of ids) (columns[col.get(id)!] ??= []).push(id);
	for (const members of columns) {
		if (!members) continue;
		const score = (id: string) => {
			const rows = preds.get(id)!.map(p => out[p]?.row).filter((r): r is number => r !== undefined);
			return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity;
		};
		members
			.map((id, i) => ({ id, s: score(id), i }))
			.sort((a, b) => a.s - b.s || a.i - b.i)
			.forEach(({ id }, row) => { out[id] = { col: col.get(id)!, row }; });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Walkthrough diagrams, drawn here (not in a webview) so the walkthrough tab and "Open larger" share one SVG.

export interface DiagramInput {
	kind?: 'flow' | 'sequence' | 'state';
	focus?: string;
	nodes: Array<{ id: string; label: string; detail?: string }>;
	/** `branch` (sequence): consecutive messages with the same branch are framed, e.g. "if over the limit". */
	edges: Array<{ from: string; to: string; label?: string; reply?: boolean; branch?: string }>;
}

/** One colour per component, readable on dark and light themes; the map and the architecture page use the same ones. */

const THEMES = {
	dark: { focusFill: '#16202c', node: '#1f2329', stroke: '#3a3f47', text: '#e6e6e6', detail: '#9aa0a6', edge: '#5b8bd0', elabel: '#c6cbd1', elabelBg: '#181a1f' },
	light: { focusFill: '#eef4fc', node: '#f6f8fa', stroke: '#d0d7de', text: '#1f2328', detail: '#59636e', edge: '#3b6fb6', elabel: '#33393f', elabelBg: '#ffffff' },
};

const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

/** Greedy word wrap into at most `max` lines of `width` chars. */
export function wrap(text: string, width: number, max: number): string[] {
	const lines: string[] = [];
	let cur = '';
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (!cur) cur = word;
		else if ((cur + ' ' + word).length <= width) cur += ' ' + word;
		else { lines.push(cur); cur = word; }
	}
	if (cur) lines.push(cur);
	if (lines.length > max) { lines.length = max; lines[max - 1] = clip(lines[max - 1] + ' …', width); }
	return lines.map(l => clip(l, width));
}

/**
 * Left-to-right boxes (title + detail) and labelled curved arrows.
 * ponytail: character-count text metrics; measure with canvas if labels start overflowing.
 */
export function diagramSvg(d: DiagramInput, theme: 'dark' | 'light', maxWidth = 640): { svg: string; width: number; height: number } {
	if (d.kind === 'sequence') return sequenceSvg(d, theme, maxWidth);
	const c = THEMES[theme];
	const state = d.kind === 'state', X0 = state ? 52 : 0; // room for the initial-state dot
	const W = 190, GX = 110, GY = 24, PAD = 16, FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
	const details = new Map(d.nodes.map(n => [n.id, n.detail ? wrap(n.detail, 30, 2) : []]));
	const H = 42 + 14 * Math.max(0, ...[...details.values()].map(l => l.length));
	const loops = d.edges.some(e => e.from === e.to), TOP = loops ? 40 : 0; // room for self-transitions above the boxes
	const cells = layers(d.nodes.map(n => n.id), d.edges);
	const cols: string[][] = [];
	for (const n of d.nodes) (cols[cells[n.id].col] ??= [])[cells[n.id].row] = n.id;
	const tallest = Math.max(...cols.map(col => col?.length ?? 0));
	const pos: Record<string, { x: number; y: number }> = {};
	cols.forEach((members, col) => members?.forEach((id, row) => {
		pos[id] = { x: X0 + PAD + col * (W + GX), y: TOP + PAD + (tallest - members.length) * (H + GY) / 2 + row * (H + GY) };
	}));
	const backs = d.edges.filter(e => e.from !== e.to && pos[e.to].x <= pos[e.from].x).length;
	const width = X0 + PAD * 2 + cols.length * W + (cols.length - 1) * GX;
	const floor = TOP + PAD + tallest * H + (tallest - 1) * GY; // bottom of the lowest box
	const height = floor + PAD + backs * 22 + (backs ? 18 : 0);
	let lane = 0;

	const paths: string[] = [], labels: string[] = [];
	for (const e of d.edges) {
		const a = pos[e.from], b = pos[e.to];
		let pts: number[];
		if (e.from === e.to) { // a transition back into the same state: a loop over the top
			const x1 = a.x + W * 0.38, x2 = a.x + W * 0.62, y = a.y;
			pts = [x1, y, x1 - 6, y - 40, x2 + 6, y - 40, x2, y - 2];
		} else if (b.x > a.x) {
			const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, dx = (x2 - x1) / 2;
			pts = [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2];
		} else { // same column or pointing back: loop below every box, one lane per such edge
			const x1 = a.x + W / 2 - 12, y1 = a.y + H, x2 = b.x + W / 2 + 12, y2 = b.y + H + 2, low = floor + 26 + 22 * lane++;
			pts = [x1, y1, x1, low + 12, x2, low + 12, x2, y2];
		}
		const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = pts;
		paths.push(`<path d="M${x1} ${y1}C${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}" fill="none" stroke="${c.edge}" stroke-width="1.5" marker-end="url(#a)"/>`);
		if (e.label) {
			const t = 0.5, u = 1 - t, at = (p: number, q: number, r: number, s: number) => u * u * u * p + 3 * u * u * t * q + 3 * u * t * t * r + t * t * t * s;
			const lx = at(x1, c1x, c2x, x2), ly = at(y1, c1y, c2y, y2), text = clip(e.label, 26), w = text.length * 6.2 + 12;
			labels.push(`<rect x="${(lx - w / 2).toFixed(1)}" y="${(ly - 9).toFixed(1)}" width="${w.toFixed(1)}" height="18" rx="4" fill="${c.elabelBg}" stroke="${c.stroke}"/>`
				+ `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="${c.elabel}">${xml(text)}</text>`);
		}
	}
	const boxes = d.nodes.map(n => {
		const { x, y } = pos[n.id];
		const lines = details.get(n.id)!;
		const top = y + (H - 18 - 14 * lines.length) / 2 + 13;
		const on = n.id === d.focus; // the node this step is about
		const rx = state ? Math.min(22, H / 2) : 6;
		// A state nothing leaves is where the lifecycle ends: drawn with a double border, as in UML.
		const final = state && d.nodes.length > 1 && !d.edges.some(e => e.from === n.id && e.to !== n.id);
		return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="${rx}" fill="${on ? c.focusFill : c.node}" stroke="${on ? c.edge : c.stroke}" stroke-width="${on ? 1.6 : 1}"/>`
			+ (final ? `<rect x="${x + 4}" y="${y + 4}" width="${W - 8}" height="${H - 8}" rx="${Math.max(2, rx - 4)}" fill="none" stroke="${c.stroke}"/>` : '')

			+ `<text x="${x + W / 2}" y="${top}" text-anchor="middle" font-size="13" font-weight="600" fill="${c.text}">${xml(clip(n.label, 26))}</text>`
			+ lines.map((l, i) => `<text x="${x + W / 2}" y="${top + 18 + i * 14}" text-anchor="middle" font-size="11" fill="${c.detail}">${xml(l)}</text>`).join('');
	});
	if (state) { // UML-style initial state: a filled dot pointing at the first state
		const first = pos[d.nodes[0].id], cy = first.y + H / 2;
		paths.push(`<circle cx="${PAD + 8}" cy="${cy}" r="7" fill="${c.edge}"/><path d="M${PAD + 15} ${cy}L${first.x - 2} ${cy}" stroke="${c.edge}" stroke-width="1.5" fill="none" marker-end="url(#a)"/>`);
	}
	const scale = Math.min(1, maxWidth / width);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="0 0 ${width} ${height}" font-family="${xml(FONT)}">`
		+ `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="${c.edge}"/></marker></defs>`
		+ paths.join('') + boxes.join('') + labels.join('') + '</svg>';
	return { svg, width, height };
}

/** Participants across the top, lifelines down, numbered messages in time order; replies dashed. */
function sequenceSvg(d: DiagramInput, theme: 'dark' | 'light', maxWidth: number): { svg: string; width: number; height: number } {
	const c = THEMES[theme];
	const W = 128, LANE = 152, PAD = 16, ROW = 38, FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
	const details = d.nodes.map(n => n.detail ? wrap(n.detail, 20, 2) : []);
	const H = 38 + 14 * Math.max(0, ...details.map(l => l.length));
	const cx = new Map(d.nodes.map((n, i) => [n.id, PAD + i * LANE + W / 2]));
	// Messages that open a new branch frame need room for its tab.
	const gaps: number[] = d.edges.map((e, k) => e.branch && e.branch !== d.edges[k - 1]?.branch ? 26 : 0);
	const yAt = (k: number) => PAD + H + 34 + k * ROW + gaps.slice(0, k + 1).reduce((a, b) => a + b, 0);
	const y0 = PAD + H + 34, yEnd = yAt(Math.max(0, d.edges.length - 1)) + 26;
	const width = PAD * 2 + (d.nodes.length - 1) * LANE + W + 40, height = yEnd + PAD;
	const out: string[] = [];
	// Alternative paths ("if over the limit", "on error"): a dashed frame around consecutive messages of one branch.
	for (let k = 0; k < d.edges.length;) {
		const branch = d.edges[k].branch;
		let j = k;
		while (j + 1 < d.edges.length && d.edges[j + 1].branch === branch) j++;
		if (branch) {
			const xs = d.edges.slice(k, j + 1).flatMap(e => [cx.get(e.from)!, cx.get(e.to)!]);
			const left = Math.max(4, Math.min(...xs) - 54), right = Math.min(width - 4, Math.max(...xs) + 54);
			const top = yAt(k) - 46, bottom = yAt(j) + 12, tag = clip(branch, 34), tw = (tag.length + 4) * 6.4 + 16;
			out.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="4" fill="none" stroke="${c.detail}" stroke-dasharray="5 4"/>`,
				`<path d="M${left} ${top}h${tw}v12l-8 8H${left}z" fill="${c.elabelBg}" stroke="${c.detail}"/>`,
				`<text x="${left + 6}" y="${top + 14}" font-size="11" fill="${c.elabel}"><tspan font-weight="600">alt</tspan> ${xml(tag)}</text>`);
		}
		k = j + 1;
	}
	d.nodes.forEach((n, i) => {
		const x = cx.get(n.id)!;
		out.push(`<path d="M${x} ${PAD + H}L${x} ${yEnd}" stroke="${c.stroke}" stroke-width="1.5" stroke-dasharray="4 4" fill="none"/>`,
			`<rect x="${x - W / 2}" y="${PAD}" width="${W}" height="${H}" rx="6" fill="${n.id === d.focus ? c.focusFill : c.node}" stroke="${n.id === d.focus ? c.edge : c.stroke}" stroke-width="${n.id === d.focus ? 1.6 : 1}"/>`,
			`<text x="${x}" y="${PAD + 23}" text-anchor="middle" font-size="13" font-weight="600" fill="${c.text}">${xml(clip(n.label, 17))}</text>`,
			...details[i].map((l, k) => `<text x="${x}" y="${PAD + 40 + k * 14}" text-anchor="middle" font-size="11" fill="${c.detail}">${xml(l)}</text>`));
	});
	d.edges.forEach((e, k) => {
		const y = yAt(k), a = cx.get(e.from)!, b = cx.get(e.to)!;
		const dash = e.reply ? ' stroke-dasharray="5 4"' : '';
		const text = `${k + 1}. ${clip(e.label ?? '', 44)}`.trim();
		if (a === b) { // a call to itself
			out.push(`<path d="M${a} ${y - 6}h34v14h-32" fill="none" stroke="${c.edge}" stroke-width="1.5"${dash} marker-end="url(#a)"/>`,
				`<text x="${a + 40}" y="${y + 4}" font-size="11" fill="${c.elabel}">${xml(text)}</text>`);
			return;
		}
		const w = text.length * 6.2 + 10, mid = (a + b) / 2;
		out.push(`<path d="M${a} ${y}L${b + (b > a ? -3 : 3)} ${y}" fill="none" stroke="${c.edge}" stroke-width="1.5"${dash} marker-end="url(#a)"/>`,
			`<rect x="${(mid - w / 2).toFixed(1)}" y="${y - 21}" width="${w.toFixed(1)}" height="16" rx="3" fill="${c.elabelBg}"/>`,
			`<text x="${mid}" y="${y - 9}" text-anchor="middle" font-size="11" fill="${c.elabel}">${xml(text)}</text>`);
	});
	const scale = Math.min(1, maxWidth / width);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="0 0 ${width} ${height}" font-family="${xml(FONT)}">`
		+ `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="${c.edge}"/></marker></defs>`
		+ out.join('') + '</svg>';
	return { svg, width, height };
}

// ---------------------------------------------------------------------------
// ER diagrams: the data model, as entities with their fields and the relations between them

export interface ErInput {
	entities: Array<{ id: string; name: string; fields: Array<{ name: string; type?: string; key?: 'pk' | 'fk' }> }>;
	/** `card`: "1-1", "1-n", "n-1" or "n-n", read from → to. */
	relations: Array<{ from: string; to: string; label?: string; card?: string }>;
}

const ER_FIELDS = 8;

/** Entity boxes (name, then fields with PK/FK marks) laid out left to right, relations with 1/N at each end. */
export function erSvg(m: ErInput, theme: 'dark' | 'light', maxWidth = 1000): { svg: string; width: number; height: number } {
	const c = THEMES[theme];
	const W = 220, GX = 130, GY = 28, PAD = 18, HEAD = 30, ROW = 19, FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
	const ids = m.entities.map(e => e.id);
	const shown = (e: ErInput['entities'][0]) => Math.min(e.fields.length, ER_FIELDS) + (e.fields.length > ER_FIELDS ? 1 : 0);
	const heightOf = new Map(m.entities.map(e => [e.id, HEAD + ROW * Math.max(1, shown(e)) + 10]));
	const cells = layers(ids, m.relations);
	const cols: string[][] = [];
	for (const id of ids) (cols[cells[id].col] ??= [])[cells[id].row] = id;
	const colHeight = (col: string[]) => col.reduce((h, id) => h + heightOf.get(id)! + GY, -GY);
	const tallest = Math.max(...cols.map(col => col ? colHeight(col.filter(Boolean)) : 0));
	const pos: Record<string, { x: number; y: number }> = {};
	cols.forEach((members, col) => {
		let y = PAD + (tallest - colHeight(members.filter(Boolean))) / 2;
		for (const id of members.filter(Boolean)) { pos[id] = { x: PAD + col * (W + GX), y }; y += heightOf.get(id)! + GY; }
	});
	const width = PAD * 2 + cols.length * W + (cols.length - 1) * GX;
	let height = PAD * 2 + tallest;
	const out: string[] = [], labels: string[] = [];
	const ends = (card?: string) => (card ?? '').toLowerCase().split(/[-:]/).map(x => x === 'n' || x === 'm' || x === '*' ? 'N' : x === '1' ? '1' : '');
	let lane = 0;
	for (const r of m.relations) {
		const a = pos[r.from], b = pos[r.to];
		if (!a || !b) continue;
		const ha = heightOf.get(r.from)!, hb = heightOf.get(r.to)!;
		let x1: number, y1: number, x2: number, y2: number, d: string, e1: [number, number], e2: [number, number];
		if (Math.abs(b.x - a.x) > W + GX) { // skips a column: run underneath every box instead of through one
			x1 = a.x + W / 2; y1 = a.y + ha; x2 = b.x + W / 2; y2 = b.y + hb;
			const low = PAD + tallest + 26 + 22 * lane++;
			d = `M${x1} ${y1}C${x1} ${low + 14} ${x2} ${low + 14} ${x2} ${y2}`;
			e1 = [x1 + 10, y1 + 14]; e2 = [x2 + 10, y2 + 14];
			height = Math.max(height, low + 30);
		} else if (b.x !== a.x) { // side to side
			const right = b.x > a.x;
			x1 = right ? a.x + W : a.x; y1 = a.y + Math.min(ha / 2, HEAD + 6);
			x2 = right ? b.x : b.x + W; y2 = b.y + Math.min(hb / 2, HEAD + 6);
			const dx = (x2 - x1) / 2;
			d = `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
			e1 = [x1 + (right ? 10 : -10), y1 - 6]; e2 = [x2 + (right ? -10 : 10), y2 - 6];
		} else { // same column: around the right-hand side
			x1 = a.x + W; y1 = a.y + ha / 2; x2 = b.x + W; y2 = b.y + hb / 2;
			const out2 = x1 + 40 + 16 * lane++;
			d = `M${x1} ${y1}C${out2} ${y1} ${out2} ${y2} ${x2} ${y2}`;
			e1 = [x1 + 10, y1 - 6]; e2 = [x2 + 10, y2 - 6];
		}
		out.push(`<path d="${d}" fill="none" stroke="${c.edge}" stroke-width="1.5"/>`);
		const [from, to] = ends(r.card);
		if (from) labels.push(`<text x="${e1[0]}" y="${e1[1]}" text-anchor="middle" font-size="11" font-weight="600" fill="${c.edge}">${from}</text>`);
		if (to) labels.push(`<text x="${e2[0]}" y="${e2[1]}" text-anchor="middle" font-size="11" font-weight="600" fill="${c.edge}">${to}</text>`);
		if (r.label) {
			const under = Math.abs(b.x - a.x) > W + GX;
			const text = clip(r.label, 22), w = text.length * 6.2 + 12, mx = (x1 + x2) / 2 + (b.x === a.x ? 30 : 0);
			const my = under ? 0.25 * (y1 + y2) / 2 + 0.75 * (PAD + tallest + 26 + 22 * (lane - 1) + 14) : (y1 + y2) / 2;
			labels.push(`<rect x="${(mx - w / 2).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="${w.toFixed(1)}" height="18" rx="4" fill="${c.elabelBg}" stroke="${c.stroke}"/>`
				+ `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="${c.elabel}">${xml(text)}</text>`);
		}
	}
	const boxes = m.entities.filter(e => pos[e.id]).map(e => {
		const { x, y } = pos[e.id], h = heightOf.get(e.id)!, accent = c.edge;
		const rows = e.fields.slice(0, ER_FIELDS).map((f, i) => {
			const ry = y + HEAD + 14 + i * ROW;
			const badge = f.key ? `<text x="${x + 10}" y="${ry}" font-size="9" font-weight="700" fill="${f.key === 'pk' ? accent : c.detail}">${f.key.toUpperCase()}</text>` : '';
			return badge + `<text x="${x + 34}" y="${ry}" font-size="12" fill="${c.text}"${f.key === 'pk' ? ' font-weight="600"' : ''}>${xml(clip(f.name, 18))}</text>`
				+ (f.type ? `<text x="${x + W - 10}" y="${ry}" text-anchor="end" font-size="11" fill="${c.detail}">${xml(clip(f.type, 12))}</text>` : '');
		});
		if (e.fields.length > ER_FIELDS) rows.push(`<text x="${x + 34}" y="${y + HEAD + 14 + ER_FIELDS * ROW}" font-size="11" fill="${c.detail}">+ ${e.fields.length - ER_FIELDS} more</text>`);
		if (!e.fields.length) rows.push(`<text x="${x + 34}" y="${y + HEAD + 14}" font-size="11" fill="${c.detail}">(fields not shown)</text>`);
		return `<rect x="${x}" y="${y}" width="${W}" height="${h}" rx="6" fill="${c.node}" stroke="${c.stroke}"/>`
			+ `<path d="M${x} ${y + HEAD}H${x + W}" stroke="${c.stroke}"/>`
			+ `<text x="${x + 12}" y="${y + 20}" font-size="13" font-weight="600" fill="${c.text}">${xml(clip(e.name, 24))}</text>` + rows.join('');
	});
	height = Math.max(height, ...Object.entries(pos).map(([id, p]) => p.y + heightOf.get(id)! + PAD));
	const scale = Math.min(1, maxWidth / width);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="0 0 ${width} ${height}" font-family="${xml(FONT)}">`
		+ out.join('') + boxes.join('') + labels.join('') + '</svg>';
	return { svg, width, height };
}
