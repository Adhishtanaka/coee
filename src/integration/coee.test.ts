// Runs inside a real VS Code (npm run test:integration), on a temporary git copy of fixtures/app, with a scripted model.
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { FakeModel } from './fake';
import { addCode, insideRoot } from '../apply';
import * as nodefs from 'fs';
import { showLines } from '../ui';

const root = () => vscode.workspace.workspaceFolders![0].uri;
const file = (p: string) => vscode.Uri.joinPath(root(), p);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(what: string, get: () => T | undefined | false, ms = 20_000): Promise<T> {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = get(); if (v) return v; }
	throw new Error(`timed out waiting for ${what}`);
}
/** Code actions at a range. VS Code cancels the query if the editor changes meanwhile (a page opening, diagnostics
 * republished), so it is asked again until it answers. */
async function codeActions(uri: vscode.Uri, range: vscode.Range): Promise<vscode.CodeAction[]> {
	for (let attempt = 0; ; attempt++) {
		try { return await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, range); } catch (err) {
			if (attempt >= 5 || !/Canceled/.test(String(err))) throw err;
			await sleep(300);
		}
	}
}
const text = async (p: string) => (await vscode.workspace.openTextDocument(file(p))).getText();
/** Groups holding a coee page (a webview tab). */
const coeeGroups = () => vscode.window.tabGroups.all.filter(g => g.tabs.some(t => t.input instanceof vscode.TabInputWebview));

/** Answer a VS Code prompt the way a user would, for the length of `fn`. */
async function answering<T>(api: 'showInformationMessage' | 'showSaveDialog', answer: unknown, fn: () => Promise<T>): Promise<T> {
	const win = vscode.window as unknown as Record<string, unknown>, original = win[api];
	win[api] = async (...args: unknown[]) => typeof answer === 'function' ? answer(...args) : answer;
	try { return await fn(); } finally { win[api] = original; }
}

const model = new FakeModel()
	.on(/You draw a system map/, { title: 'Todo API', summary: 'A small todo REST API.', components: [
		{ id: 'server', name: 'Server', summary: 'HTTP routes', files: ['server.js'] },
		{ id: 'store', name: 'Store', summary: 'In-memory todos', files: ['store.js'] }],
		connections: [{ from: 'server', to: 'store', label: 'list()' }] })
	.on(/Write the "how it works" part/, { title: 'Todo API', summary: 'Routes over an in-memory store.', howItWorks: '`server.js` answers requests and asks `store.js` for todos.',
		components: [{ id: 'server', role: 'Routes requests.', keyFiles: [{ path: 'server.js', symbol: 'const server = http.createServer(async (req, res) => {', why: 'entry' }] },
			{ id: 'store', role: 'Keeps todos.', keyFiles: [{ path: 'store.js', symbol: 'const todos = [];', why: 'data' }] }], conventions: ['CommonJS modules.'], terms: [] })
	.on(/Describe how this project behaves/, { useCases: [
		{ name: 'List todos', who: 'A client', steps: ['GET /todos'], files: [{ path: 'server.js', symbol: "if (req.method === 'GET') return send(res, 200, store.list());" }],
			sequence: { nodes: [{ id: 'c', label: 'Client' }, { id: 's', label: 'server' }], edges: [{ from: 'c', to: 's', label: 'GET /todos' }] } },
		{ name: 'Wrong method', who: 'A client', steps: ['PUT /todos'], files: [{ path: 'server.js', symbol: "send(res, 405, { error: 'Method not allowed' });" }],
			sequence: { nodes: [{ id: 'c', label: 'Client' }, { id: 's', label: 'server' }], edges: [{ from: 'c', to: 's', label: 'PUT' }] } }],
		states: [{ name: 'Request', what: 'From received to answered.', diagram: { nodes: [{ id: 'r', label: 'received', detail: 'open' }, { id: 'a', label: 'answered', detail: 'sent' }], edges: [{ from: 'r', to: 'a', label: 'send' }] } }] })
	.on(/data model/, { what: 'An array of todos.', entities: [{ id: 't', name: 'Todo', kind: 'type', fields: [{ name: 'title', type: 'string' }] }], relations: [] })
	.on(/application security reviewer/, { summary: 'Pattern hits only.', findings: [], rejected: [] })
	.on(/reviewing a colleague's change/, p => {
		const line = Number(/(\d+) \+ .*cache/.exec(p)?.[1] ?? 1);
		return { summary: 'Adds a cache.', risk: 'medium', findings: [{ severity: 'medium', kind: 'bug', title: 'Cache never expires', why: 'Entries stay forever, so memory grows with every request.', startLine: line, endLine: line,
			suggestion: { find: 'const cache = new Map();', code: 'const cache = new Map(); // cleared in send()' } }] };
	});

suiteSetup(async () => {
	model.install();
	await vscode.extensions.getExtension('coee.coee')?.activate();
});
teardown(async () => {
	await vscode.commands.executeCommand('workbench.action.files.revertAll').then(undefined, () => undefined);
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});
suiteTeardown(() => {
	model.uninstall();
	assert.deepEqual(model.unexpected, [], 'every prompt coee sent had a scripted answer');
});

suite('coee in VS Code', () => {
	test('commands: the new ones exist, the removed ones are gone', async () => {
		const all = await vscode.commands.getCommands(true);
		for (const c of ['coee.architecture', 'coee.changes', 'coee.security', 'coee.plan', 'coee.go', 'coee.exportSarif', 'coee.walkPart', 'coee.reviewProject', 'coee.reviewFile']) assert.ok(all.includes(c), c);
		for (const c of ['coee.map', 'coee.review', 'coee.reviewStaged']) assert.ok(!all.includes(c), `${c} should be gone`);
	});

	test('architecture: one coee column beside the code, and file links select the whole range', async () => {
		await vscode.window.showTextDocument(file('server.js'), { viewColumn: vscode.ViewColumn.One });
		await vscode.commands.executeCommand('coee.architecture', root());
		await until('the data model request', () => model.count(/data model/) > 0);
		await vscode.commands.executeCommand('coee.go', 'security', root());
		await until('the security page', () => coeeGroups()[0]?.tabs.length >= 2);
		assert.equal(coeeGroups().length, 1, 'coee pages share one group');
		assert.notEqual(coeeGroups()[0].viewColumn, vscode.ViewColumn.One, 'and it is not the code group');
		// A file link (lines 9-12) opens in the code group with every line selected, the last one included.
		await showLines(root(), 'server.js', 9, 12);
		const ed = await until('the editor', () => vscode.window.activeTextEditor?.document.uri.path.endsWith('server.js') && vscode.window.activeTextEditor);
		assert.equal(ed.viewColumn, vscode.ViewColumn.One);
		assert.deepEqual([ed.selection.start.line, ed.selection.end.line, ed.selection.end.character], [8, 11, ed.document.lineAt(11).text.length]);
	});

	test('security: every planted flaw is found by the rules alone, with a quick fix offered', async () => {
		await vscode.window.showTextDocument(file('files.js'), { viewColumn: vscode.ViewColumn.One });
		await vscode.commands.executeCommand('coee.security', file('files.js'));
		const diags = await until('security diagnostics', () => { const d = vscode.languages.getDiagnostics(file('files.js')).filter(x => x.source === 'coee security'); return d.length >= 4 && d; });
		const cwes = new Set(diags.map(d => typeof d.code === 'object' ? String(d.code.value) : String(d.code)));
		for (const cwe of ['CWE-22', 'CWE-78', 'CWE-95', 'CWE-79']) assert.ok(cwes.has(cwe), `missing ${cwe}: ${[...cwes]}`);
		const actions = await codeActions(file('files.js'), diags[0].range);
		assert.ok(actions.some(a => a.title === 'coee: explain this finding'));
	});

	test('security: SARIF export writes what the scan found', async () => {
		await vscode.commands.executeCommand('coee.security', file('files.js')); // each test starts clean, so scan again (cached: instant)
		await until('the scan', () => vscode.languages.getDiagnostics(file('files.js')).some(x => x.source === 'coee security'));
		const out = vscode.Uri.file(path.join(os.tmpdir(), `coee-${Date.now()}.sarif`));
		await answering('showSaveDialog', out, async () => vscode.commands.executeCommand('coee.exportSarif'));
		const sarif = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(out)));
		assert.equal(sarif.version, '2.1.0');
		assert.ok(sarif.runs[0].results.some((r: { locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }) => r.locations[0].physicalLocation.artifactLocation.uri === 'files.js'));
	});

	test('adding code: placed by its anchor, checked, refused the second time, and Cancel changes nothing', async () => {
		const sn = { file: 'store.js', mode: 'insert' as const, after: 'const todos = [];', code: 'const MAX = 100;' };
		assert.equal(await answering('showInformationMessage', undefined, () => addCode(root(), sn)), false, 'cancelled');
		assert.ok(!(await text('store.js')).includes('MAX'));
		const add = (msg: string, ...items: string[]) => items.includes('Add') ? 'Add' : undefined;
		assert.equal(await answering('showInformationMessage', add, () => addCode(root(), sn)), true);
		assert.ok((await text('store.js')).startsWith('const todos = [];\nconst MAX = 100;\n'));
		assert.equal(await answering('showInformationMessage', add, () => addCode(root(), sn)), false, 'already added');
		assert.equal((await text('store.js')).split('const MAX = 100;').length, 2, 'only once');
	});

	test('adding code: a replace whose text is gone is refused, and the file is left alone', async () => {
		const before = await text('server.js');
		const ok = await answering('showInformationMessage', () => 'Add', () => addCode(root(), { file: 'server.js', mode: 'replace', find: 'const nothing = here;', code: 'x()' }));
		assert.equal(ok, false);
		assert.equal(await text('server.js'), before);
	});

	test('adding code: never through a symlink that leads outside the project', async () => {
		const outside = nodefs.mkdtempSync(path.join(os.tmpdir(), 'coee-outside-'));
		nodefs.symlinkSync(outside, path.join(root().fsPath, 'linked'));
		try {
			assert.equal(await insideRoot(root(), file('linked/x.js')), false);
			assert.equal(await insideRoot(root(), file('newdir/x.js')), true);
			nodefs.symlinkSync(path.join(outside, 'missing.js'), path.join(root().fsPath, 'dangling.js')); // points at nothing yet
			assert.equal(await insideRoot(root(), file('dangling.js')), false, 'a dangling link is refused');
			nodefs.unlinkSync(path.join(root().fsPath, 'dangling.js'));
			const ok = await answering('showInformationMessage', () => 'Add', () => addCode(root(), { file: 'linked/x.js', mode: 'new', code: 'x()' }));
			assert.equal(ok, false);
			assert.ok(!nodefs.existsSync(path.join(outside, 'x.js')));
			// A new file is created inside the project, exactly once.
			const sn = { file: 'tests/new.test.js', mode: 'new' as const, code: "test('x', () => {});" };
			assert.equal(await answering('showInformationMessage', () => 'Add', () => addCode(root(), sn)), true);
			assert.equal(nodefs.readFileSync(path.join(root().fsPath, 'tests/new.test.js'), 'utf8'), "test('x', () => {});\n");
			assert.equal(await answering('showInformationMessage', () => 'Add', () => addCode(root(), sn)), false, 'already added');
			nodefs.rmSync(path.join(root().fsPath, 'tests'), { recursive: true });
		} finally {
			nodefs.unlinkSync(path.join(root().fsPath, 'linked'));
		}
	});

	test('changes: saving an edit gets it reviewed without a click, on the changed line, with its suggestion as a quick fix', async () => {
		await vscode.workspace.getConfiguration('coee').update('changes.autoReview', 'onSave', vscode.ConfigurationTarget.Workspace);
		const doc = await vscode.workspace.openTextDocument(file('server.js'));
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(2, 0), 'const cache = new Map();\n');
		await vscode.workspace.applyEdit(edit);
		await doc.save();
		const d = await until('a review diagnostic', () => vscode.languages.getDiagnostics(doc.uri).find(x => x.source === 'coee review'));
		assert.match(d.message, /Cache never expires/);
		assert.equal(d.range.start.line, 2);
		const actions = await codeActions(doc.uri, d.range);
		assert.ok(actions.some(a => a.title === 'coee: apply the suggested change…'));
		// The same diff isn't reviewed twice: saving again without changes costs no request.
		const n = model.count(/reviewing a colleague's change/);
		await doc.save();
		await sleep(3000);
		assert.equal(model.count(/reviewing a colleague's change/), n);
		await vscode.workspace.getConfiguration('coee').update('changes.autoReview', undefined, vscode.ConfigurationTarget.Workspace);
	});
});
