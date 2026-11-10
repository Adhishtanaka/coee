import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorKeys, planSteps } from '../steps';
import { SOURCE, indexFile, indexProject } from '../codeindex';

const SERVER = [
	'const server = http.createServer(async (req, res) => {', // 1
	'  const id = 1;',                                         // 2
	'',                                                        // 3
	"  if (req.method === 'GET') return send(res, 200, store.list());", // 4
	"  if (req.method === 'POST') {",                         // 5
	'    return send(res, 201, store.create(title));',         // 6
	'  }',                                                     // 7
	'});',                                                     // 8
];

test('anchorKeys: a key is placed by the code it quotes, not by a line number that is off', () => {
	const keys = anchorKeys(SERVER, 1, 8, [
		{ line: 5, note: 'lists todos', code: "if (req.method === 'GET') return send(res, 200, store.list());" }, // number one off
		{ line: 7, note: 'creates one', code: 'return send(res, 201, store.create(title));' },
		{ line: 4, note: 'made up', code: 'db.save(everything)' }, // quotes nothing here: dropped, never marks wrong code
	]);
	assert.deepEqual(keys.map(k => k.line), [4, 6]);
});

test('anchorKeys: without a quote, a key on a blank or brace line moves to real code; one outside the step is dropped', () => {
	assert.deepEqual(anchorKeys(SERVER, 1, 8, [{ line: 3, note: 'x' }, { line: 7, note: 'y' }, { line: 40, note: 'z' }]).map(k => k.line), [2, 6]);
});

test('events: UI handlers across toolkits are found; look-alikes are not', () => {
	const on = (path: string, src: string) => indexFile(path, src).events.map(e => e.on);
	assert.deepEqual(on('a.js', "btn.addEventListener('click', () => {\n  save();\n});"), ['click']);
	assert.deepEqual(on('A.jsx', 'return <button onClick={() => save()}>Save</button>;'), ['onClick']);
	assert.deepEqual(on('A.vue', '<button @click="save">Save</button>'), ['click']);
	assert.deepEqual(on('M.kt', 'button.setOnClickListener {\n  save()\n}'), ['Click']);
	assert.deepEqual(on('F.java', 'saveButton.addActionListener(e -> save());'), ['Action']);
	assert.deepEqual(on('main.dart', 'ElevatedButton(onPressed: () {\n  save();\n},'), ['onPressed']);
	assert.deepEqual(on('w.py', 'self.button.clicked.connect(self.save)'), ['clicked']);
	assert.deepEqual(on('F.cs', 'saveButton.Click += OnSaveClick;'), ['Click']);
	// Not events: a database connect, a running total, a Kotlin callback parameter.
	assert.deepEqual(on('db.js', 'await db.pool.connect();\ntotal += amount;'), []);
	assert.deepEqual(on('B.kt', 'fun Btn(onClick: () -> Unit) {'), []);
});

test('index: Kotlin and Swift functions with return types, and GUI entry points', () => {
	assert.deepEqual(indexFile('A.kt', 'fun total(items: List<Int>): Int {\n  return items.sum()\n}').symbols.map(s => [s.name, s.line, s.end]), [['total', 1, 3]]);
	assert.deepEqual(indexFile('A.swift', 'func load() -> [Todo] {\n  return []\n}').symbols.map(s => s.name), ['load']);
	const entry = (path: string, src: string) => indexFile(path, src).entry;
	assert.equal(entry('main.tsx', "createRoot(document.getElementById('root')!).render(<App />);"), 'mounts the React UI');
	assert.equal(entry('main.dart', 'void main() => runApp(const MyApp());'), 'starts the Flutter app (runApp)');
	assert.equal(entry('MainActivity.kt', 'class MainActivity : AppCompatActivity() {'), 'an Android screen (Activity)');
	assert.equal(entry('App.java', '@SpringBootApplication'), 'starts the Spring Boot app');
	assert.equal(entry('app.py', 'root.mainloop()'), 'runs the desktop UI loop');
});

test('steps: a top-level UI handler gets a step of its own', () => {
	const src = "const btn = document.querySelector('#save');\n\nbtn.addEventListener('click', () => {\n  save();\n  render();\n});\n";
	const steps = planSteps('app.js', src, 1, 6, { firstPart: true });
	assert.deepEqual(steps.map(s => [s.label, s.startLine, s.endLine]), [['Start here', 1, 1], ['handler on click', 3, 6]]);
});

test('Swift and Kotlin: calls are not methods; SwiftUI body, init and Button actions are found', () => {
	const swift = ['struct ContentView: View {', '    var body: some View {', '        Button("Save") {', '            save()', '        }', '    }', '    func save() {', '        print(title)', '    }', '    init(title: String) {', '        self.title = title', '    }', '}'].join('\n');
	const f = indexFile('ContentView.swift', swift);
	assert.deepEqual(f.symbols.map(s => [s.kind, s.name]), [['class', 'ContentView'], ['method', 'body'], ['method', 'save'], ['method', 'init']]);
	assert.deepEqual(f.events.map(e => [e.on, e.line]), [['tap', 3]]);
	const kt = indexFile('Screen.kt', '@Composable\nfun TodoScreen() {\n    Text("Hi")\n    Button(onClick = { add() }) {\n    }\n}');
	assert.deepEqual(kt.symbols.map(s => s.name), ['TodoScreen']);
});

test('Android layouts, storyboards and Objective-C: screens and their actions are found', () => {
	assert.ok(SOURCE.test('app/src/main/res/layout/activity_main.xml') && SOURCE.test('app/src/main/res/layout-land/row.xml'));
	assert.ok(!SOURCE.test('app/src/main/res/values/strings.xml') && !SOURCE.test('app/src/main/AndroidManifest.xml'));
	assert.ok(SOURCE.test('Todo/Base.lproj/Main.storyboard') && SOURCE.test('Todo/TodoCell.xib') && SOURCE.test('Todo/ViewController.m'));
	assert.deepEqual(indexFile('res/layout/a.xml', '<Button\n    android:id="@+id/save"\n    android:onClick="save" />').events.map(e => [e.on, e.line]), [['Click', 3]]);
	assert.deepEqual(indexFile('Main.storyboard', '<action selector="save:" destination="BYZ" eventType="touchUpInside" id="x1"/>').events.map(e => e.on), ['touchUpInside']);
	const objc = [
		'#import "TodoStore.h"',                       // 1
		'@interface ViewController ()',                 // 2
		'- (void)reload;',                              // 3: a declaration, not a method body
		'@end',                                         // 4
		'@implementation ViewController',               // 5
		'- (void)viewDidLoad {',                        // 6
		'    [super viewDidLoad];',                     // 7
		'    [self.button addTarget:self action:@selector(save:) forControlEvents:UIControlEventTouchUpInside];', // 8
		'}',                                            // 9
		'- (IBAction)save:(id)sender {',                // 10
		'    [self.store add:self.field.text];',        // 11
		'}',                                            // 12
		'@end',                                         // 13
	].join('\n');
	const f = indexFile('ViewController.m', objc);
	assert.deepEqual(f.symbols.map(s => [s.kind, s.name, s.line, s.end]), [['class', 'ViewController', 2, 4], ['class', 'ViewController', 5, 13], ['method', 'viewDidLoad', 6, 9], ['method', 'save', 10, 12]]);
	assert.deepEqual(f.events.map(e => [e.on, e.line]), [['save', 8], ['save', 10]]);
	assert.deepEqual(indexProject([{ path: 'Todo/ViewController.m', text: objc }, { path: 'Todo/TodoStore.h', text: '' }]).files.get('Todo/ViewController.m')!.imports, ['Todo/TodoStore.h']);
});

test('a layout or storyboard action links to the method it names, in the screen\'s own file first', async () => {
	const { projectFacts } = await import('../facts');
	const files = [
		{ path: 'app/src/main/res/layout/activity_main.xml', text: '<Button\n    android:onClick="save" />' },
		{ path: 'app/src/main/java/com/x/OtherActivity.kt', text: 'class OtherActivity : AppCompatActivity() {\n    fun save(v: View) {\n    }\n}' },
		{ path: 'app/src/main/java/com/x/MainActivity.kt', text: 'class MainActivity : AppCompatActivity() {\n    fun save(v: View) {\n        store.add()\n    }\n}' },
		{ path: 'Todo/Base.lproj/Main.storyboard', text: '<action selector="addTapped:" destination="BYZ" eventType="touchUpInside" id="a1"/>' },
		{ path: 'Todo/ViewController.swift', text: 'class ViewController: UIViewController {\n    @IBAction func addTapped(_ sender: Any) {\n    }\n}' },
	];
	const facts = projectFacts(indexProject(files), new Map(files.map(f => [f.path, f.text])));
	const at = (file: string) => facts.events.filter(e => e.file === file).map(e => [e.on, e.handler, e.handlerFile, e.handlerLine]);
	assert.deepEqual(at('app/src/main/res/layout/activity_main.xml'), [['Click', 'save', 'app/src/main/java/com/x/MainActivity.kt', 2]]);
	assert.deepEqual(at('Todo/Base.lproj/Main.storyboard'), [['touchUpInside', 'addTapped', 'Todo/ViewController.swift', 2]]);
});
