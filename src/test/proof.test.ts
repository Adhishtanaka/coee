import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexProject } from '../codeindex';
import { proofCommand, proofPath, traceAttack } from '../proof';

test('attack trace: from the route where input enters, through the calls, to the dangerous line', () => {
	const files = [
		{ path: 'routes.js', text: "const svc = require('./svc');\nrouter.post('/export', (req, res) => {\n  res.send(doExport(req.body.name));\n});\nfunction doExport(name) {\n  return pack(name);\n}" },
		{ path: 'svc.js', text: "function pack(name) {\n  return exec('zip ' + name);\n}\nmodule.exports = { pack };" },
	];
	const steps = traceAttack(indexProject(files), 'svc.js', 2, new Map(files.map(f => [f.path, f.text])));
	assert.deepEqual(steps.map(s => [s.file, s.line, s.role]), [['routes.js', 2, 'source'], ['routes.js', 5, 'hop'], ['svc.js', 1, 'hop'], ['svc.js', 2, 'sink']]);
	assert.match(steps[0].label, /POST \/export/);
	assert.deepEqual(steps.filter(s => s.fixHere).map(s => s.line), [5], 'validate where the input first reaches our code');
	assert.equal(steps[steps.length - 1].role, 'sink');
});

test('attack trace: a function nothing calls takes its input from its parameters', () => {
	const steps = traceAttack(indexProject([{ path: 'a.js', text: 'exports.calc = expr => eval(expr);' }]), 'a.js', 1);
	assert.equal(steps[0].role, 'source');
	assert.match(steps[0].label, /parameters of calc/);
});

test('proof runs use the project\'s own runner, on the one file', () => {
	const none = () => false;
	assert.deepEqual(proofCommand('a.coee-proof-f1.test.js', '{}', none), { command: 'node', args: ['--test', 'a.coee-proof-f1.test.js'], framework: 'node:test' });
	assert.equal(proofCommand('a.test.ts', JSON.stringify({ devDependencies: { vitest: '1' } }), none)!.framework, 'vitest');
	assert.equal(proofCommand('a.test.js', JSON.stringify({ devDependencies: { jest: '29' } }), none)!.framework, 'jest');
	assert.deepEqual(proofCommand('app/test_x.py', undefined, none)!.args, ['-m', 'pytest', '-q', 'app/test_x.py']);
	assert.deepEqual(proofCommand('pkg/a_test.go', undefined, none)!.args, ['test', './pkg']);
	assert.equal(proofCommand('a.rb', undefined, none), undefined);
});

test('proof files sit beside the code, clearly named', () => {
	assert.equal(proofPath('src/files.js', 'f1'), 'src/files.coee-proof-f1.test.js');
	assert.equal(proofPath('app/main.py', 'f2'), 'app/test_coee_proof_f2.py');
	assert.equal(proofPath('cmd/main.go', 'f3'), 'cmd/main_coee_proof_f3_test.go');
});
