import * as vscode from 'vscode';
import * as path from 'path';
import { FileDiff, FileReview, ReviewFinding, SEVERITIES, addedLines, buildChangeOverviewPrompt, buildChangeReviewPrompt, buildCommitMessagePrompt, relocate, repairChangeOverview, repairChangeReview } from './prompt';
import { scanText } from './rules';
import { ProjectIndex, indexProject } from './codeindex';
import { callSites, changedSymbols } from './facts';
import { sourceFiles } from './map';
import { readFiles } from './walkthrough';
import { Lm, isCancel, log } from './lm';
import { ReviewTarget, branchVsBase, collect, commit, currentBranch, hash, pickCommit, repoRoot, stagedOnly, useCommitMessage, working, openDiff } from './git';
import { pickProject } from './map';
import { createPanel, page, showLines } from './ui';
import { addCode } from './apply';

const REVIEWS_KEY = 'coee.changes.reviews';
const DISMISS_KEY = 'coee.changes.dismissed';
const VERSION = 1; // bump when the review prompt changes, so saved reviews are redone
const MAX_SAVED = 300;
const DEBOUNCE = 2000;

type Mode = 'working' | 'staged' | 'branch' | 'commit';
type Status = 'pending' | 'queued' | 'reviewing' | 'reviewed' | 'failed' | 'skipped';
interface FileState { path: string; diff: FileDiff; text?: string; plus: number; minus: number; key: string; status: Status; review?: FileReview; error?: string; staged?: boolean }

/** Minimal shape of the built-in git extension's API (only what's used here). */
interface GitRepo { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void>; indexChanges: Array<{ uri: vscode.Uri }> } }
interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }

const fingerprint = (f: ReviewFinding) => `${f.file}\0${f.title}\0${f.anchor}`;

/**
 * Changes: a live review of what you've changed in git. It watches the repository (saves, stages, commits), keeps the
 * diff current, runs the fast rules on every added line at once, and has the model review each changed file in the
 * background (on save, on stage, or on request), caching by the file's diff so only new edits cost a request.
 * Findings show on their lines (comments), in the Problems panel, in the status bar and on the Changes page.
 */
export class ChangesController implements vscode.Disposable, vscode.CodeActionProvider {
	private panel?: vscode.WebviewPanel;
	private repo?: string;
	private mode: Mode = 'working';
	private target?: ReviewTarget;
	private files = new Map<string, FileState>();
	/** The second pass, across the whole change, once every file has its own review. */
	private overall?: FileReview & { key: string };
	private overallBusy = false;
	private rules = new Map<string, ReviewFinding[]>();
	private error?: string;
	private loading = false;
	private commitMessage?: string;
	private messageBusy = false;
	private focus?: string;
	private timer?: NodeJS.Timeout;
	private running = false;
	private manual = new Set<string>(); // files the user asked to review (whatever the auto setting)
	private readonly lm = new Lm('coee reviews your changes.');
	private readonly askLm = new Lm('coee answers a question about a review comment.');
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('coee review');
	private readonly comments = vscode.comments.createCommentController('coee', 'coee review');
	private threads: vscode.CommentThread[] = [];
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	private readonly disposables: vscode.Disposable[] = [this.diagnostics, this.comments, this.status];
	private watched = new Set<string>();

	constructor(private readonly ext: vscode.ExtensionContext, private readonly walk: (t: ReviewTarget) => Promise<void>) {
		this.comments.options = { prompt: 'Ask coee about this…', placeHolder: 'Ask a question about this comment' };
		this.status.command = 'coee.changes';
		this.disposables.push(
			vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
			vscode.workspace.onDidSaveTextDocument(d => { if (this.repo && d.uri.fsPath.startsWith(this.repo + path.sep)) this.schedule(); }),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('coee.changes')) this.schedule(0); }),
			vscode.commands.registerCommand('coee.changesApply', (c: { findingId?: string }) => c?.findingId && this.apply(c.findingId)),
			vscode.commands.registerCommand('coee.changesDismiss', (c: { findingId?: string }) => c?.findingId && this.dismiss(c.findingId, true)),
			vscode.commands.registerCommand('coee.changesAsk', (r: vscode.CommentReply) => this.ask(r)),
			vscode.commands.registerCommand('coee.changesShow', (id: string) => this.show(id)),
		);
	}

	dispose() {
		clearTimeout(this.timer);
		this.lm.cancel();
		this.askLm.cancel();
		this.panel?.dispose();
		this.threads.forEach(t => t.dispose());
		this.disposables.forEach(d => d.dispose());
	}

	private auto(): 'onSave' | 'onStage' | 'off' {
		const v = vscode.workspace.getConfiguration('coee').get<string>('changes.autoReview', 'onStage');
		return v === 'onSave' || v === 'off' ? v : 'onStage';
	}

	/** Start watching the workspace's git repository. Called once at startup; cheap until something changes. */
	async start() {
		// Watching runs git on its own, so it waits for the user to trust the folder.
		if (!vscode.workspace.isTrusted) { this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void this.start())); return; }
		const api = await gitApi();
		if (!api) return;
		const watch = (r: GitRepo) => {
			if (this.watched.has(r.rootUri.fsPath)) return;
			this.watched.add(r.rootUri.fsPath);
			this.disposables.push(r.state.onDidChange(() => { if (r.rootUri.fsPath === this.repo) this.schedule(); }));
			if (!this.repo) { this.repo = r.rootUri.fsPath; this.schedule(500); }
		};
		api.repositories.forEach(watch);
		this.disposables.push(api.onDidOpenRepository(watch));
	}

	/** Open the Changes page (for `dir`'s repository, or the one being watched). */
	async open(dir?: vscode.Uri) {
		const root = dir ? await repoRoot(dir) : this.repo ?? await pickProject('Watch changes in which codebase?').then(u => u && repoRoot(u));
		if (!root) return;
		if (root !== this.repo) { this.repo = root; this.files.clear(); this.mode = 'working'; }
		if (!this.panel) {
			const panel = this.panel = createPanel('coee.changes', 'Changes', { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
			panel.iconPath = vscode.Uri.joinPath(this.ext.extensionUri, 'media', 'icon.png');
			panel.webview.html = page(panel.webview, { css: CSS, body: '<main id="root"></main>', script: SCRIPT });
			panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => { this.error = err instanceof Error ? err.message : String(err); this.post(); }));
			panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
		}
		this.panel.reveal(this.panel.viewColumn, false);
		await this.refresh();
	}

	private schedule(ms = DEBOUNCE) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.refresh(), ms);
	}

	/** Read the diff again; keep reviews whose file didn't change; rules run at once; the model queue picks up the rest. */
	private async refresh() {
		if (!this.repo) return;
		this.loading = true;
		this.post();
		try {
			const t = this.target = this.mode === 'working' ? await working(this.repo) : this.mode === 'staged' ? await stagedOnly(this.repo) : this.target ?? await working(this.repo);
			const r = await collect(t, true);
			const api = await gitApi();
			const staged = new Set(api?.repositories.find(x => x.rootUri.fsPath === this.repo)?.state.indexChanges.map(c => path.relative(this.repo!, c.uri.fsPath).split(path.sep).join('/')) ?? []);
			const saved = this.ext.workspaceState.get<Record<string, FileReview>>(REVIEWS_KEY, {});
			const next = new Map<string, FileState>();
			this.rules.clear();
			for (const f of r.files) {
				const key = `${VERSION}:${f.diff.path}:${hash(JSON.stringify(f.diff.hunks))}`;
				const old = this.files.get(f.diff.path);
				const s: FileState = { path: f.diff.path, diff: f.diff, text: f.text, plus: f.plus, minus: f.minus, key, staged: staged.has(f.diff.path), status: 'pending' };
				if (f.diff.status === 'deleted' || f.diff.binary || f.text === undefined) s.status = 'skipped';
				else if (old?.key === key && old.review) Object.assign(s, { status: old.status, review: old.review });
				else if (saved[key]) Object.assign(s, { status: 'reviewed', review: saved[key] });
				else if (old?.review) {
					// The file changed since its review: keep the comments that can still be found, until the new review is in.
					const moved = old.review.findings.flatMap(x => { const at = relocate(x, f.text!); return at ? [{ ...x, ...at }] : []; });
					s.review = { ...old.review, findings: moved };
				}
				if (f.text !== undefined && s.status !== 'skipped') {
					const added = new Set(addedLines(f.diff));
					this.rules.set(f.diff.path, scanText(f.diff.path, f.text, added).map((h, i) => ({
						id: `${f.diff.path}#r${i + 1}`, file: f.diff.path, startLine: h.line, endLine: h.line, severity: h.severity, kind: 'security' as const,
						title: h.title, why: `${h.why} ${h.fix}`, source: 'rule' as const, anchor: f.text!.split('\n')[h.line - 1]?.trim() ?? '' })));
				}
				next.set(f.diff.path, s);
			}
			this.files = next;
			this.error = undefined;
			if (this.commitMessage && !r.files.length) this.commitMessage = undefined;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
		}
		this.publish();
		void this.drain();
	}

	/** Files the model should review now: what the user asked for, plus what the auto setting covers. */
	private due(): FileState[] {
		const auto = this.auto(), live = this.mode === 'working' || this.mode === 'staged';
		return [...this.files.values()].filter(f => (f.status === 'pending' || f.status === 'queued')
			&& (this.manual.has(f.path) || (live && (auto === 'onSave' || (auto === 'onStage' && (f.staged || this.mode === 'staged'))))));
	}

	/** Review due files one at a time, in the background. A failure (no model, say) stops the queue until asked again. */
	private async drain() {
		if (this.running) return;
		this.running = true;
		let project: { idx: ProjectIndex; texts: Map<string, string> } | undefined;
		try {
			for (let f = this.due()[0]; f; f = this.due()[0]) {
				f.status = 'reviewing';
				this.publish();
				// What the change can break: where the rest of the project calls the functions this file changed.
				project ??= await this.project();
				const sites = callSites(project.idx, project.texts, changedSymbols(indexProject([{ path: f.path, text: f.text! }]), f.path, addedLines(f.diff)), f.path);
				const others = [...this.files.keys()].filter(p => p !== f.path);
				const context = [others.length ? `Other files in this change: ${others.slice(0, 20).join(', ')}` : '',
					sites.length ? `Where the rest of the project calls the functions this change touches (check they still work):\n${sites.map(c => `- ${c.file}:${c.line}${c.in ? ` in ${c.in}()` : ''}: ${c.text}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
				try {
					const review = await this.lm.json<FileReview>(b => buildChangeReviewPrompt(f.diff, f.text!, context, b), d => repairChangeReview(d, f.diff, f.text!));
					if (this.files.get(f.path) !== f) continue; // the file changed meanwhile; its new state is in the queue
					Object.assign(f, { status: 'reviewed', review, error: undefined });
					this.manual.delete(f.path);
					const saved = this.ext.workspaceState.get<Record<string, FileReview>>(REVIEWS_KEY, {});
					const keep = Object.entries({ ...saved, [f.key]: review }).slice(-MAX_SAVED);
					await this.ext.workspaceState.update(REVIEWS_KEY, Object.fromEntries(keep));
				} catch (err) {
					if (isCancel(err)) { f.status = 'pending'; break; }
					f.status = 'failed';
					f.error = err instanceof Error ? err.message : String(err);
					log.warn(`review of ${f.path} failed: ${f.error}`);
					this.manual.clear();
					break;
				} finally {
					this.publish();
				}
			}
			await this.reviewWhole(project);
		} finally {
			this.running = false;
		}
	}

	/** The project's code, for call sites. Read once per round of reviews; ponytail: capped like the other features. */
	private async project(): Promise<{ idx: ProjectIndex; texts: Map<string, string> }> {
		const root = vscode.Uri.file(this.repo!);
		const { files } = await readFiles(root, await sourceFiles(root), 600_000);
		return { idx: indexProject(files), texts: new Map(files.map(f => [f.path, f.text])) };
	}

	/** Once every changed file has its review: one more pass across the whole change, cached by the change itself. */
	private async reviewWhole(project?: { idx: ProjectIndex; texts: Map<string, string> }) {
		const files = [...this.files.values()].filter(f => f.status !== 'skipped');
		if (files.length < 2 || files.some(f => f.status !== 'reviewed')) return;
		const key = `${VERSION}:${hash(files.map(f => f.key).sort().join('|'))}`;
		if (this.overall?.key === key) return;
		const saved = this.ext.workspaceState.get<Record<string, FileReview>>(REVIEWS_KEY, {});
		if (saved[key]) { this.overall = { ...saved[key], key }; return this.publish(); }
		this.overallBusy = true;
		this.publish();
		try {
			project ??= await this.project();
			const names = files.flatMap(f => changedSymbols(indexProject([{ path: f.path, text: f.text! }]), f.path, addedLines(f.diff)));
			const changed = new Set(files.map(f => f.path));
			const sites = callSites(project.idx, project.texts, [...new Set(names)]).filter(c => !changed.has(c.file));
			const reviews = Object.fromEntries(files.map(f => [f.path, { summary: f.review?.summary ?? '', risk: f.review?.risk ?? 'low', titles: (f.review?.findings ?? []).map(x => x.title) }]));
			const intent = this.repo ? await currentBranch(this.repo).catch(() => '') : '';
			const review = await this.lm.json<FileReview>(b => buildChangeOverviewPrompt(files.map(f => f.diff), reviews, sites, intent && !/^(main|master|HEAD)$/.test(intent) ? `branch ${intent}` : '', b),
				d => repairChangeOverview(d, files.map(f => ({ diff: f.diff, text: f.text }))));
			this.overall = { ...review, key };
			await this.ext.workspaceState.update(REVIEWS_KEY, Object.fromEntries(Object.entries({ ...saved, [key]: review }).slice(-MAX_SAVED)));
		} catch (err) {
			if (!isCancel(err)) log.warn(`whole-change review failed: ${err}`);
		} finally {
			this.overallBusy = false;
			this.publish();
		}
	}

	/** Every finding to show: rules and model reviews, minus what the user dismissed, worst first. */
	private findings(): ReviewFinding[] {
		const gone = new Set(this.ext.workspaceState.get<string[]>(DISMISS_KEY, []));
		const all = [...this.files.values()].flatMap(f => {
			const model = f.review?.findings ?? [];
			// A rule hit the model also reported (same line, security) shows once, as the model's richer comment.
			const rules = (this.rules.get(f.path) ?? []).filter(r => !model.some(m => m.kind === 'security' && m.startLine <= r.startLine && r.startLine <= m.endLine));
			return [...model, ...rules];
		}).concat(this.overall && [...this.files.values()].every(f => f.status === 'reviewed' || f.status === 'skipped') ? this.overall.findings : []);
		return all.filter(f => !gone.has(fingerprint(f))).sort((p, q) => SEVERITIES.indexOf(p.severity) - SEVERITIES.indexOf(q.severity) || p.file.localeCompare(q.file) || p.startLine - q.startLine);
	}

	/** Comments on the lines, the Problems panel, the status bar, and the page: all from the same findings. */
	private publish() {
		const list = this.findings(), live = this.mode === 'working' || this.mode === 'staged';
		this.threads.forEach(t => t.dispose());
		this.threads = [];
		this.diagnostics.clear();
		if (this.repo && live) {
			const byFile = new Map<string, vscode.Diagnostic[]>();
			for (const f of list) {
				const uri = vscode.Uri.file(path.join(this.repo, f.file)), range = new vscode.Range(f.startLine - 1, 0, f.endLine - 1, 10_000);
				const d = new vscode.Diagnostic(range, `${f.title}: ${f.why}`, f.severity === 'critical' || f.severity === 'high' ? vscode.DiagnosticSeverity.Error : f.severity === 'medium' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
				d.source = 'coee review';
				(d as vscode.Diagnostic & { findingId?: string }).findingId = f.id;
				byFile.set(f.file, [...byFile.get(f.file) ?? [], d]);
				const body = new vscode.MarkdownString(`**${f.title}**  \n_${f.severity} · ${f.kind}${f.source === 'rule' ? ' · pattern' : ''}_\n\n${f.why}${f.suggestion ? `\n\nSuggested change:\n\`\`\`\n${f.suggestion.code}\n\`\`\`` : ''}`);
				const comment: vscode.Comment & { findingId: string } = { body, mode: vscode.CommentMode.Preview, author: { name: 'coee' }, contextValue: f.suggestion ? 'coee-fix' : 'coee', findingId: f.id };
				const thread = this.comments.createCommentThread(uri, range, [comment]);
				thread.label = `coee · ${f.severity} ${f.kind}`;
				thread.canReply = true;
				thread.contextValue = 'coee';
				thread.collapsibleState = f.severity === 'critical' || f.severity === 'high' ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
				this.threads.push(thread);
			}
			for (const [file, ds] of byFile) this.diagnostics.set(vscode.Uri.file(path.join(this.repo, file)), ds);
		}
		const files = [...this.files.values()];
		const busy = files.filter(f => f.status === 'reviewing' || f.status === 'queued').length;
		const serious = list.filter(f => f.severity === 'critical' || f.severity === 'high').length;
		if (!files.length) this.status.hide();
		else {
			this.status.text = busy ? '$(sync~spin) coee: reviewing…' : list.length ? `$(${serious ? 'error' : 'warning'}) coee: ${list.length} in changes` : '$(pass) coee: changes look fine';
			this.status.tooltip = `coee review of ${files.length} changed file${files.length === 1 ? '' : 's'}. Click to open.`;
			this.status.show();
		}
		this.post();
	}

	private post() {
		if (!this.panel) return;
		const list = this.findings();
		this.panel.webview.postMessage({ type: 'state', state: {
			repo: this.repo && path.basename(this.repo), mode: this.mode, header: this.target?.header, loading: this.loading, error: this.error, auto: this.auto(),
			files: [...this.files.values()].map(f => ({ path: f.path, status: f.status, diffStatus: f.diff.status, plus: f.plus, minus: f.minus, staged: f.staged, summary: f.review?.summary, risk: f.review?.risk, error: f.error,
				count: list.filter(x => x.file === f.path).length })),
			findings: list, commitMessage: this.commitMessage, messageBusy: this.messageBusy, focus: this.focus,
			overall: this.overall && { summary: this.overall.summary, risk: this.overall.risk }, overallBusy: this.overallBusy,
			live: this.mode === 'working' || this.mode === 'staged',
		} });
	}

	private async onMessage(m: { type: string; to?: string; value?: string; path?: string; id?: string; line?: number; text?: string }) {
		switch (m.type) {
			case 'ready': return this.post();
			case 'nav': return vscode.commands.executeCommand('coee.go', m.to, this.repo && vscode.Uri.file(this.repo));
			case 'refresh': return this.refresh();
			case 'mode': {
				if (!this.repo) return;
				const mode = m.value as Mode;
				const t = mode === 'branch' ? await branchVsBase(this.repo) : mode === 'commit' ? await pickCommit(this.repo, 'Which commit?').then(sha => sha ? commit(this.repo!, sha) : undefined) : undefined;
				if ((mode === 'branch' || mode === 'commit') && !t) return this.post();
				this.mode = mode;
				this.target = t;
				this.files.clear();
				this.commitMessage = undefined;
				return this.refresh();
			}
			case 'review': {
				const which = m.path ? [m.path] : [...this.files.values()].filter(f => f.status !== 'skipped' && f.status !== 'reviewed').map(f => f.path);
				for (const p of which) { const f = this.files.get(p); if (f && f.status !== 'skipped') { f.status = 'queued'; this.manual.add(p); } }
				this.publish();
				return this.drain();
			}
			case 'stop': this.lm.cancel(); this.manual.clear(); for (const f of this.files.values()) if (f.status === 'queued') f.status = 'pending'; return this.publish();
			case 'open': return this.repo && m.path ? showLines(vscode.Uri.file(this.repo), m.path, m.line, m.line) : undefined;
			case 'diff': return this.target && m.path ? openDiff(this.target, m.path, this.files.get(m.path)?.diff.oldPath) : undefined;
			case 'apply': return m.id && this.apply(m.id);
			case 'dismiss': return m.id && this.dismiss(m.id, true);
			case 'copy': if (m.text) { await vscode.env.clipboard.writeText(m.text); vscode.window.showInformationMessage('coee: copied.'); } return;
			case 'message': return this.suggestMessage();
			case 'useMessage': return this.target && this.commitMessage ? useCommitMessage(this.target, this.commitMessage) : undefined;
			case 'walk': return this.target && this.walk(this.target);
			case 'settings': return vscode.commands.executeCommand('workbench.action.openSettings', 'coee.changes.autoReview');
		}
	}

	private async suggestMessage() {
		const files = [...this.files.values()].map(f => f.diff);
		if (!files.length) return;
		this.messageBusy = true;
		this.post();
		try {
			this.commitMessage = (await this.lm.ask(b => buildCommitMessagePrompt(files, b))).trim().replace(/^```\w*\n?|```$/g, '').trim();
		} catch (err) {
			if (!isCancel(err)) vscode.window.showWarningMessage(`coee: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.messageBusy = false;
			this.post();
		}
	}

	private finding(id: string) { return this.findings().find(f => f.id === id); }

	private async apply(id: string) {
		const f = this.finding(id);
		if (!f?.suggestion || !this.repo) return;
		await addCode(vscode.Uri.file(this.repo), { file: f.file, mode: 'replace', find: f.suggestion.find, code: f.suggestion.code }, 'the suggested change');
	}

	private async dismiss(id: string, on: boolean) {
		const f = this.finding(id);
		if (!f) return;
		const all = new Set(this.ext.workspaceState.get<string[]>(DISMISS_KEY, []));
		on ? all.add(fingerprint(f)) : all.delete(fingerprint(f));
		await this.ext.workspaceState.update(DISMISS_KEY, [...all].slice(-500));
		this.publish();
	}

	/** A question typed under a comment: answered in the thread, from the finding and the code around it. */
	private async ask(reply: vscode.CommentReply) {
		const first = reply.thread.comments[0] as vscode.Comment & { findingId?: string };
		const f = first?.findingId && this.finding(first.findingId);
		const q = reply.text.trim();
		if (!f || !q || !this.repo) return;
		const add = (body: string, name: string) => { reply.thread.comments = [...reply.thread.comments, { body: new vscode.MarkdownString(body), mode: vscode.CommentMode.Preview, author: { name } }]; };
		add(q, 'You');
		const text = this.files.get(f.file)?.text ?? '';
		const lines = text.split('\n'), a = Math.max(0, f.startLine - 15), b = Math.min(lines.length, f.endLine + 15);
		const code = lines.slice(a, b).map((l, i) => `${String(a + i + 1).padStart(4)} | ${l}`).join('\n');
		add('_Thinking…_', 'coee');
		try {
			const answer = await this.askLm.ask(`A code review comment on ${f.file} lines ${f.startLine}-${f.endLine} says: "${f.title}: ${f.why}"\nThe developer asks: ${q}\nAnswer in under 150 words, plainly, about this code:\n${code}`);
			reply.thread.comments = [...reply.thread.comments.slice(0, -1), { body: new vscode.MarkdownString(answer), mode: vscode.CommentMode.Preview, author: { name: 'coee' } }];
		} catch (err) {
			reply.thread.comments = [...reply.thread.comments.slice(0, -1), { body: new vscode.MarkdownString(`_${err instanceof Error ? err.message : err}_`), mode: vscode.CommentMode.Preview, author: { name: 'coee' } }];
		}
	}

	private async show(id: string) {
		this.focus = id;
		await this.open();
	}

	provideCodeActions(_doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
		return ctx.diagnostics.filter(d => d.source === 'coee review').flatMap(d => {
			const id = (d as vscode.Diagnostic & { findingId?: string }).findingId, f = id && this.finding(id);
			if (!f) return [];
			const out: vscode.CodeAction[] = [];
			if (f.suggestion) {
				const a = new vscode.CodeAction('coee: apply the suggested change…', vscode.CodeActionKind.QuickFix);
				a.command = { command: 'coee.changesApply', title: 'Apply', arguments: [{ findingId: f.id }] };
				a.diagnostics = [d];
				a.isPreferred = true;
				out.push(a);
			}
			const s = new vscode.CodeAction('coee: open this in Changes', vscode.CodeActionKind.QuickFix);
			s.command = { command: 'coee.changesShow', title: 'Show', arguments: [f.id] };
			out.push(s);
			return out;
		});
	}
}

async function gitApi(): Promise<GitApi | undefined> {
	const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
	if (!ext) return undefined;
	try { return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1); } catch { return undefined; }
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
select { width: auto; }
.wrap { flex: 1; overflow: auto; padding: 20px clamp(14px, 4vw, 32px) 60px; }
article { max-width: 920px; margin: 0 auto; display: grid; gap: 18px; align-content: start; }
.verdict { display: grid; gap: 8px; padding: 16px 18px; border-radius: 8px; border: 1px solid var(--line); border-left: 4px solid var(--c); background: var(--vscode-editorWidget-background); }
.verdict h2 { font-size: 1.3em; }
.verdict.ok { --c: var(--vscode-testing-iconPassed, #3fb950); }
.verdict.warn { --c: var(--vscode-editorWarning-foreground, #cca700); }
.verdict.bad { --c: var(--vscode-errorForeground, #f14c4c); }
.verdict.busy { --c: var(--link); }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.note { font-size: .88em; color: var(--muted); line-height: 1.5; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; display: inline-flex; gap: 6px; align-items: center; font-size: .9em; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--c); flex: none; }
.critical { --c: var(--vscode-errorForeground, #f14c4c); }
.high { --c: #d18616; }
.medium { --c: var(--vscode-editorWarning-foreground, #cca700); }
.low { --c: var(--muted); }
.msg { display: grid; gap: 8px; }
.msg pre { margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; white-space: pre-wrap; font-family: var(--mono); font-size: .92em; }
.files { display: grid; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.file { border-top: 1px solid var(--line); }
.file:first-child { border-top: 0; }
.fhead { display: flex; gap: 10px; align-items: center; padding: 8px 12px; flex-wrap: wrap; }
.fhead .name { font-family: var(--mono); font-weight: 600; flex: 1; min-width: 10em; overflow-wrap: anywhere; text-align: left; }
.badge { font-family: var(--mono); font-size: .8em; padding: 0 6px; border-radius: 3px; border: 1px solid var(--line); color: var(--muted); }
.stat { font-family: var(--mono); font-size: .85em; color: var(--muted); }
.state { font-size: .85em; color: var(--muted); white-space: nowrap; }
.state.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.state.bad { color: var(--vscode-errorForeground); }
.fsum { padding: 0 12px 8px; font-size: .9em; color: var(--muted); }
.finds { display: grid; gap: 10px; padding: 0 12px 12px; }
.finding { display: grid; gap: 6px; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--line); border-left: 4px solid var(--c); background: var(--vscode-editorWidget-background); scroll-margin: 20px; }
.finding.focus { outline: 2px solid var(--vscode-focusBorder); }
.finding h3 { font-size: 1em; }
.meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: .8em; color: var(--muted); }
.sev { text-transform: uppercase; letter-spacing: .08em; font-weight: 700; color: var(--c); }
.finding pre { margin: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 5px; overflow: auto; max-height: 240px; font-family: var(--mono); font-size: .9em; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.lede { line-height: 1.6; }
.across { display: grid; gap: 10px; }
.across h3 { font-size: 1.05em; }
.empty { padding: 24px; border: 1px dashed var(--line); border-radius: 8px; line-height: 1.6; }
.sweep { width: 80px; }
`;

export const SCRIPT = String.raw`
const root = document.getElementById('root');
const send = (type, extra) => vscode.postMessage({ type, ...extra });
let st = {}, open = new Set(), focused = '';
const STATE = { pending: ['○ not reviewed', ''], queued: ['… waiting', ''], reviewing: ['… reviewing', ''], reviewed: ['✓ reviewed', 'ok'], failed: ['✕ failed', 'bad'], skipped: ['– not reviewed (deleted or binary)', ''] };
const LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

function verdict() {
  const fs = st.findings || [], files = st.files || [];
  const serious = fs.filter(f => f.severity === 'critical' || f.severity === 'high').length;
  const busy = files.filter(f => f.status === 'reviewing' || f.status === 'queued').length;
  const unreviewed = files.filter(f => f.status === 'pending' || f.status === 'failed').length;
  const failed = files.find(f => f.status === 'failed');
  const cls = busy ? 'busy' : serious ? 'bad' : fs.length ? 'warn' : 'ok';
  const title = busy ? 'Reviewing ' + busy + ' file' + (busy === 1 ? '' : 's') + '…'
    : serious ? serious + ' thing' + (serious === 1 ? '' : 's') + ' to fix before you commit'
    : fs.length ? fs.length + ' thing' + (fs.length === 1 ? '' : 's') + ' worth a look' : unreviewed ? 'No problems found yet' : 'Looks ready to commit';
  const count = s => fs.filter(f => f.severity === s).length;
  const auto = { onSave: 'Each file is reviewed when you save it.', onStage: 'Files are reviewed when you stage them; fast checks run on every save.', off: 'Automatic review is off; fast checks still run on every save.' }[st.auto];
  return el('section', { className: 'verdict ' + cls },
    el('h2', {}, title),
    st.overall && st.overall.summary ? el('p', { className: 'lede' }, st.overall.summary) : null,
    st.overallBusy ? el('p', { className: 'note' }, 'Reading the whole change across files…') : null,
    fs.length ? el('div', { className: 'chips' }, ...['critical', 'high', 'medium', 'low'].filter(count).map(s => el('span', { className: 'chip ' + s }, el('span', { className: 'dot' }), count(s) + ' ' + s))) : null,
    failed ? el('p', { className: 'error' }, 'The review of ' + failed.path + ' failed: ' + failed.error) : null,
    el('div', { className: 'row' },
      unreviewed ? el('button', { className: 'btn', onclick: () => send('review') }, 'Review ' + unreviewed + ' file' + (unreviewed === 1 ? '' : 's') + ' now') : null,
      busy ? el('button', { className: 'btn quiet', onclick: () => send('stop') }, 'Stop') : null,
      files.length ? el('button', { className: 'btn quiet', title: 'A step-by-step walkthrough of this change beside the code', onclick: () => send('walk') }, 'Walk me through it') : null,
      st.live && files.length ? el('button', { className: 'btn quiet', disabled: st.messageBusy, onclick: () => send('message') }, st.messageBusy ? 'Writing a message…' : 'Suggest a commit message') : null),
    st.live ? el('p', { className: 'note' }, auto + ' ', el('button', { className: 'link', onclick: () => send('settings') }, 'Change')) : null,
    st.commitMessage ? el('div', { className: 'msg' }, el('pre', {}, st.commitMessage), el('div', { className: 'row' },
      el('button', { className: 'btn', onclick: () => send('useMessage') }, 'Use message'), el('button', { className: 'btn quiet', onclick: () => send('copy', { text: st.commitMessage }) }, 'Copy'))) : null);
}

function finding(f) {
  return el('div', { className: 'finding ' + f.severity + (focused === f.id ? ' focus' : ''), id: 'x-' + f.id },
    el('div', { className: 'meta' }, el('span', { className: 'sev' }, f.severity), el('span', {}, f.kind + (f.source === 'rule' ? ' · pattern' : '')),
      el('button', { className: 'link', onclick: () => send('open', { path: f.file, line: f.startLine }) }, 'line ' + f.startLine)),
    el('h3', {}, f.title),
    md(f.why),
    f.suggestion ? el('pre', {}, f.suggestion.code) : null,
    el('div', { className: 'actions' },
      f.suggestion && st.live ? el('button', { className: 'btn', title: 'Shows the change first; Undo takes it back', onclick: () => send('apply', { id: f.id }) }, 'Apply…') : null,
      f.suggestion ? el('button', { className: 'btn quiet', onclick: () => send('copy', { text: f.suggestion.code }) }, 'Copy') : null,
      el('button', { className: 'btn quiet', title: 'Not a problem; coee will remember', onclick: () => send('dismiss', { id: f.id }) }, 'Dismiss')));
}

function file(f) {
  const mine = (st.findings || []).filter(x => x.file === f.path);
  const isOpen = open.has(f.path) || mine.some(x => x.id === st.focus);
  const [label, cls] = STATE[f.status] || ['', ''];
  return el('div', { className: 'file' },
    el('div', { className: 'fhead' },
      el('span', { className: 'badge', title: f.diffStatus }, LETTER[f.diffStatus] || 'M'),
      el('button', { className: 'link name', title: 'Show the findings', onclick: () => { isOpen ? open.delete(f.path) : open.add(f.path); render(); } }, f.path),
      el('span', { className: 'stat' }, '+' + f.plus + ' −' + f.minus),
      f.staged && st.mode === 'working' ? el('span', { className: 'badge', title: 'Staged for the next commit' }, 'staged') : null,
      mine.length ? el('span', { className: 'state bad' }, '● ' + mine.length) : el('span', { className: 'state ' + cls }, label),
      el('button', { className: 'tool', title: 'Open the diff', onclick: () => send('diff', { path: f.path }) }, 'Diff'),
      f.status === 'pending' || f.status === 'failed' ? el('button', { className: 'tool', onclick: () => send('review', { path: f.path }) }, 'Review') : null),
    isOpen && f.summary ? el('p', { className: 'fsum' }, f.summary + (f.risk ? ' · risk: ' + f.risk : '')) : null,
    isOpen && mine.length ? el('div', { className: 'finds' }, ...mine.map(finding)) : null);
}

function render() {
  const bar = el('div', { className: 'bar' }, coeeNav('changes'), el('h1', {}, 'Changes' + (st.repo ? ' · ' + st.repo : '')),
    el('select', { 'aria-label': 'Compare', onchange: e => send('mode', { value: e.target.value }) },
      ...[['working', 'All uncommitted'], ['staged', 'Staged only'], ['branch', 'This branch vs main'], ['commit', 'A commit…']].map(([v, l]) => el('option', { value: v, selected: st.mode === v || null }, l))),
    el('button', { className: 'tool', title: 'Read the changes again', onclick: () => send('refresh') }, '↻'));
  const files = st.files || [];
  const body = st.error ? [el('p', { className: 'error' }, st.error), el('div', {}, el('button', { className: 'btn', onclick: () => send('refresh') }, 'Try again'))]
    : !files.length ? [st.loading ? el('div', { className: 'sweep', 'aria-hidden': 'true' }) : el('div', { className: 'empty' }, st.mode === 'working'
      ? 'No uncommitted changes. coee watches this repository: edit and save a file, and the review appears here, on the lines in the editor, and in the Problems panel.'
      : 'Nothing to show for this comparison.')]
    : [verdict(),
      (st.findings || []).some(f => f.id.startsWith('overall#')) ? el('section', { className: 'across' }, el('h3', {}, 'Across the change'),
        el('p', { className: 'note' }, 'What only shows when the files are read together: callers not updated, contracts changed on one side, missing tests.'),
        ...(st.findings || []).filter(f => f.id.startsWith('overall#')).map(f => el('div', {}, el('div', { className: 'note mono' }, f.file), finding(f)))) : null,
      el('div', { className: 'files' }, ...files.map(file)),
      !st.live ? el('p', { className: 'note' }, 'Comments on the lines and the Problems panel are shown for uncommitted and staged changes, where the files match the editor.') : null];
  root.replaceChildren(bar, el('div', { className: 'wrap' }, el('article', {}, ...body)));
  if (st.focus && st.focus !== focused) { focused = st.focus; const n = document.getElementById('x-' + focused); if (n) { n.classList.add('focus'); n.scrollIntoView({ block: 'center' }); } }
}

window.addEventListener('message', ({ data: m }) => { if (m.type === 'state') { st = m.state; render(); } });
send('ready');
`;
