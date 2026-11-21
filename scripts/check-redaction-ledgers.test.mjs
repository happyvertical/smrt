import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve(import.meta.dirname, 'check-redaction-ledgers.mjs');
const CORE = 'packages/core/src/redaction-rules-ledger.json';
const CONFIG = 'packages/config/src/secret-value-rules-ledger.json';

const row = (version, digest = `d${version}`) => ({
  version,
  rulesDigest: digest,
  corpusDigest: digest,
});
const ledger = (...rows) => `${JSON.stringify({ rows }, null, 2)}\n`;

function git(root, ...args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

/** A repository whose base commit holds `baseFiles`; `headFiles` on top. */
function run(baseFiles, headFiles) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-ledgers-'));
  try {
    git(root, 'init', '-q');
    write(root, { 'README.md': 'x\n', ...baseFiles });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    write(root, headFiles);
    const result = spawnSync(process.execPath, [script, '--root', root, '--base', base], {
      encoding: 'utf8',
    });
    return { status: result.status, out: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const both = (core, config) => ({ [CORE]: core, [CONFIG]: config });

test('passes when the base has no ledgers yet', () => {
  const r = run({}, both(ledger(row(1)), ledger(row(1))));
  assert.equal(r.status, 0, r.out);
});

test('passes when a row with a higher version is appended', () => {
  const r = run(both(ledger(row(1)), ledger(row(1))), both(ledger(row(1), row(2)), ledger(row(1))));
  assert.equal(r.status, 0, r.out);
});

test('fails when an existing row is rewritten', () => {
  const r = run(both(ledger(row(1)), ledger(row(1))), both(ledger(row(1, 'changed')), ledger(row(1))));
  assert.equal(r.status, 1);
  assert.match(r.out, /redaction-rules-ledger\.json: row 1 \(version 1\) differs/);
});

test('fails when a row is removed', () => {
  const r = run(both(ledger(row(1), row(2)), ledger(row(1))), both(ledger(row(1)), ledger(row(1))));
  assert.equal(r.status, 1);
  assert.match(r.out, /row\(s\) of .* removed/);
});

test('fails when an appended row does not raise the version', () => {
  const r = run(both(ledger(row(1)), ledger(row(1))), both(ledger(row(1)), ledger(row(1), row(1, 'again'))));
  assert.equal(r.status, 1);
  assert.match(r.out, /secret-value-rules-ledger\.json: row 2 \(version 1\) does not raise the version/);
});

test('fails closed when the base revision is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-ledgers-'));
  try {
    git(root, 'init', '-q');
    write(root, both(ledger(row(1)), ledger(row(1))));
    const result = spawnSync(
      process.execPath,
      [script, '--root', root, '--base', '0000000000000000000000000000000000000000'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not available/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
