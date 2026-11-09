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

	test(`harness ${name}: the planted flaws are caught by the rules`, () => {
		for (const [file, rules] of Object.entries(x.flaws)) {
			const got = new Set(scanText(file, files.find(f => f.path === file)!.text).map(h => h.rule));
			for (const r of rules) assert.ok(got.has(r), `${file}: ${r} (got ${[...got].join(', ')})`);
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
