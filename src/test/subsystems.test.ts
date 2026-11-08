import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSubsystems, sampleTree } from '../subsystems';

const isSource = (p: string) => /\.(ts|js|go|rs|py)$/.test(p);
const fs = (files: Record<string, string>) => (p: string) => files[p];

test('npm workspaces: packages, their names, descriptions and who uses whom', () => {
	const files = {
		'package.json': JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }),
		'packages/core/package.json': JSON.stringify({ name: '@acme/core', description: 'Shared domain logic' }),
		'apps/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/core': 'workspace:*', react: '18' } }),
		'apps/web/README.md': '# Web\n\nThe customer-facing site.',
	};
	const paths = [...Object.keys(files), 'packages/core/src/a.ts', 'packages/core/src/b.ts', 'apps/web/src/page.ts', 'tools/x.js'];
	const s = detectSubsystems(paths, fs(files), isSource);
	assert.deepEqual(s.map(x => [x.path, x.name, x.files, x.uses]), [['apps/web', '@acme/web', 1, ['packages/core']], ['packages/core', '@acme/core', 2, []]]);
	assert.equal(s.find(x => x.path === 'packages/core')!.description, 'Shared domain logic');
});

test('pnpm, go.work and Cargo workspaces are read too', () => {
	const pnpm = detectSubsystems(['pnpm-workspace.yaml', 'libs/a/x.ts', 'libs/b/y.ts'], fs({ 'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n" }), isSource);
	assert.deepEqual(pnpm.map(x => x.path), ['libs/a', 'libs/b']);
	const go = detectSubsystems(['go.work', 'svc/api/main.go', 'svc/worker/main.go'], fs({ 'go.work': 'go 1.22\n\nuse (\n\t./svc/api\n\t./svc/worker\n)\n' }), isSource);
	assert.deepEqual(go.map(x => x.path), ['svc/api', 'svc/worker']);
	const cargo = detectSubsystems(['Cargo.toml', 'crates/a/src/lib.rs', 'crates/b/src/lib.rs'], fs({ 'Cargo.toml': '[workspace]\nmembers = ["crates/a", "crates/b"]\n' }), isSource);
	assert.deepEqual(cargo.map(x => x.path), ['crates/a', 'crates/b']);
});

test('no manifests: top-level code folders, looking inside a lone src/', () => {
	const paths = ['src/api/a.ts', 'src/api/b.ts', 'src/api/c.ts', 'src/db/a.ts', 'src/db/b.ts', 'src/db/c.ts', 'src/util/x.ts', 'README.md'];
	assert.deepEqual(detectSubsystems(paths, () => undefined, isSource).map(x => x.path), ['src/api', 'src/db']);
	assert.deepEqual(detectSubsystems(['a.ts', 'b.ts'], () => undefined, isSource), []); // small: no system level
});

test('nested packages belong to the outer one', () => {
	const files = { 'a/package.json': '{}', 'a/b/package.json': '{}', 'c/package.json': '{}' };
	assert.deepEqual(detectSubsystems([...Object.keys(files), 'a/x.ts', 'c/y.ts'], fs(files), isSource).map(x => x.path), ['a', 'c']);
});

test('sampleTree spreads a big tree across folders instead of cutting it alphabetically', () => {
	const paths = [...Array.from({ length: 50 }, (_, i) => `aaa/f${i}.ts`), 'zzz/main.ts', 'zzz/x.ts', 'index.ts'];
	const s = sampleTree(paths, 6);
	assert.equal(s.length, 6);
	assert.ok(s.includes('index.ts') && s.includes('zzz/main.ts'));
	assert.deepEqual(sampleTree(['a', 'b'], 5), ['a', 'b']);
});
