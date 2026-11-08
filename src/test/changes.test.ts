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
