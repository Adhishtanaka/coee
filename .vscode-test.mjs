// Integration tests: a real VS Code, a copy of fixtures/app made into a git repository, and a fake chat model.
import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const workspace = mkdtempSync(join(tmpdir(), 'coee-it-'));
cpSync('fixtures/app', workspace, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: workspace });
git('init', '-q');
git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '.');
git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'start');

// An installed VS Code is used when there is one (no 340 MB download); COEE_VSCODE points at another.
const installed = [process.env.COEE_VSCODE, '/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].find(p => p && existsSync(p));

export default defineConfig({
	...(installed ? { useInstallation: { fromPath: installed } } : {}),
	files: 'out/integration/**/*.test.js',
	workspaceFolder: workspace,
	launchArgs: ['--disable-workspace-trust', '--disable-extensions'],
	mocha: { ui: 'tdd', timeout: 60_000 },
});
