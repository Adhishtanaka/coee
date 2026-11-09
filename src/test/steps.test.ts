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
