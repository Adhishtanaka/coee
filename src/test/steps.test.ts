import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSteps } from '../steps';
import { repairSteps } from '../prompt';

const FILE = [
	"const store = require('./store');",       // 1
	'',                                         // 2
	'function helper(x) {',                     // 3
	'  return x * 2;',                          // 4
	'}',                                        // 5
	'',                                         // 6
	'function handle(req) {',                   // 7
	"  if (!req.id) throw new Error('id is required');", // 8
	'  return helper(store.get(req.id));',      // 9
	'}',                                        // 10
	'',                                         // 11
	'module.exports = { handle };',             // 12
].join('\n');

test('steps: start here, then call order (handle before the helper it calls), then how it fits', () => {
	const steps = planSteps('h.js', FILE, 1, 12, { firstPart: true, lastPart: true });
	assert.deepEqual(steps.map(s => [s.id, s.label]), [['s1', 'Start here'], ['s2', 'function handle'], ['s3', 'function helper'], ['s4', 'How it fits together']]);
	const handle = steps[1];
	assert.deepEqual([handle.startLine, handle.endLine, handle.calls, handle.rules], [7, 10, ['helper'], ["if (!req.id) throw new Error('id is required');"]]);
	assert.deepEqual(steps[2].calledBy, ['handle']);
	assert.deepEqual([steps[0].startLine, steps[0].endLine], [1, 1]);
});

test('steps: a middle part has no start or ending; a range without functions has no steps', () => {
	assert.deepEqual(planSteps('h.js', FILE, 3, 10).map(s => s.label), ['function handle', 'function helper']);
	assert.deepEqual(planSteps('h.js', 'const a = 1;\nconst b = 2;', 1, 2, { firstPart: true }), []);
});

test('steps: many tiny functions share steps, so a part stays readable, and none is dropped', () => {
	const many = Array.from({ length: 30 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');
	const steps = planSteps('m.js', many, 1, 30, { firstPart: true, lastPart: true });
	assert.ok(steps.length <= 12, `${steps.length} steps`);
	assert.deepEqual(new Set(steps.flatMap(s => s.names)).size, 30);
});

test('steps: classes give their head a step and each method its own', () => {
	const cls = ['class Cart {', '  constructor() { this.items = []; }', '  add(item) {', '    this.items.push(item);', '  }', '}'].join('\n');
	const steps = planSteps('c.js', cls, 1, 6, { symbols: [{ name: 'Cart', kind: 'class', line: 1, end: 6 }, { name: 'constructor', kind: 'method', line: 2, end: 2 }, { name: 'add', kind: 'method', line: 3, end: 5 }] });
	assert.deepEqual(steps.map(s => [s.label, s.startLine, s.endLine]), [['class Cart', 1, 1], ['method constructor', 2, 2], ['method add', 3, 5]]);
});

test('repairSteps: lines come from the step; a skipped step is asked for again, then filled from the index', () => {
	const steps = planSteps('h.js', FILE, 1, 12, { firstPart: true, lastPart: true });
	const draft = { title: 'Handler', summary: 's', steps: [
		{ id: 's1', title: 'Imports the store', text: 'It loads the store.' },
		{ id: 's2', title: 'Handles a request', text: 'Checks the id, then doubles the stored value.', inputs: 'req: the request', output: 'a number', rules: ['an id is required'], startLine: 99 },
		{ id: 's4', title: 'Together', text: 'handle validates, then helper computes.' },
	] };
	const { value, errors } = repairSteps(draft, steps);
	assert.match(errors[0], /s3/);
	const [s1, s2, s3] = value!.scenes;
	assert.deepEqual([s2.startLine, s2.endLine, s2.io, s2.rules, s2.calls], [7, 10, { inputs: 'req: the request', output: 'a number' }, ['an id is required'], ['helper']]);
	assert.equal(s3.label, 'function helper');
	assert.match(s3.text, /function helper\(x\)[\s\S]*Called by `handle`/);
	assert.deepEqual(s3.names, ['helper']);
	assert.equal(s1.label, 'Start here');
});

test('long files are split between functions, never inside one', async () => {
	const { packChapters } = await import('../prompt');
	// Lines 0-9 small, 10-209 one 200-line function, 210-299 more small ones (cuts at every function start).
	const cuts = [0, 5, 10, 120, 210, 250];
	const spans = packChapters(0, 299, cuts, 150, [[10, 209], [120, 130]]);
	for (const s of spans) assert.ok(!(s.start > 10 && s.start <= 209), `a part starts inside the big function: ${JSON.stringify(spans)}`);
	assert.equal(spans[spans.length - 1].end, 299);
	assert.equal(spans.map(s => s.end - s.start + 1).reduce((a, b) => a + b), 300, 'every line is in exactly one part');
});

test('language server symbols: exact ranges win, pseudo-symbols are dropped', async () => {
	const { mergeSymbols } = await import('../steps');
	const index = [{ name: 'handle', kind: 'function' as const, line: 5, end: 9 }];
	const server = [
		{ name: 'handle', kind: 'function' as const, line: 4, end: 12 },               // starts at its decorator, ends where the server says
		{ name: 'createServer() callback', kind: 'function' as const, line: 20, end: 30 },
		{ name: 'helper', kind: 'function' as const, line: 14, end: 16 },              // only the server saw it
	];
	assert.deepEqual(mergeSymbols(index, server).map(s => [s.name, s.line, s.end]), [['handle', 4, 12], ['helper', 14, 16]]);
});

test('key lines must sit inside their step; beginner and experienced prompts differ', async () => {
	const { buildStepsPrompt } = await import('../prompt');
	const steps = planSteps('h.js', FILE, 1, 12, { firstPart: true, lastPart: true });
	const draft = { title: 't', summary: 's', steps: steps.map(st => ({ id: st.id, title: 'x', text: 'y',
		keyLines: st.label === 'function handle' ? [{ line: 8, note: 'stops requests without an id' }, { line: 9, note: 'doubles the stored value' }, { line: 2, note: 'outside the step' }, { line: 8, note: 'dup' }] : [] })) };
	const handle = repairSteps(draft, steps).value!.scenes.find(s => s.label === 'function handle')!;
	assert.deepEqual(handle.keyLines, [{ line: 8, note: 'stops requests without an id' }, { line: 9, note: 'doubles the stored value' }]);
	const ctx = { file: 'h.js', lang: 'javascript', code: FILE, startLine: 1 };
	assert.match(buildStepsPrompt(ctx, steps), /new to programming[\s\S]*ONE concrete example/);
	assert.doesNotMatch(buildStepsPrompt(ctx, steps, 1e9, 'experienced'), /new to programming/);
	assert.match(buildStepsPrompt(ctx, steps), /"keyLines"/);
});

test('model-placed steps snap to the whole function they point into, without blank edges', async () => {
	const { snapRange } = await import('../steps');
	const lines = (r: { startLine: number; endLine: number }) => ({ startLine: r.startLine, endLine: r.endLine });
	assert.deepEqual(lines(snapRange('h.js', FILE, 8, 9)), { startLine: 7, endLine: 10 });   // part of handle → all of handle
	assert.deepEqual(lines(snapRange('h.js', FILE, 6, 10)), { startLine: 7, endLine: 10 });  // a blank first line is trimmed
	assert.deepEqual(lines(snapRange('h.js', FILE, 3, 10)), { startLine: 3, endLine: 10 });  // two functions: kept as given
	assert.deepEqual(lines(snapRange('h.js', FILE, 12, 12)), { startLine: 12, endLine: 12 });
});

test('the screenshot case: a tour step from the middle of one function to the middle of the next', async () => {
	const fs = await import('fs'), path = await import('path');
	const { snapRange } = await import('../steps');
	const text = fs.readFileSync(path.join(__dirname, '../../test/fixtures/api-ts/src/services/orders.ts'), 'utf8');
	// The model said 16-26: from createOrder's limit check to cancelOrder's paid check. Both functions are shown whole...
	const r = snapRange('src/services/orders.ts', text, 16, 26);
	assert.deepEqual([r.startLine, r.endLine], [14, 29]);
	// ...and the four checks the step is about are the key lines.
	assert.deepEqual(r.keyLines!.map(k => k.line), [16, 24, 25, 26]);
	assert.match(r.keyLines![0].note, /order total over the limit/);
	assert.match(r.keyLines![3].note, /a paid order cannot be cancelled/, 'the message, not the first string on the line');
	// Key lines the model gave win, if they're inside the range.
	assert.deepEqual(snapRange('src/services/orders.ts', text, 16, 26, [{ line: 25, note: 'only the owner' }, { line: 3, note: 'outside' }]).keyLines, [{ line: 25, note: 'only the owner' }]);
});
