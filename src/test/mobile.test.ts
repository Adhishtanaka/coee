import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packagesFromCatalog, packagesFromGradle, packagesFromPackageResolved, packagesFromPom, packagesFromPubspecLock } from '../deps';
import { appConfigChecks } from '../facts';
import { fitProof, proofCommand, proofPath } from '../proof';

const pkgs = (list: Array<{ name: string; version: string; ecosystem: string }>) => list.map(p => `${p.ecosystem}:${p.name}@${p.version}`);

test('deps: Gradle (Groovy and Kotlin), version catalogs and Maven, literal versions only', () => {
	const gradle = [
		"implementation 'com.squareup.okhttp3:okhttp:3.12.0'",
		'implementation("com.google.code.gson:gson:2.8.5")',
		'testImplementation("junit:junit:4.12")',
		'implementation("androidx.core:core-ktx:$coreVersion")', // a variable: skipped
		"implementation 'com.example:lib:1.+'",                    // a range: skipped
		'implementation(libs.retrofit)',                            // the catalog has it
	].join('\n');
	assert.deepEqual(pkgs(packagesFromGradle(gradle)), ['Maven:com.squareup.okhttp3:okhttp@3.12.0', 'Maven:com.google.code.gson:gson@2.8.5', 'Maven:junit:junit@4.12']);
	const catalog = '[versions]\nretrofit = "2.5.0"\n\n[libraries]\nretrofit = { module = "com.squareup.retrofit2:retrofit", version.ref = "retrofit" }\nmoshi = { group = "com.squareup.moshi", name = "moshi", version = "1.8.0" }\nokio = "com.squareup.okio:okio:2.2.0"\n';
	assert.deepEqual(pkgs(packagesFromCatalog(catalog)), ['Maven:com.squareup.retrofit2:retrofit@2.5.0', 'Maven:com.squareup.moshi:moshi@1.8.0', 'Maven:com.squareup.okio:okio@2.2.0']);
	const pom = '<dependency>\n  <groupId>org.apache.logging.log4j</groupId>\n  <artifactId>log4j-core</artifactId>\n  <version>2.14.1</version>\n</dependency>\n<dependency><groupId>a</groupId><artifactId>b</artifactId><version>${b.version}</version></dependency>';
	assert.deepEqual(pkgs(packagesFromPom(pom)), ['Maven:org.apache.logging.log4j:log4j-core@2.14.1']);
});

test('deps: Flutter pubspec.lock (hosted only) and Swift Package.resolved (v1 and v2), named the way OSV names them', () => {
	const lock = 'packages:\n  http:\n    dependency: "direct main"\n    description:\n      name: http\n    source: hosted\n    version: "0.12.0"\n  my_local:\n    dependency: "direct main"\n    source: path\n    version: "1.0.0"\nsdks:\n  dart: ">=2.12.0 <3.0.0"\n';
	assert.deepEqual(pkgs(packagesFromPubspecLock(lock)), ['Pub:http@0.12.0']);
	const v2 = JSON.stringify({ pins: [{ identity: 'swift-nio', location: 'https://github.com/apple/swift-nio.git', state: { version: '2.0.0' } }, { identity: 'x', location: 'https://github.com/a/x', state: { branch: 'main' } }], version: 2 });
	const v1 = JSON.stringify({ object: { pins: [{ package: 'Alamofire', repositoryURL: 'git@github.com:Alamofire/Alamofire.git', state: { version: '4.0.0' } }] }, version: 1 });
	assert.deepEqual(pkgs(packagesFromPackageResolved(v2)), ['SwiftURL:github.com/apple/swift-nio@2.0.0']);
	assert.deepEqual(pkgs(packagesFromPackageResolved(v1)), ['SwiftURL:github.com/Alamofire/Alamofire@4.0.0']);
});

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:debuggable="true"
        android:usesCleartextTraffic="true">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <activity android:name=".LinkActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.BROWSABLE" />
            </intent-filter>
        </activity>
        <provider android:name=".NotesProvider"
            android:authorities="x.notes"
            android:exported="true" />
        <service android:name=".SyncService" android:exported="true" android:permission="x.SYNC" />
        <receiver android:name=".Private" android:exported="false" />
    </application>
</manifest>`;

test('app settings: AndroidManifest problems, with the launcher screen and protected components left alone', () => {
	const hits = appConfigChecks(new Map([['app/src/main/AndroidManifest.xml', MANIFEST]]));
	assert.deepEqual(hits.map(h => [h.rule, h.line]), [['android-debuggable', 4], ['android-cleartext', 5], ['android-allow-backup', 3], ['android-deep-link', 12], ['android-exported', 18]]);
	assert.equal(hits.find(h => h.rule === 'android-exported')!.severity, 'high'); // a provider: its data is readable
});

test('app settings: network security config and Info.plist', () => {
	const hits = appConfigChecks(new Map([
		['res/xml/network_security_config.xml', '<network-security-config>\n  <base-config cleartextTrafficPermitted="true">\n    <trust-anchors>\n      <certificates src="user" />\n    </trust-anchors>\n  </base-config>\n</network-security-config>'],
		['Todo/Info.plist', '<dict>\n  <key>NSAppTransportSecurity</key>\n  <dict>\n    <key>NSAllowsArbitraryLoads</key>\n    <true/>\n  </dict>\n</dict>'],
		['Safe/Info.plist', '<dict>\n  <key>NSAllowsArbitraryLoads</key>\n  <false/>\n</dict>'],
	]));
	assert.deepEqual(hits.map(h => [h.rule, h.file, h.line]), [['android-cleartext', 'res/xml/network_security_config.xml', 2], ['android-user-certs', 'res/xml/network_security_config.xml', 4], ['ios-ats-off', 'Todo/Info.plist', 4]]);
});

test('proofs: JVM, Swift and Dart tests go where their build tool runs them, with the right command', () => {
	const has = (...files: string[]) => (p: string) => files.includes(p);
	const kt = proofPath('app/src/main/java/com/x/Notes.kt', 'f1');
	assert.equal(kt, 'app/src/test/java/com/x/CoeeProof_f1Test.kt');
	assert.deepEqual(proofCommand(kt, undefined, has('gradlew')), { command: process.platform === 'win32' ? 'gradlew.bat' : './gradlew', args: [':app:test', '--tests', '*CoeeProof_f1Test'], framework: 'Gradle' });
	const java = proofPath('src/main/java/com/x/Login.java', 'f2');
	assert.equal(java, 'src/test/java/com/x/CoeeProof_f2Test.java');
	assert.deepEqual(proofCommand(java, undefined, has('pom.xml'))!.args, ['-q', 'test', '-Dtest=CoeeProof_f2Test', '-Dsurefire.failIfNoSpecifiedTests=false']);
	assert.equal(proofCommand(java, undefined, has()), undefined); // no build tool: say so rather than guess
	const swift = proofPath('Sources/TodoKit/Store.swift', 'f3');
	assert.equal(swift, 'Tests/TodoKitTests/CoeeProof_f3Tests.swift');
	assert.deepEqual(proofCommand(swift, undefined, has('Package.swift'))!.args, ['test', '--filter', 'CoeeProof_f3Tests']);
	assert.equal(proofCommand('App/CoeeProof_f3Tests.swift', undefined, has()), undefined); // an Xcode app: needs its scheme
	const dart = proofPath('lib/src/api.dart', 'f4');
	assert.equal(dart, 'test/coee_proof_f4_test.dart');
	assert.equal(proofCommand(dart, 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n', has())!.framework, 'flutter test');
	assert.equal(proofCommand(dart, 'name: cli\n', has())!.framework, 'dart test');
	// Java needs the class named after its file; the runner filters by that name too.
	assert.equal(fitProof(java, 'package com.x;\npublic class LoginProofTest {\n}'), 'package com.x;\npublic class CoeeProof_f2Test {\n}');
	assert.equal(fitProof('a.test.js', 'class X {}'), 'class X {}');
});
