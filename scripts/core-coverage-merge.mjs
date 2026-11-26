#!/usr/bin/env node
/**
 * Merge the core shard coverage blobs for the Coverage Gate (#5648).
 *
 * The three `test-core` shards (or, in an affected-mode merge group, the three
 * `affected-core-tests` shards) run `vitest run --shard=i/n --coverage
 * --reporter=blob`. The gate used to re-run the whole core suite under
 * `vitest --coverage` (~18 min) just to measure it; this script instead merges
 * the blobs the shards already produced, and refuses to produce a coverage
 * report from anything partial — a gate that passes on absent data is worse
 * than no gate:
 *
 *   - exactly `--expected-shards` blobs, named `blob-<i>-<n>.json`, indices
 *     1..n each present once, every blob agreeing on n (missing / duplicate /
 *     mixed-count blobs fail);
 *   - the union of test files in the merged run equals the independent
 *     `vitest list --filesOnly` of the core package, with no file run twice
 *     (a blob missing a file fails; a stale blob that adds one fails).
 *
 * Usage (run from the repo root):
 *   node scripts/core-coverage-merge.mjs merge --blobs <dir> --expected-shards 3
 *   node scripts/core-coverage-merge.mjs shard-results \
 *     --test-core <result> --affected-core-tests <result>
 *
 * `merge` writes packages/core/coverage/coverage-summary.json, which
 * `check-coverage.mjs --only core --summary core=<that path>` then gates with
 * the same floors, interim floors and exemptions as any other package.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BLOB_RE = /^blob-(\d+)-(\d+)\.json$/;

/** `blob-2-3.json` → `{ index: 2, count: 3 }`, or null for any other name. */
export function parseBlobName(name) {
  const m = BLOB_RE.exec(basename(name));
  return m ? { index: Number(m[1]), count: Number(m[2]) } : null;
}

/** Every `blob-i-n.json` under `dir` (recursive: one artifact folder per shard). */
export function findBlobFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (parseBlobName(entry)) found.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

/**
 * Check that `paths` are exactly the n/n shard blobs. Returns error strings;
 * empty means complete. Pure so the negative fixtures run without vitest.
 */
export function verifyBlobSet(paths, expectedShards) {
  const errors = [];
  if (!Number.isInteger(expectedShards) || expectedShards < 1) {
    return [`--expected-shards must be a positive integer, got ${expectedShards}`];
  }
  const seen = new Map();
  for (const p of paths) {
    const parsed = parseBlobName(p);
    if (!parsed) continue;
    if (parsed.count !== expectedShards) {
      errors.push(
        `${p}: blob is for ${parsed.index}/${parsed.count}, expected ${expectedShards} shards`,
      );
    }
    if (!seen.has(parsed.index)) seen.set(parsed.index, []);
    seen.get(parsed.index).push(p);
  }
  for (let i = 1; i <= expectedShards; i++) {
    if (!seen.has(i)) {
      errors.push(`missing coverage blob for shard ${i}/${expectedShards}`);
    }
  }
  for (const [index, list] of seen) {
    if (list.length > 1) {
      errors.push(
        `duplicate coverage blob for shard ${index}/${expectedShards}: ${list.join(', ')}`,
      );
    }
    if (index < 1 || index > expectedShards) {
      errors.push(`blob index ${index} is outside 1..${expectedShards}`);
    }
  }
  if (paths.length !== expectedShards) {
    errors.push(
      `expected exactly ${expectedShards} blobs, found ${paths.length}`,
    );
  }
  return errors;
}

/** Package-relative, forward-slash test file path (blobs hold absolute paths). */
export function normalizeTestFile(file, pkgDir) {
  const abs = file.replace(/\\/g, '/');
  const rel = abs.startsWith('/')
    ? relative(pkgDir, abs).replace(/\\/g, '/')
    : abs;
  return rel.replace(/^\.\//, '');
}

/**
 * Require the merged run's files to equal the independently listed core test
 * files, each exactly once. Returns error strings; empty means every file ran.
 */
export function verifyFileUnion(expectedFiles, mergedFiles, pkgDir = ROOT) {
  const errors = [];
  const expected = new Set(expectedFiles.map((f) => normalizeTestFile(f, pkgDir)));
  if (expected.size === 0) {
    return ['vitest list found no core test files; refusing a vacuous merge'];
  }
  const counts = new Map();
  for (const f of mergedFiles) {
    const n = normalizeTestFile(f, pkgDir);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const missing = [...expected].filter((f) => !counts.has(f)).sort();
  const extra = [...counts.keys()].filter((f) => !expected.has(f)).sort();
  const dup = [...counts].filter(([, c]) => c > 1).map(([f]) => f).sort();
  if (missing.length > 0) {
    errors.push(
      `${missing.length} core test file(s) absent from the shard blobs: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`,
    );
  }
  if (extra.length > 0) {
    errors.push(
      `${extra.length} merged file(s) are not core test files: ${extra.slice(0, 10).join(', ')}`,
    );
  }
  if (dup.length > 0) {
    errors.push(
      `${dup.length} core test file(s) appear in more than one blob: ${dup.slice(0, 10).join(', ')}`,
    );
  }
  return errors;
}

/**
 * The core shards that feed the gate: full mode runs `test-core`, an
 * affected-mode merge group runs `affected-core-tests`; the other is skipped.
 * Exactly one must have succeeded. Both skipped (nothing measured core),
 * any failure/cancellation, or both succeeding is not evidence — fail.
 */
export function evaluateShardResults({ testCore, affectedCoreTests }) {
  const skipped = (r) => r === 'skipped' || r === '' || r === undefined;
  if (testCore === 'success' && skipped(affectedCoreTests)) return [];
  if (affectedCoreTests === 'success' && skipped(testCore)) return [];
  return [
    `core shards did not produce coverage: test-core=${testCore || 'absent'}, ` +
      `affected-core-tests=${affectedCoreTests || 'absent'} (exactly one must succeed)`,
  ];
}

/** Names of the test files in a vitest `--reporter=json` report. */
export function filesFromJsonReport(report) {
  return (report.testResults ?? []).map((r) => r.name);
}

function defaultExec(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

/**
 * Merge the blobs and verify completeness. `exec` is injected so tests can
 * stand in for vitest. Returns `{ errors, summaryPath }`; the caller exits
 * non-zero on any error.
 */
export function mergeCoreCoverage({
  blobsDir,
  expectedShards,
  pkgDir = join(ROOT, 'packages', 'core'),
  exec = defaultExec,
  log = console.log,
}) {
  const blobs = findBlobFiles(blobsDir);
  const setErrors = verifyBlobSet(blobs, expectedShards);
  if (setErrors.length > 0) return { errors: setErrors };

  const reports = join(pkgDir, '.vitest-reports');
  rmSync(reports, { recursive: true, force: true });
  mkdirSync(reports, { recursive: true });
  for (const blob of blobs) copyFileSync(blob, join(reports, basename(blob)));

  const listed = exec('pnpm', ['exec', 'vitest', 'list', '--filesOnly'], {
    cwd: pkgDir,
    env: { ...process.env, NODE_ENV: 'test' },
  })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\.[cm]?[jt]sx?$/.test(l));

  const jsonOut = join(pkgDir, '.vitest-merged-report.json');
  const summaryPath = join(pkgDir, 'coverage', 'coverage-summary.json');
  rmSync(join(pkgDir, 'coverage'), { recursive: true, force: true });
  log(`merging ${blobs.length} shard blobs (${listed.length} core test files)`);
  try {
    exec(
      'pnpm',
      [
        'exec',
        'vitest',
        '--merge-reports=.vitest-reports',
        '--coverage',
        '--coverage.reporter=json-summary',
        '--coverage.reporter=text-summary',
        '--reporter=json',
        `--outputFile.json=${jsonOut}`,
      ],
      {
        cwd: pkgDir,
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: 'inherit',
      },
    );
  } catch (error) {
    return {
      errors: [`vitest --merge-reports failed: ${error?.message ?? error}`],
    };
  }
  if (!existsSync(jsonOut)) {
    return { errors: ['merged run produced no JSON report of test files'] };
  }
  const merged = filesFromJsonReport(JSON.parse(readFileSync(jsonOut, 'utf8')));
  const unionErrors = verifyFileUnion(listed, merged, pkgDir);
  if (unionErrors.length > 0) return { errors: unionErrors };
  if (!existsSync(summaryPath)) {
    return { errors: ['merged run produced no coverage-summary.json'] };
  }
  log(`✓ merged coverage covers all ${listed.length} core test files`);
  return { errors: [], summaryPath };
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const command = process.argv[2];
  let errors;
  if (command === 'merge') {
    ({ errors } = mergeCoreCoverage({
      blobsDir: resolve(flag('--blobs') ?? ''),
      expectedShards: Number(flag('--expected-shards')),
    }));
  } else if (command === 'shard-results') {
    errors = evaluateShardResults({
      testCore: flag('--test-core'),
      affectedCoreTests: flag('--affected-core-tests'),
    });
  } else {
    console.error('usage: core-coverage-merge.mjs merge|shard-results ...');
    process.exit(2);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ coverage-gate-core: ${e}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
