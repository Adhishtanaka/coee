// Replays of plan replies against real file text: does the code land where it should, and only once?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Snippet, applyPlacement, placeSnippet, repairPlan } from '../prompt';

const SERVER = [
	"const http = require('http');",
	"const store = require('./store');",
	'',
	'function send(res, status, body) {',
	"  res.writeHead(status, { 'Content-Type': 'application/json' });",
	'  res.end(JSON.stringify(body));',
	'}',
	'',
	'const server = http.createServer(async (req, res) => {',
	"  if (req.method === 'GET') return send(res, 200, store.list());",
	'});',
	'',
].join('\n');

/** Place and apply, as Add does. */
function add(text: string | undefined, sn: Snippet): string {
	const p = placeSnippet(text, sn);
	assert.equal(p.status, 'ready', p.status === 'error' ? p.reason : p.status);
	return applyPlacement(text ?? '', p as any);
}

test('insert lands right after its anchor, whatever the spacing', () => {
	const sn: Snippet = { file: 'server.js', mode: 'insert', after: "const store   = require('./store');", code: "const db = require('./db');" };
	const out = add(SERVER, sn);
	assert.deepEqual(out.split('\n').slice(0, 3), ["const http = require('http');", "const store = require('./store');", "const db = require('./db');"]);
});

test('a second Add is refused: the code is already there', () => {
	const sn: Snippet = { file: 'server.js', mode: 'insert', after: "const store = require('./store');", code: "const db = require('./db');" };
	const once = add(SERVER, sn);
	assert.deepEqual(placeSnippet(once, sn), { status: 'added' });
	assert.deepEqual(placeSnippet(once.replace("const db = require('./db');", "const db   =   require('./db');"), sn), { status: 'added' }); // reformatted still counts
});

test('replace swaps exactly the found lines and nothing else', () => {
	const sn: Snippet = { file: 'server.js', mode: 'replace', find: "  if (req.method === 'GET') return send(res, 200, store.list());",
		code: "  if (req.method === 'GET') return send(res, 200, await store.list());" };
	const out = add(SERVER, sn);
	assert.equal(out, SERVER.replace('store.list())', 'await store.list())'));
});

test('the screenshot bug: a whole server body "replacing" one require can no longer clobber the file', () => {
	// The reply that replaced line 2 with the full route table: no "find", so it is dropped before it reaches a button.
	const lines = { 'server.js': SERVER.split('\n').length };
	const reply = { title: 'Neon', scenes: [
		{ label: 'Change in server.js', title: 't', text: 'x', file: 'server.js', startLine: 2, endLine: 2,
			snippets: [{ file: 'server.js', mode: 'replace', code: "const store = require('./store');\n// ...\nif (req.method === 'GET') {}" }] },
		{ label: 'Tests', title: 't', text: 'x', file: 'server.js', startLine: 9, endLine: 11, snippets: [{ file: 'server.test.js', mode: 'new', code: "test('x', () => {});" }] },
	] };
	const r = repairPlan(reply, lines, [{ path: 'server.js', text: SERVER }]);
	assert.equal(r.value!.scenes[0].snippets, undefined);
	assert.deepEqual(r.errors, []);
});

test('an anchor that is missing or not unique is sent back to the model, and refused at Add', () => {
	const lines = { 'server.js': 12 };
	const sc = (sn: unknown) => ({ title: 'P', scenes: [
		{ label: 'Change', title: 't', text: 'x', file: 'server.js', startLine: 1, endLine: 2, snippets: [sn] },
		{ label: 'Tests', title: 't', text: 'x', file: 'server.js', startLine: 1, endLine: 2, snippets: [{ file: 't.test.js', mode: 'new', code: 'test()' }] }] });
	const missing = repairPlan(sc({ file: 'server.js', mode: 'insert', after: 'const nope = 1;', code: 'x()' }), lines, [{ path: 'server.js', text: SERVER }]);
	assert.match(missing.errors.join(' '), /isn't in server\.js/);
	const twice = placeSnippet(SERVER + 'function other() {\n}\n', { file: 'server.js', mode: 'insert', after: '}', code: 'more()' });
	assert.equal(twice.status, 'error');
	assert.match((twice as any).reason, /appears 2 times/);
});

test('new files: created when missing, never overwritten, recognised when already added', () => {
	const sn: Snippet = { file: 'server.test.js', mode: 'new', code: "test('lists todos', () => {});" };
	assert.equal(add(undefined, sn), "test('lists todos', () => {});\n");
	assert.deepEqual(placeSnippet("test('lists todos', () => {});\n", sn), { status: 'added' });
	assert.equal(placeSnippet('other content\n', sn).status, 'error');
});

test('an empty "after" puts code at the top; a lone brace never counts as already added', () => {
	assert.ok(add(SERVER, { file: 'server.js', mode: 'insert', after: '', code: "'use strict';" }).startsWith("'use strict';\nconst http"));
	assert.equal(placeSnippet(SERVER, { file: 'server.js', mode: 'insert', after: "const store = require('./store');", code: '}' }).status, 'ready');
});
