import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { FileDiff, addedLines, diffStats, parseUnifiedDiff, removedRuns } from './prompt';
import { codeColumn } from './ui';

/** git's empty tree: the "before" of a repository's first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 40;
/** Lockfiles, build output and minified files: noise in a review. */
const NOISE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|out|node_modules|vendor|coverage|\.next)\//;

/** Run a program without a shell (arguments are passed as-is, so branch names can't inject anything). */
function run(cwd: string, cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) =>
		err ? reject(new Error((errOut || err.message).trim().split('\n')[0])) : resolve(out)));
}
/**
 * git, with the repository's own config kept from running programs: a repo's .git/config can name an fsmonitor,
 * hooks or diff drivers that git would execute. And only in a workspace the user trusts.
 */
const git = (cwd: string, ...args: string[]) => {
	if (!vscode.workspace.isTrusted) return Promise.reject(new Error('coee only runs git in a trusted workspace. Trust this folder (Manage Workspace Trust) to review its changes.'));
	return run(cwd, 'git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args]);
};
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

/** The "head" side of a review: a commit, the staging area, or the files on disk. */
export type Side = string | 'INDEX' | 'WORKTREE';

export interface ReviewTarget {
	repo: string;
	base: string;
	head: Side;
	/** For the prompt: "staged changes", "commit a1b2c3d", "PR #42: Add caching". */
	what: string;
	/** For the header: "a1b2c3d · Fix the login redirect". */
	header: string;
	precommit?: boolean;
	message?: string;
	note?: string;
	/** Working-tree targets: include new files git doesn't track yet. */
	untracked?: boolean;
}

export interface ReviewFile { diff: FileDiff; text?: string; added: number[]; removed: Array<{ after: number; lines: string[] }>; plus: number; minus: number }
export interface Review { files: ReviewFile[]; skipped: number; plus: number; minus: number; key: string }

export async function repoRoot(dir: vscode.Uri): Promise<string> {
	try {
		return (await git(dir.fsPath, 'rev-parse', '--show-toplevel')).trim();
	} catch {
		throw new Error(`${path.basename(dir.fsPath)} isn't a git repository, so there are no commits or changes to review.`);
	}
}

const hasHead = (repo: string) => ok(git(repo, 'rev-parse', '--verify', '-q', 'HEAD'));
const short = (sha: string) => sha.slice(0, 7);

/** Everything not yet committed: staged and unstaged edits, and new files git doesn't track yet. */
export async function working(repo: string): Promise<ReviewTarget> {
	const base = await hasHead(repo) ? 'HEAD' : EMPTY_TREE;
	return { repo, base, head: 'WORKTREE', what: 'uncommitted changes', header: 'Uncommitted changes', precommit: true, untracked: true };
}

/** Only what is staged: the next commit. */
export async function stagedOnly(repo: string): Promise<ReviewTarget> {
	return { repo, base: await hasHead(repo) ? 'HEAD' : EMPTY_TREE, head: 'INDEX', what: 'staged changes (what the next commit will contain)', header: 'Staged changes', precommit: true };
}

async function staged(repo: string): Promise<ReviewTarget> {
	const base = await hasHead(repo) ? 'HEAD' : EMPTY_TREE;
	const any = !(await ok(git(repo, 'diff', '--cached', '--quiet', base)));
	if (any) return { repo, base, head: 'INDEX', what: 'staged changes (what the next commit will contain)', header: 'Staged changes · before you commit', precommit: true };
	return { repo, base, head: 'WORKTREE', what: 'uncommitted changes', header: 'Uncommitted changes · before you commit', precommit: true,
		note: 'Nothing is staged, so this covers all uncommitted changes. New files you haven\'t added with git add aren\'t included.' };
}

export async function commit(repo: string, sha: string): Promise<ReviewTarget> {
	const [subject, body] = (await git(repo, 'log', '-1', '--format=%s%x00%b', sha)).split('\0');
	const parent = await ok(git(repo, 'rev-parse', '--verify', '-q', `${sha}^`)) ? `${sha}^` : EMPTY_TREE;
	return { repo, base: parent, head: sha, what: `commit ${short(sha)}`, header: `${short(sha)} · ${subject.trim()}`, message: `${subject}\n\n${body ?? ''}`.trim() };
}

export async function pickCommit(repo: string, placeHolder: string): Promise<string | undefined> {
	const log = await git(repo, 'log', '-50', '--format=%H%x09%s%x09%an%x09%ar');
	const items = log.trim().split('\n').filter(Boolean).map(l => { const [sha, s, who, when] = l.split('\t'); return { label: s, description: `${short(sha)} · ${who} · ${when}`, sha }; });
	return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.sha;
}

async function pickRef(repo: string, placeHolder: string): Promise<string | undefined> {
	const refs = (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags')).trim().split('\n').filter(r => r && !r.endsWith('/HEAD'));
	const log = (await git(repo, 'log', '-50', '--format=%H%x09%s%x09%ar')).trim().split('\n').filter(Boolean);
	const items: Array<vscode.QuickPickItem & { ref?: string }> = [
		{ label: 'Branches and tags', kind: vscode.QuickPickItemKind.Separator }, ...refs.map(r => ({ label: `$(git-branch) ${r}`, ref: r })),
		{ label: 'Recent commits', kind: vscode.QuickPickItemKind.Separator }, ...log.map(l => { const [sha, s, when] = l.split('\t'); return { label: s, description: `${short(sha)} · ${when}`, ref: sha }; }),
	];
	return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.ref;
}

async function defaultBase(repo: string): Promise<string | undefined> {
	const remote = await git(repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD').then(s => s.trim(), () => '');
	for (const ref of [remote, 'origin/main', 'main', 'origin/master', 'master'].filter(Boolean)) if (await ok(git(repo, 'rev-parse', '--verify', '-q', ref))) return ref;
	return undefined;
}

export async function branchVsBase(repo: string): Promise<ReviewTarget | undefined> {
	const base = await defaultBase(repo);
	if (!base) { vscode.window.showWarningMessage('coee: couldn\'t find main or master to compare with. Use "Pick two commits or branches…".'); return undefined; }
	const branch = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
	const fork = (await git(repo, 'merge-base', base, 'HEAD')).trim();
	const subjects = (await git(repo, 'log', '--format=- %s', `${fork}..HEAD`)).trim();
	if (!subjects) { vscode.window.showInformationMessage(`coee: ${branch} has no commits that ${base} doesn't have.`); return undefined; }
	return { repo, base: fork, head: 'HEAD', what: `the branch ${branch} compared with ${base}`, header: `${base} … ${branch}`, message: `Commits on this branch:\n${subjects}` };
}

/** Ask what to review. `preset` skips the picker for the Source Control buttons. */
export async function pickReview(repo: string, preset?: 'staged' | 'commit'): Promise<ReviewTarget | undefined> {
	if (preset === 'staged') return staged(repo);
	if (preset === 'commit') { const sha = await pickCommit(repo, 'Which commit should coee explain?'); return sha ? commit(repo, sha) : undefined; }
	const choice = await vscode.window.showQuickPick([
		{ label: '$(checklist) Before you commit', description: 'what your staged (or uncommitted) changes do', id: 'staged' },
		{ label: '$(git-commit) A commit…', description: 'what any commit did', id: 'commit' },
		{ label: '$(history) The last commit', description: 'HEAD', id: 'last' },
		{ label: '$(git-branch) This branch vs main', description: 'everything your branch adds, like a PR', id: 'branch' },
		{ label: '$(git-compare) Two commits or branches…', description: 'any range', id: 'range' },
	], { placeHolder: 'What should coee review?' });
	switch (choice?.id) {
		case 'staged': return staged(repo);
		case 'commit': { const sha = await pickCommit(repo, 'Which commit?'); return sha ? commit(repo, sha) : undefined; }
		case 'last': return commit(repo, (await git(repo, 'rev-parse', 'HEAD')).trim());
		case 'branch': return branchVsBase(repo);
		case 'range': {
			const base = await pickRef(repo, 'Compare from (older)…');
			const head = base && await pickRef(repo, `…to (newer), compared with ${base}`);
			return base && head ? { repo, base, head, what: `the changes from ${base} to ${head}`, header: `${short(base)} … ${short(head)}` } : undefined;
		}
	}
	return undefined;
}

/** The diff of a target, its files ranked by size (noise skipped), and each file's new text. */
export async function collect(t: ReviewTarget, allowEmpty = false): Promise<Review> {
	const args = ['diff', '--find-renames', '-U3', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
	let raw = await git(t.repo, ...(t.head === 'INDEX' ? [...args, '--cached', t.base] : t.head === 'WORKTREE' ? [...args, t.base] : [...args, t.base, t.head]));
	if (t.untracked) raw += await untrackedDiff(t.repo);
	const all = parseUnifiedDiff(raw);
	const kept = all.filter(f => !NOISE.test(f.path)).map(diff => ({ diff, ...diffStats(diff) })).sort((a, b) => (b.plus + b.minus) - (a.plus + a.minus));
	const files: ReviewFile[] = [];
	for (const k of kept.slice(0, MAX_FILES)) {
		const p = k.diff.path;
		let text: string | undefined;
		if (k.diff.status !== 'deleted' && !k.diff.binary) {
			text = await Promise.resolve(t.head === 'WORKTREE'
				? vscode.workspace.fs.readFile(vscode.Uri.file(path.join(t.repo, p))).then(b => new TextDecoder().decode(b))
				: git(t.repo, 'show', `${t.head === 'INDEX' ? '' : t.head}:${p}`)).catch(() => undefined);
		}
		files.push({ diff: k.diff, text, added: addedLines(k.diff), removed: removedRuns(k.diff), plus: k.plus, minus: k.minus });
	}
	if (!files.length && !allowEmpty) throw new Error(all.length ? 'Only lockfiles or generated files changed here, so there is nothing to explain.' : 'There are no changes to review here.');
	const plus = files.reduce((n, f) => n + f.plus, 0), minus = files.reduce((n, f) => n + f.minus, 0);
	const head = t.head === 'INDEX' || t.head === 'WORKTREE' ? raw : (await git(t.repo, 'rev-parse', t.head)).trim();
	return { files, skipped: Math.max(0, all.length - files.length), plus, minus, key: `${t.base}..${head}:${raw.length}:${hash(raw)}` };
}

/** Every file git knows here (tracked, plus new files not ignored), relative to `dir`. Fast, and respects .gitignore. */
export async function lsFiles(dir: string): Promise<string[]> {
	return (await git(dir, 'ls-files', '-co', '--exclude-standard', '-z')).split('\0').filter(Boolean);
}

/** New files git doesn't track yet, as "added" diffs (git diff leaves them out). */
async function untrackedDiff(repo: string): Promise<string> {
	const list = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(p => p && !NOISE.test(p)).slice(0, MAX_FILES);
	let out = '';
	for (const p of list) {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(repo, p))).then(b => b, () => undefined);
		if (!bytes || bytes.length > 200_000 || bytes.includes(0)) continue; // missing, big or binary
		const lines = new TextDecoder().decode(bytes).replace(/\n$/, '').split('\n');
		out += `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => '+' + l).join('\n')}\n`;
	}
	return out;
}

export function hash(s: string) {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// The built-in git extension: diffs in the editor and the commit message box

interface GitApi {
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
	repositories: Array<{ rootUri: vscode.Uri; inputBox: { value: string } }>;
}

function gitApi(): GitApi | undefined {
	try { return vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1); } catch { return undefined; }
}

/** Show one file's change as VS Code's own diff. */
export async function openDiff(t: ReviewTarget, file: string, oldPath?: string) {
	const api = gitApi(), right = vscode.Uri.file(path.join(t.repo, file)), left = vscode.Uri.file(path.join(t.repo, oldPath ?? file));
	if (!api) return vscode.window.showTextDocument(right, { viewColumn: codeColumn() });
	const ref = (side: Side) => side === 'WORKTREE' ? undefined : side === 'INDEX' ? '' : side; // '' is the index for the git extension
	const r = ref(t.head);
	await vscode.commands.executeCommand('vscode.diff', api.toGitUri(left, t.base === EMPTY_TREE ? 'HEAD' : t.base), r === undefined ? right : api.toGitUri(right, r), `${file} · ${t.header}`, { viewColumn: codeColumn() });
}

/** Put a message in the Source Control box. Nothing is committed. */
export function useCommitMessage(t: ReviewTarget, message: string) {
	const repo = gitApi()?.repositories.find(r => path.resolve(r.rootUri.fsPath) === path.resolve(t.repo));
	if (!repo) return vscode.env.clipboard.writeText(message).then(() => vscode.window.showInformationMessage('coee: commit message copied to the clipboard.'));
	repo.inputBox.value = message;
	return vscode.commands.executeCommand('workbench.view.scm');
}
