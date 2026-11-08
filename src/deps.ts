// Known vulnerabilities in dependencies. npm audit / pip-audit when installed, otherwise OSV.dev
// (only package names and versions are sent, never code). The parsers are pure and unit-tested.
import { execFile } from 'child_process';
import type { Severity } from './rules';

export interface Pkg { name: string; version: string; ecosystem: 'npm' | 'PyPI'; /** the manifest it came from, relative to the project */ file: string }
export interface DepIssue { name: string; version: string; file: string; id: string; title: string; severity: Severity; fixed?: string; url?: string }

const SEV: Record<string, Severity> = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low', info: 'low' };

/** `npm audit --json` (npm 7+): one issue per vulnerable package, with its advisories' titles. */
export function parseNpmAudit(json: string, file = 'package-lock.json'): DepIssue[] {
	const data = JSON.parse(json) as { vulnerabilities?: Record<string, { name: string; severity: string; range?: string; via: Array<string | { title?: string; url?: string; source?: number; range?: string }>; fixAvailable?: boolean | { name: string; version: string } }> };
	return Object.values(data.vulnerabilities ?? {}).flatMap(v => {
		const advisories = v.via.filter((x): x is { title?: string; url?: string; source?: number } => typeof x === 'object');
		if (!advisories.length) return []; // only vulnerable through another package: that one is reported
		const fix = typeof v.fixAvailable === 'object' ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : undefined;
		return advisories.map(a => ({ name: v.name, version: v.range ?? '', file, id: a.url?.split('/').pop() ?? String(a.source ?? v.name), title: a.title ?? 'Known vulnerability',
			severity: SEV[v.severity] ?? 'medium', fixed: fix, url: a.url }));
	});
}

/** `pip-audit -f json`. */
export function parsePipAudit(json: string, file = 'requirements.txt'): DepIssue[] {
	const data = JSON.parse(json) as { dependencies?: Array<{ name: string; version: string; vulns?: Array<{ id: string; fix_versions?: string[]; description?: string; aliases?: string[] }> }> };
	return (data.dependencies ?? []).flatMap(d => (d.vulns ?? []).map(v => ({
		name: d.name, version: d.version, file, id: v.id, title: (v.description ?? 'Known vulnerability').split('\n')[0].slice(0, 160),
		severity: 'medium' as Severity, fixed: v.fix_versions?.[0], url: `https://osv.dev/vulnerability/${v.id}`,
	})));
}

/** Installed versions from package-lock.json (v2/v3 "packages", or v1 "dependencies"). */
export function packagesFromLock(json: string, file = 'package-lock.json'): Pkg[] {
	const data = JSON.parse(json) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
	const out = new Map<string, Pkg>();
	for (const [where, p] of Object.entries(data.packages ?? {})) {
		const name = where.split('node_modules/').pop();
		if (where && name && p.version) out.set(`${name}@${p.version}`, { name, version: p.version, ecosystem: 'npm', file });
	}
	for (const [name, p] of Object.entries(data.dependencies ?? {})) if (p.version) out.set(`${name}@${p.version}`, { name, version: p.version, ecosystem: 'npm', file });
	return [...out.values()];
}

/** Pinned versions (`name==1.2.3`) from requirements.txt; unpinned lines can't be checked and are skipped. */
export function packagesFromRequirements(text: string, file = 'requirements.txt'): Pkg[] {
	return text.split('\n').flatMap(l => {
		const m = /^\s*([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*==\s*([\w.+-]+)/.exec(l.split('#')[0]);
		return m ? [{ name: m[1], version: m[3], ecosystem: 'PyPI' as const, file }] : [];
	});
}

/** OSV's batch answer (ids per package) plus the details fetched for those ids. */
export function parseOsv(pkgs: readonly Pkg[], batch: { results: Array<{ vulns?: Array<{ id: string }> }> }, details: Record<string, any>): DepIssue[] {
	return pkgs.flatMap((p, i) => (batch.results[i]?.vulns ?? []).map(v => {
		const d = details[v.id] ?? {};
		const sev = String(d.database_specific?.severity ?? '').toLowerCase();
		const fixed = (d.affected ?? []).flatMap((a: any) => (a.ranges ?? []).flatMap((r: any) => (r.events ?? []).map((e: any) => e.fixed))).find(Boolean);
		return { name: p.name, version: p.version, file: p.file, id: v.id, title: String(d.summary ?? d.details ?? 'Known vulnerability').split('\n')[0].slice(0, 160),
			severity: SEV[sev] ?? 'medium', fixed, url: `https://osv.dev/vulnerability/${v.id}` };
	}));
}

function run(cwd: string, cmd: string, args: string[]): Promise<string> {
	// npm audit exits 1 when it finds something; its JSON is still on stdout.
	return new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, out) =>
		out?.trim().startsWith('{') ? resolve(out) : reject(err ?? new Error('no output'))));
}

/**
 * Check the project's dependencies. `read(path)` returns a manifest's text or undefined.
 * Returns what was found and how it was checked, so the page can say so.
 */
export async function auditDependencies(dir: string, read: (p: string) => Promise<string | undefined>, trusted: boolean): Promise<{ issues: DepIssue[]; how: string[] }> {
	const issues: DepIssue[] = [], how: string[] = [];
	const lock = await read('package-lock.json'), reqs = await read('requirements.txt');
	const viaOsv: Pkg[] = [];
	// npm and pip-audit read the project's own config (.npmrc, pip.conf), so they only run in a trusted workspace; OSV needs no program.
	if (lock && !trusted) viaOsv.push(...packagesFromLock(lock));
	else if (lock) {
		try { issues.push(...parseNpmAudit(await run(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json', '--package-lock-only']))); how.push('npm audit'); }
		catch { viaOsv.push(...packagesFromLock(lock)); }
	}
	if (reqs && !trusted) viaOsv.push(...packagesFromRequirements(reqs));
	else if (reqs) {
		try { issues.push(...parsePipAudit(await run(dir, 'pip-audit', ['-r', 'requirements.txt', '-f', 'json', '--progress-spinner', 'off']))); how.push('pip-audit'); }
		catch { viaOsv.push(...packagesFromRequirements(reqs)); }
	}
	if (viaOsv.length) {
		try {
			// ponytail: first 500 packages, details for the first 40 hits; enough for an app, a lot of network for a monorepo
			const pkgs = viaOsv.slice(0, 500);
			const res = await fetch('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ queries: pkgs.map(p => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) }) });
			const batch = await res.json() as { results: Array<{ vulns?: Array<{ id: string }> }> };
			const ids = [...new Set(batch.results.flatMap(r => (r.vulns ?? []).map(v => v.id)))].slice(0, 40);
			const details: Record<string, unknown> = {};
			await Promise.all(ids.map(async id => { details[id] = await (await fetch(`https://api.osv.dev/v1/vulns/${id}`)).json().catch(() => ({})); }));
			issues.push(...parseOsv(pkgs, batch, details));
			how.push('OSV.dev');
		} catch { how.push('OSV.dev (unreachable)'); }
	}
	return { issues, how };
}
