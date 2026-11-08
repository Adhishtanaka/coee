import * as vscode from 'vscode';
import * as path from 'path';
import { Snippet, applyPlacement, placeSnippet } from './prompt';
import { codeColumn } from './ui';

/** The file as the editor has it (unsaved edits included), or undefined if it doesn't exist. */
export async function fileText(uri: vscode.Uri): Promise<string | undefined> {
	const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
	if (open) return open.getText();
	try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
}

const previews = new Map<string, string>();
/** Read-only "after" documents for the before/after diff. Register once. */
export function registerPreviews(): vscode.Disposable {
	return vscode.workspace.registerTextDocumentContentProvider('coee-preview', { provideTextDocumentContent: u => previews.get(u.toString()) ?? '' });
}
function previewUri(file: string, text: string) {
	const uri = vscode.Uri.from({ scheme: 'coee-preview', path: '/' + file, query: String(Date.now()) });
	previews.set(uri.toString(), text);
	return uri;
}
async function closePreviews() {
	const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'coee-preview');
	await vscode.window.tabGroups.close(tabs, true);
	previews.clear();
}

/**
 * The one way coee changes a file: show the file before and after side by side, apply only on the user's say-so,
 * then check the code landed where it should and whether the file got new errors. Undo takes it back.
 * Returns whether it was added.
 */
export async function addCode(root: vscode.Uri, sn: Snippet, label = "the suggested code"): Promise<boolean> {
	const uri = vscode.Uri.joinPath(root, sn.file);
	// Whatever the model wrote, coee only ever writes inside the project.
	const rel = path.relative(root.fsPath, uri.fsPath);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { vscode.window.showWarningMessage(`coee: ${sn.file} is outside this project, so coee won't write it.`); return false; }
	const before = await fileText(uri);
	const p = placeSnippet(before, sn);
	if (p.status === 'added') { vscode.window.showInformationMessage(`coee: this code is already in ${sn.file}.`); return false; }
	if (p.status === 'error') { vscode.window.showWarningMessage(`coee: ${p.reason} Copy the code and place it yourself.`); return false; }
	const after = applyPlacement(before ?? '', p);
	const line = (before ?? '').slice(0, p.from).split('\n').length;
	await vscode.commands.executeCommand('vscode.diff', before === undefined ? previewUri(sn.file + ' (new)', '') : uri, previewUri(sn.file, after),
		`${path.basename(sn.file)}: before ↔ with ${label}`, { viewColumn: codeColumn(), preview: true });
	const where = before === undefined ? 'as a new file' : sn.mode === 'replace' ? `in place of the code at line ${line}` : `after line ${line - 1}`;
	const ok = await vscode.window.showInformationMessage(`Add ${label} to ${sn.file}, ${where}? The diff shows the result.`, 'Add', 'Cancel');
	await closePreviews();
	if (ok !== 'Add') return false;
	// The file may have changed while the preview was open: place it again against what's there now.
	const now = await fileText(uri);
	const q = now === before ? p : placeSnippet(now, sn);
	if (q.status !== 'ready') { vscode.window.showWarningMessage(`coee: ${q.status === 'added' ? `the code is already in ${sn.file}.` : q.reason}`); return false; }
	const problems = () => vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
	const errorsBefore = problems();
	const edit = new vscode.WorkspaceEdit();
	let doc: vscode.TextDocument;
	if (now === undefined) {
		edit.createFile(uri, { contents: new TextEncoder().encode(q.text) });
		if (!await vscode.workspace.applyEdit(edit)) { vscode.window.showErrorMessage(`coee: couldn't create ${sn.file}.`); return false; }
		doc = await vscode.workspace.openTextDocument(uri);
	} else {
		doc = await vscode.workspace.openTextDocument(uri);
		edit.replace(uri, new vscode.Range(doc.positionAt(q.from), doc.positionAt(q.to)), q.text);
		if (!await vscode.workspace.applyEdit(edit)) { vscode.window.showErrorMessage(`coee: couldn't change ${sn.file}.`); return false; }
	}
	// Check it landed: the code must now be found in the file, in one piece.
	const landed = placeSnippet(doc.getText(), sn).status === 'added';
	const start = doc.positionAt(q.from + (q.text.startsWith('\n') ? 1 : 0)), end = doc.positionAt(q.from + q.text.length);
	await vscode.window.showTextDocument(doc, { viewColumn: codeColumn(), preserveFocus: false, selection: new vscode.Range(start, end) });
	const undo = async () => { await vscode.window.showTextDocument(doc, { viewColumn: codeColumn(), preserveFocus: false }); await vscode.commands.executeCommand('undo'); };
	if (!landed) {
		void vscode.window.showWarningMessage(`coee: the code was added to ${sn.file}, but coee couldn't find it there afterwards. Check the file; Undo takes it back.`, 'Undo').then(u => u && undo());
		return true;
	}
	// Give the language server a moment, then say whether the file got new errors.
	void new Promise(r => setTimeout(r, 1500)).then(async () => {
		const added = problems() - errorsBefore;
		const msg = `coee: added to ${sn.file} at line ${start.line + 1}. ${added > 0 ? `The file now has ${added} new error${added === 1 ? '' : 's'}: look at the Problems panel, or Undo.` : 'No new errors.'}`;
		const pick = await (added > 0 ? vscode.window.showWarningMessage(msg, 'Undo') : vscode.window.showInformationMessage(msg, ...(now === undefined ? [] : ['Undo'])));
		if (pick === 'Undo') await undo();
	});
	return true;
}

/** A finding's fix as a snippet: its code replaces exactly the lines the finding points at (found by their text, not their numbers). */
export async function fixSnippet(root: vscode.Uri, f: { file: string; startLine: number; endLine: number; fixCode?: string }): Promise<Snippet | undefined> {
	if (!f.fixCode) return undefined;
	const text = await fileText(vscode.Uri.joinPath(root, f.file));
	if (text === undefined) return undefined;
	const find = text.split('\n').slice(f.startLine - 1, f.endLine).join('\n');
	return find.trim() ? { file: f.file, mode: 'replace', find, code: f.fixCode } : undefined;
}
