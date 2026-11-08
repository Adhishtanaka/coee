import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAskPrompt, buildExplainPrompt, isTestFile, buildPlanPickPrompt, buildPlanPrompt, outermost, repairPick, repairPlan, repairSnippets, snapRefs, blockEnd, repairSecurity, mergeReports, batchFiles, buildSecurityPrompt, toSarif, depFinding, buildTourOverviewPrompt, buildTourPartPrompt, excerpt, packFiles, repairDiagram, fitExcerpts, numbered, numberedFit, packChapters, parseJson, repair, repairMap } from '../prompt';
import { diagramSvg, layers, wrap } from '../layout';

const scene = { title: 'a', startLine: 10, endLine: 12, text: 'x' };
const ok = { title: 'T', summary: 's', scenes: [scene] };

test('valid draft passes unchanged', () => assert.deepEqual(repair(ok, 10, 20), { value: ok, errors: [] }));

test('repair clamps, swaps and coerces lines instead of failing', () => {
	const { value, errors } = repair({ ...ok, scenes: [{ ...scene, startLine: '14', endLine: 99 }, { ...scene, startLine: 12, endLine: 3 }] }, 10, 20);
	assert.deepEqual(errors, []);
	assert.deepEqual(value!.scenes.map(s => [s.startLine, s.endLine]), [[14, 20], [10, 12]]);
});

test('repair drops broken scenes, keeps good ones, and fills a missing title', () => {
	const { value } = repair({ scenes: [{ title: '', text: 'x', startLine: 1, endLine: 1 }, scene, { title: 'b' }] }, 1, 20);
	assert.equal(value!.scenes.length, 1);
	assert.equal(value!.title, 'a');
});

test('repair shifts scenes a model renumbered from 1', () => {
	const { value } = repair({ ...ok, scenes: [{ ...scene, startLine: 1, endLine: 5 }, { ...scene, startLine: 6, endLine: 9 }] }, 301, 400);
	assert.deepEqual(value!.scenes.map(s => [s.startLine, s.endLine]), [[301, 305], [306, 309]]);
});

test('repair fails only when nothing is usable', () => {
	assert.equal(repair({ title: 'T', scenes: [] }, 1, 5).errors.length, 1);
	assert.equal(repair('nope', 1, 5).errors.length, 1);
});

test('diagrams: dangling edges and tiny diagrams are dropped', () => {
	const d = { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'zzz' }] };
	assert.equal(repair({ ...ok, scenes: [{ ...scene, diagram: d }] }, 1, 20).value!.scenes[0].diagram!.edges.length, 1);
	assert.equal(repair({ ...ok, scenes: [{ ...scene, diagram: { nodes: [{ id: 'a' }], edges: [] } }] }, 1, 20).value!.scenes[0].diagram, undefined);
	assert.equal(repair({ ...ok, scenes: [{ ...scene, diagram: 'graph TD; a-->b' }] }, 1, 20).value!.scenes[0].diagram!.edges.length, 1); // mermaid is accepted
});

test('diagramSvg escapes text, draws every node and edge, and caps its width', () => {
	const { svg } = diagramSvg({ nodes: [{ id: 'a', label: '<script>', detail: 'per-IP counter & more' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
		edges: [{ from: 'a', to: 'b', label: 'count > max' }, { from: 'b', to: 'a' }, { from: 'a', to: 'c' }] }, 'dark', 300);
	assert.ok(!svg.includes('<script>'));
	assert.match(svg, /&lt;script&gt;/);
	assert.match(svg, /count &gt; max/);
	assert.equal((svg.match(/fill="none"/g) || []).length, 3);
	assert.equal((svg.match(/rx="6"/g) || []).length, 3);
	assert.match(svg, /width="300"/);
});

test('wrap keeps lines short and marks cut text', () => {
	assert.deepEqual(wrap('one two three four five six', 9, 2), ['one two', 'three …']);
});

test('folder walkthrough scenes resolve files and clamp to each file', () => {
	const files = { 'server/app.js': 40, 'server/middleware/rateLimit.js': 70 };
	const { value } = repair({ title: 'T', scenes: [
		{ title: 'a', text: 'x', file: 'rateLimit.js', startLine: 60, endLine: 90 },
		{ title: 'b', text: 'x', file: './server/app.js', startLine: 1, endLine: 5 },
		{ title: 'c', text: 'x', file: 'nope.js', startLine: 1, endLine: 2 },
	] }, 1, 1, files);
	assert.deepEqual(value!.scenes.map(s => [s.file, s.startLine, s.endLine]), [['server/middleware/rateLimit.js', 60, 70], ['server/app.js', 1, 5]]);
});

test('repairMap keeps cited lines, drops unknown files and dangling links, accepts old string files', () => {
	const known = ['src/a.js', 'src/b.js'];
	const { value } = repairMap({ title: 'P', components: [
		{ id: 'a', name: 'A', summary: '', files: [{ path: 'src/a.js', startLine: 3, endLine: 9, why: 'entry' }, 'nope.js'] },
		{ id: 'b', name: 'B', summary: '', files: ['src/b.js'] },
	], connections: [{ from: 'a', to: 'b', label: 'calls', detail: 'imports b' }, { from: 'a', to: 'zzz' }] }, known);
	assert.deepEqual(value!.components[0].files, [{ path: 'src/a.js', startLine: 3, endLine: 9, why: 'entry' }]);
	assert.deepEqual(value!.components[1].files, [{ path: 'src/b.js' }]);
	assert.equal(value!.connections.length, 1);
	assert.equal(repairMap({ components: [] }, known).errors.length, 1);
});

test('numberedFit stays within budget and keeps the focused lines', () => {
	const code = Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`).join('\n');
	const out = numberedFit({ file: 'f', lang: 'js', code, startLine: 1 }, 2000, { startLine: 300, endLine: 305 });
	assert.ok(out.length < 2200);
	assert.match(out, / 300 \| line 300/);
	assert.match(out, / 305 \| line 305/);
	assert.match(out, /earlier lines left out/);
	assert.match(out, /later lines left out/);
});

test('prompts shrink with the budget', () => {
	const code = Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i};`).join('\n');
	const ctx = { file: 'f.js', lang: 'javascript', code, startLine: 1 };
	assert.ok(buildAskPrompt(ctx, 'why?', undefined, [], 12000).length < 12500);
	assert.ok(buildAskPrompt(ctx, 'why?').length > 30000);
});

test('excerpt keeps the top and the declarations with real line numbers', () => {
	const text = ['// header', ...Array.from({ length: 50 }, () => 'x = 1'), 'export function rateLimit() {', '}'].join('\n');
	const out = excerpt(text, 2, 10);
	assert.match(out, /^ {3}1 \| \/\/ header/);
	assert.match(out, / {2}52 \| export function rateLimit/);
	assert.match(out, /53 lines in all/);
});

test('fitExcerpts cuts the list to the budget', () => {
	const list = [{ path: 'a', text: 'x'.repeat(500) }, { path: 'b', text: 'y'.repeat(500) }, { path: 'c', text: 'z'.repeat(500) }];
	const out = fitExcerpts(list, 800);
	assert.equal(out.length, 2);
	assert.match(out[1].text, /cut/);
});

test('parseJson salvages a reply cut off mid-scene', () => {
	const cut = '```json\n{"title":"T","scenes":[{"title":"a","startLine":1,"endLine":2,"text":"x"},{"title":"b","startLine":3,"text":"unfinish';
	assert.deepEqual(parseJson(cut), { title: 'T', scenes: [{ title: 'a', startLine: 1, endLine: 2, text: 'x' }] });
});

test('packChapters cuts long ranges at symbol starts', () => {
	assert.deepEqual(packChapters(0, 99, [50]), [{ start: 0, end: 99 }]);
	const parts = packChapters(0, 599, [120, 140, 260, 300, 455]);
	assert.deepEqual(parts, [{ start: 0, end: 139 }, { start: 140, end: 259 }, { start: 260, end: 409 }, { start: 410, end: 559 }, { start: 560, end: 599 }]);
	assert.ok(parts.every(p => p.end - p.start + 1 <= 150));
});

test('parseJson strips fences and chatter', () => {
	assert.deepEqual(parseJson('Sure!\n```json\n{"a":1}\n```\nhope that helps'), { a: 1 });
	assert.deepEqual(parseJson('{"b":2}'), { b: 2 });
	assert.throws(() => parseJson('no json here'));
});

test('numbered uses real file line numbers', () => {
	assert.equal(numbered({ file: 'f', lang: 'js', code: 'a\nb', startLine: 7 }), '   7 | a\n   8 | b');
});

test('layers: chain goes left to right, cycles terminate, rows follow parents', () => {
	const l = layers(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'a', to: 'd' }]);
	assert.equal(l.a.col, 0);
	assert.equal(l.b.col, 1);
	assert.equal(l.c.col, 2);
	assert.equal(l.d.col, 1);
	assert.notEqual(l.b.row, l.d.row);
});

test('diagram kinds: sequence keeps self-calls and replies, flow drops self-loops', () => {
	const nodes = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
	const seq = repairDiagram({ kind: 'sequence', nodes, edges: [{ from: 'a', to: 'b', label: 'GET' }, { from: 'b', to: 'b', label: 'count' }, { from: 'b', to: 'a', label: '200', reply: true }] })!;
	assert.equal(seq.kind, 'sequence');
	assert.deepEqual(seq.edges.map(e => !!e.reply), [false, false, true]);
	assert.equal(repairDiagram({ nodes, edges: [{ from: 'a', to: 'a' }] })!.edges.length, 0);
	assert.equal(repairDiagram({ kind: 'bogus', nodes, edges: [] })!.kind, undefined);
	assert.equal(repairDiagram({ kind: 'sequence', nodes, edges: [] }), undefined);
});

test('sequence and state diagrams render', () => {
	const nodes = [{ id: 'a', label: 'client' }, { id: 'b', label: 'server' }];
	const seq = diagramSvg({ kind: 'sequence', nodes, edges: [{ from: 'a', to: 'b', label: 'POST /x' }, { from: 'b', to: 'a', label: '201', reply: true }] }, 'light').svg;
	assert.match(seq, /1\. POST \/x/);
	assert.match(seq, /2\. 201/);
	assert.match(seq, /stroke-dasharray="5 4"/);
	const st = diagramSvg({ kind: 'state', nodes, edges: [{ from: 'a', to: 'b', label: 'go' }] }, 'dark').svg;
	assert.match(st, /<circle/);
});

test('tour prompts carry the map, the component and its code, within budget', async () => {
	const map = { title: 'Taskboard', summary: 'A task board.', components: [
		{ id: 'api', name: 'Task API', summary: 'routes', files: [{ path: 'server/app.js', startLine: 1, endLine: 9, why: 'mounts routes' }] },
		{ id: 'rl', name: 'Rate limiter', summary: 'throttles', description: 'Per-IP fixed window.', files: [{ path: 'server/rateLimit.js' }] }],
		connections: [{ from: 'api', to: 'rl', label: 'throttles requests' }] };
	const big = Array.from({ length: 3000 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');
	const files = [{ path: 'server/rateLimit.js', text: big }];
	const part = buildTourPartPrompt(map, map.components[1], files, ['Overview: what it is'], 20000);
	assert.ok(part.length < 21000);
	assert.match(part, /component "Rate limiter": Per-IP fixed window/);
	assert.match(part, /used by Task API \(throttles requests\)/);
	assert.match(part, /Earlier parts of the tour covered/);
	assert.match(part, /outline; line numbers are real/);
	assert.match(buildTourOverviewPrompt(map, files, 20000), /"Architecture"[\s\S]*"flow" diagram/);
	const { buildTourUseCasesPrompt } = await import('../prompt');
	const uc = buildTourUseCasesPrompt(map, files, 20000);
	assert.ok(uc.length < 21000);
	assert.match(uc, /Use case: <short name>/);
	assert.match(uc, /"sequence" diagram of that flow/);
	assert.match(uc, /Skip the diagram if the flow stays inside one function/);
});

test('packFiles shows small files whole and lists what does not fit', () => {
	const out = packFiles([{ path: 'a.js', text: 'x' }, { path: 'b.js', text: 'y'.repeat(5000) }], 1000);
	assert.match(out, /--- a\.js\n {3}1 \| x/);
	assert.match(out, /Other files \(not shown\):\nb\.js|b\.js \(outline/);
});

test('outermost keeps separate codebases and drops projects nested in them', () => {
	assert.deepEqual(outermost(['web', 'api', 'web/packages/ui', 'web/packages']), ['web', 'api']);
	assert.deepEqual(outermost(['', 'packages/a']), ['']);
	assert.deepEqual(outermost(['ab', 'a']), ['a', 'ab']);
});

test('plan: file pick keeps known paths only, prompt asks for code and tests and stays in budget', () => {
	const tree = ['server/app.js', 'server/middleware/rateLimit.js', 'web/apiClient.js'];
	assert.deepEqual(repairPick({ approach: 'cache in middleware', files: [{ path: 'rateLimit.js' }, { path: 'nope.js' }, 'server/app.js'] }, tree).value,
		{ approach: 'cache in middleware', files: ['server/middleware/rateLimit.js', 'server/app.js'] });
	assert.equal(repairPick({ files: ['nope.js'] }, tree).errors.length, 1);
	const map = { title: 'Taskboard', summary: 'A task board.', components: [{ id: 'api', name: 'Task API', summary: 'routes', files: [{ path: 'server/app.js' }] }], connections: [] };
	assert.match(buildPlanPickPrompt(map, tree, 'How would I add Redis caching?'), /Redis caching[\s\S]*server\/app\.js/);
	const files = [{ path: 'server/app.js', text: 'x\n'.repeat(5000) }];
	const p = buildPlanPrompt(map, 'How would I add Redis caching?', 'cache in middleware', files, 15000);
	assert.ok(p.length < 16000);
	assert.match(p, /"snippets"/);
	assert.match(p, /Integration point[\s\S]*Tests" \(ALWAYS, last\)/);
	assert.match(p, /A first read of the codebase suggests: cache in middleware/);
});

test('learning aids: learn and terms are kept when sound and dropped when not', async () => {
	const { repair, buildMorePrompt } = await import('../prompt');
	const { value } = repair({ title: 'T', learn: ['How requests are counted', '', 7], terms: [{ name: 'middleware', meaning: 'code that runs before a route' }, { name: 'Middleware', meaning: 'dup' }, { name: 'x' }],
		scenes: [{ title: 'a', text: 'x', startLine: 1, endLine: 2 }] }, 1, 10);
	assert.deepEqual(value!.learn, ['How requests are counted']);
	assert.deepEqual(value!.terms, [{ name: 'middleware', meaning: 'code that runs before a route' }]);
	const ctx = { file: 'f.js', lang: 'javascript', code: 'a\nb', startLine: 1 };
	assert.match(buildMorePrompt(ctx, value!.scenes[0], 1e9, 'simpler'), /everyday analogy/);
	assert.match(buildMorePrompt(ctx, value!.scenes[0], 1e9, 'lines'), /one small group at a time/);
});

test('mermaid from the model becomes a diagram: flowchart, sequence, state', async () => {
	const { fromMermaid, repairDiagram } = await import('../prompt');
	const flow = fromMermaid('flowchart LR\n  ui[UI apiClient] --> rl[rateLimit middleware]\n  rl -->|count > max| over(over limit)\n  rl -- count <= max --> ok{under limit}')!;
	assert.deepEqual(flow.nodes.map(n => n.label), ['UI apiClient', 'rateLimit middleware', 'over limit', 'under limit']);
	assert.deepEqual(flow.edges.map(e => e.label ?? ''), ['', 'count > max', 'count <= max']);
	const seq = fromMermaid('sequenceDiagram\n participant C as apiClient\n participant S as server\n C->>S: POST /api/tasks\n S-->>C: 429 Retry-After')!;
	assert.equal(seq.kind, 'sequence');
	assert.deepEqual(seq.edges, [{ from: 'C', to: 'S', label: 'POST /api/tasks' }, { from: 'S', to: 'C', label: '429 Retry-After', reply: true }]);
	const st = fromMermaid('stateDiagram-v2\n [*] --> todo\n todo --> doing : move\n doing --> done : complete\n done --> doing : reopen')!;
	assert.equal(st.kind, 'state');
	assert.equal(st.nodes[0].id, 'todo');
	assert.equal(st.edges.length, 3);
	// edges by label, focus by label, and a scene-level mermaid string
	const d = repairDiagram({ nodes: [{ id: 'a', label: 'Client' }, { id: 'b', label: 'Server' }], edges: [{ from: 'Client', to: 'Server', label: 'GET' }], focus: 'Server' })!;
	assert.deepEqual([d.edges.length, d.focus], [1, 'b']);
	assert.equal(repairDiagram('graph TD\n A-->B')!.edges.length, 1);
	assert.equal(fromMermaid('pie title x'), undefined);
});

test('tours always get a picture of the structure from the map', async () => {
	const { mapDiagram, withMapDiagram } = await import('../prompt');
	const map = { title: 'coee', summary: '', components: [
		{ id: 'ext', name: 'Extension entry', summary: 'Registers commands and lenses.', files: [{ path: 'src/extension.ts' }] },
		{ id: 'wt', name: 'Walkthrough engine', summary: 'Builds and shows walkthroughs', files: [{ path: 'src/walkthrough.ts' }] },
		{ id: 'lm', name: 'Model access', summary: 'Sends prompts, fits budgets', files: [{ path: 'src/lm.ts' }] },
		{ id: 'map', name: 'System map', summary: 'Draws the project', files: [{ path: 'src/map.ts' }] }],
		connections: [{ from: 'ext', to: 'wt', label: 'starts walkthroughs' }, { from: 'wt', to: 'lm', label: 'asks the model' }, { from: 'map', to: 'lm', label: 'asks the model' }] };
	const all = mapDiagram(map)!;
	assert.equal(all.nodes.length, 4);
	assert.equal(all.edges.length, 3);
	assert.equal(all.nodes.find(n => n.id === 'ext')!.detail, 'Registers commands and lenses');
	const near = mapDiagram(map, 'wt')!;
	assert.deepEqual(near.nodes.map(n => n.id).sort(), ['ext', 'lm', 'wt']);
	assert.equal(near.focus, 'wt');
	const w = { title: 'T', summary: '', scenes: [{ title: 'a', label: 'Big picture', text: 'x', startLine: 1, endLine: 1 }, { title: 'b', label: 'Architecture', text: 'x', startLine: 1, endLine: 1 }] };
	const filled = withMapDiagram(w, map);
	assert.ok(!filled.scenes[0].diagram && filled.scenes[1].diagram, 'goes on the Architecture scene');
	const drawn = { ...w, scenes: [{ ...w.scenes[0], diagram: near }] };
	assert.equal(withMapDiagram(drawn, map), drawn, "the model's own diagram is kept");
});

const SAMPLE_DIFF = [
	'diff --git a/src/app.js b/src/app.js',
	'index 1111111..2222222 100644',
	'--- a/src/app.js',
	'+++ b/src/app.js',
	'@@ -1,4 +1,5 @@',
	' const express = require("express");',
	'-const app = express();',
	'+const app = express();',
	'+app.use(rateLimit());',
	' app.get("/", ok);',
	' module.exports = app;',
	'@@ -10,3 +11,2 @@ function ok(req, res) {',
	'   res.send("ok");',
	'-  log("served");',
	' }',
	'diff --git a/src/rateLimit.js b/src/rateLimit.js',
	'new file mode 100644',
	'--- /dev/null',
	'+++ b/src/rateLimit.js',
	'@@ -0,0 +1,2 @@',
	'+module.exports = () => (req, res, next) => next();',
	'+// todo',
	'diff --git a/old.js b/old.js',
	'deleted file mode 100644',
	'--- a/old.js',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-gone();',
	'diff --git a/a.js b/b.js',
	'similarity index 100%',
	'rename from a.js',
	'rename to b.js',
].join('\n');

test('parseUnifiedDiff: modified, added, deleted and renamed files with line positions', async () => {
	const { parseUnifiedDiff, addedLines, removedRuns, diffStats } = await import('../prompt');
	const files = parseUnifiedDiff(SAMPLE_DIFF);
	assert.deepEqual(files.map(f => [f.path, f.status, f.oldPath]), [['src/app.js', 'modified', undefined], ['src/rateLimit.js', 'added', undefined], ['old.js', 'deleted', undefined], ['b.js', 'renamed', 'a.js']]);
	const app = files[0];
	assert.deepEqual(addedLines(app), [2, 3]);
	assert.deepEqual(removedRuns(app), [{ after: 1, lines: ['const app = express();'] }, { after: 11, lines: ['  log("served");'] }]);
	assert.deepEqual(diffStats(app), { plus: 2, minus: 2 });
	assert.deepEqual(addedLines(files[1]), [1, 2]);
	assert.deepEqual(removedRuns(files[2]), [{ after: 0, lines: ['gone();'] }]);
});

test('review prompt: hunks with new-side line numbers, author message, commit message only before committing', async () => {
	const { parseUnifiedDiff, buildReviewPrompt } = await import('../prompt');
	const files = parseUnifiedDiff(SAMPLE_DIFF);
	const p = buildReviewPrompt({ what: 'staged changes', precommit: true }, files, 30000);
	assert.match(p, /--- src\/app\.js · modified · \+2 −2/);
	assert.match(p, /\n {3}3 \+ app\.use\(rateLimit\(\)\);/);
	assert.match(p, /\n {5}- const app = express\(\);/);
	assert.match(p, /"commitMessage"/);
	const c = buildReviewPrompt({ what: 'commit a1b2c3d', message: 'Add rate limiting' }, files, 30000);
	assert.doesNotMatch(c, /"commitMessage"/);
	assert.match(c, /The author describes it as:\n"""\nAdd rate limiting/);
	const big = parseUnifiedDiff(Array.from({ length: 30 }, (_, i) => SAMPLE_DIFF.replace(/src\/app\.js/g, `src/f${i}.js`)).join('\n'));
	assert.ok(buildReviewPrompt({ what: 'x' }, big, 12000).length < 13000);
});

test('architecture: every map part is kept; behaviour needs sequence and state diagrams', async () => {
	const { repairArchitecture, repairBehavior, buildArchitecturePrompt } = await import('../prompt');
	const map = { title: 'P', summary: 's', components: [{ id: 'a', name: 'A', summary: 'does a', files: [{ path: 'a.js' }] }, { id: 'b', name: 'B', summary: 'does b', files: [{ path: 'b.js' }] }], connections: [{ from: 'a', to: 'b', label: 'calls' }] };
	assert.match(buildArchitecturePrompt(map, [{ path: 'a.js', text: 'x' }]), /EVERY part/);
	const arch = repairArchitecture({ howItWorks: 'It works.', components: [{ id: 'a', role: 'Runs things.', keyFiles: [{ path: 'a.js', startLine: 1, why: 'entry' }] }] }, map, ['a.js', 'b.js']);
	assert.deepEqual(arch.errors, []);
	assert.deepEqual(arch.value!.components.map(c => c.role), ['Runs things.', 'does b']);
	assert.equal(repairArchitecture({ components: [] }, map, []).value, undefined);
	const seq = { nodes: [{ id: 'u', label: 'User' }, { id: 'a', label: 'A' }], edges: [{ from: 'u', to: 'a', label: 'run' }] };
	const st = { nodes: [{ id: 'i', label: 'idle' }, { id: 'r', label: 'running' }], edges: [{ from: 'i', to: 'r', label: 'start' }] };
	const ok = repairBehavior({ useCases: [{ name: 'Run', who: 'user', steps: ['go'], sequence: seq }, { name: 'Stop', sequence: seq }], states: [{ name: 'Job', what: 'w', diagram: st }] }, []);
	assert.deepEqual(ok.errors, []);
	assert.equal(ok.value!.useCases[0].sequence.kind, 'sequence');
	assert.equal(ok.value!.states[0].diagram.kind, 'state');
	const noState = repairBehavior({ useCases: [{ name: 'Run', sequence: seq }, { name: 'Stop', sequence: seq }], states: [] }, []);
	assert.equal(noState.errors.length, 1);
	assert.equal(noState.value!.useCases.length, 2, 'what is usable is kept for the retry fallback');
	assert.equal(repairBehavior({ useCases: [{ name: 'No picture' }] }, []).value, undefined);
});

test('data model: entities by id or name, relations with cardinality, at least two entities', async () => {
	const { repairDataModel } = await import('../prompt');
	const { value, errors } = repairDataModel({ what: 'SQLite via db.js', entities: [
		{ id: 'task', name: 'Task', kind: 'table', fields: [{ name: 'id', type: 'integer', key: 'pk' }, { name: 'column_id', key: 'fk' }, 'title'], file: { path: 'server/db.js', startLine: 4 } },
		{ name: 'Column', fields: [{ name: 'id', key: 'pk' }] }],
		relations: [{ from: 'Column', to: 'task', label: 'holds', card: '1-N' }, { from: 'task', to: 'nope' }, { from: 'task', to: 'task' }] }, ['server/db.js']);
	assert.deepEqual(errors, []);
	assert.deepEqual(value!.entities.map(e => [e.id, e.kind, e.fields.length]), [['task', 'table', 3], ['Column', 'type', 1]]);
	assert.deepEqual(value!.entities[0].file, { path: 'server/db.js', startLine: 4, endLine: 4 });
	assert.deepEqual(value!.relations, [{ from: 'Column', to: 'task', label: 'holds', card: '1-n' }]);
	assert.equal(repairDataModel({ entities: [{ name: 'Only' }] }, []).errors.length, 1);
});

test('sequence branches survive repair and are drawn as frames; ER and state diagrams render', async () => {
	const { repairDiagram } = await import('../prompt');
	const { diagramSvg, erSvg } = await import('../layout');
	const seq = repairDiagram({ kind: 'sequence', nodes: [{ id: 'c', label: 'client' }, { id: 's', label: 'server' }],
		edges: [{ from: 'c', to: 's', label: 'POST' }, { from: 's', to: 'c', label: '429', reply: true, branch: 'over the limit' }, { from: 's', to: 'c', label: '201', reply: true }] })!;
	assert.equal(seq.edges[1].branch, 'over the limit');
	assert.match(diagramSvg(seq, 'dark').svg, /alt<\/tspan> over the limit/);
	const st = diagramSvg({ kind: 'state', nodes: [{ id: 'a', label: 'open' }, { id: 'b', label: 'closed' }], edges: [{ from: 'a', to: 'a', label: 'retry' }, { from: 'a', to: 'b', label: 'close' }] }, 'dark').svg;
	assert.match(st, /retry/);
	assert.equal((st.match(/fill="none" stroke="#3a3f47"/g) || []).length, 1, 'only the end state gets the double border');
	const er = erSvg({ entities: [{ id: 'a', name: 'Board', fields: [{ name: 'id', key: 'pk' }] }, { id: 'b', name: 'Task', fields: Array.from({ length: 10 }, (_, i) => ({ name: 'f' + i })) }],
		relations: [{ from: 'a', to: 'b', label: 'has', card: '1-n' }] }, 'dark').svg;
	assert.match(er, />PK</);
	assert.match(er, /\+ 2 more/);
	assert.match(er, />N</);
});

test('whole files are taught by their building blocks, split sensibly across parts', () => {
	const base = { file: 'src/store.ts', lang: 'typescript', code: 'let cache = new Map();\nexport class Store {}', startLine: 1 };
	assert.doesNotMatch(buildExplainPrompt(base), /Module state/);
	const whole = buildExplainPrompt({ ...base, wholeFile: true });
	for (const word of ['Big picture', 'Module state', 'Class', 'Function', 'How it fits together']) assert.match(whole, new RegExp(word));
	assert.match(buildExplainPrompt({ ...base, wholeFile: true, part: { index: 0, count: 3, earlier: [] } }), /include the "Big picture" scene/);
	assert.match(buildExplainPrompt({ ...base, wholeFile: true, part: { index: 1, count: 3, earlier: [] } }), /no "Big picture" and no "How it fits together"/);
	assert.match(buildExplainPrompt({ ...base, wholeFile: true, part: { index: 2, count: 3, earlier: [] } }), /end with "How it fits together"/);
});

test('test files are recognized by name or by their test calls', () => {
	for (const f of ['test/duration.test.js', 'src/__tests__/cart.ts', 'pkg/server_test.go', 'tests/test_api.py', 'app/models/user_spec.rb', 'src/CartTest.java', 'web/login.spec.tsx'])
		assert.ok(isTestFile(f, ''), f);
	for (const f of ['src/testing.ts', 'src/contest.js', 'docs/test-plan.md'])
		assert.ok(!isTestFile(f, 'export const x = 1;'), f);
	assert.ok(isTestFile('src/checks.js', "describe('cart', () => {\n  it('adds', () => {});\n  it('removes', () => {});\n});"));
	assert.ok(isTestFile('checks.py', 'def test_add():\n    pass\n\ndef test_remove():\n    pass'));
	assert.ok(!isTestFile('src/menu.js', "items.forEach(it => { it.render(); });\ntest(x);"));
});

test('test code is explained as use cases', () => {
	const ctx = { file: 'test/cart.test.js', lang: 'javascript', code: "it('adds', () => {});", startLine: 1, testFile: true, wholeFile: true };
	const p = buildExplainPrompt(ctx);
	for (const word of ["What's tested", 'Use case', 'Given / When / Then', 'Edge case', 'Coverage']) assert.ok(p.includes(word), word);
	assert.ok(!p.includes('Module state'), 'test mode replaces file mode');
	assert.ok(buildExplainPrompt({ ...ctx, part: { index: 1, count: 3, earlier: [] } }).includes('only the use cases in these lines'));
});

const server = { path: 'server.js', text: [
	"const store = require('./store');",           // 1
	'',                                            // 2
	'const server = http.createServer(async (req, res) => {', // 3
	"  if (req.method === 'GET') return send(res, 200, store.list());", // 4
	'',                                            // 5
	"  if (req.method === 'POST') {",             // 6
	'    const body = await readJson(req);',       // 7
	'    return send(res, 201, store.create(body));', // 8
	'  }',                                         // 9
	'});',                                         // 10
	'',                                            // 11
	'def_like = 1',                                // 12
].join('\n') };

test('snapRefs: a symbol wins over wrong numbers, and the range covers the whole block', () => {
	const [post] = snapRefs([{ path: 'server.js', symbol: "if (req.method === 'POST') {", startLine: 3, endLine: 4 }], [server]);
	assert.deepEqual([post.startLine, post.endLine, post.symbol], [6, 9, undefined]);
	const [get] = snapRefs([{ path: 'server.js', symbol: "if (req.method === 'GET')", startLine: 1, endLine: 2 }], [server]);
	assert.deepEqual([get.startLine, get.endLine], [4, 4]); // one statement: not the block after it
	const [outer] = snapRefs([{ path: 'server.js', symbol: 'http.createServer' }], [server]);
	assert.deepEqual([outer.startLine, outer.endLine], [3, 10]);
});

test('snapRefs: without a symbol the numbers are only clamped; unknown files are left alone', () => {
	assert.deepEqual(snapRefs([{ path: 'server.js', startLine: 8, endLine: 400 }], [server]), [{ path: 'server.js', startLine: 8, endLine: 12 }]);
	assert.deepEqual(snapRefs([{ path: 'other.js', startLine: 8 }], [server]), [{ path: 'other.js', startLine: 8 }]);
});

test('blockEnd: braces, indentation and a missing end', () => {
	assert.equal(blockEnd(['function f() {', '  if (x) {', '  }', '}', 'next'], 0), 3);
	assert.equal(blockEnd(['def f():', '    a = 1', '', '    return a', 'x = 2'], 0), 3);
	assert.equal(blockEnd(['if (a) {', '  b();'], 0), 1);
});

test('plan snippets: kept when usable, dropped when they point nowhere', () => {
	const known = ['src/app.js'];
	const sn = repairSnippets([
		{ file: 'app.js', mode: 'insert', after: 'const k = key(req);', code: '\n  cache.get(k);\n', lang: 'js' },
		{ file: 'src/app.js', mode: 'insert', code: 'no anchor' },
		{ file: 'nope.js', mode: 'insert', after: '', code: 'x' },
		{ file: '../evil.js', mode: 'new', code: 'x' },
		{ file: '/etc/passwd', mode: 'new', code: 'x' },
		{ file: 'test/app.test.js', mode: 'new', code: "test('x', () => {})" },
		{ file: 'src/app.js', mode: 'replace', code: '' },
	], known);
	assert.deepEqual(sn.map(x => [x.file, x.mode, x.after]), [['src/app.js', 'insert', 'const k = key(req);'], ['test/app.test.js', 'new', undefined]]);
	assert.equal(sn[0].code, '  cache.get(k);');
});

test('repairPlan asks again when the plan has no tests, and accepts it when it does', () => {
	const lines = { 'src/app.js': 50 };
	const sc = (label: string, snippets?: unknown) => ({ label, title: 't', text: 'x', file: 'src/app.js', startLine: 1, endLine: 2, snippets });
	const code = [{ file: 'src/app.js', mode: 'insert', after: '', code: 'a()' }];
	const none = repairPlan({ title: 'P', scenes: [sc('Integration point'), sc('Change in app', code)] }, lines);
	assert.ok(none.value && none.errors.length === 1 && /Tests/.test(none.errors[0]));
	const withTests = repairPlan({ title: 'P', scenes: [sc('Change in app', code), sc('Tests', [{ file: 'src/app.test.js', mode: 'new', code: 'test()' }])] }, lines);
	assert.deepEqual(withTests.errors, []);
	assert.equal(withTests.value!.scenes[1].snippets![0].file, 'src/app.test.js');
});

test('security: findings are checked against the files, deduped and sorted worst first', () => {
	const f = { path: 'server.js', text: server.text };
	const draft = { summary: 'Two problems.', findings: [
		{ severity: 'low', category: 'Logging', title: 'Noisy', file: 'server.js', startLine: 1, endLine: 1, why: 'Logs too much.' },
		{ severity: 'critical', category: 'Command injection', cwe: '78', title: 'exec of input', file: './server.js', symbol: "if (req.method === 'POST') {", startLine: 99, endLine: 120, why: 'Runs user input.', exploit: 'POST ;rm -rf', fix: 'Validate.', fixCode: '\nsafe()\n', testCode: 'test()' },
		{ severity: 'critical', category: 'command injection', title: 'dup', file: 'server.js', symbol: "if (req.method === 'POST') {", why: 'again' },
		{ severity: 'high', category: 'XSS', title: 'no file', file: 'missing.js', why: 'x' },
		{ severity: 'bogus', category: 'Other', title: 'odd severity', file: 'server.js', startLine: 4, why: 'x' },
	] };
	const { value, errors } = repairSecurity(draft, [f]);
	assert.deepEqual(errors, []);
	assert.deepEqual(value!.findings.map(x => [x.id, x.severity, x.title]), [['f1', 'critical', 'exec of input'], ['f2', 'medium', 'odd severity'], ['f3', 'low', 'Noisy']]);
	const first = value!.findings[0];
	assert.deepEqual([first.startLine, first.endLine, first.cwe, first.fixCode], [6, 9, 'CWE-78', 'safe()']);
	assert.equal(repairSecurity({ findings: [] }, [f]).value!.findings.length, 0);
	assert.ok(repairSecurity({ summary: 'x' }, [f]).errors.length);
});

test('security: reports merge, and files batch by size', () => {
	const mk = (file: string, severity: any) => ({ id: 'x', severity, category: 'c', title: 't', file, startLine: 1, endLine: 1, why: 'w', exploit: '', fix: '' });
	const m = mergeReports([{ summary: '', findings: [mk('b.js', 'low'), mk('a.js', 'high')] }, { summary: 'second', findings: [mk('a.js', 'high'), mk('c.js', 'critical')] }]);
	assert.deepEqual(m.findings.map(x => x.file), ['c.js', 'a.js', 'b.js']);
	assert.equal(m.summary, 'second');
	const files = ['a', 'b', 'c'].map(n => ({ path: n, text: 'x'.repeat(40) }));
	assert.deepEqual(batchFiles(files, 100).map(b => b.map(f => f.path)), [['a', 'b'], ['c']]);
	assert.deepEqual(batchFiles([{ path: 'big', text: 'x'.repeat(500) }], 100).map(b => b.length), [1]);
	const p = buildSecurityPrompt(files, 'the project demo', 1e9);
	assert.match(p, /IDOR[\s\S]*--- a\n/);
});

test('security: rule hits are confirmed, rejected, or kept as unconfirmed when the model skips them', () => {
	const f = { path: 'files.js', text: "const a = 1;\nexports.calc = expr => eval(expr);\nexports.t = () => Math.random().toString(36);\nexports.x = y => eval(y);" };
	const hit = (id: string, rule: string, line: number) => ({ id, rule, title: rule, file: 'files.js', line, text: '', cwe: rule === 'js-eval' ? 'CWE-95' : 'CWE-338', owasp: rule === 'js-eval' ? 'A03' : 'A02', severity: 'high' as const, why: 'w', fix: 'f' });
	const hits = [hit('h1', 'js-eval', 2), hit('h2', 'weak-random', 3), hit('h3', 'js-eval', 4)];
	const draft = {
		summary: 's',
		findings: [{ hit: 'h1', severity: 'critical', owasp: 'a03', title: 'eval of user input', why: 'Runs input as code.', exploit: 'POST {"expr":"process.exit()"}',
			attack: { nodes: [{ id: 'a', label: 'Attacker' }, { id: 'r', label: 'calc' }], edges: [{ from: 'a', to: 'r', label: 'expr' }] }, verify: 'Send it.', severityWhy: 'Anyone can call it.' }],
		rejected: [{ id: 'h2', reason: 'Only used for a cache-busting suffix.' }],
	};
	const { value } = repairSecurity(draft, [f], hits);
	const [eval1, eval2] = value!.findings;
	assert.deepEqual([eval1.source, eval1.confirmed, eval1.severity, eval1.owasp, eval1.startLine, eval1.cwe, eval1.attack!.kind], ['rule', true, 'critical', 'A03', 2, 'CWE-95', 'sequence']);
	assert.deepEqual([eval2.source, eval2.confirmed, eval2.startLine], ['rule', false, 4]); // the model never mentioned h3
	assert.deepEqual(value!.rejected!.map(r => [r.hit, r.reason]), [['h2', 'Only used for a cache-busting suffix.']]);
	assert.equal(value!.findings.length, 2);
});

test('security: dependency findings and SARIF export', () => {
	const d = depFinding({ name: 'lodash', version: '4.17.20', file: 'package.json', id: 'GHSA-x', title: 'Prototype Pollution', severity: 'high', fixed: '4.17.21' }, 12);
	assert.deepEqual([d.owasp, d.startLine, d.source], ['A06', 12, 'dependency']);
	assert.match(d.fix, /4\.17\.21/);
	const sarif = toSarif({ summary: '', findings: [{ ...d, id: 'f1', cwe: 'CWE-1035' }] }) as any;
	assert.equal(sarif.version, '2.1.0');
	assert.deepEqual(sarif.runs[0].results[0].locations[0].physicalLocation.region, { startLine: 12, endLine: 12 });
	assert.equal(sarif.runs[0].results[0].level, 'error');
});
