import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, entropy, mask, scanText } from '../rules';

// Every rule: a line it must flag, and a near miss it must leave alone. Built with join so this file itself holds no live-looking secrets.
const k = (...p: string[]) => p.join('');
const CASES: Record<string, { file: string; hit: string; miss: string }> = {
	'secret-aws': { file: 'a.js', hit: k("const id = 'AKIA", 'IOSFODNN7EXAMPLE', "';"), miss: "const id = 'AKIAshort';" },
	'secret-github': { file: 'a.yml', hit: k('token: ghp_', 'a'.repeat(36)), miss: 'token: ghp_short' },
	'secret-slack': { file: 'a.py', hit: k("SLACK = 'xoxb-", '1234567890-abcdef', "'"), miss: "SLACK = os.environ['SLACK']" },
	'secret-stripe': { file: 'config.js', hit: k("apiKey: 'sk_", 'live_51H8xYzAbCdEfGhIjKlMnOpQr', "'"), miss: "apiKey: 'sk_test_51H8xYzAbCdEf'" },
	'secret-google': { file: 'a.ts', hit: k("const g = 'AIza", 'SyA1234567890abcdefghijklmnopqrstuv', "';"), miss: "const g = 'AIzaShort';" },
	'secret-private-key': { file: 'key.pem.js', hit: k('-----BEGIN RSA ', 'PRIVATE KEY-----'), miss: '-----BEGIN PUBLIC KEY-----' },
	'secret-db-url': { file: '.env', hit: k('DATABASE_URL=postgres://app:', 'S3cretPw', '@db:5432/x'), miss: 'DATABASE_URL=postgres://app@db:5432/x' },
	'secret-generic': { file: 'config.js', hit: k("adminPassword: '", 'hunter2x9', "'"), miss: "adminPassword: 'changeme'" },
	'hardcoded-compare': { file: 'auth.js', hit: "if (password === 'letmein') ok();", miss: 'if (password === stored) ok();' },
	'js-eval': { file: 'a.js', hit: 'exports.calc = expr => eval(expr);', miss: 'const evaluate = x => x; // no eval here' },
	'js-function': { file: 'a.js', hit: "const f = new Function('a', body);", miss: 'function named() {}' },
	'js-exec': { file: 'files.js', hit: "exec('convert ' + title + ' out.png', done);", miss: "execFile('convert', [title, 'out.png'], done);" },
	'js-shell-true': { file: 'a.js', hit: "spawn('ls', [dir], { shell: true });", miss: "spawn('ls', [dir]);" },
	'py-shell': { file: 'a.py', hit: "subprocess.run(cmd, shell=True)", miss: "subprocess.run(['ls', d])" },
	'py-eval': { file: 'a.py', hit: 'value = eval(request.args["x"])', miss: 'value = ast.literal_eval(text)' },
	'sql-concat': { file: 'db.js', hit: "db.query(`SELECT * FROM todos WHERE id = ${id}`);", miss: "db.query('SELECT * FROM todos WHERE id = $1', [id]);" },
	'xss-inner-html': { file: 'ui.js', hit: 'list.innerHTML = todo.title;', miss: "list.innerHTML = '';" },
	'xss-document-write': { file: 'ui.js', hit: 'document.write(location.hash);', miss: "document.write('<p>static</p>');" },
	'xss-react': { file: 'A.tsx', hit: '<div dangerouslySetInnerHTML={{ __html: html }} />', miss: '<div>{html}</div>' },
	'xss-vue': { file: 'A.vue', hit: '<p v-html="comment"></p>', miss: '<p>{{ comment }}</p>' },
	'xss-html-concat': { file: 'files.js', hit: "todos.map(t => '<li>' + t.title + '</li>')", miss: "todos.map(t => esc(t.title))" },
	'path-traversal': { file: 'files.js', hit: "res.end(fs.readFileSync('./uploads/' + name));", miss: "fs.readFileSync(path.join(__dirname, 'static.txt'));" },
	'py-path': { file: 'a.py', hit: "open('/data/' + name)", miss: "open(SAFE_PATH)" },
	'ssrf': { file: 'a.js', hit: 'const r = await fetch(req.query.url);', miss: "const r = await fetch('https://api.example.com');" },
	'open-redirect': { file: 'a.js', hit: 'res.redirect(req.query.next);', miss: "res.redirect('/home');" },
	'py-pickle': { file: 'a.py', hit: 'obj = pickle.loads(data)', miss: 'obj = json.loads(data)' },
	'py-yaml': { file: 'a.py', hit: 'cfg = yaml.load(f)', miss: 'cfg = yaml.load(f, Loader=yaml.SafeLoader)' },
	'unsafe-deserialize': { file: 'a.php', hit: '$o = unserialize($_POST["d"]);', miss: '$o = json_decode($_POST["d"]);' },
	'c-gets': { file: 'a.c', hit: 'gets(buf);', miss: 'fgets(buf, sizeof buf, stdin);' },
	'c-strcpy': { file: 'a.c', hit: 'strcpy(dst, src);', miss: 'strlcpy(dst, src, sizeof dst);' },
	'c-scanf': { file: 'a.c', hit: 'scanf("%s", name);', miss: 'scanf("%63s", name);' },
	'weak-hash': { file: 'a.js', hit: "crypto.createHash('md5').update(pw)", miss: "crypto.createHash('sha256').update(data)" },
	'weak-random': { file: 'files.js', hit: 'exports.token = () => Math.random().toString(36).slice(2);', miss: 'const jitter = Math.random() * 100;' },
	'weak-cipher': { file: 'a.js', hit: "crypto.createCipheriv('aes-128-ecb', key, null)", miss: "crypto.createCipheriv('aes-256-gcm', key, iv)" },
	'mobile-insecure-storage': { file: 'Session.m', hit: '[[NSUserDefaults standardUserDefaults] setObject:token forKey:@"authToken"];', miss: '[[NSUserDefaults standardUserDefaults] setBool:YES forKey:@"darkMode"];' },
	'keychain-always': { file: 'Keychain.swift', hit: 'kSecAttrAccessible: kSecAttrAccessibleAlways,', miss: 'kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,' },
	'webview-js-bridge': { file: 'Web.kt', hit: 'webView.addJavascriptInterface(Bridge(), "app")', miss: 'webView.loadUrl("https://example.com")' },
	'tls-off': { file: 'a.js', hit: 'https.request({ rejectUnauthorized: false })', miss: 'https.request({ rejectUnauthorized: true })' },
	'cors-any': { file: 'a.js', hit: "res.setHeader('Access-Control-Allow-Origin', '*');", miss: "res.setHeader('Access-Control-Allow-Origin', 'https://app.example.com');" },
	'debug-on': { file: 'app.py', hit: 'app.run(debug=True)', miss: 'app.run(debug=os.environ.get("DEBUG") == "1")' },
	'jwt-none': { file: 'a.js', hit: "jwt.verify(t, key, { algorithms: ['none'] })", miss: "jwt.verify(t, key, { algorithms: ['HS256'] })" },
	'cookie-flags': { file: 'a.js', hit: "res.cookie('sid', id, { httpOnly: false })", miss: "res.cookie('sid', id, { httpOnly: true, secure: true })" },
	'idor-lookup': { file: 'a.js', hit: 'const order = await Order.findById(req.params.id);', miss: 'const order = await Order.findOne({ _id: id, ownerId: user.id });' },
	'mass-assignment': { file: 'a.js', hit: 'await User.create(req.body);', miss: 'await User.create({ name: req.body.name });' },
	'csrf-off': { file: 'views.py', hit: '@csrf_exempt', miss: '@login_required' },
	'jwt-secret-literal': { file: 'a.js', hit: "const t = jwt.sign({ id }, 'supersecret');", miss: 'const t = jwt.sign({ id }, process.env.JWT_SECRET);' },
	'plain-http': { file: 'a.js', hit: "await fetch('http://api.example.com/data');", miss: "await fetch('http://localhost:3000/data');" },
	'nosql-injection': { file: 'a.js', hit: 'const user = await User.findOne(req.body);', miss: 'const user = await User.findOne({ email: String(req.body.email) });' },
	'template-injection': { file: 'app.py', hit: 'return render_template_string(request.args["page"])', miss: 'return render_template("page.html", name=name)' },
	'body-no-limit': { file: 'app.js', hit: 'app.use(express.json());', miss: "app.use(express.json({ limit: '100kb' }));" },
	'upload-unrestricted': { file: 'a.js', hit: "const upload = multer({ dest: 'uploads/' });", miss: "const upload = multer({ dest: 'uploads/', limits: { fileSize: 1e6 } });" },
	'regex-from-input': { file: 'a.js', hit: 'const re = new RegExp(req.query.q);', miss: "const re = new RegExp('^[a-z]+$');" },
	'error-leak': { file: 'server.js', hit: 'send(res, 400, { error: err.message });', miss: "send(res, 400, { error: 'Bad request' });" },
	'serve-index': { file: 'a.js', hit: "app.use('/files', serveIndex('public'));", miss: "app.use('/files', express.static('public'));" },
	'dep-unpinned': { file: 'package.json', hit: '    "express": "*",', miss: '    "express": "^4.19.2",' },
	'plaintext-password': { file: 'auth.js', hit: 'if (password === user.password) login();', miss: 'if (await bcrypt.compare(password, user.passwordHash)) login();' },
	'jwt-no-expiry': { file: 'a.js', hit: 'const t = jwt.sign({ id }, key);', miss: "const t = jwt.sign({ id }, key, { expiresIn: '15m' });" },
	'prototype-pollution': { file: 'a.js', hit: 'const settings = _.merge({}, defaults, req.body);', miss: 'const settings = { ...defaults, theme: req.body.theme };' },
	'script-no-integrity': { file: 'index.html', hit: '<script src="https://cdn.example.com/lib.js"></script>', miss: '<script src="https://cdn.example.com/lib.js" integrity="sha384-abc" crossorigin="anonymous"></script>' },
	'dynamic-require': { file: 'a.js', hit: 'const plugin = require(req.query.name);', miss: "const plugin = require('./plugins/' + PLUGINS[name]);" },
	'log-secret': { file: 'a.js', hit: "console.log('login', user, password);", miss: "console.log('login', user.id);" },
	'log-injection': { file: 'a.js', hit: "logger.info('search', req.query);", miss: "logger.info('search', { results: hits.length });" },
	'empty-catch': { file: 'a.js', hit: 'try { save(); } catch (e) {}', miss: 'try { save(); } catch (e) { log.error(e); }' },
	'ssrf-variable': { file: 'a.js', hit: 'const r = await fetch(`https://${req.query.host}/status`);', miss: 'const r = await fetch(`https://status.example.com/${encodeURIComponent(id)}`);' },
};

test('every rule has a hit and a near-miss case', () => {
	assert.deepEqual(RULES.map(r => r.id).filter(id => !CASES[id]), []);
});

for (const [id, c] of Object.entries(CASES)) {
	test(`rule ${id}: flags the hit, not the near miss`, () => {
		assert.ok(scanText(c.file, c.hit).some(h => h.rule === id), `missed: ${c.hit}`);
		assert.ok(!scanText(c.file, c.miss).some(h => h.rule === id), `false alarm: ${c.miss}`);
	});
}

test('rules only apply to their languages, and code rules skip comments', () => {
	assert.equal(scanText('a.py', "list.innerHTML = todo.title;").length, 0);
	assert.equal(scanText('a.js', '// we never call eval(x) here').length, 0);
	assert.ok(scanText('a.js', k('// old key: AKIA', 'IOSFODNN7EXAMPLE')).length); // a leaked key is leaked in a comment too
});

test('secrets are masked in what is shown; only the requested lines are checked', () => {
	const [hit] = scanText('config.js', k("apiKey: 'sk_", 'live_51H8xYzAbCdEfGhIjKlMnOpQr', "'"));
	assert.ok(!hit.text.includes('AbCdEfGhIjKlMnOpQr'));
	assert.match(hit.text, /sk_l…/);
	const text = 'const a = eval(x);\nconst b = eval(y);';
	assert.deepEqual(scanText('a.js', text, new Set([2])).map(h => h.line), [2]);
});

test('the planted flaws in the sample app are all caught by rules alone', () => {
	const files = {
		'config.js': k("module.exports = { apiKey: 'sk_", "live_51H8xYzAbCdEfGhIjKlMnOpQr', adminPassword: 'admin123' };"),
		'files.js': [
			"  res.end(fs.readFileSync('./uploads/' + name));",
			"exports.thumbnail = (title, done) => exec('convert ' + title + ' out.png', done);",
			'exports.calc = expr => eval(expr);',
			"exports.page = todos => '<ul>' + todos.map(t => '<li>' + t.title + '</li>').join('') + '</ul>';",
			'exports.token = () => Math.random().toString(36).slice(2);',
		].join('\n'),
	};
	const rules = Object.entries(files).flatMap(([f, t]) => scanText(f, t)).map(h => h.rule).sort();
	assert.deepEqual([...new Set(rules)], ['js-eval', 'js-exec', 'path-traversal', 'secret-generic', 'secret-stripe', 'weak-random', 'xss-html-concat']);
});

test('entropy and masking', () => {
	assert.ok(entropy('aaaaaaaa') < 1);
	assert.ok(entropy('x9Qz2LmP7vT4') > 3.3);
	assert.equal(mask("name: 'hello world'"), "name: 'hello world'");
});
