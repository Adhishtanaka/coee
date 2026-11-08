import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPrompt, jsonLoop } from '../loop';

const count = async (t: string) => Math.ceil(t.length / 4);

test('fit: a builder is shrunk until the prompt fits; a fixed prompt that is too big says so', async () => {
	const budgets: number[] = [];
	const dense = async (t: string) => Math.ceil(t.length / 2); // more tokens per character than the first guess assumes
	const text = await fitPrompt(b => { budgets.push(b); return 'x'.repeat(Math.min(b, 50_000)); }, 1000, dense);
	assert.ok((await dense(text)) <= 1000);
	assert.ok(budgets.length > 1 && budgets[1] < budgets[0]);
	await assert.rejects(fitPrompt('y'.repeat(10_000), 100, count), /too much code/);
	await assert.rejects(fitPrompt(() => 'z'.repeat(10_000), 100, count), /Couldn't fit/);
});

test('json loop: a good reply is used at once', async () => {
	let calls = 0;
	const v = await jsonLoop('p', async () => { calls++; return '```json\n{"a": 1}\n```'; }, (d: any) => ({ value: d.a, errors: [] }));
	assert.deepEqual([v, calls], [1, 1]);
});

test('json loop: problems go back to the model once, listed; the second reply is used', async () => {
	const seen: string[][] = [];
	const replies = ['{"a": 0}', '{"a": 2}'];
	const v = await jsonLoop('p', async h => { seen.push(h.map(String)); return replies[seen.length - 1]; }, (d: any) => d.a ? { value: d.a, errors: [] } : { value: 0, errors: ['"a" must not be 0'] });
	assert.equal(v, 2);
	assert.equal(seen[1].length, 3);
	assert.match(seen[1][2], /"a" must not be 0/);
});

test('json loop: after the retry, an imperfect but usable value is kept; nothing usable fails', async () => {
	assert.equal(await jsonLoop('p', async () => '{"a": 0}', () => ({ value: 7, errors: ['still wrong'] })), 7);
	await assert.rejects(jsonLoop('p', async () => 'not json at all', () => ({ errors: ['x'] })), /couldn't be used/);
});
