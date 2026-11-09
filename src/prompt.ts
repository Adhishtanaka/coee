// Pure prompt, repair and packing logic. No vscode import, so it's unit-testable.
// Every build*Prompt takes `budget`, the characters it may use; lm.ts shrinks it until the prompt fits the model.

import { packContext } from './context';
import type { Step } from './steps';

// ---------------------------------------------------------------------------
// Walkthroughs

export interface DiagramNode { id: string; label: string; detail?: string }
export interface DiagramEdge { from: string; to: string; label?: string; /** sequence: a return/response, drawn dashed */ reply?: boolean; /** sequence: an alternative path these messages belong to, e.g. "over the limit" */ branch?: string }
export type DiagramKind = 'flow' | 'sequence' | 'state';
export interface Diagram { kind?: DiagramKind; nodes: DiagramNode[]; edges: DiagramEdge[]; caption?: string; /** the node this step is about, drawn highlighted */ focus?: string; /** shows something that doesn't exist in the code (yet) */ illustrative?: boolean }

export interface Scene {
	title: string;
	/** Eyebrow shown above the title: "Big picture", "Data flow", "Edge cases"… */
	label?: string;
	/** Workspace-relative path, for walkthroughs that span files. Absent: the walkthrough's one file. */
	file?: string;
	startLine: number;
	endLine: number;
	text: string;
	diagram?: Diagram;
	/** Index of the chapter (part of a long range) the scene came from. */
	part?: number;
	/** Plans: code to add for this scene, which the reader can copy or insert. */
	snippets?: Snippet[];
	/** Steps planned by coee (steps.ts): the symbols this step is about, what it takes and gives, its rules and links. */
	names?: string[];
	io?: { inputs?: string; output?: string; effects?: string };
	rules?: string[];
	calls?: string[];
	calledBy?: string[];
}

/**
 * Code a plan proposes, placed by the text around it (line numbers drift as soon as anything changes):
 * "insert" goes after the existing lines `after`, "replace" takes the place of the existing text `find`, "new" is a new file.
 */
export interface Snippet { file: string; mode: 'insert' | 'replace' | 'new'; code: string; after?: string; find?: string; lang?: string }

export interface Term { name: string; meaning: string }
export interface Walkthrough {
	title: string;
	summary: string;
	scenes: Scene[];
	/** What the reader will understand by the end, as outcomes. */
	learn?: string[];
	/** Words a junior may not know, with plain meanings (shown on the intro and underlined in the text). */
	terms?: Term[];
	/** Reviews of uncommitted work: a suggested commit message. */
	commitMessage?: string;
}

export interface CodeContext {
	file: string;
	lang: string;
	code: string;
	/** 1-based line of the first line in `code`. */
	startLine: number;
	/** Imports and symbol list of the whole file, so a slice of a big file knows what's around it. */
	outline?: string;
	/** Set when a long range is explained in parts. */
	part?: { index: number; count: number; earlier: string[] };
	/** The whole file is being explained (possibly in parts): teach it by its building blocks. */
	wholeFile?: boolean;
	/** Test code: explain each test as the use case it protects. */
	testFile?: boolean;
}

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs|e2e|cypress|playwright)\/|[._-](test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb|exs?)$|(Tests?|Spec|IT)\.(java|kt|cs|swift|scala)$|_spec\.rb$/i;
const TEST_CALLS = /^\s*(describe|it|test|context|suite)(\.(each|only|skip)\b[^(]*)?\s*\(|^\s*(async\s+)?def\s+test_\w*\s*\(|^\s*func\s+Test\w*\s*\(\s*t\s+\*testing\.T|#\[(tokio::)?test\]|@(Test|ParameterizedTest)\b|\[(Fact|Theory|Test|TestMethod)\]|^\s*class\s+\w+\(\s*(unittest\.)?TestCase\s*\)/m;

/** A test file by its name, or by test-framework calls in its code (several, so one stray it( doesn't count). */
export function isTestFile(file: string, code: string): boolean {
	if (TEST_PATH.test(file)) return true;
	const calls = code.split('\n').filter(l => TEST_CALLS.test(l)).length;
	return calls >= 2;
}

/** One file offered to a folder walkthrough. */
export interface FolderFile { path: string; text: string }

export interface Turn { q: string; a: string }

export function numberLines(text: string, start = 1): string[] {
	return text.split('\n').map((l, i) => `${String(start + i).padStart(4)} | ${l}`);
}

export function numbered(ctx: CodeContext): string {
	return numberLines(ctx.code, ctx.startLine).join('\n');
}

/** Numbered code within `budget` chars: everything if it fits, else a window around `focus` (1-based lines). */
export function numberedFit(ctx: CodeContext, budget: number, focus?: { startLine: number; endLine: number }): string {
	const lines = numberLines(ctx.code, ctx.startLine);
	if (lines.join('\n').length <= budget) return lines.join('\n');
	let used = 0;
	const grow = (i: number) => {
		if (i < 0 || i >= lines.length || used + lines[i].length + 1 > budget) return false;
		used += lines[i].length + 1;
		return true;
	};
	let lo = Math.min(lines.length - 1, Math.max(0, (focus?.startLine ?? ctx.startLine) - ctx.startLine)), hi = lo - 1;
	const focusEnd = Math.min(lines.length - 1, (focus?.endLine ?? ctx.startLine) - ctx.startLine);
	while (hi < focusEnd && grow(hi + 1)) hi++; // the focus first
	for (let more = true; more;) { // then outward, below and above in turn
		more = false;
		if (grow(hi + 1)) { hi++; more = true; }
		if (grow(lo - 1)) { lo--; more = true; }
	}
	const out = lines.slice(lo, hi + 1);
	if (lo > 0) out.unshift(`     … ${lo} earlier lines left out …`);
	if (hi < lines.length - 1) out.push(`     … ${lines.length - 1 - hi} later lines left out …`);
	return out.join('\n');
}

export function endLine(ctx: CodeContext): number {
	return ctx.startLine + ctx.code.split('\n').length - 1;
}

const ROLE = 'You explain code to help someone understand it. You never suggest, write or make edits.';
export const GUIDE = 'The reader is a working programmer. Skip what any programmer already knows (syntax, obvious names) and spend words on intent, data flow, and the non-obvious.';
const MAX_SCENES = 12, MAX_NODES = 12, MAX_EDGES = 20;
const FIXED = 3500; // room for the fixed instructions in each prompt

/** How to teach. */
const EXPLAINING = `How to explain: like a patient senior colleague walking someone through the code, beside it. Assume the reader is new to this codebase and may be new to the idea itself.
Order the scenes the way understanding builds:
1. The problem: why this code exists, what would go wrong without it.
2. The underlying concept: the idea in plain words. When it's abstract, open with a short everyday analogy ("Think of it as two halves shaking hands: …"), then say concretely what happens. Show a diagram here when the shape is the point.
3. How the code does it: point at the exact lines and say how they carry out the idea, using the real names.
4. Behavior worth knowing: what happens in the edge cases and failures, with a concrete example ("a 61st request in the same minute gets a 429 and waits 12 seconds").
5. A short summary scene when there are 4 or more scenes: the whole idea again in two or three plain sentences.
Writing rules:
- Each scene is ONE idea. Its "title" is the takeaway as a short sentence ("Limiter says wait, client waits the longer of backoff or server ask"), never a label like "Imports" or "The handler".
- Its "label" names what kind of scene it is, as an eyebrow: "The problem", "Underlying concept", "How it works", "Behavior", "Edge case", "Tradeoff", "Summary", or "Big picture".
- "text" is 50-110 words of plain, spoken-style sentences. No headings, no line numbers, no "this code…" filler. The first time a term a beginner may not know appears (middleware, debounce, idempotent…), explain it in a few words.
- Never walk line by line or list what each statement does. Use the same names in text, diagrams and code.
- Be concrete: name the real files, functions, commands and data of THIS code. Never write a sentence that could describe any project ("understanding code can be challenging", "this improves the user experience", "handles errors gracefully").
- Ground every claim in the code shown; if something isn't shown, say what it probably does and that it's not shown.
For a reader who knows some programming but not much:
- "learn": 2-4 things they will understand by the end, as outcomes ("How each request is counted per IP address").
- "terms": 3-8 words from this code or its domain that a junior may not know (e.g. middleware, token bucket, debounce, ORM), each with a plain meaning under 20 words. Use the same spelling in the text.`;

/** Tests are taught as the use cases they pin down, in plain words, before any test mechanics. */
const TEST_EXPLAINING = `This is test code. Tests are the clearest description of what the code is supposed to do, so teach them as use cases: real situations and what must happen in each. Someone who has never seen this project should finish knowing what the code under test promises.
Scenes, in this order:
1. "What's tested": which code these tests cover (name the module, class or function, from the imports), what it is for, and how the tests are organized (groups, shared setup).
2. "Setup", only when there is real setup (fixtures, mocks, fakes, a test database, fake timers): what the fake world looks like and why the tests need it. Skip it otherwise.
3. One "Use case" scene per test, or per small group of tests about the same behavior, in the order they appear. For each:
   - Open with the situation in everyday words, as a short story: "A customer enters 1h30m as a timeout…". Not the test's name, not code.
   - Then what the test does and what it expects, as Given / When / Then in plain words ("Given an empty cart, when the user checks out, then they see 'Your cart is empty' and no order is created").
   - Then why it matters: the bug or broken promise this test would catch.
   - Use the concrete values from the test ("1h30m becomes 5,400,000 ms").
   Label a test about invalid input, failures, limits or odd inputs "Edge case" instead of "Use case"; label a test that pins down a past bug "Regression".
   Point each scene at the lines of that test (or group).
4. "Coverage": what these tests guarantee taken together, and the obvious cases they do NOT check, so the reader knows the gaps.
Use those words as scene labels. With many tests, group closely related ones so there are at most 10 scenes. This order replaces the generic scene order under "How to explain" below; every scene still follows its writing rules. Explain assertion helpers or mocking only when needed to follow a case, in a sentence.`;

/** A whole file is taught by its building blocks: the map first, then each class, function and piece of module state. */
const FILE_EXPLAINING = `This is a whole source file. Teach it the way a senior engineer onboards someone to a file they will have to work in: first the map, then each building block, then how they work together.
Scenes, in this order:
1. "Big picture": what this file is for in the project and who uses it, then a map of what's inside: the main classes, functions and module-level variables, each in a few words, and how they depend on each other. Point it at the file's opening lines (imports and first declarations). A flow diagram of how the pieces depend on each other usually helps here.
2. One scene per important building block, in the order a reader needs them: things others depend on first, entry points and exports last.
   - "Module state": module-level variables and constants. Say what each holds, why it lives at file level, and who reads or changes it. Call out shared mutable state (caches, singletons, counters) and why it matters. Group small related constants into one scene.
   - "Class": its responsibility in one sentence, the state it keeps (its fields) and what that state means, its key methods and how they work together, and its lifecycle: how it's created, used and cleaned up. Use a state diagram when it moves between stages.
   - "Function": what it takes and returns, its side effects (I/O, network, mutation, throwing), who calls it and when, and the edge cases it handles.
   - "Helpers": small utility functions grouped into one scene, a sentence or two each.
   - "Entry point": what the file exports or runs, and what an outside caller sees.
   Skip trivial getters, re-exports and boilerplate, or mention them in passing.
3. "How it fits together": follow one typical use through the file from its entry point, naming each class, function and variable as it's touched, so the reader sees the pieces cooperate. A sequence diagram often helps.
Use those words as scene labels. Use 4-8 scenes. This order replaces the generic scene order under "How to explain" below; every scene still follows its writing rules.`;

const DIAGRAM_RULES = `Diagrams: add one only when a picture makes the idea click faster than words. Decide per scene:
- "sequence" when two or more parts call each other over time (a request through middleware, client ↔ server, a callback or event round trip). Nodes are the participants, left to right; edges are the messages in time order, with "reply": true on responses.
- "state" when the code manages a lifecycle: a status field, an enum of modes, a connection or job that moves between stages. Nodes are the states, the initial one first; edges are transitions labelled with the event or condition.
- "flow" when data or control branches or passes through stages (a pipeline, a decision with several outcomes, how parts depend on each other). Nodes are parts or steps; edge labels say what flows or when ("count > max", "429").
- No diagram for a single function doing one thing, plain data, or setup code: omit "diagram".
A walkthrough of 4+ scenes usually has 1-3 diagrams, mostly on "Underlying concept", "How it works" and "Big picture" scenes.
Like a whiteboard sketch: 3-7 nodes, each with a short "label" (a real name from the code, e.g. "rateLimit middleware") and a 2-5 word "detail" ("per-IP counter"). Set "focus" to the id of the node this scene is about. Add a one-line "caption". Set "illustrative": true when it shows a model of the idea rather than code exactly as written.`;
const DIAGRAM_SCHEMA = `"diagram"?: {"kind": "flow"|"sequence"|"state", "nodes": [{"id": string, "label": string, "detail"?: string}], "edges": [{"from": id, "to": id, "label"?: string, "reply"?: boolean}], "focus"?: id, "caption"?: string, "illustrative"?: boolean}`;
const SCENE_SCHEMA = (file: boolean) => `{"label": string, "title": string (the takeaway, a short sentence),${file ? ' "file": string,' : ''} "startLine": number, "endLine": number, "text": string (50-110 words; \`code\` spans allowed), ${DIAGRAM_SCHEMA}}`;
const LEARNING_SCHEMA = `"learn": [string], "terms": [{"name": string, "meaning": string}]`;

function surroundings(ctx: CodeContext, room: number): string {
	const out: string[] = [];
	if (ctx.outline) out.push(`Outline of the whole file (for context; explain only the numbered code below):\n${ctx.outline.slice(0, Math.max(0, room))}`);
	if (ctx.part) {
		out.push(`This is part ${ctx.part.index + 1} of ${ctx.part.count} of a longer walkthrough.`);
		if (ctx.part.earlier.length) out.push(`Earlier parts covered:\n${ctx.part.earlier.map(e => `- ${e}`).join('\n')}\nBuild on them; don't repeat them.`);
	}
	return out.length ? out.join('\n\n') + '\n\n' : '';
}

function testTask(ctx: CodeContext): string {
	const p = ctx.part;
	const which = !p ? ''
		: p.index === 0 ? `\nThis walkthrough covers the tests in ${p.count} parts and this is the first: include "What's tested" (using the outline for the whole file), but leave "Coverage" to the last part.`
		: p.index === p.count - 1 ? '\nThis is the last part: no "What\'s tested" scene (part 1 had it); end with "Coverage" for the whole file.'
		: '\nThis is a middle part: only the use cases in these lines, no "What\'s tested" and no "Coverage" scene.';
	const scope = ctx.wholeFile || p ? `the tests in ${ctx.file}` : `these tests from ${ctx.file}`;
	return `Explain ${scope} (${ctx.lang}).\n${TEST_EXPLAINING}${which}`;
}

function fileTask(ctx: CodeContext): string {
	const p = ctx.part;
	const which = !p ? ''
		: p.index === 0 ? `\nThis walkthrough covers the file in ${p.count} parts and this is the first: include the "Big picture" scene (map the whole file, using the outline), but leave "How it fits together" to the last part.`
		: p.index === p.count - 1 ? '\nThis is the last part of the file: no "Big picture" scene (part 1 had it); end with "How it fits together" for the whole file.'
		: '\nThis is a middle part of the file: no "Big picture" and no "How it fits together" scene; explain only the building blocks in these lines.';
	return `Explain the ${ctx.lang} file ${ctx.file}.\n${FILE_EXPLAINING}${which}`;
}

/**
 * A walkthrough whose steps coee has already chosen (steps.ts): every function, class and method, in call order, with
 * exact lines. The model writes each step; it doesn't choose or move them.
 */
export function buildStepsPrompt(ctx: CodeContext, steps: readonly Step[], budget = 1e9): string {
	const list = steps.map(st => `${st.id} · ${st.label} · lines ${st.startLine}-${st.endLine}${st.signature ? ` · \`${st.signature.slice(0, 120)}\`` : ''}`
		+ `${st.calls.length ? ` · calls ${st.calls.join(', ')}` : ''}${st.calledBy.length ? ` · called by ${st.calledBy.join(', ')}` : ''}${st.rules.length ? ` · has ${st.rules.length} rule${st.rules.length === 1 ? '' : 's'}` : ''}`).join('\n');
	const head = `${ROLE}
${GUIDE}

Explain this ${ctx.lang} code from ${ctx.file} as a step-by-step walkthrough. The steps are already chosen: one per function, class or method, in the order the code runs. Write EVERY step below, in this order, using its id. Don't add, merge, skip or move steps.
${list}

For each step:
- "title": the takeaway, one short sentence (not just the name).
- "text": 60-140 words. What it's for and why it exists, then how it does it, naming the real variables and calls. Explain the non-obvious parts: an edge case, a trick, a gotcha, why it's written this way. For "Start here": what this file is for, what it imports and keeps, and where execution enters. For "How it fits together": how the steps work together, as one story from where it starts to what it produces. For "Small helpers": one sentence per helper.
- "inputs": what it takes (parameters, and what each means), "output": what it returns or produces, "effects": state it changes, I/O, network, files, or other calls with consequences. Plain words, one line each; omit when there's nothing.
- "rules": the business rules and guards inside it in plain words, one per item ("a title is required", "only the owner can cancel"); omit when there are none.
- "diagram": only when a picture helps (a branchy flow, calls back and forth, a lifecycle).
${surroundings(ctx, 1500)}
${DIAGRAM_RULES}

Reply with ONLY JSON, no prose:
{"title": string, "summary": string (one or two sentences: what this code is for), ${LEARNING_SCHEMA}, "steps": [{"id": string, "title": string, "text": string, "inputs"?: string, "output"?: string, "effects"?: string, "rules"?: [string], ${DIAGRAM_SCHEMA}}]}

\`\`\``;
	return `${head}
${numberedFit(ctx, budget - head.length - 200)}
\`\`\``;
}

/**
 * The model's words on coee's steps: lines, labels and links come from the step, never from the model.
 * A step the model skipped is an error the first time (it's asked again), and after that gets a plain step from the
 * index, so a walkthrough never silently leaves a function out.
 */
export function repairSteps(draft: any, steps: readonly Step[]): { value?: Walkthrough; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	const raw: any[] = Array.isArray(draft.steps) ? draft.steps : Array.isArray(draft.scenes) ? draft.scenes : [];
	const byId = new Map(raw.map(x => [str(x?.id, 10), x]));
	const missing: string[] = [];
	const scenes: Scene[] = steps.map((st, k) => {
		const x = byId.get(st.id) ?? (raw.length === steps.length ? raw[k] : undefined); // ids dropped but order kept: still usable
		const text = str(x?.text ?? x?.explanation, 3000);
		if (!text) missing.push(st.id);
		const scene: Scene = {
			title: str(x?.title, 200) || st.label, label: st.label, startLine: st.startLine, endLine: st.endLine,
			text: text || [st.signature ? `\`${st.signature}\`` : '', st.calls.length ? `Calls ${st.calls.map(c => `\`${c}\``).join(', ')}.` : '', st.calledBy.length ? `Called by ${st.calledBy.map(c => `\`${c}\``).join(', ')}.` : ''].filter(Boolean).join(' ') || 'See the highlighted lines.',
		};
		if (st.names.length) scene.names = st.names;
		const io = { inputs: str(x?.inputs, 300), output: str(x?.output, 300), effects: str(x?.effects, 300) };
		if (io.inputs || io.output || io.effects) scene.io = Object.fromEntries(Object.entries(io).filter(([, v]) => v));
		const rules = (Array.isArray(x?.rules) ? x.rules : []).map((r: unknown) => str(r, 200)).filter(Boolean).slice(0, 8);
		if (rules.length) scene.rules = rules; else if (st.rules.length) scene.rules = st.rules.slice(0, 8);
		if (st.calls.length) scene.calls = st.calls;
		if (st.calledBy.length) scene.calledBy = st.calledBy;
		const diagram = repairDiagram(x?.diagram ?? x?.mermaid);
		if (diagram) scene.diagram = diagram;
		return scene;
	});
	const errors = missing.length ? [`These steps are missing their "text": ${missing.join(', ')}. Write every step, by id.`] : [];
	const w: Walkthrough = { title: str(draft.title, 200) || scenes[0].title, summary: str(draft.summary, 500), scenes };
	const learn = (Array.isArray(draft.learn) ? draft.learn : []).map((x: unknown) => str(x, 160)).filter(Boolean).slice(0, 4);
	if (learn.length) w.learn = learn;
	const terms = repairTerms(draft.terms);
	if (terms.length) w.terms = terms;
	return { value: w, errors };
}

export function buildExplainPrompt(ctx: CodeContext, budget = 1e9): string {
	const room = budget - FIXED;
	const around = surroundings(ctx, room * 0.15);
	return `${ROLE}
${GUIDE}

${around}${ctx.testFile ? testTask(ctx) : ctx.wholeFile ? fileTask(ctx) : `Explain this ${ctx.lang} code from ${ctx.file} as a walkthrough of 2-6 scenes, in the order a reader should meet the ideas.`}
Each scene points at the lines it is about, using the line numbers shown at the left (between ${ctx.startLine} and ${endLine(ctx)}).

${EXPLAINING}

${DIAGRAM_RULES}

Reply with ONLY JSON, no prose:
{"title": string, "summary": string (one or two sentences: what this code is for), ${LEARNING_SCHEMA}, "scenes": [${SCENE_SCHEMA(false)}]}

\`\`\`
${numberedFit(ctx, room - around.length)}
\`\`\``;
}

/**
 * Files into `room` chars, the way pr-agent packs a pull request: ranked (the `focus` files, entry points, core files
 * first), every file's outline from the code index (functions, routes, data shapes, rules, real line numbers), and as
 * many files whole as fit. See context.ts.
 */
export function packFiles(files: FolderFile[], room: number, focus: readonly string[] = []): string {
	return packContext(files, Math.max(0, room), focus).text;
}

function filesWalkthrough(task: string, files: FolderFile[], budget: number, scenes: string, opts: { role?: string; snippets?: boolean; focus?: readonly string[] } = {}): string {
	const scene = SCENE_SCHEMA(true).replace(/\}$/, opts.snippets ? `, "snippets"?: [{"file": string, "mode": "insert"|"replace"|"new", "after"?: string, "find"?: string, "lang"?: string, "code": string}]}` : '}');
	return `${opts.role ?? ROLE}
${GUIDE}

${task}
Each scene points at one file ("file", exactly as written after ---) and the lines it is about, using the line numbers shown at the left. Use ${scenes} scenes.

${EXPLAINING}

${DIAGRAM_RULES}

Reply with ONLY JSON, no prose:
{"title": string, "summary": string (one or two sentences), ${LEARNING_SCHEMA}, "scenes": [${scene}]}

${packFiles(files, budget - FIXED - task.length - 1500, opts.focus)}`;
}

function mapContext(map: SystemMap): string {
	const name = (id: string) => map.components.find(c => c.id === id)?.name ?? id;
	return `Project: ${map.title}. ${map.summary}
Its parts (from the system map):
${map.components.map(c => `- ${c.name}: ${c.description || c.summary} [${c.files.map(f => f.path).slice(0, 6).join(', ')}]`).join('\n')}
How they connect:
${map.connections.map(e => `- ${name(e.from)} → ${name(e.to)}: ${e.label ?? ''}${e.detail ? ` (${e.detail})` : ''}`).join('\n') || '- (none recorded)'}`;
}

// ---------------------------------------------------------------------------
// Plan a change: a walkthrough of how a proposed change would integrate, explained without writing it

const PLAN_ROLE = 'You plan changes to a codebase for a developer who will make them. You propose the code, they decide whether to use it.';
const PLAN_RULES = `Explain how the change fits into this codebase, and give the code for it, so the reader can plan it, judge it and add it themselves.
Ground every claim in the files shown: each scene points at the EXISTING lines it is about (where the new logic would hook in, or what it would change). Say when something would be new, and where it would live.
Use these scene labels, in this order, skipping any that don't apply:
- "Integration point": the existing seam (a middleware chain, a call site, a configuration, an interface) the change attaches to, and why there.
- "Proposed flow": the request or data path once the change exists, as a "sequence" diagram with the new participant, marked "illustrative": true.
- "Change in <component>": one scene per file that changes: what its responsibility becomes, with the code in "snippets" (see below).
- "State and data": new or changed state, storage, configuration or lifecycle (a "state" diagram if a lifecycle changes).
- "Risks and trade-offs": failure modes, and the main design decision with its alternative.
- "Tests" (ALWAYS, last): which cases the tests cover (the happy path, each edge case and each failure the change introduces), and the test code in "snippets", written in the project's own test framework, file naming and style (if it has none, use the language's standard one). Point the scene at the code under test.
"snippets": the code to add, as small as works, in the project's style and matching what the files already do. Each one: {"file", "mode", "code", "after"?, "find"?, "lang"?}. Snippets are placed by the text around them, never by line numbers:
  "insert": "file" is a file shown; "after" is 1-3 existing lines copied EXACTLY from that file (without the line numbers), unique in it; "code" goes right after them. Use "after": "" only to put code at the very top (imports).
  "replace": "find" is the existing text to replace, copied EXACTLY from the file (whole lines, without line numbers), unique in it; "code" is what replaces it. Replace only what changes, and never replace a line with a much bigger block that keeps it: insert instead.
  "new": "file" is a new path inside the project (a test file, usually); "code" is the whole file.
  Write complete, runnable code. The reader may copy it or insert it with one click.
Write in a clear, professional tone, as in a design review.`;

/** First call: which files a proposed change concerns, judged from the map and the file list. */
export function buildPlanPickPrompt(map: SystemMap, tree: string[], question: string, budget = 1e9): string {
	const head = `You help plan changes to a codebase. You never write code.

${mapContext(map)}

The developer asks: ${question}

Pick the files someone must read to explain how this would fit into the codebase: the seam it plugs into, the components it changes, the config and entry points involved, and the tests that would notice. Pick at most 15, most important first, using paths exactly as listed.
Reply with ONLY JSON: {"approach": string (2-3 sentences: where and how it would fit), "files": [{"path": string, "why": string}]}

Files in the project:
`;
	return head + tree.join('\n').slice(0, Math.max(0, budget - head.length - 500));
}

export function repairPick(draft: any, known: readonly string[]): { value?: { approach: string; files: string[] }; errors: string[] } {
	const files = [...new Set((Array.isArray(draft?.files) ? draft.files : [])
		.map((f: any) => resolvePath(typeof f === 'string' ? f : str(f?.path, 300), known))
		.filter((p: string | undefined): p is string => !!p))].slice(0, 15) as string[];
	if (!files.length) return { errors: ['"files" must list at least one path from the file list'] };
	return { value: { approach: str(draft?.approach, 800), files }, errors: [] };
}

/** Second call: the walkthrough of how the change would fit, from the picked files. */
export function buildPlanPrompt(map: SystemMap, question: string, approach: string, files: FolderFile[], budget = 1e9, focus: readonly string[] = []): string {
	return filesWalkthrough(`${mapContext(map)}

The developer asks: "${question}"
${approach ? `A first read of the codebase suggests: ${approach}\n` : ''}
${PLAN_RULES}`, files, budget, '5-10', { role: PLAN_ROLE, snippets: true, focus });
}

/** A plan must carry its tests: a "Tests" scene whose snippets hold the test code. Without them the model is asked once more. */
export function repairPlan(draft: any, files: Record<string, number>, texts: readonly FolderFile[] = []): { value?: Walkthrough; errors: string[] } {
	const r = repair(draft, 1, 1, files);
	if (!r.value) return r;
	// Code whose place can't be found is sent back once; what still can't be placed is shown with Copy only.
	const byPath = new Map(texts.map(f => [f.path, f.text]));
	for (const sn of r.value.scenes.flatMap(s => s.snippets ?? [])) {
		if (sn.mode === 'new' || !byPath.has(sn.file)) continue;
		const p = placeSnippet(byPath.get(sn.file), sn);
		if (p.status === 'error') r.errors.push(`Snippet for ${sn.file}: ${p.reason} Copy "${sn.mode === 'replace' ? 'find' : 'after'}" exactly from the file, unique lines, without line numbers`);
	}
	if (!r.value.scenes.some(s => /test/i.test(s.label ?? '') && s.snippets?.length)) {
		r.errors.push('The plan must end with a scene labelled "Tests" whose "snippets" hold the test code (mode "new" for a new test file), covering the happy path and the edge cases');
	}
	return r;
}

/** Codebase tour, part 1: the whole system, before any one component. */
export function buildTourOverviewPrompt(map: SystemMap, files: FolderFile[], budget = 1e9, focus: readonly string[] = []): string {
	return filesWalkthrough(`${mapContext(map)}

This is the first part of a guided tour of the whole codebase; later parts take each component in turn. Give the overview a newcomer needs before reading any code. For this overview, use these scenes in this order instead of the generic order below (skip one only if it truly doesn't apply):
1. label "Big picture": what this project does and for whom, concretely (what a user does with it, what comes out), pointing at the entry point (where execution starts: the first file shown, marked "entry point" in its outline).
2. label "Architecture": how the parts above fit together, with a "flow" diagram whose nodes are those parts (use their names) and whose edges say what passes between them.
3. label "State": the central lifecycle or status the system manages, with a "state" diagram, only if there is one.
4. label "Where to start": which files to read first and the conventions that hold across the code.
Don't trace individual user actions here; the next part of the tour covers the use cases.
The files shown are the README, manifests and entry points. Point scenes at source code (the entry point, the main loop or router, the key functions), not at the README or manifests, except at most one scene.`, files, budget, '3-4', { focus });
}

/** Codebase tour, part 2: what people do with the project, each traced through the code. */
export function buildTourUseCasesPrompt(map: SystemMap, files: FolderFile[], budget = 1e9, focus: readonly string[] = []): string {
	return filesWalkthrough(`${mapContext(map)}

This part of a guided tour of the codebase covers its use cases: the 2-4 main things someone does with this project (a command they run, a request they send, a screen they use, a job that runs), the ones a newcomer must understand to understand the codebase. For this part, use this structure instead of the generic order below.
For each use case, one scene (two if it has an important branch), labelled "Use case: <short name>" (e.g. "Use case: explain a function"):
- First what the person does and what they get back, in one or two plain sentences.
- Then how it flows through the code, in order: where it enters (point the scene at those lines), which parts it passes through (by their names above), where data is read or written, what comes back.
- Add a "sequence" diagram of that flow through the parts (nodes are the parts or key functions, by their real names) when it crosses two or more parts; a "flow" diagram instead when the interesting part is a branch or decision. Skip the diagram if the flow stays inside one function.
End with one scene labelled "How they fit" only if the use cases share an important path worth pointing out.`, files, budget, '3-6', { focus });
}

/**
 * A diagram straight from the system map: the whole architecture, or one part with its neighbours (highlighted).
 * The tour falls back to these when the model leaves a part without a picture, so every tour shows the structure.
 */
export function mapDiagram(map: SystemMap, focus?: string): Diagram | undefined {
	const degree = (id: string) => map.connections.filter(e => e.from === id || e.to === id).length;
	const ids = focus
		? [focus, ...new Set(map.connections.flatMap(e => e.from === focus ? [e.to] : e.to === focus ? [e.from] : []))].slice(0, 7)
		: map.components.map(c => c.id).sort((a, b) => degree(b) - degree(a)).slice(0, 10);
	const keep = new Set(ids);
	const nodes = map.components.filter(c => keep.has(c.id)).map(c => ({ id: c.id, label: c.name, ...(c.summary ? { detail: c.summary.split(/[.;,(]/)[0].slice(0, 40) } : {}) }));
	if (nodes.length < 2) return undefined;
	const edges = map.connections.filter(e => keep.has(e.from) && keep.has(e.to) && e.from !== e.to).map(e => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) }));
	const name = map.components.find(c => c.id === focus)?.name;
	return { nodes, edges, ...(focus ? { focus, caption: `${name} and the parts it works with` } : { caption: `How the parts of ${map.title} connect` }) };
}

/** Give a tour part a picture from the map when the model didn't draw one. */
export function withMapDiagram(w: Walkthrough, map: SystemMap, focus?: string): Walkthrough {
	if (w.scenes.some(s => s.diagram)) return w;
	const d = mapDiagram(map, focus);
	if (!d) return w;
	const find = (re: RegExp) => w.scenes.findIndex(s => re.test(s.label ?? ''));
	const at = [/architecture/i, /big picture|how it works|concept/i].map(find).find(k => k >= 0) ?? 0;
	return { ...w, scenes: w.scenes.map((s, k) => k === at ? { ...s, diagram: d } : s) };
}

/** Codebase tour, one component: its own code, in the context of the whole map. */
export function buildTourPartPrompt(map: SystemMap, c: MapComponent, files: FolderFile[], earlier: string[], budget = 1e9): string {
	const name = (id: string) => map.components.find(x => x.id === id)?.name ?? id;
	const links = map.connections.filter(e => e.from === c.id || e.to === c.id)
		.map(e => e.from === c.id ? `uses ${name(e.to)} (${e.label ?? ''})` : `used by ${name(e.from)} (${e.label ?? ''})`);
	const cited = c.files.filter(f => f.startLine).map(f => `${f.path}:${f.startLine}-${f.endLine}${f.why ? ` (${f.why})` : ''}`);
	return filesWalkthrough(`${mapContext(map)}

This part of a guided tour of the codebase covers the component "${c.name}": ${c.description || c.summary}
It ${links.join('; ') || 'has no recorded connections'}.${cited.length ? `\nKey code: ${cited.join('; ')}` : ''}
${earlier.length ? `Earlier parts of the tour covered:\n${earlier.map(e => `- ${e}`).join('\n')}\nBuild on them; don't repeat them.\n` : ''}
Explain how this component does its job: its responsibility and the main idea, the key code path, how it talks to the parts it connects to (a "sequence" diagram if calls go back and forth), any state it keeps (a "state" diagram if it has a lifecycle), and its edge cases.`, files, budget, '2-5', { focus: c.files.map(f => f.path) });
}

export function buildRepairPrompt(errors: string[]): string {
	return `Your JSON had problems:\n- ${errors.join('\n- ')}\nReply with the corrected JSON only.`;
}

const STYLE = 'Be concise. Light markdown is fine: `code` spans, **bold**, short bullet lists, a small code block only when quoting the code helps.';

export type HelpMode = 'simpler' | 'deeper' | 'lines';

const HELP: Record<HelpMode, string> = {
	simpler: 'Explain the same idea again for someone with only a little programming experience: start with an everyday analogy, then say what the code does in plain words, with no jargon (or define each term in a few words). Under 150 words.',
	deeper: 'Explain that part in more depth: what the lines do and why they are written this way, the alternatives and their tradeoffs, and what would break if it changed. Under 220 words.',
	lines: 'Walk through those lines one small group at a time, as a bullet list: quote the code briefly in a `code` span, then say in plain words what it does and why. Skip blank lines and obvious closing braces. Under 250 words.',
};

export function buildMorePrompt(ctx: CodeContext, s: Scene, budget = 1e9, mode: HelpMode = 'deeper'): string {
	const room = budget - FIXED - s.text.length;
	const around = surroundings({ ...ctx, part: undefined }, room * 0.15);
	return `${ROLE}
${GUIDE}

${around}The reader is on the step "${s.title}" (lines ${s.startLine}-${s.endLine}) of a walkthrough of ${ctx.file}, which said:
"${s.text}"
${HELP[mode]} ${STYLE}

\`\`\`
${numberedFit(ctx, room - around.length, s)}
\`\`\``;
}

export function buildAskPrompt(ctx: CodeContext, question: string, scene?: Scene, history: Turn[] = [], budget = 1e9): string {
	let room = budget - FIXED - question.length;
	const past = history.slice(-4).map(t => `Q: ${t.q}\nA: ${t.a}`).join('\n\n').slice(-Math.max(0, Math.floor(room * 0.25)));
	room -= past.length;
	const around = surroundings({ ...ctx, part: undefined }, room * 0.15);
	return `${ROLE}
${GUIDE}

${around}${scene ? `The reader is looking at lines ${scene.startLine}-${scene.endLine} ("${scene.title}").\n` : ''}${past ? `Earlier in this conversation:\n${past}\n\n` : ''}Their question about this code from ${ctx.file}: ${question}
Answer in under 200 words. ${STYLE} If they ask for a change, explain what it would involve instead of writing it.

\`\`\`
${numberedFit(ctx, room - around.length, scene)}
\`\`\``;
}

/** Brackets still open at the end of `s` (ignoring those inside strings), as the text that closes them. */
function closers(s: string): string {
	const stack: string[] = [];
	let inStr = false, esc = false;
	for (const ch of s) {
		if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
		if (ch === '"') inStr = true;
		else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
		else if (ch === '}' || ch === ']') stack.pop();
	}
	return stack.reverse().join('');
}

/** Pull the JSON object out of a model reply (tolerates ``` fences, chatter, and a reply cut off mid-way). */
export function parseJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
	const body = fenced && fenced[1].includes('{') ? fenced[1] : text;
	const start = body.indexOf('{');
	if (start < 0) throw new Error('No JSON object in reply');
	const end = body.lastIndexOf('}');
	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch (first) {
		// Truncated reply: cut after the last complete object we can find and close what's still open.
		// ponytail: tries the last 40 '}' only; a real streaming JSON parser if replies get cut earlier
		for (let i = end, tries = 0; i > start && tries < 40; i = body.lastIndexOf('}', i - 1), tries++) {
			const head = body.slice(start, i + 1);
			try { return JSON.parse(head + closers(head)); } catch { /* keep cutting */ }
		}
		throw first;
	}
}

const str = (v: unknown, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const int = (v: unknown) => { const n = typeof v === 'string' ? parseInt(v, 10) : v; return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN; };

/**
 * Mermaid (flowchart / sequenceDiagram / stateDiagram) as a Diagram. Models write mermaid fluently, so it's
 * accepted alongside the JSON shape. ponytail: the common one-line forms only; subgraphs, notes and styling are ignored
 */
export function fromMermaid(src: string): Diagram | undefined {
	const lines = src.replace(/```(mermaid)?/g, '').split(/\n|;/).map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
	const head = (lines.shift() ?? '').toLowerCase();
	const nodes: DiagramNode[] = [], edges: DiagramEdge[] = [];
	const node = (id: string, label?: string) => {
		id = id.trim();
		if (!id) return id;
		const n = nodes.find(x => x.id === id);
		if (!n) nodes.push({ id, label: label?.trim() || id });
		else if (label?.trim()) n.label = label.trim();
		return id;
	};
	const unquote = (t: string) => t.replace(/^["'`]|["'`]$/g, '').trim();
	if (head.startsWith('sequencediagram')) {
		for (const l of lines) {
			let m = l.match(/^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/i);
			if (m) { node(m[1], m[2] && unquote(m[2])); continue; }
			m = l.match(/^([^\s\-<>:)]+)\s*(-{1,2})(>>|>|\)|x)\s*\+?-?([^\s:]+)\s*:?\s*(.*)$/);
			if (m) edges.push({ from: node(m[1]), to: node(m[4]), ...(m[5] ? { label: m[5].trim() } : {}), ...(m[2] === '--' ? { reply: true } : {}) });
		}
		return nodes.length >= 2 && edges.length ? { kind: 'sequence', nodes, edges } : undefined;
	}
	const state = head.startsWith('statediagram');
	if (!state && !/^(graph|flowchart)\b/.test(head)) return undefined;
	const shape = /^([A-Za-z0-9_.\-]+)\s*(?:\[\[?|\(\(?|\{\{?|>)\s*"?([^\]\)\}"]*)"?\s*(?:\]\]?|\)\)?|\}\}?)?$/;
	const ref = (t: string) => { // "A[Label]" or "A" or [*]
		t = t.trim();
		if (state && t === '[*]') return node('__start', '●');
		const m = t.match(shape);
		return m ? node(m[1], m[2] || undefined) : node(t);
	};
	for (const l of lines) {
		let m = state && l.match(/^state\s+"([^"]+)"\s+as\s+(\S+)/);
		if (m) { node(m[2], m[1]); continue; }
		m = l.match(/^(.+?)\s*(?:--\s*([^->]+?)\s*-->|-->|-\.->|==>|---|--o|--x)\s*(?:\|([^|]*)\|)?\s*(.+?)\s*(?::\s*(.+))?$/);
		if (!m) { if (!state && shape.test(l)) ref(l); continue; }
		const from = ref(m[1]), to = ref(m[4]), label = (m[2] || m[3] || m[5] || '').trim();
		edges.push({ from, to, ...(label ? { label: unquote(label) } : {}) });
	}
	if (state) { // UML start marker: the diagram's own initial-state dot stands in for [*]
		const start = edges.find(e => e.from === '__start');
		const keep = nodes.filter(n => n.id !== '__start');
		if (start) keep.sort((a, b) => Number(b.id === start.to) - Number(a.id === start.to));
		return keep.length >= 2 ? { kind: 'state', nodes: keep, edges: edges.filter(e => e.from !== '__start' && e.to !== '__start') } : undefined;
	}
	return nodes.length >= 2 ? { nodes, edges } : undefined;
}

export function repairDiagram(raw: any): Diagram | undefined {
	if (typeof raw === 'string') raw = fromMermaid(raw);
	else if (raw && typeof raw === 'object' && !Array.isArray(raw.nodes) && typeof raw.mermaid === 'string') raw = { ...fromMermaid(raw.mermaid), caption: raw.caption, illustrative: raw.illustrative, focus: raw.focus };
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return undefined;
	const nodes: DiagramNode[] = [];
	for (const n of raw.nodes) {
		const id = typeof n === 'string' ? n : str(String(n?.id ?? n?.label ?? ''), 60);
		if (!id || nodes.some(x => x.id === id)) continue;
		const node: DiagramNode = { id, label: str(n?.label, 60) || id };
		const detail = str(n?.detail, 80);
		if (detail) node.detail = detail;
		nodes.push(node);
		if (nodes.length === MAX_NODES) break;
	}
	if (nodes.length < 2) return undefined;
	const kind: DiagramKind = raw.kind === 'sequence' || raw.kind === 'state' ? raw.kind : 'flow';
	// Edges may name nodes by id or (a common slip) by label.
	const idOf = (v: unknown) => { const t = String(v ?? '').trim(); return nodes.find(n => n.id === t)?.id ?? nodes.find(n => n.label.toLowerCase() === t.toLowerCase())?.id ?? ''; };
	const edges = (Array.isArray(raw.edges) ? raw.edges : [])
		.map((e: any) => {
			const edge: DiagramEdge = { from: idOf(e?.from ?? e?.source), to: idOf(e?.to ?? e?.target) };
			const label = str(e?.label, kind === 'sequence' ? 48 : 40);
			if (label) edge.label = label;
			if (kind === 'sequence' && e?.reply === true) edge.reply = true;
			const branch = kind === 'sequence' ? str(e?.branch ?? e?.alt, 40) : '';
			if (branch) edge.branch = branch;
			return edge;
		})
		.filter((e: DiagramEdge) => e.from && e.to && (e.from !== e.to || kind !== 'flow'))
		.slice(0, MAX_EDGES);
	if (kind === 'sequence' && !edges.length) return undefined;
	const d: Diagram = { nodes, edges };
	if (kind !== 'flow') d.kind = kind;
	const caption = str(raw.caption, 160);
	if (caption) d.caption = caption;
	if (raw.illustrative === true) d.illustrative = true;
	const focus = idOf(raw.focus);
	if (focus) d.focus = focus;
	return d;
}

/** The known path a model meant: exact, else a unique suffix or basename match. */
export function resolvePath(p: string, known: readonly string[]): string | undefined {
	const want = p.replace(/^\.?\//, '');
	if (known.includes(want)) return want;
	const hits = known.filter(k => k.endsWith('/' + want) || want.endsWith('/' + k) || k.split('/').pop() === want.split('/').pop());
	return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Fix what can be fixed locally (clamp lines, drop broken scenes and diagrams) instead of failing the whole reply.
 * Only reports errors when nothing usable is left. With `files` (path → line count), scenes may point at any of them.
 */
export function repair(draft: any, first: number, last: number, files?: Record<string, number>): { value?: Walkthrough; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	const raw: any[] = Array.isArray(draft.scenes) ? draft.scenes : Array.isArray(draft.steps) ? draft.steps : [];
	const known = files ? Object.keys(files) : [];
	let scenes = raw.map(s => {
		let a = int(s?.startLine), b = int(s?.endLine);
		if (Number.isNaN(a)) a = b;
		if (Number.isNaN(b)) b = a;
		const file = files ? resolvePath(str(s?.file, 300), known) : undefined;
		return { title: str(s?.title, 200), label: str(s?.label, 30), text: str(s?.text ?? s?.explanation), file, startLine: a, endLine: b, diagram: repairDiagram(s?.diagram ?? s?.mermaid), snippets: repairSnippets(s?.snippets, known) };
	}).filter(s => s.title && s.text && !Number.isNaN(s.startLine) && (!files || s.file));
	// Models often renumber a slice from 1; shift back when that's clearly what happened.
	const shift = first - 1;
	if (!files && shift > 0 && scenes.length && scenes.every(s => s.endLine < first && s.startLine + shift >= first && s.endLine + shift <= last)) {
		scenes = scenes.map(s => ({ ...s, startLine: s.startLine + shift, endLine: s.endLine + shift }));
	}
	const out: Scene[] = scenes.slice(0, MAX_SCENES).map(s => {
		const hi = files ? files[s.file!] : last, lo = files ? 1 : first;
		const clamp = (n: number) => Math.max(lo, Math.min(hi, n));
		const [a, b] = [clamp(s.startLine), clamp(s.endLine)].sort((x, y) => x - y);
		const scene: Scene = { title: s.title, text: s.text, startLine: a, endLine: b };
		if (s.label) scene.label = s.label;
		if (s.file) scene.file = s.file;
		if (s.diagram) scene.diagram = s.diagram;
		if (s.snippets.length) scene.snippets = s.snippets;
		return scene;
	});
	if (!out.length) {
		const where = files ? '"file" (one of the files shown) and integer "startLine"/"endLine"' : `integer "startLine"/"endLine" between ${first} and ${last}`;
		return { errors: [`"scenes" must be a non-empty array; each scene needs "title", "text", ${where}`] };
	}
	const w: Walkthrough = { title: str(draft.title, 200) || out[0].title, summary: str(draft.summary, 500), scenes: out };
	const learn = (Array.isArray(draft.learn) ? draft.learn : []).map((x: unknown) => str(x, 160)).filter(Boolean).slice(0, 4);
	if (learn.length) w.learn = learn;
	const terms = repairTerms(draft.terms);
	if (terms.length) w.terms = terms;
	const commitMessage = str(draft.commitMessage, 600);
	if (commitMessage) w.commitMessage = commitMessage;
	return { value: w, errors: [] };
}

/** Code from the model: keeps its indentation, drops blank edges. A path that isn't a file shown (insert, replace) or that escapes the project (new) is dropped. */
export function repairSnippets(raw: unknown, known: readonly string[]): Snippet[] {
	const out: Snippet[] = [];
	const text = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/^\s*\n/, '').trimEnd().slice(0, max) : '';
	for (const x of Array.isArray(raw) ? raw : []) {
		const code = text(x?.code, 8000);
		const mode = x?.mode === 'replace' || x?.mode === 'new' ? x.mode : 'insert';
		const given = str(x?.file, 300).replace(/\\/g, '/').replace(/^\.\//, '');
		const file = mode === 'new' ? safeNewPath(given) : resolvePath(given, known);
		if (!code || !file) continue;
		const sn: Snippet = { file, mode, code };
		if (mode === 'insert') {
			if (typeof x?.after !== 'string') continue; // no anchor: there's no telling where it goes
			sn.after = text(x.after, 2000);
		}
		if (mode === 'replace') {
			sn.find = text(x?.find, 4000);
			if (!sn.find) continue;
		}
		const lang = str(x?.lang, 20);
		if (lang) sn.lang = lang;
		out.push(sn);
	}
	return out.slice(0, 4);
}

/** A new file's path from the model, if it stays inside the project: relative, no "..", no drive letter or UNC prefix. */
export function safeNewPath(p: string): string | undefined {
	const q = p.replace(/\\/g, '/');
	const parts = q.split('/').filter(x => x && x !== '.');
	if (!parts.length || /^([a-z]:|\/)/i.test(q) || parts.some(x => x === '..' || /^[a-z]:$/i.test(x))) return undefined;
	return parts.join('/');
}

/** Lines with their spacing ignored, so a snippet still matches after reformatting. Blank lines don't count. */
function normLines(text: string): Array<{ n: string; line: number }> {
	return text.split('\n').map((l, line) => ({ n: l.trim().replace(/\s+/g, ' '), line })).filter(x => x.n);
}

/** Every place where `needle`'s lines appear, in order, in `hay`'s lines: [first line, last line] (0-based). */
function findLines(hay: string, needle: string): Array<[number, number]> {
	const h = normLines(hay), n = normLines(needle).map(x => x.n);
	if (!n.length) return [];
	const hits: Array<[number, number]> = [];
	for (let i = 0; i + n.length <= h.length; i++) {
		if (n.every((x, k) => h[i + k].n === x)) hits.push([h[i].line, h[i + n.length - 1].line]);
	}
	return hits;
}

export type Placement =
	| { status: 'ready'; from: number; to: number; text: string }
	| { status: 'added' }
	| { status: 'error'; reason: string };

/**
 * Where a snippet goes in the file as it is now (character offsets), or why it can't go anywhere.
 * `fileText` is undefined when the file doesn't exist. Code that's already in the file counts as added.
 */
export function placeSnippet(fileText: string | undefined, sn: Snippet): Placement {
	if (fileText === undefined) {
		return sn.mode === 'new' ? { status: 'ready', from: 0, to: 0, text: sn.code + '\n' } : { status: 'error', reason: `${sn.file} doesn't exist any more.` };
	}
	// Already there (a one-line `}` proves nothing, so only code with words counts).
	if (normLines(sn.code).some(x => /\w{3}/.test(x.n)) && findLines(fileText, sn.code).length) return { status: 'added' };
	if (sn.mode === 'new') return { status: 'error', reason: `${sn.file} already exists with other content, so coee won't overwrite it.` };
	const starts: number[] = [0];
	for (let i = 0; i < fileText.length; i++) if (fileText[i] === '\n') starts.push(i + 1);
	const endOf = (line: number) => (line + 1 < starts.length ? starts[line + 1] - 1 : fileText.length);
	const anchor = sn.mode === 'replace' ? sn.find ?? '' : sn.after ?? '';
	if (sn.mode === 'insert' && !normLines(anchor).length) return { status: 'ready', from: 0, to: 0, text: sn.code + '\n' }; // the very top
	const hits = findLines(fileText, anchor);
	if (!hits.length) return { status: 'error', reason: `The code it goes ${sn.mode === 'replace' ? 'in place of' : 'after'} isn't in ${sn.file} any more.` };
	if (hits.length > 1) return { status: 'error', reason: `The code it goes ${sn.mode === 'replace' ? 'in place of' : 'after'} appears ${hits.length} times in ${sn.file}, so its place is unclear.` };
	const [a, b] = hits[0];
	if (sn.mode === 'replace') return { status: 'ready', from: starts[a], to: endOf(b), text: sn.code };
	return { status: 'ready', from: endOf(b), to: endOf(b), text: '\n' + sn.code };
}

/** The file with a placement applied (what Apply will produce). */
export function applyPlacement(fileText: string, p: Placement & { status: 'ready' }): string {
	return fileText.slice(0, p.from) + p.text + fileText.slice(p.to);
}

export function repairTerms(raw: unknown): Term[] {
	const out: Term[] = [];
	for (const t of Array.isArray(raw) ? raw : []) {
		const name = str((t as any)?.name, 40), meaning = str((t as any)?.meaning, 200);
		if (name && meaning && !out.some(o => o.name.toLowerCase() === name.toLowerCase())) out.push({ name, meaning });
	}
	return out.slice(0, 10);
}

/**
 * Split lines [first, last] (0-based, inclusive) into parts of at most `size` lines, cutting at a candidate
 * line (symbol starts, else blank lines) in the back half of each part when there is one.
 */
export function packChapters(first: number, last: number, cuts: number[], size = 150): Array<{ start: number; end: number }> {
	const sorted = [...new Set(cuts)].filter(c => c > first && c <= last).sort((a, b) => a - b);
	const out: Array<{ start: number; end: number }> = [];
	let cur = first;
	while (last - cur + 1 > size) {
		const max = cur + size, min = cur + Math.floor(size / 2);
		const cut = [...sorted].reverse().find(c => c <= max && c >= min) ?? max;
		out.push({ start: cur, end: cut - 1 });
		cur = cut;
	}
	out.push({ start: cur, end: last });
	return out;
}

// ---------------------------------------------------------------------------
// File excerpts: the top of a file plus its declaration lines, with real line numbers

const SIGNATURE = /^\s*(export\s|(async\s+)?function[\s*]|class\s|def\s|async\s+def\s|func\s|fn\s|pub(\(\w+\))?\s|public\s|private\s|protected\s|internal\s|interface\s|type\s+\w+|struct\s|enum\s|impl\s|module\.exports|exports\.\w+\s*=|(app|router|server|api)\.(use|get|post|put|delete|patch|listen|route)\b|@(app|router|api)\.|create\s+table)/i;

/** First `head` lines, then up to `max` declaration lines after them, numbered with real line numbers. */
export function excerpt(text: string, head = 20, max = 50): string {
	const lines = text.split('\n');
	const keep: number[] = [];
	for (let i = 0; i < Math.min(head, lines.length); i++) keep.push(i);
	for (let i = head; i < lines.length && keep.length < head + max; i++) if (SIGNATURE.test(lines[i])) keep.push(i);
	const out: string[] = [];
	keep.forEach((i, k) => {
		if (k && i !== keep[k - 1] + 1) out.push('     …');
		out.push(`${String(i + 1).padStart(4)} | ${lines[i].slice(0, 200)}`);
	});
	if (keep.at(-1)! < lines.length - 1) out.push(`     … (${lines.length} lines in all)`);
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// System map

export interface CodeRef { path: string; startLine?: number; endLine?: number; why?: string; symbol?: string }
export interface MapComponent { id: string; name: string; summary: string; description?: string; files: CodeRef[] }
export interface MapConnection { from: string; to: string; label?: string; detail?: string; evidence?: CodeRef[] }
export interface SystemMap { title: string; summary: string; components: MapComponent[]; connections: MapConnection[] }
export interface FileExcerpt { path: string; text: string }

/** Take excerpts in order until `budget` chars are used; the last one is cut to fit. */
export function fitExcerpts(list: FileExcerpt[], budget: number): FileExcerpt[] {
	const out: FileExcerpt[] = [];
	let left = budget;
	for (const e of list) {
		if (left < 200) break;
		const text = e.text.length + e.path.length + 6 <= left ? e.text : e.text.slice(0, left - e.path.length - 30) + '\n… (cut)';
		out.push({ path: e.path, text });
		left -= text.length + e.path.length + 6;
	}
	return out;
}

const MAP_RULES = `What makes a good map:
- One consistent level of detail: each component is a cohesive part with one clear responsibility, named for what it does ("Rate limiter", not "src/middleware"). Group by responsibility, not by folder. Use 2-12 components; small projects need few.
- External things the code clearly talks to (a database, a web API, the file system) can be components; cite the file that talks to them.
- Connections point from the part that calls, uses or sends to the part that is called, used or receives. Label them with what flows, in 2-5 words ("validates input", "SQL reads and writes"). Merge parallel connections.
- Every component cites its files (paths exactly as listed), with the line range of the important code and a few words on each, using the line numbers shown in the excerpts. A file belongs to at most one component.
- "description" says what the component is responsible for and how it works, for someone about to read its code: 2-4 plain sentences.
- Every connection says in "detail" how it happens (one sentence), and cites where in the code it's made when you can.`;

export function buildMapPrompt(tree: string[], excerpts: FileExcerpt[], budget = 1e9): string {
	const room = budget - FIXED - 1500;
	const list = tree.join('\n').slice(0, Math.floor(room * 0.25));
	const shown = fitExcerpts(excerpts, room - list.length);
	return `You draw a system map of a software project for someone who wants to understand how it fits together. You never suggest edits.

${MAP_RULES}

Reply with ONLY JSON:
{"title": string (project name), "summary": string (1-2 sentences: what the project does), "components": [{"id": string (short kebab-case), "name": string, "summary": string (one line shown in the box), "description": string, "files": [{"path": string, "startLine"?: number, "endLine"?: number, "why"?: string}]}], "connections": [{"from": id, "to": id, "label": string, "detail"?: string, "evidence"?: [{"path": string, "startLine"?: number, "endLine"?: number}]}]}

Files in the project:
${list}

Excerpts of key files (the top of each file, then its declarations, with real line numbers):
${shown.map(e => `--- ${e.path}\n${e.text}`).join('\n')}`;
}

function refs(raw: unknown, known: readonly string[]): CodeRef[] {
	if (!Array.isArray(raw)) return [];
	const out: CodeRef[] = [];
	for (const r of raw) {
		const path = resolvePath(typeof r === 'string' ? r : str((r as any)?.path, 300), known);
		if (!path) continue;
		const ref: CodeRef = { path };
		const a = int((r as any)?.startLine), b = int((r as any)?.endLine);
		if (a > 0) { ref.startLine = a; ref.endLine = b >= a ? b : a; }
		const symbol = str((r as any)?.symbol, 120).split('\n')[0].trim();
		if (symbol) ref.symbol = symbol;
		const why = str((r as any)?.why, 160);
		if (why) ref.why = why;
		// The same file may appear again for a different part of it, but not for the same place.
		if (out.some(o => o.path === path && (o.symbol && ref.symbol ? o.symbol === ref.symbol : o.startLine === ref.startLine))) continue;
		out.push(ref);
	}
	return out;
}

export { blockEnd } from './blocks';
import { blockEnd } from './blocks';

/**
 * Make the model's line numbers match the file. A "symbol" (the text that starts the code) is looked up and wins over its numbers;
 * the range then runs to the end of that block. Otherwise the numbers are only clamped to the file.
 */
export function snapRefs(list: readonly CodeRef[], files: readonly FolderFile[]): CodeRef[] {
	const text = new Map(files.map(f => [f.path, f.text.split('\n')]));
	return list.map(r => {
		const lines = text.get(r.path);
		if (!lines) return r;
		const { symbol, ...rest } = r;
		const want = (r.startLine ?? 1) - 1;
		const hits = symbol ? lines.flatMap((l, i) => l.includes(symbol) ? [i] : []) : [];
		if (hits.length) {
			const at = hits.reduce((best, i) => Math.abs(i - want) < Math.abs(best - want) ? i : best);
			return { ...rest, startLine: at + 1, endLine: blockEnd(lines, at) + 1 };
		}
		if (!r.startLine) return rest;
		const a = Math.min(r.startLine, lines.length), b = Math.max(a, Math.min(r.endLine ?? a, lines.length));
		return { ...rest, startLine: a, endLine: b };
	});
}

/** Normalize a map (from the model, or stored by an older version): unknown files and dangling links are dropped. */
export function repairMap(draft: any, known: readonly string[]): { value?: SystemMap; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	const ids = new Set<string>();
	const components: MapComponent[] = (Array.isArray(draft.components) ? draft.components : []).flatMap((c: any) => {
		const id = str(c?.id, 60), name = str(c?.name, 80);
		if (!id || !name || ids.has(id)) return [];
		ids.add(id);
		const comp: MapComponent = { id, name, summary: str(c?.summary, 200), files: refs(c?.files, known) };
		const description = str(c?.description, 1200);
		if (description) comp.description = description;
		return [comp];
	}).slice(0, 14);
	if (!components.length) return { errors: ['"components" must be a non-empty array of {id, name, summary, description, files}'] };
	const connections: MapConnection[] = (Array.isArray(draft.connections) ? draft.connections : [])
		.filter((e: any) => ids.has(e?.from) && ids.has(e?.to) && e.from !== e.to)
		.map((e: any) => {
			const conn: MapConnection = { from: e.from, to: e.to, label: str(e?.label, 60) };
			const detail = str(e?.detail, 400), evidence = refs(e?.evidence, known);
			if (detail) conn.detail = detail;
			if (evidence.length) conn.evidence = evidence;
			return conn;
		});
	return { value: { title: str(draft.title, 120) || 'System map', summary: str(draft.summary, 400), components, connections }, errors: [] };
}

// ---------------------------------------------------------------------------
// Projects inside a workspace folder

/** Keep only paths not inside another listed path ('' is the root and contains everything). */
export function outermost(paths: string[]): string[] {
	const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
	return sorted.filter((p, i) => !sorted.slice(0, i).some(q => q !== p && (q === '' || p.startsWith(q + '/'))));
}

// ---------------------------------------------------------------------------
// Reviewing changes: unified diffs, and a walkthrough of what a change does

export interface DiffLine { t: '+' | '-' | ' '; text: string }
export interface DiffHunk { oldStart: number; newStart: number; newLines: number; lines: DiffLine[] }
export interface FileDiff { path: string; oldPath?: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; hunks: DiffHunk[]; binary?: boolean }

/** `git diff` output (with a/ b/ prefixes) as files and hunks. */
export function parseUnifiedDiff(text: string): FileDiff[] {
	const out: FileDiff[] = [];
	const unq = (p: string) => p.startsWith('"') ? JSON.parse(p) as string : p; // git quotes unusual paths C-style, close enough to JSON
	const strip = (p: string) => unq(p.trim()).replace(/^[ab]\//, '');
	let f: FileDiff | undefined, h: DiffHunk | undefined;
	for (const line of text.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const m = line.match(/^diff --git (\"[^\"]+\"|\S+) (\"[^\"]+\"|\S+)$/);
			f = { path: m ? strip(m[2]) : '', status: 'modified', hunks: [] };
			if (m && strip(m[1]) !== f.path) f.oldPath = strip(m[1]);
			out.push(f);
			h = undefined;
			continue;
		}
		if (!f) continue;
		if (!h) {
			if (line.startsWith('new file mode')) f.status = 'added';
			else if (line.startsWith('deleted file mode')) f.status = 'deleted';
			else if (line.startsWith('rename from ')) { f.oldPath = unq(line.slice(12)); f.status = 'renamed'; }
			else if (line.startsWith('rename to ')) f.path = unq(line.slice(10));
			else if (line.startsWith('Binary files')) f.binary = true;
			else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) f.path = strip(line.slice(4));
			else if (line.startsWith('--- ') && !line.startsWith('--- /dev/null') && f.status !== 'added') f.oldPath ??= strip(line.slice(4)) !== f.path ? strip(line.slice(4)) : undefined;
		}
		const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (m) { h = { oldStart: +m[1], newStart: +m[2], newLines: m[3] === undefined ? 1 : +m[3], lines: [] }; f.hunks.push(h); continue; }
		if (h && (line[0] === '+' || line[0] === '-' || line[0] === ' ')) h.lines.push({ t: line[0] as DiffLine['t'], text: line.slice(1) });
	}
	return out.filter(x => x.path);
}

/** New-version line numbers that were added or changed. */
export function addedLines(f: FileDiff): number[] {
	const out: number[] = [];
	for (const h of f.hunks) {
		let n = h.newStart;
		for (const l of h.lines) { if (l.t === '+') out.push(n); if (l.t !== '-') n++; }
	}
	return out;
}

/** Removed blocks, each placed after the new-version line it followed (0 = before line 1). */
export function removedRuns(f: FileDiff): Array<{ after: number; lines: string[] }> {
	const out: Array<{ after: number; lines: string[] }> = [];
	for (const h of f.hunks) {
		// A hunk that adds nothing ("+4,0") names the line its removals follow, not the first line of the hunk.
		let n = h.newLines === 0 ? h.newStart + 1 : h.newStart, run: { after: number; lines: string[] } | undefined;
		for (const l of h.lines) {
			if (l.t === '-') { if (!run) out.push(run = { after: n - 1, lines: [] }); run.lines.push(l.text); }
			else { run = undefined; n++; }
		}
	}
	return out;
}

export const diffStats = (f: FileDiff) => f.hunks.reduce((a, h) => { for (const l of h.lines) { if (l.t === '+') a.plus++; else if (l.t === '-') a.minus++; } return a; }, { plus: 0, minus: 0 });

/** One file's hunks with real new-side line numbers ("  42 + x", "     - y"), cut at `room` chars. */
function renderHunks(f: FileDiff, room: number): string {
	const out: string[] = [];
	let used = 0, cut = 0;
	for (const h of f.hunks) {
		let n = h.newStart;
		const head = `@@ new line ${h.newStart} @@`;
		for (const line of [head, ...h.lines.map(l => {
			const s = l.t === '-' ? `     - ${l.text}` : `${String(n).padStart(4)} ${l.t === '+' ? '+' : ' '} ${l.text}`;
			if (l.t !== '-') n++;
			return s;
		})]) {
			if (used + line.length + 1 > room) { cut++; continue; }
			out.push(line);
			used += line.length + 1;
		}
	}
	if (cut) out.push(`     … ${cut} more changed lines not shown`);
	return out.join('\n');
}

export interface ReviewMeta {
	/** What is being reviewed, e.g. "staged changes", "commit a1b2c3d", "PR #42: Add caching". */
	what: string;
	/** Staged or uncommitted work: also suggest a commit message. */
	precommit?: boolean;
	/** The commit or PR's own description, as written by its author. */
	message?: string;
}

/** A walkthrough of a change, for a reviewer who is still learning: what it does, each logical change, what to check. */
export function buildReviewPrompt(meta: ReviewMeta, files: FileDiff[], budget = 1e9): string {
	const head = reviewInstructions(meta);
	return `${head}

Changed files:
${compressDiff(files, budget - head.length - 300).text}`;
}

/**
 * A change in `room` chars, after pr-agent's compression: deleted files and hunks that only delete are named, not
 * shown; files in the change's main language come first, biggest change first; files are added whole (all their
 * hunks) while they fit, then the rest are listed by name. Nothing is dropped without saying so.
 */
export function compressDiff(files: readonly FileDiff[], room: number): { text: string; shown: string[]; minimized: string[]; deleted: string[] } {
	const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
	const deleted = files.filter(f => f.status === 'deleted').map(f => f.path);
	const live = files.filter(f => f.status !== 'deleted' && !f.binary)
		.map(f => ({ ...f, stats: diffStats(f), hunks: f.hunks.filter(h => h.lines.some(l => l.t === '+')) })) // hunks that only delete say less than the files around them
		.filter(f => f.hunks.length || f.status === 'renamed');
	const langs = new Map<string, number>();
	for (const f of live) langs.set(ext(f.path), (langs.get(ext(f.path)) ?? 0) + 1);
	const size = (f: { stats: { plus: number; minus: number } }) => f.stats.plus + f.stats.minus;
	live.sort((a, b) => (langs.get(ext(b.path))! - langs.get(ext(a.path))!) || size(b) - size(a));
	const shown: string[] = [], minimized: string[] = [], parts: string[] = [];
	// Every file's name is reserved first, so the list of what isn't shown always fits; a file shown whole gets its name back.
	const nameCost = (p: string) => p.length + 20;
	let left = room - 200 - deleted.reduce((n, p) => n + nameCost(p), 0) - files.reduce((n, f) => n + nameCost(f.path), 0);
	for (const f of live) {
		const { plus, minus } = f.stats; // the whole file's change, though only hunks that add are shown
		const head = `--- ${f.path}${f.oldPath ? ` (renamed from ${f.oldPath})` : ''} · ${f.status} · +${plus} −${minus}`;
		const body = renderHunks(f, 1e9);
		if (head.length + body.length + 2 <= left + nameCost(f.path)) { parts.push(`${head}\n${body}`); shown.push(f.path); left -= head.length + body.length + 2 - nameCost(f.path); }
		else minimized.push(f.path);
	}
	minimized.push(...files.filter(f => f.binary).map(f => `${f.path} (binary)`));
	const onlyDeletions = files.filter(f => f.status !== 'deleted' && !f.binary && !f.hunks.some(h => h.lines.some(l => l.t === '+'))).map(f => `${f.path} (only removals)`);
	minimized.push(...onlyDeletions);
	if (minimized.length) parts.push(`Other modified files (not shown):\n${minimized.map(p => `- ${p}`).join('\n')}`);
	if (deleted.length) parts.push(`Deleted files:\n${deleted.map(p => `- ${p}`).join('\n')}`);
	return { text: parts.join('\n\n'), shown, minimized, deleted };
}

function reviewInstructions(meta: ReviewMeta): string {
	return `${ROLE}
${GUIDE}

Explain this change (${meta.what}) as a walkthrough for a reviewer who is still learning the codebase: what it does, how, and what to look at carefully.
${meta.message ? `The author describes it as:\n"""\n${meta.message.slice(0, 2000)}\n"""\nWhere the code does more, less or something different than this says, point it out.\n` : ''}
Use this order of scenes (skip what doesn't apply), 3-9 in all:
1. label "What changed": the purpose of the change in plain words, and the big picture of how it works. A diagram only if the change adds or alters a path across parts.
2. One scene per logical change, grouped by idea rather than file by file, labelled "New", "Changed", "Removed" or "Behavior change". Say what it was before, what it is now, and why that matters.
3. label "Worth checking": concrete things a careful reviewer should check (edge cases, error paths, callers that might break, missing tests, security), each pointing at the lines involved. Only real concerns grounded in the diff; say plainly if it looks sound.
4. label "Tests": what the changed tests cover, only if tests changed.
Each scene points at one file ("file", exactly as written after ---) and lines in its NEW version, using the numbers at the left (lines marked + are new or changed; lines marked - were removed and have no number: point at the nearest numbered line). Deleted files can't be pointed at; mention them in another scene.

${EXPLAINING}

${DIAGRAM_RULES}

Reply with ONLY JSON, no prose:
{"title": string, "summary": string (one or two sentences: what this change does), ${LEARNING_SCHEMA},${meta.precommit ? ' "commitMessage": string (a commit message for this change: a subject line under 72 characters in the imperative mood, a blank line, then 1-3 short lines on what and why),' : ''} "scenes": [${SCENE_SCHEMA(true)}]}`;
}

// ---------------------------------------------------------------------------
// Architecture page: how the whole project works, with every part, use case and lifecycle drawn

export interface ArchComponent { id: string; role: string; keyFiles: CodeRef[] }
export interface ArchDoc { title: string; summary: string; howItWorks: string; components: ArchComponent[]; conventions: string[]; terms?: Term[] }
export interface UseCase { name: string; who: string; steps: string[]; sequence: Diagram; files: CodeRef[] }
export interface Lifecycle { name: string; what: string; diagram: Diagram }
export interface Behavior { useCases: UseCase[]; states: Lifecycle[] }

export function buildArchitecturePrompt(map: SystemMap, files: FolderFile[], budget = 1e9): string {
	const task = `${mapContext(map)}

Write the "how it works" part of an architecture document for this project, for a developer who is new to it and not very experienced. Plain words, concrete names from the code, no filler.
- "howItWorks": 3-6 short paragraphs: what the project does, how a typical run flows through the parts above, where data lives, and the main design choices. Light markdown (\`code\` spans, **bold**) is fine.
- "components": one entry for EVERY part listed above (use its id), with "role": 2-3 sentences on what it is responsible for and how it does it, and "keyFiles": the 1-3 files (paths exactly as written after ---) to read first, each with a short "why". Give each a "symbol": the exact text of the line where that code starts, copied from the file (a function signature or route line), so it can be found. Line numbers are optional.
- "conventions": 2-6 patterns that hold across the code (naming, error handling, where state lives, how parts talk).
- "terms": 3-8 words a junior may not know, with plain meanings.

Reply with ONLY JSON:
{"title": string, "summary": string (one or two sentences), "howItWorks": string, "components": [{"id": string, "role": string, "keyFiles": [{"path": string, "symbol": string, "startLine"?: number, "endLine"?: number, "why": string}]}], "conventions": [string], "terms": [{"name": string, "meaning": string}]}
`;
	return `${task}\n${packFiles(files, budget - task.length - 1000)}`;
}

export function buildBehaviorPrompt(map: SystemMap, files: FolderFile[], budget = 1e9): string {
	const task = `${mapContext(map)}

Describe how this project behaves, for an architecture document read by a developer new to it. Use real names from the code.
- "useCases": the 2-5 main things someone does with it (a command, a request, a screen, a scheduled job). For each: "name" (short), "who" (the user, another system, a timer…), "steps" (3-7 short plain sentences, in order, naming the parts above), "sequence", and "files": where it enters and the key code (paths exactly as written after ---). Give each a "symbol": the exact text of the line where that code starts, copied from the file (a function signature or route line), so it can be found; line numbers are optional. Use a different file entry for each use case's own code.
  The "sequence" diagram: "nodes" = the participants left to right (the person or caller first, then the parts or key functions, by their real names, 3-6 of them), "edges" = every message in time order: {"from", "to", "label" (the real call, route or event, e.g. "POST /api/tasks", "listTasks()"), "reply"?: true for responses}. Include the important alternative paths too (an error, a cache hit, a limit reached): give those messages "branch": a short condition like "over the limit" or "invalid input"; consecutive messages with the same branch are drawn inside one frame.
- "states": 1-3 lifecycles the code manages: a status field or enum, a mode, a connection, a job, a request, a screen. If there is no explicit status, use the closest real lifecycle (e.g. a request from received to answered) and say so in "what". For each: "name", "what" (1-2 sentences, naming the field or code that holds and changes the state), and "diagram":
  "nodes" = the states, by the names the code uses (enum values, status strings), initial state first, each with a 2-6 word "detail" saying what is true in it; include the end states (done, failed, closed) where the lifecycle ends.
  "edges" = the transitions, labelled "event [condition] / action" with the parts that apply (e.g. "reply arrives [valid JSON]", "close / cancel request"). A state may transition to itself (a retry, a refresh).
Every use case MUST have its sequence diagram and there MUST be at least one state diagram.

Reply with ONLY JSON:
{"useCases": [{"name": string, "who": string, "steps": [string], "sequence": {"nodes": [{"id": string, "label": string, "detail"?: string}], "edges": [{"from": id, "to": id, "label": string, "reply"?: boolean, "branch"?: string}]}, "files": [{"path": string, "symbol": string, "startLine"?: number, "endLine"?: number, "why"?: string}]}], "states": [{"name": string, "what": string, "diagram": {"nodes": [{"id": string, "label": string, "detail": string}], "edges": [{"from": id, "to": id, "label": string}]}}]}
`;
	return `${task}\n${packFiles(files, budget - task.length - 1000)}`;
}

// The data model: what the project stores or passes around, as an ER diagram

export interface Entity { id: string; name: string; kind: 'table' | 'document' | 'type'; fields: Array<{ name: string; type?: string; key?: 'pk' | 'fk' }>; file?: CodeRef }
export interface Relation { from: string; to: string; label?: string; card?: string }
export interface DataModel { what: string; entities: Entity[]; relations: Relation[] }

export function buildDataModelPrompt(map: SystemMap, files: FolderFile[], budget = 1e9): string {
	const task = `${mapContext(map)}

Describe this project's data model for an architecture document, as an entity-relationship diagram.
- If it stores data (a database schema, migrations, ORM models, JSON files, a key-value store), the entities are what it stores. Otherwise use the main data structures the code passes between its parts (classes, interfaces, records, message shapes): the ones a newcomer must know.
- "entities": 2-8 of them. Each: "id", "name" (as in the code), "kind" ("table", "document" or "type"), "fields" (the important ones, at most 8, as in the code: {"name", "type", "key"?: "pk" for an identifier, "fk" for a reference to another entity}), and "file": where it's defined ({"path", "startLine"}).
- "relations": how entities refer to or contain each other: {"from", "to", "label" (a verb: "has", "belongs to", "contains"), "card": "1-1", "1-n", "n-1" or "n-n", read from → to}.
- "what": 1-2 sentences on where this data lives and how it's kept (e.g. "SQLite file via db.js; tasks are ordered by position").

Reply with ONLY JSON:
{"what": string, "entities": [{"id": string, "name": string, "kind": "table"|"document"|"type", "fields": [{"name": string, "type": string, "key"?: "pk"|"fk"}], "file": {"path": string, "startLine": number}}], "relations": [{"from": id, "to": id, "label": string, "card": "1-1"|"1-n"|"n-1"|"n-n"}]}
`;
	return `${task}\n${packFiles(files, budget - task.length - 1000)}`;
}

export function repairDataModel(draft: any, known: readonly string[]): { value?: DataModel; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	const entities: Entity[] = [];
	for (const e of Array.isArray(draft.entities) ? draft.entities : []) {
		const name = str(e?.name, 60), id = str(e?.id, 60) || name;
		if (!name || entities.some(x => x.id === id)) continue;
		const fields = (Array.isArray(e?.fields) ? e.fields : []).flatMap((f: any) => {
			const n = typeof f === 'string' ? f : str(f?.name, 40);
			if (!n) return [];
			const key = f?.key === 'pk' || f?.key === 'fk' ? f.key : undefined;
			return [{ name: n, ...(str(f?.type, 24) ? { type: str(f?.type, 24) } : {}), ...(key ? { key } : {}) }];
		}).slice(0, 12);
		const file = refs(e?.file ? [e.file] : [], known)[0];
		entities.push({ id, name, kind: e?.kind === 'table' || e?.kind === 'document' ? e.kind : 'type', fields, ...(file ? { file } : {}) });
		if (entities.length === 10) break;
	}
	const idOf = (v: unknown) => { const t = String(v ?? ''); return entities.find(e => e.id === t)?.id ?? entities.find(e => e.name.toLowerCase() === t.toLowerCase())?.id; };
	const relations: Relation[] = (Array.isArray(draft.relations) ? draft.relations : []).flatMap((r: any) => {
		const from = idOf(r?.from), to = idOf(r?.to);
		if (!from || !to || from === to) return [];
		const card = /^[1n]-[1n]$/i.test(String(r?.card ?? '')) ? String(r.card).toLowerCase() : undefined;
		return [{ from, to, ...(str(r?.label, 30) ? { label: str(r?.label, 30) } : {}), ...(card ? { card } : {}) }];
	}).slice(0, 16);
	const errors = entities.length < 2 ? ['"entities" needs at least 2 entities (what the project stores, or its main data structures), each with its "fields"'] : [];
	return { value: entities.length ? { what: str(draft.what, 400), entities, relations } : undefined, errors };
}

export function repairArchitecture(draft: any, map: SystemMap, known: readonly string[]): { value?: ArchDoc; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	const howItWorks = str(draft.howItWorks, 6000);
	const given = new Map<string, any>((Array.isArray(draft.components) ? draft.components : []).map((c: any) => [str(c?.id, 60), c]));
	// Every part of the map appears; one the model skipped falls back to the map's own description.
	const components = map.components.map(c => {
		const g = given.get(c.id) ?? [...given.values()].find(x => str(x?.name ?? x?.id, 80).toLowerCase() === c.name.toLowerCase());
		return { id: c.id, role: str(g?.role, 800) || c.description || c.summary, keyFiles: refs(g?.keyFiles, known).slice(0, 3) };
	});
	const errors: string[] = [];
	if (!howItWorks) errors.push('"howItWorks" must be a few paragraphs on how the project works');
	if (given.size < Math.ceil(map.components.length / 2)) errors.push(`"components" must describe every part: ${map.components.map(c => c.id).join(', ')}`);
	const doc: ArchDoc = { title: str(draft.title, 120) || map.title, summary: str(draft.summary, 500) || map.summary, howItWorks, components,
		conventions: (Array.isArray(draft.conventions) ? draft.conventions : []).map((x: unknown) => str(x, 300)).filter(Boolean).slice(0, 8) };
	const terms = repairTerms(draft.terms);
	if (terms.length) doc.terms = terms;
	return { value: howItWorks ? doc : undefined, errors };
}

/** Use cases and lifecycles; a missing sequence or state diagram is an error, so the model is asked again. */
export function repairBehavior(draft: any, known: readonly string[]): { value?: Behavior; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	const force = (d: any, kind: DiagramKind) => repairDiagram(typeof d === 'string' ? d : d && { ...d, kind });
	const useCases: UseCase[] = (Array.isArray(draft.useCases) ? draft.useCases : []).flatMap((u: any) => {
		const name = str(u?.name, 80), sequence = force(u?.sequence ?? u?.diagram, 'sequence');
		const steps = (Array.isArray(u?.steps) ? u.steps : []).map((x: unknown) => str(x, 300)).filter(Boolean).slice(0, 8);
		return name && sequence && sequence.kind === 'sequence' ? [{ name, who: str(u?.who, 80), steps, sequence, files: refs(u?.files, known).slice(0, 4) }] : [];
	}).slice(0, 5);
	const states: Lifecycle[] = (Array.isArray(draft.states) ? draft.states : []).flatMap((x: any) => {
		const name = str(x?.name, 80), diagram = force(x?.diagram, 'state');
		return name && diagram && diagram.kind === 'state' ? [{ name, what: str(x?.what, 500), diagram }] : [];
	}).slice(0, 3);
	const errors: string[] = [];
	if (useCases.length < 2) errors.push('"useCases" needs at least 2 use cases, each with a "sequence" diagram (nodes = participants, edges = messages in order)');
	if (!states.length) errors.push('"states" needs at least 1 lifecycle with a state "diagram" (nodes = states, edges = transitions); use the closest real lifecycle if there is no status field');
	return { value: useCases.length || states.length ? { useCases, states } : undefined, errors };
}

// ---------------------------------------------------------------------------
// Security scan: weaknesses found in the code, each with why it matters, a fix and a test

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
export interface Finding {
	id: string; severity: Severity; category: string; cwe?: string; title: string;
	file: string; startLine: number; endLine: number;
	why: string; exploit: string; fix: string; fixCode?: string; testCode?: string;
	/** Found by a fast rule (and confirmed by the model, or not checked), by the model alone, or in a dependency advisory. */
	source?: 'rule' | 'model' | 'dependency';
	rule?: string; confirmed?: boolean;
	/** OWASP Top 10 code (A01…A10), or MEM for memory safety. */
	owasp?: string;
	/** Why this severity, how to check it yourself, and the attack as a sequence diagram. */
	severityWhy?: string; verify?: string; attack?: Diagram;
	url?: string;
}
/** A rule hit the model looked at and judged not to be a problem, kept so the reader can see why. */
export interface Rejected { hit: string; title: string; file: string; line: number; reason: string }
export interface SecurityReport { summary: string; findings: Finding[]; rejected?: Rejected[]; deps?: string[] }

const SECURITY_ROLE = 'You are a careful application security reviewer. You find real weaknesses in code and say how to fix them, so that a developer who is not a security expert understands them. You never invent a problem.';

/** What a rule found, as the model sees it. */
export interface HitRef { id: string; rule: string; title: string; file: string; line: number; text: string; cwe: string; owasp: string; severity: Severity; why: string; fix: string }

export function buildSecurityPrompt(files: FolderFile[], scope: string, budget = 1e9, hits: readonly HitRef[] = []): string {
	const flagged = hits.length ? `
Fast pattern checks flagged these lines. For EACH one decide whether it is a real problem in this code:
- real: report it as a finding with "hit" set to its id (you may change the severity, and explain it better);
- not real (test code, a constant, already validated, unreachable): list it in "rejected" with its id and a one-sentence reason.
${hits.map(h => `[${h.id}] ${h.file}:${h.line} ${h.title} (${h.cwe}): ${h.text}`).join('\n')}
` : '';
	const task = `${SECURITY_ROLE}
${GUIDE}

Review ${scope} for security weaknesses.${flagged}
Then look for what patterns can't see, by following data from where it enters (requests, files, environment, messages) to where it is used:
- missing or broken authentication and authorization: routes anyone can call, no ownership check on an id from the request (IDOR), privilege checks done only in the client
- injection through variables and helpers (SQL, shell, eval, templates, HTML), server-side request forgery, open redirects, path traversal
- mass assignment (the request body copied into a record), prototype pollution, race conditions, missing rate limits or size limits, unsafe uploads
- memory safety in C/C++/unsafe Rust: buffer and integer overflow, out-of-bounds, use after free, format strings
- secrets in config, weak crypto, disabled TLS checks, insecure defaults, sensitive data in logs or error messages

Rules:
- Report ONLY what you can point at in the code shown: a file and the exact lines. No guesses about code you can't see, no generic advice, no style comments. If there is no real problem, return an empty list.
- Never copy a secret in full: show its first 4 characters then "…".
- Write for a developer who is not a security expert: plain words, concrete, no jargon without saying what it means.
- "severity": critical (exploitable now, by anyone, with big impact: remote code execution, a leaked live secret), high, medium, low. "severityWhy": one sentence on why that level (who can reach it, what they gain).
- "why": what is wrong and what it puts at risk. "exploit": how someone would actually abuse it, with an example request or input. "verify": how the reader can check it themselves (a request to send, a test to run).
- "attack": a sequence diagram of the attack: nodes = "Attacker" first, then the entry point and the functions the data passes through by their real names, then the sink; edges = the steps, the first carrying the malicious input.
- "fix": what to change, in plain words. "fixCode": the corrected code for exactly those lines, ready to paste, in the project's style. "testCode": a small test that fails on the vulnerable code and passes on the fixed code, in the project's test framework (else the language's standard one).
- "owasp": the OWASP Top 10 2021 code ("A01" … "A10"), or "MEM" for memory safety. "cwe": e.g. "CWE-89".
- "symbol": the exact text of the line where the problem starts, copied from the file; "startLine"/"endLine" use the line numbers shown.
- At most 25 findings, most severe first. Merge repeats of the same problem into one finding that names the other places.

Reply with ONLY JSON:
{"summary": string (one or two sentences on the overall state), "findings": [{"hit"?: string, "severity": "critical"|"high"|"medium"|"low", "severityWhy": string, "category": string (e.g. "SQL injection"), "owasp": string, "cwe"?: string, "title": string (short), "file": string (exactly as written after ---), "symbol": string, "startLine": number, "endLine": number, "why": string, "exploit": string, "verify": string, "attack": {"nodes": [{"id": string, "label": string}], "edges": [{"from": id, "to": id, "label": string}]}, "fix": string, "fixCode"?: string, "testCode"?: string}], "rejected": [{"id": string, "reason": string}]}
`;
	// ponytail: whole files only (an outline hides the bug); the host batches files to fit, and what still doesn't fit at this budget is left out
	let room = budget - task.length - 500;
	const shown: string[] = [];
	for (const f of files) {
		const part = `--- ${f.path}\n${numberLines(f.text).join('\n')}`;
		if (part.length > room) break;
		shown.push(part);
		room -= part.length;
	}
	return `${task}\n${shown.join('\n\n')}`;
}

const order = (p: Finding, q: Finding) => SEVERITIES.indexOf(p.severity) - SEVERITIES.indexOf(q.severity) || p.file.localeCompare(q.file) || p.startLine - q.startLine;
const renumber = (list: Finding[]) => list.map((f, i) => ({ ...f, id: `f${i + 1}` }));

/**
 * Findings as the page shows them: paths and lines checked against the files, text capped, repeats merged, worst first.
 * Rule hits the model didn't mention are kept as unconfirmed rule findings: a pattern match is still worth a look.
 */
export function repairSecurity(draft: any, files: readonly FolderFile[], hits: readonly HitRef[] = []): { value?: SecurityReport; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	if (!Array.isArray(draft.findings)) return { errors: ['"findings" must be an array (empty if there is nothing to report)'] };
	const known = files.map(f => f.path);
	const byId = new Map(hits.map(h => [h.id, h]));
	const used = new Set<string>();
	const out: Finding[] = [];
	const code = (v: unknown) => typeof v === 'string' ? v.replace(/^\s*\n/, '').trimEnd().slice(0, 6000) : '';
	for (const x of draft.findings) {
		const hit = byId.get(str(x?.hit, 300));
		const file = resolvePath(str(x?.file, 300), known) ?? hit?.file;
		const title = str(x?.title, 120) || hit?.title || '', why = str(x?.why, 800) || hit?.why || '';
		if (!file || !title || !why) continue;
		const [ref] = snapRefs([{ path: file, symbol: str(x?.symbol, 120).split('\n')[0].trim() || undefined,
			startLine: int(x?.startLine) > 0 ? int(x?.startLine) : hit?.line, endLine: int(x?.endLine) > 0 ? int(x?.endLine) : hit?.line }], files);
		const a = ref.startLine ?? 1, b = ref.endLine ?? a;
		const category = str(x?.category, 60) || hit?.title || 'Security';
		if (hit) used.add(hit.id);
		if (out.some(o => o.file === file && o.startLine === a && o.category.toLowerCase() === category.toLowerCase())) continue;
		const f: Finding = {
			id: '', severity: SEVERITIES.includes(x?.severity) ? x.severity : hit?.severity ?? 'medium', category, title, file, startLine: a, endLine: Math.max(a, b),
			why, exploit: str(x?.exploit, 600), fix: str(x?.fix, 600) || hit?.fix || '', source: hit ? 'rule' : 'model',
		};
		if (hit) { f.rule = hit.rule; f.confirmed = true; }
		const cwe = (str(x?.cwe, 20) || hit?.cwe || '').match(/\d+/)?.[0];
		if (cwe) f.cwe = `CWE-${cwe}`;
		const owasp = str(x?.owasp, 10).toUpperCase().match(/^(A(0[1-9]|10)|MEM)/)?.[0] ?? hit?.owasp;
		if (owasp) f.owasp = owasp;
		for (const k of ['severityWhy', 'verify'] as const) { const v = str(x?.[k], 500); if (v) f[k] = v; }
		const attack = repairDiagram(x?.attack && typeof x.attack === 'object' ? { ...x.attack, kind: 'sequence' } : undefined);
		if (attack) f.attack = attack;
		if (code(x?.fixCode)) f.fixCode = code(x.fixCode);
		if (code(x?.testCode)) f.testCode = code(x.testCode);
		out.push(f);
	}
	const rejected: Rejected[] = (Array.isArray(draft.rejected) ? draft.rejected : []).flatMap((r: any) => {
		const h = byId.get(str(r?.id, 300));
		if (!h || used.has(h.id)) return [];
		used.add(h.id);
		return [{ hit: h.id, title: h.title, file: h.file, line: h.line, reason: str(r?.reason, 300) || 'Judged not to be a problem here.' }];
	});
	for (const h of hits) {
		if (used.has(h.id) || out.some(o => o.file === h.file && o.startLine <= h.line && h.line <= o.endLine && o.cwe === h.cwe)) continue;
		out.push(ruleFinding(h));
	}
	return { value: { summary: str(draft.summary, 400), findings: renumber(out.sort(order).slice(0, 40)), rejected }, errors: [] };
}

/** A rule hit on its own (no model, or the model skipped it). */
export function ruleFinding(h: HitRef): Finding {
	return { id: '', severity: h.severity, category: h.title, cwe: h.cwe, owasp: h.owasp, title: h.title, file: h.file, startLine: h.line, endLine: h.line,
		why: h.why, exploit: '', fix: h.fix, source: 'rule', rule: h.rule, confirmed: false };
}

/** A dependency advisory as a finding, pointed at the line of the manifest that names the package. */
export function depFinding(d: { name: string; version: string; file: string; id: string; title: string; severity: Severity; fixed?: string; url?: string }, line = 1): Finding {
	return { id: '', severity: d.severity, category: 'Vulnerable dependency', owasp: 'A06', title: `${d.name} ${d.version}: ${d.title}`, file: d.file, startLine: line, endLine: line,
		why: `This version of ${d.name} has a published vulnerability (${d.id}). Your code doesn't need to call the vulnerable part for it to matter if an attacker can reach it through the library.`,
		exploit: '', fix: d.fixed ? `Upgrade ${d.name} to ${d.fixed} or later, then run your tests.` : `No fixed version is listed yet. Check the advisory for a workaround, or replace ${d.name}.`,
		source: 'dependency', url: d.url };
}

/** One report from several (one per batch of files): findings together, repeats dropped, worst first. */
export function mergeReports(reports: readonly SecurityReport[]): SecurityReport {
	const seen = new Set<string>();
	const findings = reports.flatMap(r => r.findings).filter(f => {
		const key = `${f.file}:${f.startLine}:${f.category.toLowerCase()}`;
		return seen.has(key) ? false : (seen.add(key), true);
	}).sort(order);
	return { summary: reports.map(r => r.summary).find(Boolean) ?? '', findings: renumber(findings), rejected: reports.flatMap(r => r.rejected ?? []), deps: reports.flatMap(r => r.deps ?? []) };
}

/** SARIF 2.1.0, for GitHub code scanning and other tools. */
export function toSarif(r: SecurityReport, tool = 'coee'): object {
	const rules = new Map<string, Finding>();
	for (const f of r.findings) rules.set(f.rule ?? f.cwe ?? f.category, f);
	const level = (s: Severity) => s === 'critical' || s === 'high' ? 'error' : s === 'medium' ? 'warning' : 'note';
	return {
		version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
		runs: [{
			tool: { driver: { name: tool, rules: [...rules].map(([id, f]) => ({ id, name: f.category, shortDescription: { text: f.title }, properties: { tags: [f.cwe, f.owasp].filter(Boolean) } })) } },
			results: r.findings.map(f => ({ ruleId: f.rule ?? f.cwe ?? f.category, level: level(f.severity), message: { text: `${f.title}. ${f.why}` },
				locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.startLine, endLine: f.endLine } } }] })),
		}],
	};
}

/** Split files into batches of at most `chars` characters each (a file bigger than that gets a batch of its own). */
export function batchFiles(files: readonly FolderFile[], chars: number): FolderFile[][] {
	const out: FolderFile[][] = [];
	let used = 0;
	for (const f of files) {
		if (!out.length || used + f.text.length > chars) { out.push([]); used = 0; }
		out[out.length - 1].push(f);
		used += f.text.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Changes: a code review of one changed file, as structured findings that land on its lines

export type FindingKind = 'bug' | 'security' | 'performance' | 'test' | 'maintainability';
export const KINDS: readonly FindingKind[] = ['bug', 'security', 'performance', 'test', 'maintainability'];
export interface ReviewFinding {
	id: string; file: string; startLine: number; endLine: number;
	severity: Severity; kind: FindingKind; title: string; why: string;
	/** Code to apply: it replaces `find` (existing text) in the file. */
	suggestion?: { find: string; code: string };
	/** Found by a fast rule (no model) or in the model's review. */
	source: 'rule' | 'model';
	/** The text of the first line, to find it again after edits move it. */
	anchor: string;
}
export interface FileReview { summary: string; risk: 'low' | 'medium' | 'high'; findings: ReviewFinding[] }

export function buildChangeReviewPrompt(file: FileDiff, text: string, context: string, budget = 1e9): string {
	const head = `You are a senior engineer reviewing a colleague's change to ${file.path} before it is committed. Find what is wrong or risky in the CHANGED lines (marked +), the way a careful human reviewer would.
${GUIDE}
${context ? `\n${context}\n` : ''}
Look for, in order of importance:
- bugs: wrong logic, off-by-one, null/undefined not handled, wrong condition, a missing await, a promise not handled, resources not closed, a changed function whose callers in this file now break
- security: user input reaching SQL, shell, eval, HTML, file paths or URLs; missing auth or validation; secrets; unsafe defaults
- error handling that hides failures, or leaks internals to users
- performance problems that matter (work in a loop that could be done once, N+1 queries, unbounded growth)
- missing tests for new behavior, when the project has tests
- maintainability only when it will clearly cause bugs later (duplicated logic that must stay in sync, a misleading name)
Rules:
- Only comment on the changed lines or on code the change breaks. No style nits, no praise, no restating what the code does. If nothing is wrong, return an empty list: that is a good review.
- Each finding: "severity" (critical, high, medium, low), "kind" (${KINDS.join(', ')}), "title" (short), "why" (what goes wrong, when, and the consequence, in 1-3 plain sentences), "symbol" (the exact text of the line it starts at, copied from the file), "startLine"/"endLine" (new-file line numbers as shown).
- "suggestion" when a concrete fix is small: "find" is the existing lines to replace, copied EXACTLY from the file without line numbers, and "code" what replaces them. Complete code, in the file's style.
- "risk": low (safe to commit), medium (worth a second look), high (likely to break something).

Reply with ONLY JSON:
{"summary": string (one sentence: what this change does), "risk": "low"|"medium"|"high", "findings": [{"severity": string, "kind": string, "title": string, "why": string, "symbol": string, "startLine": number, "endLine": number, "suggestion"?: {"find": string, "code": string}}]}

The change (new-file line numbers; + added, - removed):
`;
	const room = budget - head.length - 400;
	const diff = renderHunks(file, Math.floor(room * 0.4));
	return `${head}${diff}\n\nThe whole file after the change:\n${packFiles([{ path: file.path, text }], room - diff.length)}`;
}

/** Lines (1-based) a change added, with `margin` lines around each run: where review comments belong. */
export function changedRegion(f: FileDiff, margin = 3): Set<number> {
	const out = new Set<number>();
	for (const n of addedLines(f)) for (let k = n - margin; k <= n + margin; k++) if (k > 0) out.add(k);
	for (const h of f.hunks) out.add(h.newStart); // a pure removal still gets a place to comment
	return out;
}

/** The model's review of one file, checked against the file: lines snapped, comments outside the change dropped, suggestions that can't be placed dropped. */
export function repairChangeReview(draft: any, file: FileDiff, text: string): { value?: FileReview; errors: string[] } {
	if (!draft || typeof draft !== 'object') return { errors: ['Reply is not a JSON object'] };
	if (!Array.isArray(draft.findings)) return { errors: ['"findings" must be an array (empty if the change looks right)'] };
	const lines = text.split('\n'), region = changedRegion(file, 5), f = [{ path: file.path, text }];
	const out: ReviewFinding[] = [];
	for (const x of draft.findings) {
		const title = str(x?.title, 120), why = str(x?.why, 700);
		if (!title || !why) continue;
		const [ref] = snapRefs([{ path: file.path, symbol: str(x?.symbol, 160).split('\n')[0].trim() || undefined, startLine: int(x?.startLine) > 0 ? int(x?.startLine) : undefined, endLine: int(x?.endLine) > 0 ? int(x?.endLine) : undefined }], f);
		const a = ref.startLine ?? 0, b = Math.max(a, ref.endLine ?? a);
		if (!a || ![...Array(b - a + 1)].some((_, k) => region.has(a + k))) continue; // not about this change
		const r: ReviewFinding = { id: '', file: file.path, startLine: a, endLine: Math.min(b, a + 30), title, why, source: 'model',
			severity: SEVERITIES.includes(x?.severity) ? x.severity : 'medium', kind: KINDS.includes(x?.kind) ? x.kind : 'bug', anchor: lines[a - 1]?.trim() ?? '' };
		const find = typeof x?.suggestion?.find === 'string' ? x.suggestion.find.replace(/^\s*\n/, '').trimEnd() : '';
		const code = typeof x?.suggestion?.code === 'string' ? x.suggestion.code.replace(/^\s*\n/, '').trimEnd().slice(0, 4000) : '';
		if (find && code && placeSnippet(text, { file: file.path, mode: 'replace', find, code }).status === 'ready') r.suggestion = { find, code };
		if (!out.some(o => o.startLine === r.startLine && o.title === r.title)) out.push(r);
	}
	out.sort((p, q) => SEVERITIES.indexOf(p.severity) - SEVERITIES.indexOf(q.severity) || p.startLine - q.startLine);
	const risk = draft.risk === 'high' || draft.risk === 'medium' ? draft.risk : out.some(x => x.severity === 'critical' || x.severity === 'high') ? 'high' : 'low';
	return { value: { summary: str(draft.summary, 300), risk, findings: out.slice(0, 15).map((x, i) => ({ ...x, id: `${file.path}#${i + 1}` })) }, errors: [] };
}

/** Where a finding is now, after edits: the line whose text matches its anchor, nearest to where it was; undefined if the line is gone. */
export function relocate(f: { startLine: number; endLine: number; anchor: string }, text: string): { startLine: number; endLine: number } | undefined {
	if (!f.anchor) return undefined;
	const lines = text.split('\n');
	if (lines[f.startLine - 1]?.trim() === f.anchor) return { startLine: f.startLine, endLine: f.endLine };
	let best = -1;
	lines.forEach((l, i) => { if (l.trim() === f.anchor && (best < 0 || Math.abs(i + 1 - f.startLine) < Math.abs(best + 1 - f.startLine))) best = i; });
	if (best < 0) return undefined;
	const d = best + 1 - f.startLine;
	return { startLine: f.startLine + d, endLine: Math.min(f.endLine + d, lines.length) };
}

/** A commit message for the whole change, from its diff. */
export function buildCommitMessagePrompt(files: FileDiff[], budget = 1e9): string {
	const head = `Write a git commit message for this change: a subject line under 72 characters in the imperative mood ("Add", "Fix"), a blank line, then 1-3 short lines on what changed and why. Plain text only, no markdown, no quotes around it.\n\n`;
	return head + compressDiff(files, budget - head.length - 200).text;
}

// ---------------------------------------------------------------------------
// Business rules in plain words, for the architecture page

export function buildRulesPrompt(rules: ReadonlyArray<{ id: string; text: string; file: string; line: number; in?: string }>, budget = 1e9): string {
	const head = `These lines are the business rules and guards of a codebase: checks that reject a request, throw, or validate data.
For each, write the rule in plain words for someone new to the project, as a short statement of the rule itself (not the code): "a title is required", "only the order's owner can cancel it", "an order can't total more than 10,000", "the request must come from a logged-in user". Name real things from the code. If a line is only error plumbing with no rule (e.g. re-throwing, a generic 500), say "not a business rule".

Reply with ONLY JSON: {"rules": [{"id": string, "plain": string}]}

`;
	let room = budget - head.length - 200;
	const lines: string[] = [];
	for (const r of rules) {
		const l = `[${r.id}] ${r.file}:${r.line}${r.in ? ` in ${r.in}()` : ''}: ${r.text}`;
		if (l.length > room) break;
		lines.push(l);
		room -= l.length + 1;
	}
	return head + lines.join('\n');
}

/** Plain words by rule id; "not a business rule" drops it from the list. */
export function repairRules(draft: any, ids: readonly string[]): { value?: Record<string, string>; errors: string[] } {
	const raw = Array.isArray(draft?.rules) ? draft.rules : [];
	const out: Record<string, string> = {};
	for (const r of raw) { const id = str(r?.id, 300), plain = str(r?.plain, 200); if (ids.includes(id) && plain) out[id] = plain; }
	return Object.keys(out).length || !ids.length ? { value: out, errors: [] } : { errors: ['"rules" must give "plain" words for the rule ids listed'] };
}
