import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packagesFromLock, packagesFromRequirements, parseNpmAudit, parseOsv, parsePipAudit } from '../deps';

test('npm audit: one issue per advisory; packages only vulnerable through others are left to those', () => {
	const json = JSON.stringify({ vulnerabilities: {
		lodash: { name: 'lodash', severity: 'high', range: '<4.17.21', via: [{ title: 'Prototype Pollution', url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', source: 1 }], fixAvailable: { name: 'lodash', version: '4.17.21' } },
		express: { name: 'express', severity: 'moderate', via: ['body-parser'], fixAvailable: true },
	} });
	assert.deepEqual(parseNpmAudit(json), [{ name: 'lodash', version: '<4.17.21', file: 'package-lock.json', id: 'GHSA-p6mc-m468-83gw', title: 'Prototype Pollution', severity: 'high', fixed: 'lodash@4.17.21', url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw' }]);
	assert.deepEqual(parseNpmAudit('{}'), []);
});

test('pip-audit json', () => {
	const json = JSON.stringify({ dependencies: [{ name: 'flask', version: '0.12', vulns: [{ id: 'PYSEC-2019-179', fix_versions: ['1.0'], description: 'Denial of service\nmore' }] }, { name: 'ok', version: '1', vulns: [] }] });
	const [i] = parsePipAudit(json);
	assert.deepEqual([i.name, i.id, i.fixed, i.title], ['flask', 'PYSEC-2019-179', '1.0', 'Denial of service']);
});

test('lockfiles and requirements give name and version only', () => {
	const lock = JSON.stringify({ packages: { '': { version: '1.0.0' }, 'node_modules/a': { version: '1.2.3' }, 'node_modules/b/node_modules/a': { version: '0.1.0' } } });
	assert.deepEqual(packagesFromLock(lock).map(p => `${p.name}@${p.version}`), ['a@1.2.3', 'a@0.1.0']);
	assert.deepEqual(packagesFromRequirements('flask==2.0.1\nrequests>=2  # unpinned\n# comment\nuvicorn[standard]==0.20.0').map(p => `${p.name}@${p.version}`), ['flask@2.0.1', 'uvicorn@0.20.0']);
});

test('OSV answers are matched back to their packages, with severity and fixed version from the details', () => {
	const pkgs = [{ name: 'a', version: '1', ecosystem: 'npm' as const, file: 'package-lock.json' }, { name: 'b', version: '2', ecosystem: 'npm' as const, file: 'package-lock.json' }];
	const issues = parseOsv(pkgs, { results: [{}, { vulns: [{ id: 'GHSA-x' }] }] }, { 'GHSA-x': { summary: 'RCE in b', database_specific: { severity: 'CRITICAL' }, affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '2.1' }] }] }] } });
	assert.deepEqual(issues.map(i => [i.name, i.severity, i.fixed, i.title]), [['b', 'critical', '2.1', 'RCE in b']]);
});
