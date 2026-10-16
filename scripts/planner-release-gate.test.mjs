import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, runChecks, withTarballOverrides } from './planner-release-gate.mjs';

const tarballs = new Map([
  ['@happyvertical/smrt-ui', '/packs/happyvertical-smrt-ui-1.0.0.tgz'],
  ['@happyvertical/smrt-core', '/packs/happyvertical-smrt-core-1.0.0.tgz'],
]);

test('appends sorted tarball overrides to a workspace file', () => {
  assert.equal(
    withTarballOverrides('allowBuilds:\n  esbuild: true', tarballs),
    "allowBuilds:\n  esbuild: true\noverrides:\n  '@happyvertical/smrt-core': 'file:/packs/happyvertical-smrt-core-1.0.0.tgz'\n  '@happyvertical/smrt-ui': 'file:/packs/happyvertical-smrt-ui-1.0.0.tgz'\n",
  );
});

test('extends an existing overrides block instead of adding a second key', () => {
  const out = withTarballOverrides("overrides:\n  left-pad: 1.3.0\n", tarballs);
  assert.equal(out.match(/^overrides:/gm).length, 1);
  assert.match(out, /left-pad: 1\.3\.0/);
  assert.match(out, /'@happyvertical\/smrt-ui': 'file:/);
});

test('retries a failing check once and reports a pass on retry as flaky', () => {
  let calls = 0;
  const flakyCheck = { owner: 'planner', name: 'flaky', run: () => { calls += 1; if (calls === 1) throw new Error('boom'); } };
  const broken = { owner: 'framework', name: 'broken', run: () => { throw new Error('always'); } };
  const lines = [];
  const result = runChecks([flakyCheck, broken], { log: (line) => lines.push(line) });
  assert.equal(calls, 2);
  assert.deepEqual(result.flaky.map((c) => c.name), ['flaky']);
  assert.deepEqual(result.failed.map((c) => c.name), ['broken']);
  assert.ok(lines.some((line) => line.includes('[FRAMEWORK] broken (attempt 2/2)')));
});

test('requires a packs directory and a known owner filter', () => {
  assert.throws(() => parseArgs([]), /--packs/);
  assert.throws(() => parseArgs(['--packs', 'x', '--only', 'docs']), /--only/);
  assert.deepEqual(parseArgs(['--packs=x', '--cookbook', 'roaster']), {
    packs: 'x',
    cookbook: 'roaster',
    template: undefined,
    only: undefined,
  });
});
