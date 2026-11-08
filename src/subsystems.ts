// Big codebases: the parts a repository is made of (workspace packages, modules, top-level folders), found from its
// manifests without the model. Pure, so it's unit-tested; the architecture page uses it to show a system level first.

export interface Subsystem {
	/** Folder, relative to the root ("" never: a subsystem is always a subfolder). */
	path: string;
	name: string;
	description?: string;
	files: number;
	/** Paths of the other subsystems it depends on. */
	uses: string[];
}

/** A repository is "big" past this many source files: the architecture page starts at the subsystem level. */
export const BIG = 400;

/** Simple glob for workspace patterns: "packages/*", "apps/**", "libs/core". */
function globToRe(g: string): RegExp {
	const body = g.replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]+').replace(/\0/g, '.+');
	return new RegExp(`^${body}$`);
}

const dirOf = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';

/** Workspace members declared by the root's manifests, as patterns. */
function declared(read: (p: string) => string | undefined): string[] {
	const out: string[] = [];
	const pkg = read('package.json');
	if (pkg) {
		try { const j = JSON.parse(pkg); const ws = Array.isArray(j.workspaces) ? j.workspaces : j.workspaces?.packages; if (Array.isArray(ws)) out.push(...ws.filter((x: unknown) => typeof x === 'string' && !x.startsWith('!'))); } catch { /* not JSON */ }
	}
	const pnpm = read('pnpm-workspace.yaml');
	if (pnpm) out.push(...[...pnpm.matchAll(/^\s*-\s*["']?([^"'#\n]+?)["']?\s*$/gm)].map(m => m[1]).filter(x => !x.startsWith('!')));
	const gowork = read('go.work');
	if (gowork) out.push(...[...gowork.matchAll(/^\s*(?:use\s+)?\.\/([\w./-]+)\s*$/gm)].map(m => m[1]));
	const cargo = read('Cargo.toml');
	const members = cargo && /\[workspace\][\s\S]*?members\s*=\s*\[([^\]]*)\]/.exec(cargo);
	if (members) out.push(...[...members[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]));
	const gradle = read('settings.gradle') ?? read('settings.gradle.kts');
	if (gradle) out.push(...[...gradle.matchAll(/include\s*\(?([^)\n]+)\)?/g)].flatMap(m => [...m[1].matchAll(/["']:?([^"']+)["']/g)].map(x => x[1].replace(/:/g, '/'))));
	const pom = read('pom.xml');
	if (pom) out.push(...[...pom.matchAll(/<module>([^<]+)<\/module>/g)].map(m => m[1].trim()));
	return out;
}

const MANIFESTS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile'];

/**
 * The subsystems of a repository from its file list (relative paths) and a way to read small files.
 * Declared workspaces win; otherwise every folder with its own manifest; otherwise the top-level folders with code
 * (looking inside a lone "src" or similar). Fewer than two means it isn't worth a system level.
 */
export function detectSubsystems(paths: readonly string[], read: (p: string) => string | undefined, isSource: (p: string) => boolean): Subsystem[] {
	const dirs = new Set<string>();
	for (const p of paths) for (let d = dirOf(p); d && !dirs.has(d); d = dirOf(d)) dirs.add(d); // every folder, not only those holding files
	let roots: string[] = [];
	const patterns = declared(read).map(globToRe);
	if (patterns.length) roots = [...dirs].filter(d => d && patterns.some(re => re.test(d)));
	if (roots.length < 2) roots = [...new Set(paths.filter(p => MANIFESTS.includes(p.split('/').pop()!) && p.includes('/')).map(dirOf))];
	if (roots.length < 2) {
		// No manifests: top-level folders with code; a single wrapper folder ("src", "lib") is looked into.
		let base = '';
		for (let i = 0; i < 2; i++) {
			const tops = new Map<string, number>();
			for (const p of paths) if (isSource(p) && p.startsWith(base) && p.slice(base.length).includes('/')) { const t = base + p.slice(base.length).split('/')[0]; tops.set(t, (tops.get(t) ?? 0) + 1); }
			const real = [...tops].filter(([, n]) => n >= 3).map(([t]) => t);
			if (real.length === 1) { base = real[0] + '/'; continue; }
			roots = real;
			break;
		}
	}
	// Outermost only: a package inside another package belongs to it.
	roots = roots.filter(r => !roots.some(o => o !== r && r.startsWith(o + '/'))).sort();
	if (roots.length < 2) return [];
	const names = new Map<string, string>(); // package name → subsystem path, for dependencies
	const out: Subsystem[] = roots.map(r => {
		const files = paths.filter(p => isSource(p) && p.startsWith(r + '/')).length;
		const s: Subsystem = { path: r, name: r.split('/').pop()!, files, uses: [] };
		const pkg = read(`${r}/package.json`);
		if (pkg) { try { const j = JSON.parse(pkg); if (j.name) { s.name = j.name; names.set(j.name, r); } if (j.description) s.description = String(j.description).slice(0, 200); } catch { /* skip */ } }
		const gomod = read(`${r}/go.mod`);
		const mod = gomod && /^module\s+(\S+)/m.exec(gomod);
		if (mod) names.set(mod[1], r);
		const cargo = read(`${r}/Cargo.toml`);
		const crate = cargo && /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo);
		if (crate) { s.name = crate[1]; names.set(crate[1], r); }
		if (!s.description) {
			const readme = read(`${r}/README.md`);
			const para = readme?.split(/\n\s*\n/).map(x => x.trim()).find(x => x && !x.startsWith('#') && !x.startsWith('!') && !x.startsWith('[!'));
			if (para) s.description = para.replace(/\s+/g, ' ').slice(0, 200);
		}
		return s;
	});
	// Who uses whom: a package.json dependency, a go.mod require or a Cargo dependency naming another subsystem.
	for (const s of out) {
		const text = [read(`${s.path}/package.json`), read(`${s.path}/go.mod`), read(`${s.path}/Cargo.toml`)].filter(Boolean).join('\n');
		for (const [name, p] of names) if (p !== s.path && new RegExp(`["\\s]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["\\s=]`).test(text)) s.uses.push(p);
	}
	return out;
}

/**
 * At most `n` paths, spread over the tree: shallow files first, then round-robin across top-level folders,
 * so a 5,000-file repository is sampled everywhere instead of cut off alphabetically.
 */
export function sampleTree(paths: readonly string[], n: number): string[] {
	if (paths.length <= n) return [...paths];
	const depth = (p: string) => p.split('/').length;
	const groups = new Map<string, string[]>();
	for (const p of [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
		const top = p.includes('/') ? p.split('/')[0] : '';
		groups.set(top, [...groups.get(top) ?? [], p]);
	}
	const lists = [...groups.values()], out: string[] = [];
	for (let i = 0; out.length < n; i++) {
		let any = false;
		for (const l of lists) if (i < l.length && out.length < n) { out.push(l[i]); any = true; }
		if (!any) break;
	}
	return out.sort();
}
