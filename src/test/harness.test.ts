// The quality harness: fixture projects in test/fixtures, each with expected.json listing what coee must find.
// Every entry point, function, route, data shape, rule, call and planted flaw must be found by the index, and must
// still reach the model's prompt when the budget is too small for whole files. A coverage table is printed at the end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { indexProject, outline } from '../codeindex';
import { packContext } from '../context';
import { scanText } from '../rules';
import { planSteps } from '../steps';
import { projectFacts } from '../facts';
import { traceAttack } from '../proof';

const ROOT = path.join(__dirname, '../../test/fixtures');
interface Expected {
	entries: string[]; functions: Record<string, string[]>; routes: Array<[string, string]>;
	dtos: Array<[string, string, string[]]>; rules: Array<[string, string]>; calls: Array<[string, string]>;
	core?: string; flaws: Record<string, string[]>;
}
function load(dir: string) {
	const files: Array<{ path: string; text: string }> = [];
	const walk = (rel: string) => {
		for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(p); else if (e.name !== 'expected.json') files.push({ path: p, text: fs.readFileSync(path.join(dir, p), 'utf8') });
		}
	};
	walk('');
	return { files, expected: JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) as Expected };
}

const report: string[] = [];
for (const name of fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'expected.json')))) {
	const { files, expected: x } = load(path.join(ROOT, name));
	const idx = indexProject(files);
	const facts: Array<{ what: string; found: boolean; needle: string }> = [];
	const fact = (what: string, found: boolean, needle: string) => facts.push({ what, found, needle });
	for (const e of x.entries) fact(`entry ${e}`, !!idx.files.get(e)?.entry, e);
	for (const [file, fns] of Object.entries(x.functions)) for (const fn of fns) fact(`function ${fn} in ${file}`, !!idx.files.get(file)?.symbols.some(s => s.name === fn), fn);
	for (const [method, file] of x.routes) fact(`route ${method} in ${file}`, !!idx.files.get(file)?.routes.some(r => r.method === method), method);
	for (const [file, dto, fields] of x.dtos) {
		const d = idx.files.get(file)?.dtos.find(d => d.name === dto);
		fact(`data shape ${dto}`, !!d, dto);
		for (const fld of fields) fact(`field ${dto}.${fld}`, !!d?.fields.some(f => f.name === fld), fld);
	}
	for (const [file, text] of x.rules) fact(`rule "${text}" in ${file}`, !!idx.files.get(file)?.rules.some(r => r.text.includes(text)), text);
	for (const [from, to] of x.calls) fact(`${from} calls ${to}`, [...idx.files.values()].some(f => f.calls[from]?.includes(to)), from);
	if (x.core) fact(`core file ${x.core}`, (idx.importedBy.get(x.core)?.length ?? 0) >= 2, x.core);

	test(`harness ${name}: the index finds every expected fact`, () => {
		assert.deepEqual(facts.filter(f => !f.found).map(f => f.what), []);
	});

	test(`harness ${name}: a file walkthrough has a step for every function, with its exact lines`, () => {
		for (const [file, fns] of Object.entries(x.functions)) {
			const text = files.find(f => f.path === file)!.text;
			const steps = planSteps(file, text, 1, text.split('\n').length, { firstPart: true, lastPart: true });
			const fi = idx.files.get(file)!;
			for (const fn of fns) {
				const step = steps.find(st => st.names.includes(fn));
				assert.ok(step, `${file}: no step for ${fn}`);
				const sym = fi.symbols.find(sy => sy.name === fn)!;
				if (step!.kind === 'symbol') assert.deepEqual([step!.startLine, step!.endLine], [sym.line, sym.end], `${file}: ${fn} lines`);
			}
			assert.ok(steps.length <= 12, `${file}: ${steps.length} steps`);
		}
	});

	test(`harness ${name}: the architecture page lists every entry point, route, data shape and rule`, () => {
		const f = projectFacts(idx, new Map(files.map(x => [x.path, x.text])));
		for (const e of x.entries) assert.ok(f.entries.some(y => y.file === e), `entry ${e}`);
		for (const [method, file] of x.routes) assert.ok(f.routes.some(r => r.method === method && r.file === file), `route ${method} ${file}`);
		for (const [file, dto, fields] of x.dtos) {
			const d = f.dtos.find(y => y.name === dto && y.file === file);
			assert.ok(d, `data shape ${dto}`);
			assert.deepEqual(fields.filter(fl => !d!.fields.some(y => y.name === fl)), [], `${dto} fields`);
		}
		for (const [file, text] of x.rules) assert.ok(f.rules.some(r => r.file === file && r.text.includes(text)), `rule "${text}"`);
	});

	test(`harness ${name}: the planted flaws are caught by the rules`, () => {
		for (const [file, rules] of Object.entries(x.flaws)) {
			const got = new Set(scanText(file, files.find(f => f.path === file)!.text).map(h => h.rule));
			for (const r of rules) assert.ok(got.has(r), `${file}: ${r} (got ${[...got].join(', ')})`);
			// Each flaw has a path from where input enters to the dangerous line, with one place to validate.
			for (const h of scanText(file, files.find(f => f.path === file)!.text).filter(h => rules.includes(h.rule))) {
				const t = traceAttack(idx, file, h.line, new Map(files.map(f => [f.path, f.text])));
				assert.equal(t[0].role, 'source', `${file}:${h.line} starts where input enters`);
				assert.deepEqual([t[t.length - 1].role, t[t.length - 1].line], ['sink', h.line], `${file}:${h.line} ends at the flaw`);
				assert.equal(t.filter(x => x.fixHere).length, 1);
			}
		}
	});

	test(`harness ${name}: every fact reaches the prompt when whole files don't fit`, () => {
		const total = files.reduce((n, f) => n + f.text.length, 0);
		// Room for every file's outline plus a little code: less than the files need whole, so most must be outlines.
		const outlines = files.reduce((n, f) => n + outline(idx.files.get(f.path)!).length + f.path.length + 70, 0);
		const tight = outlines + Math.floor(total * 0.25);
		const p = packContext(files, tight, [], idx);
		assert.ok(p.text.length <= tight, `over budget: ${p.text.length} > ${tight}`);
		// Tiny projects (outlines as big as the code) have no budget between the two; for the rest it must bite.
		if (tight < total) assert.ok(p.full.length < files.length, `the budget is tight enough to matter (${tight} chars, ${total} of code)`);
		const missing = facts.filter(f => !p.text.includes(f.needle)).map(f => f.what);
		assert.deepEqual(missing, []);
		const all = packContext(files, 1e9, [], idx);
		assert.equal(all.full.length + all.outlined.length + all.named.length, files.length);
		assert.equal(all.full.length, files.length, 'a big budget shows everything whole');
		report.push(`${name.padEnd(8)} ${String(facts.filter(f => f.found).length).padStart(3)}/${facts.length} facts found · at ${Math.round(tight / 1000)}k chars: ${p.full.length} whole, ${p.outlined.length} outlined, ${p.named.length} named, every fact in the prompt`);
	});
}

after(() => { if (report.length) console.log('\ncoee harness\n' + report.join('\n')); });

test('the index stays fast on hostile lines (no catastrophic backtracking)', async () => {
	const { indexFile } = await import('../codeindex');
	const nasty = [
		'public ' + ' '.repeat(390) + 'x',
		'static '.repeat(55) + 'x',
		'int' + ' *'.repeat(195) + 'x',
		'a b'.repeat(130) + '(',
		'f(' + ' '.repeat(395),
	];
	for (const [file, line] of nasty.flatMap(l => [['A.java', l], ['a.c', l], ['a.ts', l], ['a.py', l]] as const)) {
		const t = Date.now();
		indexFile(file, Array(50).fill(line).join('\n'));
		assert.ok(Date.now() - t < 200, `${file}: ${line.slice(0, 20)}… took ${Date.now() - t} ms`);
	}
});
