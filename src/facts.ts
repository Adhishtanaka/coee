// What the architecture page lists about a project, from the code index (no model): entry points, the API, the data
// shapes (DTOs) and where they're used, the business rules, and which part of the map each belongs to.
// Pure, so the harness checks every expected route, data shape and rule reaches the page.
import { Dto, Field, ProjectIndex } from './codeindex';

export interface EntryFact { file: string; why: string }
export interface RouteFact { method: string; path: string; file: string; line: number; handler?: string; uses: string[]; guards: string[]; part?: string }
export interface DtoFact { name: string; kind: Dto['kind']; file: string; line: number; end: number; fields: Field[]; usedIn: string[]; validated: boolean; part?: string }
export interface RuleFact { id: string; text: string; kind: string; file: string; line: number; in?: string; part?: string; plain?: string }
export interface EventFact { on: string; file: string; line: number; handler?: string; part?: string; /** Where the handler is, when a layout or storyboard names it in another file. */ handlerFile?: string; handlerLine?: number }
export interface Facts { entries: EntryFact[]; routes: RouteFact[]; events: EventFact[]; dtos: DtoFact[]; rules: RuleFact[] }

/** Which part of the map a file belongs to (the first part that lists it, or shares its folder). */
export function partOf(parts: ReadonlyArray<{ id: string; files: ReadonlyArray<{ path: string }> }>, file: string): string | undefined {
	const exact = parts.find(c => c.files.some(f => f.path === file));
	if (exact) return exact.id;
	const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
	return parts.find(c => c.files.some(f => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === dir))?.id;
}

export function projectFacts(idx: ProjectIndex, texts: ReadonlyMap<string, string>, parts: ReadonlyArray<{ id: string; files: ReadonlyArray<{ path: string }> }> = []): Facts {
	const files = [...idx.files.values()];
	const dtoNames = files.flatMap(f => f.dtos.filter(d => d.kind !== 'object').map(d => d.name));
	const rules: RuleFact[] = files.flatMap(f => f.rules.map((r, i) => ({ id: `${f.path}#${i + 1}`, text: r.text, kind: r.kind, file: f.path, line: r.line, in: r.in, part: partOf(parts, f.path) })));
	const routes: RouteFact[] = files.flatMap(f => {
		const lines = texts.get(f.path)?.split('\n') ?? [];
		return f.routes.map(r => {
			// The handler: the function the route line sits in, or the next lines up to the next route (inline handlers).
			const sym = f.symbols.find(s => s.line <= r.line && r.line <= s.end && s.kind !== 'class' && s.end - s.line < 400);
			const next = f.routes.map(x => x.line).filter(l => l > r.line).sort((a, b) => a - b)[0] ?? r.line + 25;
			const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 40)).join('\n');
			const guards = rules.filter(x => x.file === f.path && x.line >= r.line && x.line < next).map(x => x.text);
			const middleware = (lines[r.line - 1] ?? '').match(/,\s*([a-z]\w*(?:Auth|User|Login|Admin|Role|Token|Guard|Permission)\w*)\s*,/i)?.[1];
			return { method: r.method, path: r.path, file: f.path, line: r.line, handler: sym?.name, part: partOf(parts, f.path),
				uses: dtoNames.filter(n => new RegExp(`\\b${n}\\b`).test(body)), guards: middleware ? [`${middleware} (middleware)`, ...guards] : guards };
		});
	});
	const dtos: DtoFact[] = files.flatMap(f => f.dtos.map(d => {
		const re = new RegExp(`\\b${d.name}\\b`);
		const usedIn = d.kind === 'object' ? [] : [...texts].filter(([p, t]) => p !== f.path && re.test(t)).map(([p]) => p);
		return { name: d.name, kind: d.kind, file: f.path, line: d.line, end: d.end, fields: d.fields, usedIn, part: partOf(parts, f.path),
			validated: d.kind === 'schema' || d.kind === 'model' || [...texts.values()].some(t => new RegExp(`\\b${d.name}\\.(safeParse|parse|validate|parseAsync)\\b`).test(t)) };
	}));
	// Mount points: app.use('/orders', requireUser, ordersRouter) puts the router's routes under '/orders', behind requireUser.
	for (const f of files) {
		for (const m of (texts.get(f.path) ?? '').matchAll(/\.use\(\s*['"`](\/[^'"`]*)['"`]\s*,([^)]*)\)/g)) {
			const args = m[2].split(',').map(a => a.trim()).filter(a => /^[A-Za-z_$][\w$]*$/.test(a));
			const router = args[args.length - 1], middleware = args.slice(0, -1);
			const owner = router && files.find(o => (texts.get(o.path) ?? '').match(new RegExp(`\\b(?:const|let|var)\\s+${router}\\s*=`)));
			if (!owner) continue;
			for (const r of routes) {
				if (r.file !== owner.path) continue;
				if (!r.path.startsWith(m[1])) r.path = (m[1] + (r.path === '/' ? '' : r.path)) || '/';
				r.guards.unshift(...middleware.map(x => `${x} (middleware on ${m[1]})`));
			}
		}
	}
	const entries = files.filter(f => f.entry).map(f => ({ file: f.path, why: f.entry! }));
	// UI and app events, each with the function it sits in (the component or screen) when there is one.
	// A layout or storyboard names its handler (android:onClick="save"): link it to that method in the code. Several
	// definitions: the one in a file named like the screen (activity_main.xml → MainActivity) wins, else the first.
	const findMethod = (name: string, from: string) => {
		const where = files.flatMap(f => f.symbols.filter(s => s.name === name && s.kind !== 'class').map(s => ({ file: f.path, line: s.line })));
		const screen = (from.split('/').pop() ?? '').replace(/\.\w+$/, '').split(/[_\-.]/).filter(Boolean).map(w => w.toLowerCase());
		return where.find(w => screen.length && screen.every(word => (w.file.split('/').pop() ?? '').toLowerCase().includes(word))) ?? where[0];
	};
	const events: EventFact[] = files.flatMap(f => f.events.map(e => {
		const ev: EventFact = { on: e.on, file: f.path, line: e.line, part: partOf(parts, f.path),
			handler: [...f.symbols].reverse().find(s => s.line <= e.line && e.line <= s.end && s.end - s.line < 400)?.name };
		const m = e.calls && findMethod(e.calls, f.path);
		if (e.calls) ev.handler = e.calls;
		if (m) { ev.handlerFile = m.file; ev.handlerLine = m.line; }
		return ev;
	})).slice(0, 200);
	return { entries, routes, events, dtos, rules };
}

/** For one use case (its code ranges), the rules it applies and the data shapes it handles, following the calls it makes. */
export function flowFacts(idx: ProjectIndex, facts: Facts, refs: ReadonlyArray<{ path: string; startLine?: number; endLine?: number }>, texts: ReadonlyMap<string, string>): { rules: RuleFact[]; dtos: string[] } {
	const ranges: Array<[string, number, number]> = [];
	const seen = new Set<string>();
	const add = (file: string, a: number, b: number, depth: number) => {
		const key = `${file}:${a}`;
		if (seen.has(key) || depth > 3) return;
		seen.add(key);
		ranges.push([file, a, b]);
		const fi = idx.files.get(file);
		for (const s of fi?.symbols ?? []) {
			if (s.line < a || s.line > b) continue;
			// Follow the calls the code makes into other functions, so rules in the services it uses count too.
			for (const name of fi!.calls[s.name] ?? []) for (const where of idx.definedIn.get(name) ?? []) {
				const t = idx.files.get(where)!.symbols.find(x => x.name === name);
				if (t) add(where, t.line, t.end, depth + 1);
			}
		}
		const body = (texts.get(file) ?? '').split('\n').slice(a - 1, b).join('\n');
		for (const fi2 of idx.files.values()) for (const s of fi2.symbols) if (s.kind !== 'class' && body.includes(`${s.name}(`)) add(fi2.path, s.line, s.end, depth + 1);
	};
	for (const r of refs) {
		const fi = idx.files.get(r.path);
		if (!fi) continue;
		const a = r.startLine ?? 1, b = r.endLine ?? fi.lines;
		// A one-line reference means the function around it.
		const sym = fi.symbols.find(s => s.line <= a && b <= s.end && s.kind !== 'class');
		add(r.path, sym && b - a < 3 ? sym.line : a, sym && b - a < 3 ? sym.end : b, 0);
	}
	const inRange = (file: string, line: number) => ranges.some(([f, a, b]) => f === file && a <= line && line <= b);
	const rules = facts.rules.filter(r => inRange(r.file, r.line));
	const body = ranges.map(([f, a, b]) => (texts.get(f) ?? '').split('\n').slice(a - 1, b).join('\n')).join('\n');
	const dtos = facts.dtos.filter(d => d.kind !== 'object' && new RegExp(`\\b${d.name}\\b`).test(body)).map(d => d.name);
	return { rules, dtos: [...new Set(dtos)] };
}

/** Functions a change touched: those whose lines include an added line. */
export function changedSymbols(idx: ProjectIndex, file: string, added: readonly number[]): string[] {
	const fi = idx.files.get(file);
	if (!fi) return [];
	return [...new Set(fi.symbols.filter(s => s.kind !== 'class' && added.some(l => l >= s.line && l <= s.end)).map(s => s.name))];
}

/** Where the rest of the project calls these functions: the line, and the function it sits in. What a change can break. */
export function callSites(idx: ProjectIndex, texts: ReadonlyMap<string, string>, names: readonly string[], skipFile?: string, max = 15): Array<{ file: string; line: number; text: string; in?: string; calls: string }> {
	const out: Array<{ file: string; line: number; text: string; in?: string; calls: string }> = [];
	for (const name of names) {
		const re = new RegExp(`(^|[^\\w$.])${name.replace(/[$]/g, '\\$')}\\s*\\(|\\.${name.replace(/[$]/g, '\\$')}\\s*\\(`);
		for (const [file, text] of texts) {
			if (file === skipFile) continue;
			const fi = idx.files.get(file);
			text.split('\n').forEach((l, i) => {
				if (out.length >= max || !re.test(l) || /^\s*(function|def|func|export\s+function)\b/.test(l)) return;
				const at = fi?.symbols.find(s => s.kind !== 'class' && s.line <= i + 1 && i + 1 <= s.end);
				out.push({ file, line: i + 1, text: l.trim().slice(0, 160), in: at?.name, calls: name });
			});
		}
	}
	return out;
}

/** A problem in how the project is put together, rather than on one line. Fed to the model like a rule hit. */
export interface DesignHit { rule: string; title: string; severity: 'high' | 'medium' | 'low'; cwe: string; owasp: string; file: string; line: number; text: string; why: string; fix: string }

const AUTHY = /auth|login|user|token|session|role|permission|jwt|passport|guard|admin|owner|forbidden|40[13]/i;

/**
 * Whole-project checks the line rules can't make: routes that change data with no auth in sight (A01), login-like
 * routes with no rate limiting anywhere (A04, brute force), and a web app without security headers (A05).
 */
export function designChecks(facts: Facts, texts: ReadonlyMap<string, string>): DesignHit[] {
	const all = [...texts.values()].join('\n');
	const out: DesignHit[] = [];
	const lineText = (file: string, line: number) => texts.get(file)?.split('\n')[line - 1]?.trim().slice(0, 160) ?? '';
	// Auth applied to everything (app.use(passport.authenticate…) / app.use(requireUser) with no path) covers every route.
	const globalAuth = /\.use\(\s*(?!['"`])[^)]*(auth|passport|jwt|requireUser|login|session|guard)/i.test(all);
	for (const r of facts.routes) {
		if (!/^(POST|PUT|PATCH|DELETE)$/.test(r.method) || globalAuth) continue;
		const handler = (texts.get(r.file) ?? '').split('\n').slice(r.line - 1, r.line + 25).join('\n');
		if (r.guards.some(g => AUTHY.test(g)) || /Depends\(\s*\w*(user|auth)|@login_required|req\.user\b|request\.user\b|current_user/i.test(handler)) continue;
		out.push({ rule: 'design-no-auth', title: `${r.method} ${r.path} changes data with no auth check in sight`, severity: 'medium', cwe: 'CWE-862', owasp: 'A01', file: r.file, line: r.line, text: lineText(r.file, r.line),
			why: 'Nothing in this route or in front of it checks who is calling, so anyone who can reach the server can change this data.', fix: 'Put an authentication check (middleware or a dependency) in front of the route, and check the user may change this record.' });
	}
	const limited = /express-rate-limit|rateLimit\s*\(|RateLimit|slowapi|Limiter\s*\(|throttle|django_ratelimit|ratelimit\b|bottleneck|@nestjs\/throttler/i.test(all);
	for (const r of facts.routes) {
		if (limited || !/login|signin|sign-in|session|token|password|reset|otp|verify|auth/i.test(r.path)) continue;
		out.push({ rule: 'design-no-rate-limit', title: `${r.method} ${r.path} can be tried without limit`, severity: 'medium', cwe: 'CWE-307', owasp: 'A04', file: r.file, line: r.line, text: lineText(r.file, r.line),
			why: 'There is no rate limiting anywhere in the project, so passwords or codes on this route can be guessed by trying many times quickly.', fix: 'Limit attempts per IP and per account (e.g. express-rate-limit, slowapi), and slow down after failures.' });
	}
	for (const [file, text] of texts) {
		const at = text.split('\n').findIndex(l => /=\s*express\(\s*\)/.test(l));
		if (at < 0 || /helmet|secure-headers|Content-Security-Policy|X-Frame-Options|Strict-Transport-Security/i.test(all)) continue;
		out.push({ rule: 'design-no-headers', title: 'No security headers', severity: 'low', cwe: 'CWE-693', owasp: 'A05', file, line: at + 1, text: lineText(file, at + 1),
			why: 'Browsers get no instructions to block framing, sniffing or mixed content, so clickjacking and some XSS are easier.', fix: 'Add helmet() (or set Content-Security-Policy, X-Frame-Options, Strict-Transport-Security yourself).' });
		break;
	}
	return out;
}

/**
 * Mobile app settings, where most mobile security problems live: AndroidManifest.xml (exported components, cleartext,
 * debuggable, backups), the network security config, and iOS's Info.plist (App Transport Security). Whole elements,
 * not lines, so an attribute on the next line still counts. Pure, like the design checks.
 */
export function appConfigChecks(texts: ReadonlyMap<string, string>): DesignHit[] {
	const out: DesignHit[] = [];
	for (const [file, text] of texts) {
		const lineAt = (i: number) => text.slice(0, i).split('\n').length;
		const hit = (i: number, h: Omit<DesignHit, 'file' | 'line' | 'text'>) => { const line = lineAt(i); out.push({ ...h, file, line, text: text.split('\n')[line - 1].trim().slice(0, 160) }); };
		if (/(^|\/)AndroidManifest\.xml$/.test(file)) {
			let m = /android:debuggable\s*=\s*"true"/.exec(text);
			if (m) hit(m.index, { rule: 'android-debuggable', title: 'App ships debuggable', severity: 'high', cwe: 'CWE-489', owasp: 'A05',
				why: 'A debuggable app lets anyone with the phone and a cable attach a debugger, read its memory and its private files.', fix: 'Remove android:debuggable; Gradle sets it for debug builds only.' });
			m = /android:usesCleartextTraffic\s*=\s*"true"/.exec(text);
			if (m) hit(m.index, { rule: 'android-cleartext', title: 'App allows plain HTTP', severity: 'medium', cwe: 'CWE-319', owasp: 'A02',
				why: 'Traffic over plain HTTP can be read and changed by anyone on the same Wi-Fi.', fix: 'Remove usesCleartextTraffic and use HTTPS; allow a single dev host in network_security_config.xml if you must.' });
			m = /android:allowBackup\s*=\s*"true"/.exec(text);
			if (m) hit(m.index, { rule: 'android-allow-backup', title: 'App data can be copied off by backup', severity: 'low', cwe: 'CWE-530', owasp: 'A05',
				why: 'With backups on, the app\'s private files (tokens, databases) can be pulled off the phone with adb backup or restored onto another device.', fix: 'Set android:allowBackup="false", or exclude sensitive files with dataExtractionRules / fullBackupContent.' });
			// Components other apps can start: exported, with no permission, and not the launcher screen (which must be exported).
			for (const c of text.matchAll(/<(activity|activity-alias|service|receiver|provider)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g)) {
				const [, kind, attrs, , body = ''] = c;
				if (!/android:exported\s*=\s*"true"/.test(attrs) || /android:(permission|readPermission|writePermission)\s*=/.test(attrs)) continue;
				if (/android\.intent\.category\.LAUNCHER/.test(body)) continue;
				const name = /android:name\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? kind;
				const link = /android\.intent\.category\.BROWSABLE/.test(body);
				hit(c.index!, link
					? { rule: 'android-deep-link', title: `${name} opens from any link`, severity: 'low', cwe: 'CWE-939', owasp: 'A01',
						why: 'Any web page or app can open this screen with data of its choosing; code that trusts the link\'s parameters (an id, a URL to load, an action) can be steered.', fix: 'Treat every deep-link parameter as untrusted: validate it, never load arbitrary URLs from it, and confirm actions with the user. Prefer verified App Links.' }
					: { rule: 'android-exported', title: `${name} can be started by any app`, severity: kind === 'provider' ? 'high' : 'medium', cwe: 'CWE-926', owasp: 'A01',
						why: `This ${kind} is exported with no permission, so any app on the phone can start it${kind === 'provider' ? ' and read or change its data' : ' and pass it data'}.`, fix: 'Set android:exported="false" if only your app uses it; otherwise require a permission (signature level for your own apps) and validate what it receives.' });
			}
		}
		if (/(^|\/)network_security_config\.xml$/.test(file)) {
			const m = /cleartextTrafficPermitted\s*=\s*"true"/.exec(text);
			if (m) hit(m.index, { rule: 'android-cleartext', title: 'Network config allows plain HTTP', severity: 'medium', cwe: 'CWE-319', owasp: 'A02',
				why: 'Traffic over plain HTTP can be read and changed by anyone on the same network.', fix: 'Allow cleartext only for a named dev domain, never in base-config.' });
			const u = /<certificates\s+src\s*=\s*"user"/.exec(text);
			if (u) hit(u.index, { rule: 'android-user-certs', title: 'App trusts certificates the user installs', severity: 'medium', cwe: 'CWE-295', owasp: 'A02',
				why: 'Any certificate installed on the phone (by a user, malware or an MDM) can read the app\'s HTTPS traffic.', fix: 'Trust user certificates only inside <debug-overrides>.' });
		}
		if (/(^|\/)Info\.plist$/.test(file)) {
			let m = /<key>NSAllowsArbitraryLoads<\/key>\s*<true\s*\/>/.exec(text);
			if (m) hit(m.index, { rule: 'ios-ats-off', title: 'App Transport Security is off', severity: 'medium', cwe: 'CWE-319', owasp: 'A02',
				why: 'NSAllowsArbitraryLoads lets the app load anything over plain HTTP or weak TLS, so traffic can be read and changed on the network.', fix: 'Remove it; add a narrow NSExceptionDomains entry for the one host that needs it.' });
			m = /<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\s*\/>/.exec(text);
			if (m) hit(m.index, { rule: 'ios-ats-exception', title: 'A domain is allowed over plain HTTP', severity: 'low', cwe: 'CWE-319', owasp: 'A02',
				why: 'Traffic to this domain is not encrypted.', fix: 'Serve that host over HTTPS and remove the exception.' });
		}
	}
	return out;
}
