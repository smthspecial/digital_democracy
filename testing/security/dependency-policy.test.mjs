import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateExceptions, unmitigatedAdvisories } from './dependency-policy.mjs';
const bytes = Buffer.from('verified patch');
const exception = { package: 'package', version: '1', advisory: 'GHSA-test', cve: 'CVE-test', owner: 'maintainer', reviewBy: '2026-11-07', patch: 'patch', sha256: createHash('sha256').update(bytes).digest('hex') };
const report = (version = '1', advisory = 'GHSA-test') => ({ metadata: {}, advisories: { a: { module_name: 'package', github_advisory_id: advisory, findings: [{ version }] } } });
test('only the exact patched advisory/version is mitigated', () => {
  const entries = validateExceptions([exception], () => bytes, new Date('2026-10-08'));
  assert.equal(unmitigatedAdvisories(report(), entries).length, 0);
  assert.equal(unmitigatedAdvisories(report('2'), entries).length, 1);
  assert.equal(unmitigatedAdvisories(report('1', 'GHSA-new'), entries).length, 1);
});
test('expired or tampered patches fail closed', () => {
  assert.throws(() => validateExceptions([exception], () => bytes, new Date('2026-11-08')));
  assert.throws(() => validateExceptions([exception], () => Buffer.from('changed'), new Date('2026-10-08')));
});
test('scanner failures and duplicate exceptions fail closed', () => {
  assert.throws(() => unmitigatedAdvisories({}, [exception]));
  assert.throws(() => validateExceptions([exception, exception], () => bytes, new Date('2026-10-08')));
});
