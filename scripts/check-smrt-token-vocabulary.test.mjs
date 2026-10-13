import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('ratchets 0px and 1px per file, rejecting new and stale literal counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-hairline-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages/example/src'), { recursive: true });
    const gate = join(root, 'scripts/check-smrt-token-vocabulary.mjs');
    const fixture = join(root, 'packages/example/src/Edge.svelte');
    copyFileSync(new URL('./check-smrt-token-vocabulary.mjs', import.meta.url), gate);
    writeFileSync(fixture, '<style>.a { margin: 0; border: var(--smrt-hairline); }</style>');
    execFileSync(process.execPath, [gate, '--write-allowlist']);
    assert.equal(spawnSync(process.execPath, [gate]).status, 0);
    writeFileSync(fixture, '<style>.a { top: 0px; border: 1px solid red; width: 2px; }</style>');
    const failure = spawnSync(process.execPath, [gate], { encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /3 raw px value/);
    execFileSync(process.execPath, [gate, '--write-allowlist']);
    const allow = JSON.parse(readFileSync(join(root, 'scripts/smrt-style-literal-allowlist.json'), 'utf8'));
    assert.equal(allow.px['packages/example/src/Edge.svelte'], 3);
    assert.equal(spawnSync(process.execPath, [gate]).status, 0);
    writeFileSync(fixture, '<style>.a { top: 0; border: var(--smrt-hairline); width: 2px; }</style>');
    const stale = spawnSync(process.execPath, [gate], { encoding: 'utf8' });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale \(actual 1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
