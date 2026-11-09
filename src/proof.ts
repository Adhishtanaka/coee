// Security, made concrete: the path an attack takes through the code (where input enters, the calls it passes through,
// the line that does the damage, and the best place for the fix), and how to run a proof test with the project's own
// test runner. Pure, so the harness checks traces on the fixtures and the commands chosen.
import { ProjectIndex } from './codeindex';

export interface TraceStep { file: string; line: number; endLine: number; label: string; role: 'source' | 'hop' | 'sink'; fixHere?: boolean }

/**
 * From the dangerous line back to where input enters: the function around the sink, then whoever calls it, up to a
 * route or entry point (at most 5 hops). Returned source first. The fix goes at the first function the input reaches
 * (validate early), or at the sink when the input arrives there directly.
 */
export function traceAttack(idx: ProjectIndex, file: string, line: number, texts?: ReadonlyMap<string, string>): TraceStep[] {
	const around = (f: string, l: number) => idx.files.get(f)?.symbols.filter(s => s.kind !== 'class' && s.line <= l && l <= s.end).sort((a, b) => (a.end - a.line) - (b.end - b.line))[0];
	const steps: TraceStep[] = [{ file, line, endLine: line, label: 'The dangerous line: the input is used here', role: 'sink' }];
	const seen = new Set<string>();
	let cur = around(file, line), curFile = file;
	for (let hop = 0; cur && hop < 5; hop++) {
		const key = `${curFile}:${cur.name}`;
		if (seen.has(key)) break;
		seen.add(key);
		const route = idx.files.get(curFile)?.routes.find(r => r.line >= cur!.line - 1 && r.line <= cur!.end);
		if (route) { steps.push({ file: curFile, line: route.line, endLine: route.line, label: `Input enters: ${route.method} ${route.path}`, role: 'source' }); break; }
		// Who calls this function: the first caller found in the project, at the line of the call.
		const callerName = idx.callers.get(cur.name)?.[0];
		const callerFile = callerName && [...idx.files.values()].find(f => f.symbols.some(s => s.name === callerName) && f.calls[callerName]?.includes(cur!.name))?.path;
		if (!callerName || !callerFile) {
			// Called from an inline route handler (`router.post('/x', (req, res) => …)`), which isn't a named function.
			const fromRoute = texts && [...idx.files.values()].flatMap(f => f.routes.map(r => ({ f: f.path, r }))).find(({ f, r }) => {
				const lines = texts.get(f)?.split('\n') ?? [];
				return lines.slice(r.line - 1, r.line + 25).some(l => l.includes(`${cur!.name}(`));
			});
			if (fromRoute) {
				steps.push({ file: curFile, line: cur.line, endLine: cur.line, label: `${cur.name}() receives it`, role: 'hop' });
				steps.push({ file: fromRoute.f, line: fromRoute.r.line, endLine: fromRoute.r.line, label: `Input enters: ${fromRoute.r.method} ${fromRoute.r.path}`, role: 'source' });
			} else steps.push({ file: curFile, line: cur.line, endLine: cur.line, label: `Input enters: the parameters of ${cur.name}()`, role: 'source' });
			break;
		}
		const caller = idx.files.get(callerFile)!.symbols.find(s => s.name === callerName)!;
		steps.push({ file: curFile, line: cur.line, endLine: cur.line, label: `${cur.name}() receives it`, role: 'hop' });
		cur = caller;
		curFile = callerFile;
	}
	steps.reverse();
	// Fix at the first place the input reaches in our own code that isn't just a route line; else at the sink.
	const target = steps.find(s => s.role === 'hop') ?? steps.find(s => s.role === 'source' && s.label.includes('parameters')) ?? steps[steps.length - 1];
	target.fixHere = true;
	return steps;
}

export interface ProofRun { command: string; args: string[]; framework: string }

/**
 * How to run one test file with the project's own runner. `manifest` is package.json's text (or undefined),
 * `pythonish`/`goish` say what the project is. Undefined when coee can't tell.
 */
export function proofCommand(testFile: string, manifest: string | undefined, has: (p: string) => boolean): ProofRun | undefined {
	if (/\.py$/.test(testFile)) return { command: 'python', args: ['-m', 'pytest', '-q', testFile], framework: 'pytest' };
	if (/_test\.go$/.test(testFile)) return { command: 'go', args: ['test', `./${testFile.includes('/') ? testFile.slice(0, testFile.lastIndexOf('/')) : '.'}`], framework: 'go test' };
	if (!/\.[cm]?[jt]sx?$/.test(testFile)) return undefined;
	let deps: Record<string, string> = {};
	try { const j = JSON.parse(manifest ?? '{}'); deps = { ...j.dependencies, ...j.devDependencies }; } catch { /* no manifest */ }
	if (deps.vitest) return { command: 'npx', args: ['vitest', 'run', testFile], framework: 'vitest' };
	if (deps.jest || has('jest.config.js') || has('jest.config.ts')) return { command: 'npx', args: ['jest', testFile], framework: 'jest' };
	if (deps.mocha) return { command: 'npx', args: ['mocha', testFile], framework: 'mocha' };
	if (/\.tsx?$/.test(testFile)) return { command: 'npx', args: ['tsx', '--test', testFile], framework: 'node:test (tsx)' };
	return { command: 'node', args: ['--test', testFile], framework: 'node:test' };
}

/** Where a proof test for `file` goes: beside it, named so it's clearly coee's and easy to delete. */
export function proofPath(file: string, id: string): string {
	const dot = file.lastIndexOf('.'), base = dot > file.lastIndexOf('/') ? file.slice(0, dot) : file, ext = dot > file.lastIndexOf('/') ? file.slice(dot) : '.js';
	if (ext === '.py') { const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''; return `${dir}test_coee_proof_${id}.py`; }
	if (ext === '.go') return `${base}_coee_proof_${id}_test.go`;
	return `${base}.coee-proof-${id}.test${ext}`;
}
