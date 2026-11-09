// OWASP Top 10 (2021), every category: each has checks of its own, and the planted problems in test/fixtures/owasp
// are all found. Prints a coverage table.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { OWASP, RULES, scanText } from '../rules';
import { indexProject } from '../codeindex';
import { designChecks, projectFacts } from '../facts';

const TOP10 = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10'];
const DIR = path.join(__dirname, '../../test/fixtures/owasp');
const files = fs.readdirSync(DIR).filter(f => f !== 'expected.json').map(f => ({ path: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));
const expected: Record<string, string[]> = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8')).flaws;
const report: string[] = [];

test('every OWASP Top 10 category has its own checks, with a name and an explanation', () => {
	for (const c of TOP10) {
		assert.ok(OWASP[c]?.name && OWASP[c].learn.length > 40, `${c} is described`);
		assert.ok(RULES.filter(r => r.owasp === c).length >= 1, `${c} has rules`);
	}
});

test('every category\'s planted problems are found', () => {
	const hits = files.flatMap(f => scanText(f.path, f.text));
	const byRule = new Map(RULES.map(r => [r.id, r.owasp]));
	for (const c of TOP10) {
		const planted = Object.values(expected).flat().filter(r => byRule.get(r) === c);
		const found = planted.filter(r => hits.some(h => h.rule === r));
		assert.ok(planted.length >= 1, `${c} has planted problems in the fixture`);
		assert.deepEqual(found, planted, `${c}: missed ${planted.filter(r => !found.includes(r)).join(', ')}`);
		report.push(`${c} ${OWASP[c].name.padEnd(44)} ${String(RULES.filter(r => r.owasp === c).length).padStart(2)} rules · ${found.length}/${planted.length} planted found`);
	}
});

test('design checks: a data-changing route without auth, a login without rate limit, no security headers', () => {
	const app = [
		"const app = express();",
		"app.post('/login', (req, res) => res.json(login(req.body)));",
		"app.delete('/posts/:id', (req, res) => remove(req.params.id));",
	].join('\n');
	const t = new Map([['app.js', app]]);
	const got = designChecks(projectFacts(indexProject([{ path: 'app.js', text: app }]), t), t).map(d => `${d.owasp} ${d.rule}`).sort();
	assert.deepEqual(got, ['A01 design-no-auth', 'A01 design-no-auth', 'A04 design-no-rate-limit', 'A05 design-no-headers']);
	// The same app, protected: nothing to say.
	const safe = ["const app = express();", "app.use(helmet());", "app.use(rateLimit({ max: 100 }));", "app.use(requireUser);", app.split('\n').slice(1).join('\n')].join('\n');
	const t2 = new Map([['app.js', safe]]);
	assert.deepEqual(designChecks(projectFacts(indexProject([{ path: 'app.js', text: safe }]), t2), t2), []);
});

after(() => { if (report.length) console.log('\nOWASP Top 10 coverage\n' + report.join('\n')); });

test('the rules stay fast on hostile lines (no catastrophic backtracking)', () => {
	const nasty = ['console.log(' + 'a,'.repeat(990), 'x.find(' + ' '.repeat(1990), 'fetch(`' + '${'.repeat(600), 'password' + ' ='.repeat(600), '"a": "' + '>='.repeat(900), "jwt.sign(" + "'a',".repeat(450), 'catch (' + ' '.repeat(1990), '<script src="https://' + 'a'.repeat(1900)];
	for (const line of nasty) for (const file of ['a.js', 'a.py', 'package.json', 'a.html']) {
		const t = Date.now();
		scanText(file, Array(20).fill(line).join('\n'));
		assert.ok(Date.now() - t < 300, `${file}: ${line.slice(0, 20)}… took ${Date.now() - t} ms`);
	}
});
