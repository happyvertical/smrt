import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FLOORS,
  INTERIM_FLOORS,
  evaluateCoverage,
  parseSummaryFlag,
  readCoverageSummary,
  selectGatedPackages,
} from './check-coverage.mjs';

const core = () => selectGatedPackages(['core']).checked[0];

test('core is gated at the ratified T1 floor with no interim floor', () => {
  assert.deepEqual(core(), { pkg: 'core', tier: 'T1', floor: 80, interim: false });
  assert.equal(FLOORS.T1, 80);
});

test('interim floors, exemptions, waivers and untiered packages are unchanged', () => {
  const { checked, skipped } = selectGatedPackages([
    'voice',
    'types',
    'smrt-svelte',
    'vitest',
    'no-such-tier',
  ]);
  assert.deepEqual(
    checked.map((c) => [c.pkg, c.floor, c.interim]),
    [['voice', INTERIM_FLOORS.voice, true]],
  );
  assert.equal(skipped.length, 4);
});

test('a merged core summary at or above the floor passes, below it fails', () => {
  assert.equal(evaluateCoverage(core(), { pct: 90.6, files: [] }).outcome, 'pass');
  assert.equal(evaluateCoverage(core(), { pct: 80, files: [] }).outcome, 'pass');
  assert.equal(evaluateCoverage(core(), { pct: 79.99, files: [] }).outcome, 'fail');
});

test('no coverage summary fails, never passes', () => {
  assert.equal(evaluateCoverage(core(), null).outcome, 'fail');
  assert.equal(evaluateCoverage(core(), { pct: null, files: [] }).outcome, 'fail');
});

test('below-floor debt is excused only when no measured source was touched', () => {
  const measured = { pct: 50, files: ['/r/packages/core/src/a.ts'] };
  assert.equal(
    evaluateCoverage(core(), measured, {
      onlyModified: true,
      files: new Set(['src/other.ts']),
    }).outcome,
    'debt',
  );
  assert.equal(
    evaluateCoverage(core(), measured, {
      onlyModified: true,
      files: new Set(['src/a.ts']),
    }).outcome,
    'fail',
  );
  assert.equal(
    evaluateCoverage(core(), measured, {
      onlyModified: false,
      files: new Set(['src/other.ts']),
    }).outcome,
    'fail',
  );
});

test('readCoverageSummary reads json-summary and treats absent/garbled as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cov-'));
  const good = join(dir, 'ok.json');
  writeFileSync(
    good,
    JSON.stringify({ total: { lines: { pct: 91.2 } }, '/a.ts': {} }),
  );
  assert.deepEqual(readCoverageSummary(good), { pct: 91.2, files: ['/a.ts'] });
  assert.equal(readCoverageSummary(join(dir, 'missing.json')), null);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{');
  assert.equal(readCoverageSummary(bad), null);
});

test('parseSummaryFlag parses pkg=path pairs and rejects malformed input', () => {
  assert.deepEqual([...parseSummaryFlag('core=a/b.json')], [['core', 'a/b.json']]);
  assert.equal(parseSummaryFlag(undefined).size, 0);
  assert.throws(() => parseSummaryFlag('core'));
  assert.throws(() => parseSummaryFlag('core='));
});
