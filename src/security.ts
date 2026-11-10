import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { Finding, HitRef, Scene, SecurityReport, Snippet, Walkthrough, batchFiles, buildSecurityPrompt, depFinding, mergeReports, repairSecurity, ruleFinding, toSarif } from './prompt';
import { OWASP, RULES, scanText } from './rules';

/** The categories the whole-project design checks (facts.ts) look at: missing auth, missing rate limits, missing headers. */
const DESIGN_CHECKS = ['A01', 'A04', 'A05'];
import { auditDependencies } from './deps';
import { diagramSvg } from './layout';
import { Lm, isCancel, log } from './lm';
import { pickProject, sourceFiles } from './map';
import { digest, readFiles } from './walkthrough';
import { createPanel, page, showLines } from './ui';
import { addCode, fileText, fixSnippet } from './apply';
import { indexProject } from './codeindex';
import { appConfigChecks, designChecks, projectFacts } from './facts';
import { INPUT_DRIVEN, TraceStep, fitProof, proofCommand, proofPath, traceAttack } from './proof';

const CACHE_KEY = 'coee.security';
const DISMISS_KEY = 'coee.security.dismissed';
const CACHE_SIZE = 15;
const VERSION = 2; // bump when what a saved scan holds changes (2: rules, dependencies, model verdicts)
const SCAN_CHARS = 600_000; // code read per scan
const BATCH_CHARS = 40_000; // code per request; ponytail: sized for small context windows, bigger batches if scans are slow
// Config and markup hold secrets and unsafe settings too; the other features don't read them.
const EXTRA = /\.(json|ya?ml|toml|ini|conf|properties|env|html?|gradle|kts|plist)$|(^|\/)\.env[\w.]*$|(^|\/)(pom\.xml|pubspec\.lock|Package\.resolved|AndroidManifest\.xml|network_security_config\.xml)$/i;

interface PageState {
	title?: string;
	scope?: string;
	report?: SecurityReport;
	/** Attack diagrams, drawn here in the current theme, by finding id. */
	svgs?: Record<string, string>;
	dismissed?: string[];
	scanned?: number;
	left?: number;
	reading?: string;
	error?: string;
	/** Why the model's part is missing, when it is. */
	note?: string;
	focus?: string;
	/** Per finding: the attack's path through the code, source first, with the best place for the fix. */
	traces?: Record<string, TraceStep[]>;
	/** Every OWASP Top 10 category: how many checks ran and what they found. */
	coverage?: Array<{ code: string; name: string; checks: number; findings: number }>;
	/** Per finding: what running its proof test showed. */
	proofs?: Record<string, { status: 'running' | 'vulnerable' | 'safe' | 'error'; note?: string; file?: string }>;
}

/** Same finding across scans: the rule (or title) and the text of its first line, not its line number. */
async function fingerprint(root: vscode.Uri, f: Finding): Promise<string> {
	const text = (await fileText(vscode.Uri.joinPath(root, f.file)))?.split('\n')[f.startLine - 1]?.trim() ?? '';
	return createHash('sha1').update(`${f.file}\0${f.rule ?? f.category}\0${text}`).digest('hex').slice(0, 16);
}

/**
 * The security scan, in three passes:
 * 1. fast rules on every line (no model): secrets, injection sinks, unsafe calls;
 * 2. dependency advisories (npm audit / pip-audit, else OSV.dev; only names and versions leave the machine);
 * 3. the model confirms or rejects each rule hit and finds what rules can't (auth, IDOR, SSRF, logic), explaining each with an attack diagram.
 * Findings go to the page, to the Problems panel, and get a quick fix when there's fix code. A review aid, not a guarantee.
 */
export class SecurityController implements vscode.Disposable, vscode.CodeActionProvider {
	private panel?: vscode.WebviewPanel;
	private root?: vscode.Uri;
	private target?: vscode.Uri;
	private state: PageState = {};
	private gen = 0;
	private readonly lm = new Lm('coee scans your code for security gaps.');
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('coee security');
	private readonly disposables: vscode.Disposable[] = [this.diagnostics];
	private ids = new Map<string, string>(); // finding id → fingerprint

	constructor(private readonly ext: vscode.ExtensionContext, private readonly showSteps: (root: vscode.Uri, w: Walkthrough, heading: string) => Promise<void>) {
		this.disposables.push(
			vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
			vscode.commands.registerCommand('coee.securityFix', (id: string) => this.applyFix(id)),
			vscode.commands.registerCommand('coee.securityShow', (id: string) => this.reveal(id)),
			vscode.commands.registerCommand('coee.securityProve', (id: string) => this.prove(id)),
			vscode.window.onDidChangeActiveColorTheme(() => { if (this.state.report) { this.state.svgs = this.svgs(this.state.report); this.post(); } }),
		);
	}

	dispose() {
		this.lm.cancel();
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	/** Scan `uri` (a file or folder, from the Explorer) or, without one, a whole project. */
	async open(uri?: vscode.Uri, fresh = false) {
		let root: vscode.Uri | undefined = uri, target = uri;
		if (uri) {
			const stat = await vscode.workspace.fs.stat(uri);
			if (!(stat.type & vscode.FileType.Directory)) root = vscode.workspace.getWorkspaceFolder(uri)?.uri ?? vscode.Uri.joinPath(uri, '..');
		} else {
			root = target = await pickProject('Scan which codebase?');
		}
		if (!root || !target) return;
		if (this.panel && !fresh && (!uri || this.target?.toString() === target.toString()) && (this.state.report || this.state.reading)) return this.panel.reveal(this.panel.viewColumn, false);
		this.root = root;
		this.target = target;
		this.ensurePanel();
		await this.scan(root, target, fresh);
	}

	private ensurePanel() {
		if (this.panel) return this.panel.reveal(this.panel.viewColumn, true);
		const panel = this.panel = createPanel('coee.security', 'Security scan', { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
		panel.iconPath = vscode.Uri.joinPath(this.ext.extensionUri, 'media', 'icon.png');
		panel.webview.html = page(panel.webview, { css: CSS, body: '<main id="root"></main>', script: SCRIPT });
		panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => this.show({ error: err instanceof Error ? err.message : String(err), reading: undefined })));
		panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.lm.cancel(); this.gen++; this.state = {}; } });
	}

	async clearCache() {
		const n = Object.keys(this.ext.workspaceState.get(CACHE_KEY, {})).length;
		await this.ext.workspaceState.update(CACHE_KEY, undefined);
		return n;
	}

	/** Save the last scan as SARIF (for GitHub code scanning and other tools). */
	async exportSarif() {
		if (!this.state.report || !this.root) return void vscode.window.showInformationMessage('coee: run a security scan first.');
		const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(this.root, 'coee-security.sarif'), filters: { SARIF: ['sarif', 'json'] } });
		if (!to) return;
		await vscode.workspace.fs.writeFile(to, new TextEncoder().encode(JSON.stringify(toSarif(this.visible()), null, 2)));
		vscode.window.showInformationMessage(`coee: saved ${this.visible().findings.length} findings to ${path.basename(to.path)}.`);
	}

	private async onMessage(m: { type: string; id?: string; to?: string; text?: string; path?: string; startLine?: number; endLine?: number }) {
		switch (m.type) {
			case 'ready': return this.post();
			case 'rescan': return this.target && this.open(this.target, true);
			case 'open': return this.root && m.path ? showLines(this.root, m.path, m.startLine, m.endLine) : undefined;
			case 'copy':
				if (!m.text) return;
				await vscode.env.clipboard.writeText(m.text);
				return void vscode.window.showInformationMessage('coee: copied.');
			case 'fix': return m.id && this.applyFix(m.id);
			case 'walkAttack': return m.id && this.walkAttack(m.id);
			case 'prove': return m.id && this.prove(m.id);
			case 'plan': return vscode.commands.executeCommand('coee.plan', this.root, m.text);
			case 'sarif': return this.exportSarif();
			case 'dismiss': case 'restore': {
				const key = m.id && this.ids.get(m.id);
				if (!key) return;
				const all = new Set(this.ext.workspaceState.get<string[]>(DISMISS_KEY, []));
				m.type === 'dismiss' ? all.add(key) : all.delete(key);
				await this.ext.workspaceState.update(DISMISS_KEY, [...all]);
				this.state.dismissed = [...this.ids].filter(([, k]) => all.has(k)).map(([id]) => id);
				this.publish();
				return this.post();
			}
			case 'nav': return vscode.commands.executeCommand('coee.go', m.to, this.root);
		}
	}

	private show(patch: Partial<PageState>) {
		Object.assign(this.state, patch);
		this.post();
	}

	private post() { this.panel?.webview.postMessage({ type: 'state', state: this.state }); }

	/** The report without what the user dismissed. */
	private visible(): SecurityReport {
		const r = this.state.report!, gone = new Set(this.state.dismissed ?? []);
		return { ...r, findings: r.findings.filter(f => !gone.has(f.id)) };
	}

	private theme(): 'dark' | 'light' {
		return [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
	}

	private svgs(r: SecurityReport) {
		return Object.fromEntries(r.findings.filter(f => f.attack).map(f => [f.id, diagramSvg(f.attack!, this.theme(), 760).svg]));
	}

	private async scan(root: vscode.Uri, target: vscode.Uri, fresh: boolean) {
		const gen = ++this.gen;
		this.lm.cancel();
		const isFile = !((await vscode.workspace.fs.stat(target)).type & vscode.FileType.Directory);
		const scope = isFile ? path.basename(target.path) : target.path === root.path ? path.basename(root.path) : vscode.workspace.asRelativePath(target, false);
		this.panel!.title = `Security · ${scope}`;
		this.state = { title: scope, scope: isFile ? `the file ${scope}` : `the project ${scope}`, reading: 'the code' };
		this.post();
		try {
			const rel = path.posix.relative(root.path, target.path);
			const all = isFile ? [rel] : (await sourceFiles(root, undefined, EXTRA)).filter(p => !rel || p === rel || p.startsWith(rel + '/'));
			if (!all.length) throw new Error('No source files found here, so there is nothing to scan.');
			const { files } = await readFiles(root, all, SCAN_CHARS);
			if (gen !== this.gen) return;
			if (!files.length) throw new Error('coee couldn\'t read any of the files here (they may be too large).');
			const scopeText = this.state.scope!;
			const report = await this.cached({ v: VERSION, root: root.toString(), target: target.toString(), code: digest(files) }, fresh, async () => {
				// 1. Rules: instant, and shown at once while the rest runs.
				// Line rules, plus checks on how the project is put together (no auth on a route that changes data, no rate limit
				// on login, no security headers). Both go to the model to confirm or reject.
				const fx = new Map(files.map(f => [f.path, f.text]));
				const design: HitRef[] = isFile ? [] : designChecks(projectFacts(indexProject(files), fx), fx).map(d => ({ ...d, id: `${d.rule}:${d.file}:${d.line}` }));
				const config: HitRef[] = appConfigChecks(fx).map(d => ({ ...d, id: `${d.rule}:${d.file}:${d.line}` })); // a file scan of AndroidManifest.xml too
				const hits: HitRef[] = [...files.flatMap(f => scanText(f.path, f.text)), ...design, ...config];
				const ruleOnly: SecurityReport = { summary: '', findings: hits.map(ruleFinding) };
				this.show({ report: mergeReports([ruleOnly]), reading: 'dependencies' });
				// 2. Dependencies (a project or folder scan only).
				let deps: Finding[] = [], how: string[] = [];
				if (!isFile) {
					const dir = path.join(root.fsPath, rel);
					const read = (p: string) => fileText(vscode.Uri.file(path.join(dir, p)));
					const under = all.map(p => rel ? p.slice(rel.length + 1) : p);
					const audit = await auditDependencies(dir, read, vscode.workspace.isTrusted, under).catch(() => ({ issues: [], how: [] }));
					const manifest = await read('package.json') ?? '';
					// The line that declares it: "name" in package.json; the artifact (okhttp of com.squareup.okhttp3:okhttp), the
					// package or the repository elsewhere.
					const texts = new Map<string, string>();
					for (const d of audit.issues) if (d.file !== 'package-lock.json' && !texts.has(d.file)) texts.set(d.file, await read(d.file) ?? '');
					const lineOf = (text: string, needle: string) => Math.max(1, text.split('\n').findIndex(l => l.includes(needle)) + 1);
					how = audit.how;
					deps = audit.issues.map(d => d.file === 'package-lock.json'
						? depFinding({ ...d, file: path.posix.join(rel, manifest ? 'package.json' : d.file) }, manifest ? lineOf(manifest, `"${d.name}"`) : 1)
						: depFinding({ ...d, file: path.posix.join(rel, d.file) }, lineOf(texts.get(d.file) ?? '', d.name.split(/[:/]/).pop()!)));
				}
				if (gen !== this.gen) throw new Error('cancelled');
				// 3. The model, batch by batch, with that batch's rule hits to confirm or reject.
				const batches = batchFiles(files, BATCH_CHARS);
				const reports: SecurityReport[] = [];
				try {
					for (const [k, batch] of batches.entries()) {
						if (gen !== this.gen) throw new Error('cancelled');
						this.show({ reading: batches.length > 1 ? `the code with the model (part ${k + 1} of ${batches.length})` : 'the code with the model' });
						const mine = new Set(batch.map(f => f.path)), batchHits = hits.filter(h => mine.has(h.file));
						reports.push(await this.lm.json<SecurityReport>(b => buildSecurityPrompt(batch, scopeText, b, batchHits), d => repairSecurity(d, batch, batchHits)));
					}
				} catch (err) {
					if (isCancel(err) || (err as Error).message === 'cancelled') throw err;
					// No model (or it failed): the rules and advisories still stand, unconfirmed.
					log.warn(`security scan without the model: ${(err as Error).message}`);
					const done = new Set(reports.flatMap(r => r.findings.map(f => f.file)));
					reports.push({ summary: '', findings: hits.filter(h => !done.has(h.file)).map(ruleFinding) });
					this.state.note = `The chat model couldn't be used (${(err as Error).message}), so pattern matches are shown unchecked.`;
				}
				reports.push({ summary: '', findings: deps, deps: how });
				return mergeReports(reports);
			});
			if (gen !== this.gen) return;
			for (const f of report.findings) this.ids.set(f.id, await fingerprint(root, f));
			const gone = new Set(this.ext.workspaceState.get<string[]>(DISMISS_KEY, []));
			const idx = indexProject(files), texts = new Map(files.map(f => [f.path, f.text]));
			const traces = Object.fromEntries(report.findings.filter(f => f.source !== 'dependency' && idx.files.has(f.file) && (!f.cwe || INPUT_DRIVEN.has(f.cwe))).map(f => [f.id, traceAttack(idx, f.file, f.startLine, texts)]));
			const coverage = [...Object.entries(OWASP)].map(([code, o]) => ({ code, name: o.name,
				checks: RULES.filter(r => r.owasp === code).length + DESIGN_CHECKS.filter(c => c === code).length + (code === 'A06' ? 1 : 0),
				findings: report.findings.filter(f => f.owasp === code).length }));
			this.show({ coverage, traces, proofs: {}, report, svgs: this.svgs(report), dismissed: report.findings.filter(f => gone.has(this.ids.get(f.id)!)).map(f => f.id), scanned: files.length, left: all.length - files.length, reading: undefined });
			this.publish();
		} catch (err) {
			if (gen !== this.gen || isCancel(err) || (err instanceof Error && err.message === 'cancelled')) return;
			const msg = err instanceof Error ? err.message : String(err);
			log.error(msg);
			this.show({ error: msg, reading: undefined });
		}
	}

	/** Findings in the Problems panel, on their lines. */
	private publish() {
		this.diagnostics.clear();
		if (!this.root || !this.state.report) return;
		const byFile = new Map<string, vscode.Diagnostic[]>();
		for (const f of this.visible().findings) {
			const d = new vscode.Diagnostic(new vscode.Range(f.startLine - 1, 0, f.endLine - 1, 10_000), `${f.title}. ${f.why}`,
				f.severity === 'critical' || f.severity === 'high' ? vscode.DiagnosticSeverity.Error : f.severity === 'medium' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
			d.source = 'coee security';
			d.code = { value: f.cwe ?? f.category, target: vscode.Uri.parse(f.url ?? (f.cwe ? `https://cwe.mitre.org/data/definitions/${f.cwe.replace('CWE-', '')}.html` : 'https://owasp.org/Top10/')) };
			(d as vscode.Diagnostic & { findingId?: string }).findingId = f.id;
			byFile.set(f.file, [...byFile.get(f.file) ?? [], d]);
		}
		for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.joinPath(this.root, file), list);
	}

	provideCodeActions(_doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
		return ctx.diagnostics.filter(d => d.source === 'coee security').flatMap(d => {
			const id = (d as vscode.Diagnostic & { findingId?: string }).findingId, f = this.state.report?.findings.find(x => x.id === id);
			if (!f) return [];
			const out: vscode.CodeAction[] = [];
			if (f.fixCode) {
				const fix = new vscode.CodeAction('coee: apply the suggested fix…', vscode.CodeActionKind.QuickFix);
				fix.command = { command: 'coee.securityFix', title: 'Apply fix', arguments: [f.id] };
				fix.diagnostics = [d];
				fix.isPreferred = true;
				out.push(fix);
			}
			if (f.testCode) {
				const prove = new vscode.CodeAction('coee: prove it…', vscode.CodeActionKind.QuickFix);
				prove.command = { command: 'coee.securityProve', title: 'Prove it', arguments: [f.id] };
				out.push(prove);
			}
			const explain = new vscode.CodeAction('coee: explain this finding', vscode.CodeActionKind.QuickFix);
			explain.command = { command: 'coee.securityShow', title: 'Explain', arguments: [f.id] };
			out.push(explain);
			return out;
		});
	}

	private async applyFix(id: string) {
		const f = this.state.report?.findings.find(x => x.id === id);
		if (!f || !this.root) return;
		const sn = await fixSnippet(this.root, f);
		if (!sn) return void vscode.window.showWarningMessage('coee: this finding has no fix code to apply. Copy the advice from the page instead.');
		await addCode(this.root, sn, 'the fix');
	}

	private reveal(id: string) {
		if (!this.panel) return;
		this.panel.reveal(this.panel.viewColumn, false);
		this.show({ focus: id });
	}

	/**
	 * The attack, step by step in the editor, like a walkthrough: where the input enters, each function it passes
	 * through, the dangerous line, and the step where the fix belongs (with the fix code to add there).
	 */
	private async walkAttack(id: string) {
		const f = this.state.report?.findings.find(x => x.id === id), trace = this.state.traces?.[id];
		if (!f || !trace || !this.root) return;
		const fix = await fixSnippet(this.root, f);
		const scenes: Scene[] = trace.map((t, k) => {
			const text = t.role === 'source' ? `This is where the attacker's input comes in. ${f.exploit || ''}`
				: t.role === 'sink' ? `${f.why}${fix ? '' : `\n\n${f.fix}`}`
				: `The input reaches \`${t.label.replace(/\(\).*/, '')}()\` unchanged: nothing here checks or cleans it.`;
			const scene: Scene = { title: t.label, label: `Step ${k + 1} of ${trace.length}${t.fixHere ? ' · validate the input here' : ''}`, file: t.file, startLine: t.line, endLine: t.endLine,
				text: t.fixHere && t.role !== 'sink' ? `${text}\n\nThis is the best place to check the input: as early as it reaches your code, before it travels further. ${f.fix}` : text };
			// The fix itself goes where the finding is (the dangerous lines).
			if (t.role === 'sink' && fix) { scene.snippets = [fix]; scene.title = `${t.label}: fix it here`; }
			return scene;
		});
		await this.showSteps(this.root, { title: `Attack: ${f.title}`, summary: f.why, scenes }, `Attack · ${f.title}`);
	}

	/**
	 * Prove it: save the finding's proof test beside the code (previewed, like any change), then run it with the project's
	 * own test runner in a VS Code task, after the user agrees. The test asserts the code is safe: failing means the
	 * attack works. Local only, in a trusted workspace.
	 */
	private async prove(id: string): Promise<'vulnerable' | 'safe' | 'error' | undefined> {
		const f = this.state.report?.findings.find(x => x.id === id), root = this.root;
		if (!f?.testCode || !root) return;
		if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage('coee runs proof tests only in a trusted workspace.'); return; }
		const file = proofPath(f.file, f.id);
		const sn: Snippet = { file, mode: 'new', code: fitProof(file, f.testCode) };
		const existing = await fileText(vscode.Uri.joinPath(root, file));
		if (existing === undefined && !await addCode(root, sn, 'the proof test')) return;
		const manifest = await fileText(vscode.Uri.joinPath(root, /\.dart$/.test(file) ? (file.match(/^(.*\/)?test\//)?.[1] ?? '') + 'pubspec.yaml' : 'package.json'));
		// What the project has at its root decides the runner (gradlew, pom.xml, Package.swift, jest.config…).
		const MARKERS = ['gradlew', 'gradlew.bat', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'Package.swift', 'jest.config.js', 'jest.config.ts'];
		const present = new Set((await Promise.all(MARKERS.map(async m => (await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, m)).then(() => m, () => undefined))))).filter(Boolean));
		const run = proofCommand(file, manifest, p => present.has(p));
		if (!run) { vscode.window.showWarningMessage(`coee doesn't know how to run ${file}. Run it with your test runner.`); return; }
		const shown = [run.command, ...run.args].join(' ');
		const ok = await vscode.window.showWarningMessage(`Run the proof test for "${f.title}"?`, { modal: true, detail: `coee will run this in a terminal, in ${path.basename(root.path)}:\n\n${shown}\n\nThe test attacks your code locally, in-process. It doesn't contact any server.` }, 'Run');
		if (ok !== 'Run') return;
		this.setProof(id, { status: 'running', file });
		const task = new vscode.Task({ type: 'coee-proof', id }, vscode.TaskScope.Workspace, `proof ${f.id}`, 'coee', new vscode.ProcessExecution(run.command, run.args, { cwd: root.fsPath }));
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true };
		const done = new Promise<number | undefined>(resolve => {
			const sub = vscode.tasks.onDidEndTaskProcess(e => { if (e.execution.task === task || e.execution.task.name === task.name) { sub.dispose(); resolve(e.exitCode); } });
		});
		try {
			await vscode.tasks.executeTask(task);
			const code = await done;
			this.setProof(id, code === 0 ? { status: 'safe', file, note: `the proof test passes (${run.framework}), so this attack no longer works.` }
				: { status: 'vulnerable', file, note: `The proof test fails (${run.framework}). Apply the fix, then run it again.` });
			return code === 0 ? 'safe' : 'vulnerable';
		} catch (err) {
			this.setProof(id, { status: 'error', file, note: err instanceof Error ? err.message : String(err) });
			return 'error';
		}
	}

	private setProof(id: string, p: NonNullable<PageState['proofs']>[string]) {
		this.state.proofs = { ...this.state.proofs, [id]: p };
		this.post();
	}

	/** Saved per code version (a hash of the files); `coee.cache` turns it off. */
	private async cached<T>(key: object, fresh: boolean, make: () => Promise<T>): Promise<T> {
		const on = vscode.workspace.getConfiguration('coee').get('cache', true);
		const hash = createHash('sha256').update(JSON.stringify(key)).digest('hex');
		const saved = this.ext.workspaceState.get<Record<string, { v: T; t: number }>>(CACHE_KEY, {});
		if (on && !fresh && saved[hash]) return saved[hash].v;
		const v = await make();
		if (on) await this.ext.workspaceState.update(CACHE_KEY, Object.fromEntries(Object.entries({ ...saved, [hash]: { v, t: Date.now() } }).sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_SIZE)));
		return v;
	}
}

// ---------------------------------------------------------------------------

export const CSS = /* css */ `
html, body { height: 100%; }
body { background: var(--vscode-editor-background); }
main { height: 100vh; display: flex; flex-direction: column; }
.bar { display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.bar h1 { font-size: 1.05em; flex: 1; min-width: 8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool { border: 0; background: none; color: var(--vscode-foreground); padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
.tool:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.wrap { flex: 1; overflow: auto; padding: 24px clamp(14px, 4vw, 36px) 60px; }
article { max-width: 900px; margin: 0 auto; display: grid; gap: 22px; align-content: start; }
.eyebrow { font-size: .78em; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
h1.title { font-size: 1.8em; line-height: 1.2; }
.lede { font-size: 1.08em; line-height: 1.6; }
.note { font-size: .88em; color: var(--muted); line-height: 1.5; }
.filters { display: grid; gap: 8px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); background: none; color: var(--vscode-foreground); border-radius: 999px; padding: 3px 11px; display: inline-flex; gap: 7px; align-items: center; font-size: .92em; }
.chip[aria-pressed="false"] { opacity: .45; }
.chip b { font-weight: 600; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--c); }
.critical { --c: var(--vscode-errorForeground, #f14c4c); }
.high { --c: #d18616; }
.medium { --c: var(--vscode-editorWarning-foreground, #cca700); }
.low { --c: var(--muted); }
.group { display: grid; gap: 12px; }
.group > header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.group > header h2 { font-size: 1.15em; }
.group > header .code { color: var(--muted); font-family: var(--mono); font-size: .85em; }
details.learn { font-size: .92em; color: var(--muted); line-height: 1.55; }
details.learn summary { cursor: pointer; color: var(--link); }
.finding { display: grid; gap: 10px; padding: 14px 18px; border-radius: 8px; border: 1px solid var(--line); border-left: 4px solid var(--c); background: var(--vscode-editorWidget-background); scroll-margin: 20px; }
.finding.focus { outline: 2px solid var(--vscode-focusBorder); }
.finding h3 { font-size: 1.05em; line-height: 1.35; }
.meta { display: flex; gap: 8px 10px; align-items: center; flex-wrap: wrap; font-size: .8em; color: var(--muted); }
.sev { text-transform: uppercase; letter-spacing: .08em; font-weight: 700; color: var(--c); }
.src { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
.src.ok { color: var(--vscode-testing-iconPassed, #3fb950); border-color: currentColor; }
.finding h4 { font-size: .74em; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 3px; }
.finding .md { line-height: 1.6; }
.where .link { font-family: var(--mono); }
.pic { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
.pic svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
.code { position: relative; margin: 0; }
.code pre { margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; overflow: auto; max-height: 300px; font-family: var(--mono); font-size: .92em; line-height: 1.5; background: var(--vscode-textCodeBlock-background, transparent); }
.code .btn { position: absolute; top: 6px; right: 6px; padding: 1px 8px; font-size: .85em; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.more { display: grid; gap: 10px; }
.clean { padding: 20px; border: 1px dashed var(--line); border-radius: 8px; line-height: 1.6; }
.reading { display: flex; gap: 12px; align-items: center; color: var(--muted); }
.reading .sweep { flex: 0 0 80px; }
.rejected li { margin: 4px 0; }
.owasp { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.otile { display: grid; gap: 2px; text-align: left; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); }
.otile.hit { border-color: var(--vscode-editorWarning-foreground, #cca700); }
.ocode { font-family: var(--mono); font-size: .78em; color: var(--muted); }
.oname { font-size: .88em; font-weight: 600; line-height: 1.3; }
.ostat { font-size: .8em; color: var(--vscode-testing-iconPassed, #3fb950); }
.otile.hit .ostat { color: var(--vscode-editorWarning-foreground, #cca700); }
.trace { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.trace li.sink > span:first-child { color: var(--c); font-weight: 600; }
.fixbadge { margin-left: 8px; font-size: .75em; padding: 0 6px; border-radius: 3px; border: 1px solid var(--vscode-testing-iconPassed, #3fb950); color: var(--vscode-testing-iconPassed, #3fb950); }
.proof { padding: 8px 12px; border-radius: 6px; font-weight: 600; }
.proof.vulnerable { background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); color: var(--vscode-errorForeground); }
.proof.safe { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 15%, transparent); color: var(--vscode-testing-iconPassed, #3fb950); }
.proof.running, .proof.error { border: 1px solid var(--line); color: var(--muted); font-weight: 400; }
`;

export const SCRIPT = String.raw`
const root = document.getElementById('root');
const send = (type, extra) => vscode.postMessage({ type, ...extra });
const SEV = ['critical', 'high', 'medium', 'low'];
const SRC = [['rule', 'Pattern'], ['model', 'Model'], ['dependency', 'Dependency']];
const OWASP = ${JSON.stringify(Object.fromEntries(Object.entries(OWASP).map(([k, v]) => [k, v])))};
let st = {}, hideSev = new Set(), hideSrc = new Set(), showDismissed = false, focused = '';

const reading = what => el('div', { className: 'reading' }, el('div', { className: 'sweep', 'aria-hidden': 'true' }), 'Reading ' + what + '…');
const code = text => el('div', { className: 'code' }, el('pre', {}, text), el('button', { className: 'btn quiet', onclick: () => send('copy', { text }) }, 'Copy'));
const sec = (title, body) => body ? el('div', {}, el('h4', {}, title), typeof body === 'string' ? md(body) : body) : null;
const source = f => f.source === 'dependency' ? el('span', { className: 'src' }, 'Dependency advisory')
  : f.source === 'rule' ? (f.confirmed ? el('span', { className: 'src ok', title: 'A pattern found it and the model confirmed it in context' }, 'Pattern · confirmed')
    : el('span', { className: 'src', title: 'A pattern matched; the model did not check it' }, 'Pattern · unchecked'))
  : el('span', { className: 'src', title: 'Found by reading the code with the model' }, 'Model');

/** The attack's path, source first, with where the fix belongs. */
function trace(f) {
  const t = st.traces && st.traces[f.id];
  if (!t || t.length < 2) return null;
  return sec('The path through your code', el('ol', { className: 'trace' }, ...t.map(x => el('li', { className: x.role + (x.fixHere ? ' fixhere' : '') },
    el('span', {}, x.label), ' ',
    el('button', { className: 'link mono', onclick: () => send('open', { path: x.file, startLine: x.line, endLine: x.endLine }) }, x.file + ':' + x.line),
    x.fixHere ? el('span', { className: 'fixbadge' }, 'validate here') : null))));
}

function finding(f, dismissed) {
  const proof = st.proofs && st.proofs[f.id];
  const where = f.file + ':' + f.startLine + (f.endLine !== f.startLine ? '–' + f.endLine : '');
  const pic = st.svgs && st.svgs[f.id] ? (() => { const d = el('div', { className: 'pic' }); d.innerHTML = st.svgs[f.id]; return d; })() : null;
  return el('section', { className: 'finding ' + f.severity + (focused === f.id ? ' focus' : ''), id: 'f-' + f.id },
    el('div', { className: 'meta' }, el('span', { className: 'sev' }, f.severity), el('span', {}, f.category + (f.cwe ? ' · ' + f.cwe : '')), source(f)),
    el('h3', {}, f.title),
    proof ? el('div', { className: 'proof ' + proof.status }, proof.status === 'running' ? 'Running the proof test…' : proof.status === 'vulnerable' ? '⚠ Proven: the attack works. ' + (proof.note || '') : proof.status === 'safe' ? '✓ Fixed: ' + (proof.note || '') : 'The proof test couldn\'t run: ' + (proof.note || '')) : null,
    el('div', { className: 'where' }, el('button', { className: 'link', title: 'Show these lines in the editor', onclick: () => send('open', { path: f.file, startLine: f.startLine, endLine: f.endLine }) }, where)),
    sec("What's wrong", f.why),
    sec('Why ' + f.severity, f.severityWhy),
    sec('How it could be abused', f.exploit),
    trace(f),
    pic ? sec('The attack, as a sequence', pic) : null,
    sec('Check it yourself', f.verify),
    sec('How to fix it', f.fix),
    f.fixCode ? code(f.fixCode) : null,
    f.testCode ? sec('A test that catches it', code(f.testCode)) : null,
    f.url ? el('p', { className: 'note' }, el('button', { className: 'link', onclick: () => send('copy', { text: f.url }) }, 'Copy the advisory link')) : null,
    el('div', { className: 'actions' },
      st.traces && st.traces[f.id] && !dismissed ? el('button', { className: 'btn', title: 'Follow the input through the code, step by step, in the editor', onclick: () => send('walkAttack', { id: f.id }) }, 'Step through the attack') : null,
      f.testCode && !dismissed ? el('button', { className: 'btn quiet', title: 'Save the proof test beside the code and run it with your test runner (asks first)', onclick: () => send('prove', { id: f.id }) }, proof && proof.status !== 'running' ? 'Run the proof again' : 'Prove it') : null,
      f.fixCode && !dismissed ? el('button', { className: 'btn quiet', title: 'Shows the change first; Undo takes it back', onclick: () => send('fix', { id: f.id }) }, 'Apply fix…') : null,
      !dismissed ? el('button', { className: 'btn quiet', title: 'Plan this fix, with the code and tests', onclick: () => send('plan', { text: 'Fix: ' + f.title + ' (' + f.file + ', lines ' + f.startLine + '–' + f.endLine + ')' }) }, 'Plan this fix') : null,
      el('button', { className: 'btn quiet', title: dismissed ? 'Show it again' : 'Not a problem here; coee will remember', onclick: () => send(dismissed ? 'restore' : 'dismiss', { id: f.id }) }, dismissed ? 'Restore' : 'Not a problem')));
}

function chipRow(items, hidden, count) {
  return el('div', { className: 'chips' }, ...items.filter(([k]) => count(k)).map(([k, label]) => el('button', { className: 'chip ' + k, 'aria-pressed': hidden.has(k) ? 'false' : 'true',
    onclick: () => { hidden.has(k) ? hidden.delete(k) : hidden.add(k); render(); } }, SEV.includes(k) ? el('span', { className: 'dot' }) : null, label, el('b', {}, String(count(k))))));
}

function render() {
  const bar = el('div', { className: 'bar' }, coeeNav('security'), el('h1', {}, 'Security' + (st.title ? ' · ' + st.title : '')),
    st.report && !st.reading ? el('button', { className: 'tool', title: 'Save as SARIF for GitHub code scanning', onclick: () => send('sarif') }, 'Export SARIF') : null,
    st.report || st.error ? el('button', { className: 'tool', title: 'Read the code again and scan it', onclick: () => send('rescan') }, '↻ Scan again') : null);
  if (st.error) return root.replaceChildren(bar, el('div', { className: 'wrap' }, el('article', {}, el('p', { className: 'error' }, st.error),
    el('div', {}, el('button', { className: 'btn', onclick: () => send('rescan') }, 'Try again')))));
  if (!st.report) return root.replaceChildren(bar, el('div', { className: 'wrap' }, el('article', {}, reading(st.reading || 'the code'))));
  const gone = new Set(st.dismissed || []);
  const all = st.report.findings.filter(f => !gone.has(f.id));
  const shown = all.filter(f => !hideSev.has(f.severity) && !hideSrc.has(f.source || 'model'));
  const groups = [...new Set(shown.map(f => f.owasp || 'other'))].sort();
  const counts = s => all.filter(f => f.severity === s).length;
  const head = el('div', {}, el('span', { className: 'eyebrow' }, 'Security scan · ' + st.scope),
    el('h1', { className: 'title' }, all.length ? all.length + (all.length === 1 ? ' thing to look at' : ' things to look at') : st.reading ? 'Nothing so far' : 'Nothing found'),
    st.report.summary ? el('p', { className: 'lede' }, st.report.summary) : null);
  root.replaceChildren(bar, el('div', { className: 'wrap' }, el('article', {},
    head,
    st.coverage ? el('div', { className: 'owasp' }, ...st.coverage.map(c => el('button', { className: 'otile' + (c.findings ? ' hit' : ''), title: c.checks + ' checks' + (c.code === 'A06' ? ', plus the dependency audit' : '') + (c.code === 'A04' || c.code === 'A01' ? ', plus the model reading the design' : ''),
      onclick: () => { const g = document.getElementById('g-' + c.code); if (g) g.scrollIntoView({ behavior: 'smooth' }); } },
      el('span', { className: 'ocode' }, c.code === 'MEM' ? 'C/C++' : c.code), el('span', { className: 'oname' }, c.name),
      el('span', { className: 'ostat' }, c.findings ? c.findings + ' found' : '✓ ' + c.checks + ' checks clean')))) : null,
    st.reading ? reading(st.reading) : null,
    st.note ? el('p', { className: 'note warn' }, st.note) : null,
    all.length ? el('div', { className: 'filters' }, chipRow(SEV.map(s => [s, s]), hideSev, counts), chipRow(SRC, hideSrc, k => all.filter(f => (f.source || 'model') === k).length)) : null,
    !all.length && !st.reading ? el('div', { className: 'clean' }, 'coee read ' + st.scanned + ' file' + (st.scanned === 1 ? '' : 's') + ' and found nothing it could point at. That is not a guarantee: it reads code, not a running system, and can miss things.') : null,
    ...groups.map(g => el('div', { className: 'group', id: 'g-' + g },
      el('header', {}, el('h2', {}, OWASP[g] ? OWASP[g].name : 'Other'), el('span', { className: 'code' }, g === 'MEM' ? 'memory safety' : g !== 'other' ? 'OWASP ' + g : '')),
      OWASP[g] ? el('details', { className: 'learn' }, el('summary', {}, 'What is this?'), el('p', {}, OWASP[g].learn)) : null,
      ...shown.filter(f => (f.owasp || 'other') === g).map(f => finding(f, false)))),
    st.report.rejected && st.report.rejected.length ? el('details', { className: 'more' }, el('summary', {}, st.report.rejected.length + ' pattern match' + (st.report.rejected.length === 1 ? '' : 'es') + ' the model judged harmless'),
      el('ul', { className: 'rejected' }, ...st.report.rejected.map(r => el('li', {}, el('button', { className: 'link', onclick: () => send('open', { path: r.file, startLine: r.line, endLine: r.line }) }, r.file + ':' + r.line), ' ' + r.title + ': ' + r.reason)))) : null,
    gone.size ? el('details', { className: 'more', open: showDismissed || null, ontoggle: e => { showDismissed = e.target.open; } }, el('summary', {}, gone.size + ' marked as not a problem'),
      ...st.report.findings.filter(f => gone.has(f.id)).map(f => finding(f, true))) : null,
    el('p', { className: 'note' }, 'A review aid, not a guarantee. Patterns run first, then the model checks each match and looks for what patterns miss; both can be wrong. '
      + (st.report.deps && st.report.deps.length ? 'Dependencies checked with ' + st.report.deps.join(', ') + '. ' : '')
      + (st.left > 0 ? st.left + ' file' + (st.left === 1 ? ' was' : 's were') + ' over the reading limit and left out.' : '')))));
  if (st.focus && st.focus !== focused) { focused = st.focus; const n = document.getElementById('f-' + focused); if (n) { n.classList.add('focus'); n.scrollIntoView({ block: 'center' }); } }
}

window.addEventListener('message', ({ data: m }) => { if (m.type === 'state') { st = m.state; render(); } });
send('ready');
`;
