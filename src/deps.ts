// Known vulnerabilities in dependencies. npm audit / pip-audit when installed, otherwise OSV.dev
// (only package names and versions are sent, never code). The parsers are pure and unit-tested.
import { execFile } from 'child_process';
import type { Severity } from './rules';

export interface Pkg { name: string; version: string; ecosystem: 'npm' | 'PyPI' | 'Maven' | 'Pub' | 'SwiftURL'; /** the manifest it came from, relative to the project */ file: string }
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

/** A literal version: not a variable ($x, ${x}), a range (1.+, [1,2)) or "latest". */
const exact = (v: string) => /^\d[\w.-]*$/.test(v) && !/\+$/.test(v);

/**
 * Gradle dependencies with literal versions: `implementation("com.squareup.okhttp3:okhttp:4.9.0")` or
 * `implementation 'g:a:v'`, from build.gradle(.kts). Versions from variables are skipped (see the version catalog).
 */
export function packagesFromGradle(text: string, file = 'build.gradle'): Pkg[] {
	return [...text.matchAll(/\b(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor|kapt|ksp|classpath|\w+Implementation)\s*\(?\s*["']([\w.-]+):([\w.-]+):([^"'@:]+)["']/g)]
		.filter(m => exact(m[3])).map(m => ({ name: `${m[1]}:${m[2]}`, version: m[3], ecosystem: 'Maven' as const, file }));
}

/** Gradle's version catalog (gradle/libs.versions.toml): `okhttp = { module = "g:a", version.ref = "okhttp" }` and friends. */
export function packagesFromCatalog(text: string, file = 'gradle/libs.versions.toml'): Pkg[] {
	const versions = new Map<string, string>(), out: Pkg[] = [];
	let section = '';
	for (const raw of text.split('\n')) {
		const l = raw.split('#')[0].trim();
		const sec = /^\[(\w+)\]$/.exec(l);
		if (sec) { section = sec[1]; continue; }
		const kv = /^([\w.-]+)\s*=\s*(.+)$/.exec(l);
		if (!kv) continue;
		if (section === 'versions') { const v = /^"([^"]+)"$/.exec(kv[2]); if (v) versions.set(kv[1], v[1]); continue; }
		if (section !== 'libraries') continue;
		const val = kv[2], get = (k: string) => new RegExp(`\\b${k.replace('.', '\\.')}\\s*=\\s*"([^"]+)"`).exec(val)?.[1];
		const short = /^"([\w.-]+):([\w.-]+):([^"]+)"$/.exec(val); // lib = "g:a:v"
		const module = short ? `${short[1]}:${short[2]}` : get('module') ?? (get('group') && get('name') ? `${get('group')}:${get('name')}` : undefined);
		const version = short?.[3] ?? get('version') ?? versions.get(get('version.ref') ?? '');
		if (module && version && exact(version)) out.push({ name: module, version, ecosystem: 'Maven', file });
	}
	return out;
}

/** Maven's pom.xml: each <dependency> with a literal <version>. */
export function packagesFromPom(text: string, file = 'pom.xml'): Pkg[] {
	return [...text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap(m => {
		const tag = (t: string) => new RegExp(`<${t}>\\s*([^<\\s]+)\\s*</${t}>`).exec(m[1])?.[1];
		const g = tag('groupId'), a = tag('artifactId'), v = tag('version');
		return g && a && v && exact(v) ? [{ name: `${g}:${a}`, version: v, ecosystem: 'Maven' as const, file }] : [];
	});
}

/** Dart and Flutter's pubspec.lock: the hosted packages and their resolved versions. */
export function packagesFromPubspecLock(text: string, file = 'pubspec.lock'): Pkg[] {
	const out: Pkg[] = [];
	let name = '', version = '', hosted = false;
	const flush = () => { if (name && version && hosted) out.push({ name, version, ecosystem: 'Pub', file }); name = version = ''; hosted = false; };
	for (const l of text.split('\n')) {
		const n = /^ {2}([\w-]+):\s*$/.exec(l);
		if (n) { flush(); name = n[1]; continue; }
		const v = /^ {4}version:\s*"?([^"\s]+)"?/.exec(l);
		if (v) version = v[1];
		if (/^ {4}source:\s*hosted\b/.test(l)) hosted = true;
	}
	flush();
	return out;
}

/** Swift Package Manager's Package.resolved (v1, v2 and v3). OSV names Swift packages by repository: github.com/apple/swift-nio. */
export function packagesFromPackageResolved(json: string, file = 'Package.resolved'): Pkg[] {
	let data: any;
	try { data = JSON.parse(json); } catch { return []; }
	const pins: any[] = data?.pins ?? data?.object?.pins ?? [];
	return pins.flatMap(p => {
		const url = String(p.location ?? p.repositoryURL ?? ''), version = String(p.state?.version ?? '');
		const name = url.replace(/^\w+:\/\//, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '').replace(/\/$/, '');
		return name && exact(version) ? [{ name, version, ecosystem: 'SwiftURL' as const, file }] : [];
	});
}

/** Which manifest parser reads a file, by its name. */
const PARSERS: Array<[RegExp, (text: string, file: string) => Pkg[]]> = [
	[/(^|\/)build\.gradle(\.kts)?$/, packagesFromGradle],
	[/(^|\/)libs\.versions\.toml$/, packagesFromCatalog],
	[/(^|\/)pom\.xml$/, packagesFromPom],
	[/(^|\/)pubspec\.lock$/, packagesFromPubspecLock],
	[/(^|\/)Package\.resolved$/, packagesFromPackageResolved],
];
/** The files `auditDependencies` reads besides package-lock.json and requirements.txt. */
export const DEP_FILES = /(^|\/)(build\.gradle(\.kts)?|libs\.versions\.toml|pom\.xml|pubspec\.lock|Package\.resolved)$/;

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
export async function auditDependencies(dir: string, read: (p: string) => Promise<string | undefined>, trusted: boolean, paths: readonly string[] = []): Promise<{ issues: DepIssue[]; how: string[] }> {
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
	// Gradle, Maven, Flutter and Swift: OSV only (their own audit tools need a build). Every module's file, deduplicated.
	// The usual places too: lock files aren't in the project's file list (it skips *.lock).
	const usual = ['pubspec.lock', 'Package.resolved', 'build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts', 'android/app/build.gradle', 'gradle/libs.versions.toml', 'pom.xml'];
	for (const p of [...new Set([...usual, ...paths.filter(x => DEP_FILES.test(x))])].slice(0, 60)) {
		const parse = PARSERS.find(([re]) => re.test(p))?.[1], text = parse && await read(p);
		if (parse && text) viaOsv.push(...parse(text, p));
	}
	const seen = new Set<string>();
	viaOsv.splice(0, viaOsv.length, ...viaOsv.filter(x => { const k = `${x.ecosystem}:${x.name}@${x.version}`; return !seen.has(k) && !!seen.add(k); }));
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
