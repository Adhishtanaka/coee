import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChangeReviewPrompt, buildCommitMessagePrompt, changedRegion, parseUnifiedDiff, relocate, repairChangeReview } from '../prompt';

const BEFORE = ['function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.price;', '  return sum;', '}', '', 'module.exports = { total };'];
const AFTER = ['function total(items) {', '  let sum = 0;', '  for (let k = 0; k <= items.length; k++) sum += items[k].price;', '  return sum;', '}', '', 'module.exports = { total };'];
const DIFF = `diff --git a/cart.js b/cart.js
index 1..2 100644
--- a/cart.js
+++ b/cart.js
@@ -1,7 +1,7 @@
 ${BEFORE[0]}
 ${BEFORE[1]}
-${BEFORE[2]}
+${AFTER[2]}
 ${BEFORE[3]}
 ${BEFORE[4]}
 
 ${BEFORE[6]}
`;
const [file] = parseUnifiedDiff(DIFF);
const FAR = ['', '// helpers', ...Array.from({ length: 8 }, (_, i) => `const c${i} = ${i};`), 'function other() {', '  return 1;', '}'];
const text = [...AFTER, ...FAR].join('\n');

test('change review: comments land on the changed lines; others are dropped', () => {
	const draft = { summary: 'Loops by index.', risk: 'high', findings: [
		{ severity: 'high', kind: 'bug', title: 'Off by one', why: '<= reads past the end, so items[k] is undefined and .price throws.', symbol: '  for (let k = 0; k <= items.length; k++) sum += items[k].price;', startLine: 9,
			suggestion: { find: '  for (let k = 0; k <= items.length; k++) sum += items[k].price;', code: '  for (let k = 0; k < items.length; k++) sum += items[k].price;' } },
		{ severity: 'low', kind: 'maintainability', title: 'Unrelated', why: 'Not part of the change.', symbol: 'function other() {', startLine: 18 },
		{ severity: 'medium', kind: 'bug', title: 'Bad suggestion', why: 'Its find text is not in the file.', startLine: 3, suggestion: { find: 'nope', code: 'x' } },
	] };
	const { value } = repairChangeReview(draft, file, text);
	assert.deepEqual(value!.findings.map(f => [f.title, f.startLine, !!f.suggestion]), [['Off by one', 3, true], ['Bad suggestion', 3, false]]);
	assert.equal(value!.findings[0].anchor, AFTER[2].trim());
	assert.equal(value!.risk, 'high');
	assert.ok(repairChangeReview({ summary: 'x' }, file, text).errors.length);
});

test('change review: where comments may go is the change plus a margin', () => {
	assert.deepEqual([...changedRegion(file, 1)].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('relocate: a comment follows its line when edits above move it, and goes when the line does', () => {
	const f = { startLine: 3, endLine: 3, anchor: AFTER[2].trim() };
	assert.deepEqual(relocate(f, ['// added', '// added', ...AFTER].join('\n')), { startLine: 5, endLine: 5 });
	assert.equal(relocate(f, BEFORE.join('\n')), undefined);
});

test('untracked files arrive as added diffs', () => {
	const [d] = parseUnifiedDiff('diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+const a = 1;\n+module.exports = a;\n');
	assert.deepEqual([d.path, d.status, d.hunks[0].lines.length], ['new.js', 'added', 2]);
});

test('prompts: the review shows the diff and the whole file; the commit prompt stays in budget', () => {
	const p = buildChangeReviewPrompt(file, text, 'Other files in this change: a.js');
	assert.match(p, /3 \+ +for \(let k/);
	assert.match(p, /Other files in this change: a\.js/);
	assert.match(p, /--- cart\.js/);
	assert.ok(buildCommitMessagePrompt([file], 2000).length <= 2000);
});

test('compressDiff: pr-agent style; main language first, deletions named, nothing silently dropped', async () => {
	const { compressDiff } = await import('../prompt');
	const hunk = (lines: Array<['+' | '-' | ' ', string]>) => ({ oldStart: 1, newStart: 1, newLines: lines.length, lines: lines.map(([t, text]) => ({ t, text })) });
	const files = [
		{ path: 'README.md', status: 'modified' as const, hunks: [hunk([['+', 'docs']])] },
		{ path: 'src/a.ts', status: 'modified' as const, hunks: [hunk([['+', 'x'.repeat(50)], ['-', 'old']]), hunk([['-', 'only removed']])] },
		{ path: 'src/b.ts', status: 'modified' as const, hunks: [hunk([['+', 'y']])] },
		{ path: 'src/gone.ts', status: 'deleted' as const, hunks: [hunk([['-', 'bye']])] },
		{ path: 'src/trim.ts', status: 'modified' as const, hunks: [hunk([['-', 'cut']])] },
		{ path: 'logo.png', status: 'modified' as const, hunks: [], binary: true },
	];
	const all = compressDiff(files, 1e9);
	assert.deepEqual(all.shown, ['src/a.ts', 'src/b.ts', 'README.md']); // .ts is the main language; bigger change first
	assert.ok(!all.text.includes('only removed'), 'hunks that only delete are left out');
	assert.match(all.text, /Deleted files:\n- src\/gone\.ts/);
	assert.match(all.text, /- src\/trim\.ts \(only removals\)/);
	assert.match(all.text, /- logo\.png \(binary\)/);
	const tight = compressDiff(files, 500);
	assert.deepEqual(tight.shown, ['src/a.ts']);
	assert.ok(tight.minimized.includes('src/b.ts') && tight.minimized.includes('README.md'));
	assert.ok(tight.text.length <= 500);
});

test('review context: what a change touched, and where the rest of the project calls it', async () => {
	const fs = await import('fs'), path = await import('path');
	const { indexProject } = await import('../codeindex');
	const { callSites, changedSymbols } = await import('../facts');
	const dir = path.join(__dirname, '../../test/fixtures/api-ts');
	const files = ['src/services/orders.ts', 'src/routes/orders.ts', 'src/types.ts'].map(p => ({ path: p, text: fs.readFileSync(path.join(dir, p), 'utf8') }));
	const idx = indexProject(files);
	assert.deepEqual(changedSymbols(idx, 'src/services/orders.ts', [27]), ['cancelOrder']);
	const sites = callSites(idx, new Map(files.map(f => [f.path, f.text])), ['cancelOrder'], 'src/services/orders.ts');
	assert.deepEqual(sites.map(s => [s.file, s.line]), [['src/routes/orders.ts', 14]]);
});

test('reviews keep only what the model would defend: low confidence is dropped', () => {
	const draft = { summary: 's', findings: [
		{ severity: 'high', kind: 'bug', title: 'Sure', why: 'Breaks.', confidence: 9, symbol: AFTER[2], startLine: 3 },
		{ severity: 'medium', kind: 'bug', title: 'Maybe', why: 'Might.', confidence: 4, symbol: AFTER[2], startLine: 3 },
		{ severity: 'low', kind: 'test', title: 'Unscored', why: 'No score given.', symbol: AFTER[2], startLine: 3 },
	] };
	assert.deepEqual(repairChangeReview(draft, file, text).value!.findings.map(f => f.title), ['Sure', 'Unscored']);
});

test('whole-change review: findings are checked against their own file', async () => {
	const { repairChangeOverview, buildChangeOverviewPrompt } = await import('../prompt');
	const draft = { summary: 'Loops by index across the cart.', risk: 'medium', findings: [
		{ severity: 'high', kind: 'bug', title: 'Caller not updated', why: 'checkout() still expects a promise.', confidence: 8, file: 'cart.js', symbol: AFTER[2], startLine: 3 },
		{ severity: 'high', kind: 'bug', title: 'Unknown file', why: 'x', confidence: 9, file: 'nope.js', startLine: 1 },
	] };
	const r = repairChangeOverview(draft, [{ diff: file, text }]).value!;
	assert.deepEqual(r.findings.map(f => [f.id, f.file, f.startLine]), [['overall#1', 'cart.js', 3]]);
	const p = buildChangeOverviewPrompt([file], { 'cart.js': { summary: 'Loops by index.', risk: 'high', titles: ['Off by one'] } }, [{ file: 'checkout.js', line: 9, text: 'await total(items)', in: 'checkout', calls: 'total' }], 'branch fix-cart');
	assert.match(p, /checkout\.js:9 in checkout\(\) calls total/);
	assert.match(p, /branch fix-cart/);
	assert.match(p, /cart\.js \(risk high\): Loops by index\. Found: Off by one/);
});
