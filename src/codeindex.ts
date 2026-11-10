// The code index: what each file declares, found without the model. Functions and classes with their exact lines,
// routes, data shapes (DTOs), business rules (guards and validation), entry points, imports and calls.
// Pure, so it's unit-tested against fixture projects; every feature builds on it (context packing, walkthrough steps,
// the architecture page). ponytail: line-based patterns per language, not real parsers; the fixtures say what it must find.
import { blockEnd } from './blocks';

export type Lang = 'js' | 'py' | 'go' | 'java' | 'c' | 'objc' | 'rust' | 'ruby' | 'php' | 'other';
export interface Sym { name: string; kind: 'function' | 'method' | 'class'; line: number; end: number; signature: string; exported?: boolean; parent?: string }
export interface Route { method: string; path: string; line: number; handler?: string }
/** A UI or app event the code reacts to: a click, a tap, a key, a listener, a CLI command. GUIs' answer to routes. */
export interface UiEvent { on: string; line: number; /** The method a screen file names for it: android:onClick="save", a storyboard's selector="save:". */ calls?: string }
export interface Field { name: string; type?: string; optional?: boolean }
export interface Dto { name: string; kind: 'interface' | 'type' | 'class' | 'schema' | 'struct' | 'model' | 'record' | 'object'; line: number; end: number; fields: Field[] }
export interface Rule { line: number; text: string; kind: 'validation' | 'auth' | 'limit' | 'error'; in?: string }
export interface FileIndex {
	path: string; lang: Lang; lines: number;
	/** Imported project files (resolved paths) and packages. */
	imports: string[];
	symbols: Sym[]; routes: Route[]; events: UiEvent[]; dtos: Dto[]; rules: Rule[];
	/** Why this file starts the program, if it does. */
	entry?: string;
	/** Per function: the names of project functions it calls. */
	calls: Record<string, string[]>;
}
export interface ProjectIndex {
	files: Map<string, FileIndex>;
	/** Who imports each file: many importers means a core file. */
	importedBy: Map<string, string[]>;
	/** Function name → files that define it, and → the functions that call it. */
	definedIn: Map<string, string[]>;
	callers: Map<string, string[]>;
}

/** The files coee reads as code. */
export const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|h|cc|cpp|hpp|scala|dart|vue|svelte|ex|exs|lua|sh|sql|html|fxml|xaml|qml|kts|m|mm|storyboard|xib)$|(^|\/)res\/(layout|navigation|menu)[^/]*\/[^/]+\.xml$/i; // Android screens are XML under res/layout*: only those, not every resource

export function langOf(path: string): Lang {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (/^(m?[jt]sx?|cjs|vue|svelte)$/.test(ext)) return 'js';
	if (ext === 'py') return 'py';
	if (ext === 'go') return 'go';
	if (/^(java|kts?|cs|scala|swift|dart)$/.test(ext)) return 'java';
	if (ext === 'm' || ext === 'mm') return 'objc';
	if (/^(c|h|cc|cpp|cxx|hpp|hh)$/.test(ext)) return 'c';
	if (ext === 'rs') return 'rust';
	if (ext === 'rb') return 'ruby';
	if (ext === 'php') return 'php';
	return 'other';
}

const KEYWORDS = new Set('if for while switch catch return function typeof new else do try with await yield sizeof elif except def class import from require'.split(' '));

/** Where symbols start, per language: [pattern, kind, name group, parent-aware]. */
const SYMBOLS: Record<Lang, Array<[RegExp, Sym['kind']]>> = {
	js: [
		[/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, 'function'],
		[/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
		// A handler passed to a call: `const server = http.createServer(async (req, res) => {`, `router.get('/', async (req, res) => {` is a route.
		[/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$.]+\(\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
		[/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
		[/^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
		[/^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+)*(?:async\s+)?\*?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/, 'method'],
	],
	py: [[/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, 'function'], [/^\s*class\s+([A-Za-z_]\w*)/, 'class']],
	go: [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, 'function'], [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, 'class']],
	// Modifiers are whole words each followed by whitespace, and the return type is one token: no two repeats can match
	// the same characters, so a crafted line can't make these backtrack (ReDoS).
	java: [[/^\s*(?:@\w+\s+)*(?:(?:public|private|protected|internal|static|final|open|override|abstract|suspend|inline|operator|infix|mutating|class|async|fileprivate)\s+)*(?:fun|func)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*[(<]/, 'function'], // Kotlin fun, Swift func: any return type
		[/^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open)\s+)*(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)/, 'class'],
		[/^\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|async|virtual|suspend|fun|func)\s+)*(?:[\w<>\[\],.?]+\s+)?([A-Za-z_]\w*)\s*\([^;)]*\)\s*(?:throws\s+[\w.,\s]+)?\{?\s*$/, 'method']],
	c: [[/^(?:(?:static|inline|extern|const|unsigned|signed|struct)\s+)*[A-Za-z_]\w*(?:\s+\**|\s*\*+\s*)([A-Za-z_]\w*)\s*\([^;)]*\)\s*\{?\s*$/, 'function']],
	// Objective-C: classes are @implementation … @end (no braces), methods are `- (void)save:(id)sender {`; C functions too.
	objc: [[/^\s*@(?:implementation|interface)\s+([A-Za-z_]\w*)/, 'class'],
		[/^\s*[-+]\s*\([^)]*\)\s*([A-Za-z_]\w*)/, 'method'],
		[/^(?:(?:static|inline|extern|const|unsigned|signed|struct)\s+)*[A-Za-z_]\w*(?:\s+\**|\s*\*+\s*)([A-Za-z_]\w*)\s*\([^;)]*\)\s*\{?\s*$/, 'function']],
	rust: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/, 'class']],
	ruby: [[/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, 'function'], [/^\s*class\s+([A-Z]\w*)/, 'class']],
	php: [[/^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, 'class']],
	other: [],
};

const SWIFT_KOTLIN: Array<[RegExp, Sym['kind']]> = [
	[/^\s*(?:(?:public|private|internal|fileprivate|open|override|convenience|required)\s+)*(init|deinit)\b\s*[?!]?\s*[({]/, 'method'],
	[/^\s*(?:(?:public|private|internal|fileprivate|open|override)\s+)*var\s+(body)\s*:\s*some\s+\w+\s*\{/, 'method'], // SwiftUI: what a view draws
];

const ROUTES: RegExp[] = [
	// Any router object: `app.get('/x', …)`, `ordersRouter.post('/', …)`. The path must start with "/" and a handler follow.
	/\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|all|head|options)\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,/i,
	/@(?:app|router|bp|blueprint|api)\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/i,
	/@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/,
	/\b(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/,
	/@(Get|Post|Put|Patch|Delete)\s*\(\s*['"]?([^'")]*)['"]?\s*\)/,
];

/** UI and app events, across GUI toolkits: [pattern, the event's name (group 1 when it has one)]. First match per line. */
const EVENTS: Array<[RegExp, string]> = [
	[/\.addEventListener\s*\(\s*['"`]([\w:-]+)['"`]/, ''], // DOM
	[/\s(on[A-Z]\w*)\s*=\s*\{/, ''], // JSX: onClick={…}
	[/(?:\s|^)(?:@|v-on:)([\w.-]+)\s*=\s*["']/, ''], // Vue: @click="…"
	[/\s\(([a-z][\w.]*)\)=["']/, ''], // Angular: (click)="…"
	[/\bon:([\w-]+)\s*=\s*\{/, ''], // Svelte
	[/\.setOn(\w+?)Listener\s*[({]/, ''], // Android views
	[/\.add(Action|Mouse|Key|Change|Item|Window|Focus)Listener\s*\(/, ''], // Swing / AWT
	[/\bpublic\s+void\s+(actionPerformed|mouseClicked|keyPressed|stateChanged|itemStateChanged)\s*\(/, ''],
	[/\.setOn(Action|MouseClicked|KeyPressed|KeyReleased|MouseEntered|MouseExited)\s*\(/, ''], // JavaFX
	[/@FXML\b.*\bvoid\s+(\w+)\s*\(/, ''],
	[/\b(onPressed|onTap|onLongPress|onChanged|onSubmitted|onClick|onValueChange|onDismissRequest)\s*[:=]\s*(?:\{|\([\w\s,]*\)\s*(?:=>|\{)|[a-z_][\w.]*\s*[,)])/, ''], // Flutter, Compose (not a `onClick: () -> Unit` parameter)
	[/\bandroid:on(\w+)\s*=\s*"/, ''], // Android layout XML: android:onClick="save"
	[/\bapp:(?:on\w+|navigationIcon)\w*\s*=\s*"@\{/, 'binding'], // data binding: app:onRefresh="@{() -> vm.refresh()}"
	[/<action\s[^>]*\beventType="(\w+)"/, ''], // storyboard / xib: a button wired to an @IBAction
	[/<segue\s[^>]*\bkind="(\w+)"/, 'segue'], // storyboard: moving to the next screen
	[/\baddTarget:\s*self\s+action:\s*@selector\((\w+)/, ''], // Objective-C buttons in code
	[/^\s*-\s*\(IBAction\)\s*(\w+)/, ''], // Objective-C @IBAction
	[/@IBAction\s+func\s+(\w+)/, ''], // UIKit
	[/\b(?:Button|Toggle|Stepper|Menu)\s*\([^)]*\)\s*\{\s*$/, 'tap'], // SwiftUI: Button("Save") { … }
	[/\.addTarget\s*\(\s*self\s*,\s*action:\s*#selector\((\w+)/, ''], // UIKit buttons in code
	[/\.(onTapGesture|onAppear|onDisappear|onChange|onSubmit|onReceive)\s*[({]/, ''], // SwiftUI
	[/\.(clicked|pressed|released|toggled|triggered|activated|timeout|finished|returnPressed|\w+Changed)\.connect\s*\(/, ''], // Qt signals: button.clicked.connect(…)
	[/\.bind\s*\(\s*['"]<([\w-]+)>['"]/, ''], // Tkinter
	[/\bcommand\s*=\s*(?:self\.)?([a-z_]\w*)\s*[,)]/, 'command'], // Tkinter Button(command=…)
	[/\.([A-Z]\w*)\s*\+=\s*(?:new\s+\w+\(\s*)?(?:On[A-Z]\w*|[A-Za-z]\w*_[A-Z]\w*|\([\w\s,]*\)\s*=>)/, ''], // C#: button.Click += OnClick; / += (s, e) =>
	[/\b(?:ipcMain|ipcRenderer)\.(?:on|handle)\s*\(\s*['"]([\w:-]+)['"]/, ''], // Electron
	[/\b(?:socket|io|ws|emitter|bus|channel|client)\.on\s*\(\s*['"]([\w:-]+)['"]/, ''], // sockets and emitters
	[/\.command\s*\(\s*['"]([\w:-]+)/, ''], // CLI: commander, yargs
	[/@(?:click|app|cli)\.command\s*\(\s*(?:['"]([\w-]+)['"])?/, 'command'], // CLI: click, typer
	[/\.add_parser\s*\(\s*['"]([\w-]+)['"]/, ''], // argparse subcommands
	[/@(Scheduled|EventListener|KafkaListener|RabbitListener|JmsListener|Subscribe)\b/, ''], // Java/Spring events and jobs
	[/\b(?:cron\.schedule|schedule\.every|setInterval)\s*\(/, 'timer'],
];

const RULE =/\b(throw\s+new\s+\w*|raise\s+\w+|HTTPException\s*\(|abort\s*\(\s*4\d\d|status(?:Code)?\s*[(=:]\s*4\d\d|send\w*\s*\([^,]*,\s*4\d\d|res\.status\(\s*4\d\d|return\s+4\d\d|\bassert\s*[.(]|\.(?:min|max|length|regex|email|positive|nonempty)\s*\(|@(?:Is\w+|Min|Max|Length|NotNull|NotBlank|NotEmpty|Size|Pattern|Email)\b|Field\([^)]*(?:gt|lt|ge|le|min_length|max_length)\s*=|required\s*:\s*true|panic\s*\()/;

function ruleKind(line: string): Rule['kind'] {
	if (/auth|token|permission|role|owner|forbidden|unauthori[sz]ed|login|\b40[13]\b|admin/i.test(line)) return 'auth';
	if (/limit|too (large|long|many)|max|min|length|size|\b413\b|\b429\b|exceed/i.test(line)) return 'limit';
	if (/valid|required|must|invalid|missing|empty|format|\b400\b|\b422\b|assert|@Is|Field\(|\.(min|max|email|regex)/i.test(line)) return 'validation';
	return 'error';
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[\w]+$|(^|\/)test_[^/]+\.py$|_test\.go$|Tests?\.(java|kt|cs|swift|m)$/i;
const COMMENT = /^\s*(\/\/|#(?!include|import)|\*|\/\*|<!--|--)/;

function dtoFields(lines: string[], from: number, to: number, lang: Lang, kind: Dto['kind']): Field[] {
	const out: Field[] = [];
	for (let i = from; i <= to && out.length < 40; i++) {
		const l = lines[i];
		let m: RegExpExecArray | null;
		if (kind === 'schema' && (m = /^\s*([A-Za-z_]\w*)\s*:\s*(?:z|Joi|yup|t|S)\.(\w+)/.exec(l))) out.push({ name: m[1], type: m[2], optional: /\.optional\(|\.nullish\(/.test(l) });
		else if (kind === 'schema' && (m = /^\s*([A-Za-z_]\w*)\s*:\s*\{?\s*type\s*:\s*(\w+)/.exec(l))) out.push({ name: m[1], type: m[2], optional: !/required\s*:\s*true/.test(l) });
		else if (lang === 'go' && (m = /^\s*([A-Z]\w*)\s+([\w.*\[\]]+)/.exec(l))) out.push({ name: m[1], type: m[2] });
		else if (lang === 'py' && (m = /^\s+([a-z_]\w*)\s*:\s*([^=#]+?)\s*(?:=.*)?$/.exec(l))) out.push({ name: m[1], type: m[2].trim(), optional: /Optional|None|=/.test(l) });
		else if (lang === 'js' && (m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^;,=]+?)\s*[;,]?\s*$/.exec(l)) && !/\(/.test(m[1])) out.push({ name: m[1], type: m[3].trim(), optional: !!m[2] });
		else if (lang === 'java' && (m = /^\s*(?:private|public|protected)?\s*(?:final\s+)?([\w<>\[\],.?]+)\s+([a-z]\w*)\s*;/.exec(l))) out.push({ name: m[2], type: m[1] });
	}
	return out;
}

/** Everything the index knows about one file. */
export function indexFile(path: string, text: string): FileIndex {
	const lang = langOf(path), lines = text.split('\n');
	// Kotlin and Swift lines don't end in ";", so the Java-style method pattern would take every call (`print(x)`,
	// `Button("Save") {`) for a method: there, functions are only what `fun`/`func`/`init` declare.
	const noSemi = /\.(kts?|swift)$/i.test(path);
	const f: FileIndex = { path, lang, lines: lines.length, imports: [], symbols: [], routes: [], events: [], dtos: [], rules: [], calls: Object.create(null) as Record<string, string[]> }; // no prototype: a method named "constructor" or "toString" must not find Object's own
	const classes: Array<{ name: string; end: number }> = [];
	const test = TEST_FILE.test(path);
	let urlPath = '';
	lines.forEach((raw, i) => {
		if (raw.length > 400 || COMMENT.test(raw)) return; // minified or generated, and keeps every pattern's work small
		const line = i + 1;
		// Imports: relative ones are resolved later against the file list.
		for (const m of raw.matchAll(/(?:require\(\s*|from\s+|import\s+)['"]([^'"]+)['"]/g)) f.imports.push(m[1]);
		const py = lang === 'py' && /^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import|^\s*import\s+([\w.]+)/.exec(raw);
		if (py) f.imports.push(py[1] ?? py[2]);
		// Symbols.
		for (const [re, kind] of noSemi ? [...SWIFT_KOTLIN, ...SYMBOLS.java.filter(([, k]) => k !== 'method')] : SYMBOLS[lang]) {
			const m = re.exec(raw);
			if (!m || KEYWORDS.has(m[1])) continue;
			const inClass = classes.find(c => i <= c.end);
			if (kind === 'method' && !inClass) continue;
			if (kind === 'function' && lang === 'c' && /^\s*(else|return|if)\b/.test(raw)) continue;
			if (lang === 'objc' && kind === 'method' && /;\s*$/.test(raw)) continue; // a declaration in @interface, not a body
			const end = lang === 'objc' && kind === 'class' ? Math.max(i, lines.findIndex((l, k) => k > i && /^\s*@end\b/.test(l))) : blockEnd(lines, i, 5000);
			const sym: Sym = { name: m[1], kind: inClass && kind !== 'class' ? 'method' : kind, line, end: end + 1, signature: raw.trim().replace(/\s*\{\s*$/, '').slice(0, 160) };
			if (inClass && sym.kind === 'method') sym.parent = inClass.name;
			if (/^\s*export\b|^\s*(module\.)?exports\.|^\s*pub\b|^\s*public\b/.test(raw) || (lang === 'go' && /^[A-Z]/.test(m[1]))) sym.exported = true;
			if (kind === 'class') classes.push({ name: m[1], end });
			f.symbols.push(sym);
			break;
		}
		// Routes, including hand-rolled routers: `req.method === 'GET'` under a `url.match(/^\/todos/)`.
		const um = /match\(\s*\/\^?\\?\/([\w/-]+)/.exec(raw);
		if (um) urlPath = '/' + um[1].replace(/\\\//g, '/');
		for (const re of ROUTES) {
			const m = re.exec(raw);
			if (m) { const method = m[2] !== undefined && m.length > 2 ? m[1] : 'ANY', p = m[2] ?? m[1]; f.routes.push({ method: method.toUpperCase().replace('REQUEST', 'ANY').replace('ROUTE', 'ANY'), path: p || '/', line }); break; }
		}
		const hm = /req(?:uest)?\.method\s*===?\s*['"](\w+)['"]/.exec(raw);
		if (hm) f.routes.push({ method: hm[1].toUpperCase(), path: urlPath || '/', line });
		// UI and app events (tests fire events; they don't handle them).
		if (!test) for (const [re, fallback] of EVENTS) {
			const m = re.exec(raw);
			if (!m) continue;
			const e: UiEvent = { on: m[1] || fallback || 'event', line };
			const named = /\bandroid:on\w+\s*=\s*"([A-Za-z_]\w*)"|\bselector="([A-Za-z_]\w*):?"/.exec(raw); // layouts and storyboards name their handler
			if (named) e.calls = named[1] ?? named[2];
			f.events.push(e);
			break;
		}
		// DTOs and data shapes.
		let dm: RegExpExecArray | null, kind: Dto['kind'] | undefined, name = '';
		if (lang === 'js' && (dm = /^\s*(?:export\s+)?interface\s+([A-Z]\w*)/.exec(raw))) { kind = 'interface'; name = dm[1]; }
		else if (lang === 'js' && (dm = /^\s*(?:export\s+)?type\s+([A-Z]\w*)\s*=\s*\{/.exec(raw))) { kind = 'type'; name = dm[1]; }
		else if (lang === 'js' && (dm = /^\s*(?:export\s+)?const\s+([A-Za-z]\w*)\s*=\s*(?:z|Joi|yup)\.object\s*\(/.exec(raw))) { kind = 'schema'; name = dm[1]; }
		else if (lang === 'js' && (dm = /^\s*(?:export\s+)?const\s+([A-Za-z]\w*)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(/.exec(raw))) { kind = 'schema'; name = dm[1]; }
		else if (lang === 'js' && (dm = /^\s*(?:export\s+)?class\s+([A-Z]\w*(?:Dto|DTO|Request|Response|Input|Payload|Entity|Model|Body|Params))\b/.exec(raw))) { kind = 'class'; name = dm[1]; }
		else if (lang === 'py' && (dm = /^\s*class\s+([A-Za-z_]\w*)\s*\(\s*(?:\w+\.)?(BaseModel|Schema|TypedDict|Model|SQLModel)\b/.exec(raw))) { kind = 'model'; name = dm[1]; }
		else if (lang === 'py' && /^\s*@dataclass/.test(lines[i - 1] ?? '') && (dm = /^\s*class\s+([A-Za-z_]\w*)/.exec(raw))) { kind = 'model'; name = dm[1]; }
		else if (lang === 'go' && (dm = /^type\s+([A-Za-z_]\w*)\s+struct\b/.exec(raw))) { kind = 'struct'; name = dm[1]; }
		else if (lang === 'java' && (dm = /\brecord\s+([A-Z]\w*)\s*\(([^)]*)\)/.exec(raw))) {
			f.dtos.push({ name: dm[1], kind: 'record', line, end: line, fields: dm[2].split(',').map(p => p.trim().split(/\s+/)).filter(p => p.length >= 2).map(p => ({ name: p[p.length - 1], type: p.slice(0, -1).join(' ') })) });
		} else if (lang === 'java' && (dm = /\bclass\s+([A-Z]\w*(?:Dto|DTO|Request|Response|Entity|Model))\b/.exec(raw))) { kind = 'class'; name = dm[1]; }
		else if (lang === 'js' && (dm = /^\s*(?:const|let)\s+([a-z]\w*)\s*=\s*\{\s*([A-Za-z_$][\w$]*\s*(?::[^,}]+)?(?:,\s*[A-Za-z_$][\w$]*\s*(?::[^,}]+)?)+)\s*\}\s*;?\s*$/.exec(raw))) {
			// A record built inline, e.g. `const todo = { id: nextId++, title, done: false }`: the shape the code passes around.
			f.dtos.push({ name: dm[1], kind: 'object', line, end: line, fields: dm[2].split(',').map(p => p.split(':')[0].trim()).filter(Boolean).map(n => ({ name: n })) });
		}
		if (kind) {
			const end = blockEnd(lines, i, 400);
			f.dtos.push({ name, kind, line, end: end + 1, fields: dtoFields(lines, i + 1, end, lang, kind) });
		}
		// Business rules: guards that reject (throw, 4xx, assert) and declarative validation. Tests check rules; they don't make them.
		if (!test && !/\brequire\(|^\s*import\b/.test(raw) && RULE.test(raw)) {
			const at = [...f.symbols].reverse().find(s => s.line <= line && line <= s.end && s.kind !== 'class');
			f.rules.push({ line, text: raw.trim().slice(0, 160), kind: ruleKind(raw), in: at?.name });
		}
		// Entry points.
		if (!f.entry && !test) {
			if (/\.listen\s*\(/.test(raw)) f.entry = 'starts the server (listen)';
			else if (/\bcreateServer\s*\(/.test(raw)) f.entry = 'creates the HTTP server';
			else if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(raw)) f.entry = 'runs as a script (__main__)';
			else if (/^func\s+main\s*\(\s*\)/.test(raw) || /\bint\s+main\s*\(/.test(raw) || /static\s+void\s+main\s*\(/.test(raw) || /^\s*fn\s+main\s*\(/.test(raw)) f.entry = 'main()';
			else if (/\bexport\s+function\s+activate\s*\(/.test(raw)) f.entry = 'extension activate()';
			else if (/\b(uvicorn\.run|app\.run|createApp|bootstrap)\s*\(/.test(raw)) f.entry = 'starts the app';
			else if (/\b(createRoot|hydrateRoot)\s*\(|\bReactDOM\.render\s*\(|\bAppRegistry\.registerComponent\s*\(/.test(raw)) f.entry = 'mounts the React UI';
			else if (/\brunApp\s*\(/.test(raw)) f.entry = 'starts the Flutter app (runApp)';
			else if (/\bSpringApplication\.run\s*\(|@SpringBootApplication\b/.test(raw)) f.entry = 'starts the Spring Boot app';
			else if (/\bextends\s+Application\b|\bApplication\.launch\s*\(|^\s*launch\s*\(\s*args\s*\)/.test(raw)) f.entry = 'starts the JavaFX app';
			else if (/\b(SwingUtilities|EventQueue)\.invokeLater\s*\(/.test(raw)) f.entry = 'starts the Swing UI';
			else if (/\bclass\s+\w+\s*(?:extends|:)\s*(?:AppCompat|Component|Fragment)?Activity\b/.test(raw)) f.entry = 'an Android screen (Activity)';
			else if (/didFinishLaunchingWithOptions/.test(raw)) f.entry = 'the app delegate: where the iOS app launches';
			else if (/^\s*@main\b|\bUIApplicationMain\b|:\s*App\s*\{/.test(raw)) f.entry = 'the app\'s entry (@main)';
			else if (/\bapp\.whenReady\s*\(|new\s+BrowserWindow\s*\(/.test(raw)) f.entry = 'starts the Electron app';
			else if (/\.mainloop\s*\(\s*\)|\bapp\.exec_?\s*\(\s*\)|\bQApplication\s*\(/.test(raw)) f.entry = 'runs the desktop UI loop';
			else if (/\bstatic\s+(?:async\s+)?(?:void|int|Task)\s+Main\s*\(|\bWebApplication\.CreateBuilder\s*\(/.test(raw)) f.entry = 'Main()';
			else if (/\bprogram\.parse\s*\(|\byargs\b.*\.argv\b|\bargparse\.ArgumentParser\s*\(/.test(raw)) f.entry = 'reads the command line';
		}
	});
	return f;
}

/** Resolve an import written in `from` against the project's files ("./store" → "src/store.js"). */
function resolveImport(from: string, spec: string, known: ReadonlySet<string>): string | undefined {
	if (/\.h$/.test(spec)) { // C / Objective-C: #import "TodoStore.h" names a header somewhere in the project
		const dir = from.split('/').slice(0, -1).join('/');
		return [dir ? `${dir}/${spec}` : spec, spec].find(p => known.has(p)) ?? [...known].find(k => k.endsWith(`/${spec}`));
	}
	if (!spec.startsWith('.')) {
		// Python package imports ("app.models") map to paths; anything else is a library.
		const asPath = spec.replace(/\./g, '/');
		return [`${asPath}.py`, `${asPath}/__init__.py`].find(p => known.has(p)) ?? [...known].find(k => k.endsWith(`/${asPath}.py`));
	}
	const parts = from.split('/').slice(0, -1);
	const dots = /^\.+$/.test(spec.split('/')[0]) && !spec.startsWith('./') && !spec.startsWith('../') ? spec : '';
	if (dots) { // python relative: "..models"
		const up = dots.match(/^\.+/)![0].length - 1;
		const rest = dots.slice(up + 1).replace(/\./g, '/');
		const base = parts.slice(0, parts.length - up).join('/');
		return [`${base}/${rest}.py`, `${base}/${rest}/__init__.py`].map(p => p.replace(/^\//, '')).find(p => known.has(p));
	}
	for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
	const base = parts.join('/');
	return [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.vue'].map(e => base + e), ...['/index.ts', '/index.js'].map(e => base + e)].find(p => known.has(p));
}

/** The index of a whole project: every file, who imports whom, and who calls whom. */
export function indexProject(files: ReadonlyArray<{ path: string; text: string }>): ProjectIndex {
	const known = new Set(files.map(f => f.path));
	const idx: ProjectIndex = { files: new Map(), importedBy: new Map(), definedIn: new Map(), callers: new Map() };
	for (const f of files) {
		const fi = indexFile(f.path, f.text);
		fi.imports = [...new Set(fi.imports.map(s => resolveImport(f.path, s, known) ?? (s.startsWith('.') ? '' : s)).filter(Boolean))];
		idx.files.set(f.path, fi);
		for (const s of fi.symbols) if (s.kind !== 'class') idx.definedIn.set(s.name, [...idx.definedIn.get(s.name) ?? [], f.path]);
	}
	for (const fi of idx.files.values()) for (const i of fi.imports) if (known.has(i)) idx.importedBy.set(i, [...idx.importedBy.get(i) ?? [], fi.path]);
	// Calls: inside each function, the names of project functions followed by "(".
	const names = new Set([...idx.definedIn.keys()].filter(n => n.length > 2));
	for (const f of files) {
		const fi = idx.files.get(f.path)!, lines = f.text.split('\n');
		for (const s of fi.symbols) {
			if (s.kind === 'class') continue;
			const body = lines.slice(s.line, s.end).join('\n');
			const called = [...new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]).filter(n => n !== s.name && names.has(n) && !KEYWORDS.has(n)))];
			if (called.length) fi.calls[s.name] = called;
			for (const c of called) idx.callers.set(c, [...idx.callers.get(c) ?? [], s.name]);
		}
	}
	return idx;
}

/** A file's structure in a few lines, with real line numbers: what a reader (or the model) needs when the body doesn't fit. */
export function outline(fi: FileIndex): string {
	const out: string[] = [];
	if (fi.entry) out.push(`entry point: ${fi.entry}`);
	const local = fi.imports.filter(i => i.includes('/') || i.includes('.'));
	if (local.length) out.push(`imports: ${local.slice(0, 12).join(', ')}`);
	for (const r of fi.routes) out.push(`${String(r.line).padStart(4)} | route ${r.method} ${r.path}`);
	for (const e of fi.events.slice(0, 30)) out.push(`${String(e.line).padStart(4)} | on ${e.on}`);
	for (const d of fi.dtos) out.push(`${String(d.line).padStart(4)} | ${d.kind} ${d.name} { ${d.fields.map(x => x.name + (x.optional ? '?' : '') + (x.type ? `: ${x.type}` : '')).join(', ')} }`);
	for (const s of fi.symbols) out.push(`${String(s.line).padStart(4)} | ${s.parent ? '  ' : ''}${s.signature}  (lines ${s.line}-${s.end}${fi.calls[s.name]?.length ? `; calls ${fi.calls[s.name].slice(0, 6).join(', ')}` : ''})`);
	for (const r of fi.rules.slice(0, 30)) out.push(`${String(r.line).padStart(4)} | rule (${r.kind}${r.in ? ` in ${r.in}` : ''}): ${r.text.slice(0, 110)}`);
	return out.join('\n');
}
