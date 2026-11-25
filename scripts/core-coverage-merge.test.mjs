import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  evaluateShardResults,
  filesFromJsonReport,
  findBlobFiles,
  mergeCoreCoverage,
  normalizeTestFile,
  parseBlobName,
  verifyBlobSet,
  verifyFileUnion,
} from './core-coverage-merge.mjs';

const full = ['blob-1-3.json', 'blob-2-3.json', 'blob-3-3.json'];
const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];

test('parseBlobName reads vitest shard blob names and rejects others', () => {
  assert.deepEqual(parseBlobName('/x/blob-2-3.json'), { index: 2, count: 3 });
  assert.equal(parseBlobName('blob.json'), null);
  assert.equal(parseBlobName('coverage-summary.json'), null);
});

test('a complete n/n blob set passes', () => {
  assert.deepEqual(verifyBlobSet(full, 3), []);
});

test('a missing blob fails', () => {
  const errors = verifyBlobSet(full.slice(0, 2), 3);
  assert.ok(errors.some((e) => /missing coverage blob for shard 3\/3/.test(e)));
  assert.ok(errors.some((e) => /expected exactly 3 blobs, found 2/.test(e)));
});

test('a duplicate blob fails even when the count is satisfied', () => {
  const errors = verifyBlobSet(
    ['a/blob-1-3.json', 'b/blob-1-3.json', 'blob-2-3.json'],
    3,
  );
  assert.ok(errors.some((e) => /duplicate coverage blob for shard 1\/3/.test(e)));
  assert.ok(errors.some((e) => /missing coverage blob for shard 3\/3/.test(e)));
});

test('a blob from a different shard count fails', () => {
  const errors = verifyBlobSet(['blob-1-3.json', 'blob-2-3.json', 'blob-3-4.json'], 3);
  assert.ok(errors.some((e) => /expected 3 shards/.test(e)));
});

test('zero blobs fails and a non-positive expectation fails', () => {
  assert.notDeepEqual(verifyBlobSet([], 3), []);
  assert.notDeepEqual(verifyBlobSet(full, 0), []);
});

test('the union of blob files must equal the listed core test files', () => {
  const abs = files.map((f) => `/repo/packages/core/${f}`);
  assert.deepEqual(verifyFileUnion(files, abs, '/repo/packages/core'), []);
});

test('a blob missing one file fails', () => {
  const abs = files.slice(0, 2).map((f) => `/repo/packages/core/${f}`);
  const errors = verifyFileUnion(files, abs, '/repo/packages/core');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /absent from the shard blobs: src\/c\.test\.ts/);
});

test('a file run in two blobs, or a non-core file, fails', () => {
  const abs = [...files, 'src/a.test.ts', '/repo/other/z.test.ts'].map((f) =>
    f.startsWith('/') ? f : `/repo/packages/core/${f}`,
  );
  const errors = verifyFileUnion(files, abs, '/repo/packages/core');
  assert.ok(errors.some((e) => /more than one blob: src\/a\.test\.ts/.test(e)));
  assert.ok(errors.some((e) => /not core test files/.test(e)));
});

test('an empty listing is never a vacuous pass', () => {
  assert.notDeepEqual(verifyFileUnion([], [], '/repo/packages/core'), []);
});

test('normalizeTestFile maps absolute and relative paths to one form', () => {
  assert.equal(
    normalizeTestFile('/repo/packages/core/src/a.test.ts', '/repo/packages/core'),
    'src/a.test.ts',
  );
  assert.equal(normalizeTestFile('./src/a.test.ts', '/x'), 'src/a.test.ts');
});

test('a skipped core job never counts as a successful shard set (#5648)', () => {
  assert.deepEqual(
    evaluateShardResults({ testCore: 'success', affectedCoreTests: 'skipped' }),
    [],
  );
  assert.deepEqual(
    evaluateShardResults({ testCore: 'skipped', affectedCoreTests: 'success' }),
    [],
  );
  for (const bad of [
    { testCore: 'skipped', affectedCoreTests: 'skipped' },
    { testCore: 'failure', affectedCoreTests: 'skipped' },
    { testCore: 'cancelled', affectedCoreTests: 'skipped' },
    { testCore: 'skipped', affectedCoreTests: 'failure' },
    { testCore: 'success', affectedCoreTests: 'success' },
    { testCore: undefined, affectedCoreTests: undefined },
  ]) {
    assert.notDeepEqual(evaluateShardResults(bad), [], JSON.stringify(bad));
  }
});

test('filesFromJsonReport reads vitest json reporter names', () => {
  assert.deepEqual(
    filesFromJsonReport({ testResults: [{ name: '/a' }, { name: '/b' }] }),
    ['/a', '/b'],
  );
  assert.deepEqual(filesFromJsonReport({}), []);
});

// End to end with vitest stood in by a fake exec.
function fixture({ blobs = full, merged = files, writeSummary = true }) {
  const root = mkdtempSync(join(tmpdir(), 'core-cov-'));
  const blobsDir = join(root, 'artifacts');
  blobs.forEach((name, i) => {
    const dir = join(blobsDir, `core-coverage-blob-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), '[]');
  });
  const pkgDir = join(root, 'packages', 'core');
  mkdirSync(pkgDir, { recursive: true });
  const exec = (_cmd, args, opts) => {
    if (args.includes('list')) {
      return `${files.join('\n')}\n`;
    }
    writeFileSync(
      join(pkgDir, '.vitest-merged-report.json'),
      JSON.stringify({
        testResults: merged.map((f) => ({ name: join(pkgDir, f) })),
      }),
    );
    if (writeSummary) {
      mkdirSync(join(pkgDir, 'coverage'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'coverage', 'coverage-summary.json'),
        JSON.stringify({ total: { lines: { pct: 90 } } }),
      );
    }
    assert.equal(opts.cwd, pkgDir);
    return '';
  };
  return { blobsDir, pkgDir, exec };
}

test('end to end: complete blobs merge and yield a summary', () => {
  const f = fixture({});
  const out = mergeCoreCoverage({
    blobsDir: f.blobsDir,
    expectedShards: 3,
    pkgDir: f.pkgDir,
    exec: f.exec,
    log: () => {},
  });
  assert.deepEqual(out.errors, []);
  assert.equal(
    JSON.parse(readFileSync(out.summaryPath, 'utf8')).total.lines.pct,
    90,
  );
  assert.equal(findBlobFiles(join(f.pkgDir, '.vitest-reports')).length, 3);
});

test('end to end: a missing blob fails before vitest runs', () => {
  const f = fixture({ blobs: full.slice(0, 2) });
  let ran = false;
  const out = mergeCoreCoverage({
    blobsDir: f.blobsDir,
    expectedShards: 3,
    pkgDir: f.pkgDir,
    exec: () => {
      ran = true;
      return '';
    },
    log: () => {},
  });
  assert.notDeepEqual(out.errors, []);
  assert.equal(ran, false);
  assert.equal(out.summaryPath, undefined);
});

test('end to end: a duplicate blob fails', () => {
  const f = fixture({ blobs: ['blob-1-3.json', 'blob-1-3.json', 'blob-2-3.json'] });
  const out = mergeCoreCoverage({
    blobsDir: f.blobsDir,
    expectedShards: 3,
    pkgDir: f.pkgDir,
    exec: f.exec,
    log: () => {},
  });
  assert.ok(out.errors.some((e) => /duplicate/.test(e)));
});

test('end to end: a blob missing one file fails with no summary', () => {
  const f = fixture({ merged: files.slice(0, 2) });
  const out = mergeCoreCoverage({
    blobsDir: f.blobsDir,
    expectedShards: 3,
    pkgDir: f.pkgDir,
    exec: f.exec,
    log: () => {},
  });
  assert.ok(out.errors.some((e) => /absent from the shard blobs/.test(e)));
  assert.equal(out.summaryPath, undefined);
});

test('end to end: a merge that writes no coverage summary fails', () => {
  const f = fixture({ writeSummary: false });
  const out = mergeCoreCoverage({
    blobsDir: f.blobsDir,
    expectedShards: 3,
    pkgDir: f.pkgDir,
    exec: f.exec,
    log: () => {},
  });
  assert.ok(out.errors.some((e) => /no coverage-summary\.json/.test(e)));
});

test('end to end: a failing vitest merge fails', () => {
  const f = fixture({});
  const out = mergeCoreCoverage({
    blobsDir: f.blobsDir,
    expectedShards: 3,
    pkgDir: f.pkgDir,
    exec: (_c, args) => {
      if (args.includes('list')) return `${files.join('\n')}\n`;
      throw new Error('boom');
    },
    log: () => {},
  });
  assert.ok(out.errors.some((e) => /merge-reports failed/.test(e)));
});

// Formats observed from real vitest 4.1.10 runs (three-file subset of core):
// `vitest list --filesOnly` prints package-relative paths, in an order that
// differs from the merged `--reporter=json` report, whose `testResults[].name`
// are absolute.
test('real vitest output formats compare equal and a dropped file fails', () => {
  const pkgDir =
    '/Users/will/Work/happyvertical/repos/smrt-worktrees/ci-wall-clock-5648/packages/core';
  const listed = [
    'src/browser-field.test.ts',
    'src/byo-inference.test.ts',
    'src/class.spec.ts',
  ];
  const report = {
    testResults: [
      { name: `${pkgDir}/src/byo-inference.test.ts` },
      { name: `${pkgDir}/src/class.spec.ts` },
      { name: `${pkgDir}/src/browser-field.test.ts` },
    ],
  };
  assert.deepEqual(
    verifyFileUnion(listed, filesFromJsonReport(report), pkgDir),
    [],
  );
  assert.notDeepEqual(
    verifyFileUnion(listed, filesFromJsonReport(report).slice(1), pkgDir),
    [],
  );
});
