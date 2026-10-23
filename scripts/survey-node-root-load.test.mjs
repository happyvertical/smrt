import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { strictViolations } from './survey-node-root-load.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'survey-node-root-load.mjs');
const PRODUCTS = '@happyvertical/smrt-products';

test('strict passes when only allow-listed packages fail', () => {
  assert.deepEqual(
    strictViolations(
      [
        { name: '@happyvertical/smrt-users', ok: true },
        { name: PRODUCTS, ok: false },
      ],
      [PRODUCTS],
    ),
    [],
  );
});

test('strict fails on an unexpected failure', () => {
  const violations = strictViolations(
    [
      { name: '@happyvertical/smrt-users', ok: false },
      { name: PRODUCTS, ok: false },
    ],
    [PRODUCTS],
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /unexpected failure.*smrt-users/);
});

test('strict fails when nothing was surveyed', () => {
  const violations = strictViolations([], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no package was surveyed/);
});

test('strict fails when an allow-listed package was not surveyed', () => {
  const violations = strictViolations(
    [{ name: '@happyvertical/smrt-users', ok: true }],
    [PRODUCTS],
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /allow-listed .*smrt-products was not surveyed/);
});

test('strict fails when an allow-listed package now loads', () => {
  const violations = strictViolations([{ name: PRODUCTS, ok: true }], [PRODUCTS]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /now loads under plain Node/);
});

test('the CLI exits 1 in strict mode over an empty packages directory', () => {
  const packagesDir = mkdtempSync(join(tmpdir(), 'survey-node-roots-'));
  try {
    // A package without a built manifest is not surveyed.
    mkdirSync(join(packagesDir, 'unbuilt'));
    writeFileSync(
      join(packagesDir, 'unbuilt', 'package.json'),
      JSON.stringify({ name: '@fixture/unbuilt', type: 'module' }),
    );
    const strict = spawnSync(
      process.execPath,
      [SCRIPT, '--strict', `--packages-dir=${packagesDir}`],
      { encoding: 'utf8' },
    );
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(strict.stderr, /no package was surveyed/);

    const report = spawnSync(
      process.execPath,
      [SCRIPT, `--packages-dir=${packagesDir}`],
      { encoding: 'utf8' },
    );
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /node-root-load: 0 OK, 0 FAIL/);
  } finally {
    rmSync(packagesDir, { recursive: true, force: true });
  }
});
