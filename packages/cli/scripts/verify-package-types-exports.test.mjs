import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const wrapper = fileURLToPath(new URL('../../../scripts/verify-package-types-exports.js', import.meta.url));
function verify(exports, files, { packedExports = exports } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'smrt-svelte-export-'));
  try {
    const root = join(fixture, 'package');
    mkdirSync(root);
    const manifest = { name: 'export-fixture', version: '1.0.0', type: 'module', exports };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    const tarball = join(fixture, 'fixture.tgz');
    // Exercise the actual packed manifest as well as the root wrapper.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, exports: packedExports }));
    const packed = spawnSync('tar', ['-czf', tarball, '-C', fixture, 'package']);
    assert.equal(packed.status, 0, packed.stderr?.toString());
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [wrapper, root, '--tarball', tarball], { encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
const context = { 'dist/analytics.js': 'import { getContext } from "svelte"; export const analytics = () => getContext("analytics");' };
const plainExport = { './analytics': { import: './dist/analytics.js', default: './dist/analytics.js' } };
const corrected = { './analytics': { types: './dist/analytics.d.ts', svelte: './dist/analytics.js', import: './dist/analytics.js', default: './dist/analytics.js' } };
const types = { 'dist/analytics.d.ts': 'import type { Component } from "svelte"; export declare const analytics: Component;' };

test('analytics context export fails without svelte condition and passes when corrected', () => {
  const broken = verify(plainExport, context);
  assert.equal(broken.status, 1);
  assert.match(broken.output, /Export \.\/analytics.*reaches Svelte runtime.*effective "svelte"/);
  const fixed = verify(corrected, { ...context, ...types });
  assert.equal(fixed.status, 0, fixed.output);
});

test('transitive static reexport reaching a component requires its own condition', () => {
  const files = {
    'dist/index.mjs': 'export { Card } from "./bridge.js";',
    'dist/bridge.js': 'export { default as Card } from "./Card.svelte";',
    'dist/Card.svelte': '<script lang="ts">import type { Component } from "svelte";</script><div />',
  };
  const broken = verify({ '.': { import: './dist/index.mjs' } }, files);
  assert.equal(broken.status, 1);
  assert.match(broken.output, /Card\.svelte/);
  const fixed = verify({ '.': { svelte: './dist/index.mjs', import: './dist/index.mjs' } }, files);
  assert.equal(fixed.status, 0, fixed.output);
});

test('plain currency/data and type-only declarations need no svelte runtime condition', () => {
  const result = verify({ './currency': { types: './dist/currency.d.ts', import: './dist/currency.js' } }, {
    'dist/currency.js': '/* import { getContext } from "svelte" */ export const currency = "CAD";',
    'dist/currency.d.ts': 'import type { Component } from "svelte"; export type Currency = string;',
  });
  assert.equal(result.status, 0, result.output);
});

test('shadowed or null svelte conditions fail actionably', () => {
  for (const conditions of [
    { import: './dist/analytics.js', svelte: './dist/analytics.js' },
    { default: './dist/analytics.js', svelte: './dist/analytics.js' },
    { svelte: './dist/analytics.js', types: './dist/analytics.d.ts', import: './dist/analytics.js' },
    { svelte: null, import: './dist/analytics.js' },
  ]) {
    const result = verify({ './analytics': conditions }, { ...context, ...types, 'dist/other.js': 'export {};' });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /condition order|effective "svelte"/);
  }
});

test('raw component and source barrel conditions may differ from compiled fallback', () => {
  const files = {
    'source/Card.svelte': '<div>Card</div>',
    'source/index.js': 'export { default as Card } from "./Card.svelte";',
    'dist/compiled.js': 'export { getContext as Card } from "svelte";',
  };
  for (const source of ['./source/Card.svelte', './source/index.js']) {
    for (const svelte of [source, { browser: source, default: source }]) {
      const result = verify({ '.': { svelte, import: './dist/compiled.js', default: './dist/compiled.js' } }, files);
      assert.equal(result.status, 0, result.output);
    }
  }
});

test('a different svelte target must still be packaged and parseable', () => {
  for (const [svelte, extra, message] of [
    ['./source/missing.svelte', {}, /cannot read packed target source\/missing.svelte/],
    ['./source/invalid.js', { 'source/invalid.js': 'export const =' }, /cannot parse packed JavaScript source\/invalid.js/],
    [{ browser: './source/missing.svelte', default: './source/index.js' }, { 'source/index.js': 'export {};' }, /cannot read packed target/],
    [{ browser: null, default: null }, {}, /no effective packed svelte target/],
  ]) {
    const result = verify({ './analytics': { svelte, import: './dist/analytics.js' } }, { ...context, ...extra });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, message);
  }
});

test('cycles terminate and still detect a Svelte runtime edge', () => {
  const files = {
    'dist/a.js': 'export * from "./b.js";',
    'dist/b.js': 'export * from "./a.js"; import "svelte/store";',
  };
  const broken = verify({ '.': { import: './dist/a.js' } }, files);
  assert.equal(broken.status, 1);
  assert.match(broken.output, /svelte\/store/);
  const fixed = verify({ '.': { svelte: './dist/a.js', import: './dist/a.js' } }, files);
  assert.equal(fixed.status, 0, fixed.output);
  files['dist/b.js'] = 'export * from "./a.js";';
  assert.equal(verify({ '.': { import: './dist/a.js' } }, files).status, 0);
});

test('missing or unparseable packed closure targets fail with file diagnostic', () => {
  for (const [files, message] of [
    [{ 'dist/a.js': 'export * from "./missing.js";' }, /missing packed import target: dist\/a.js -> .\/missing.js/],
    [{ 'dist/a.js': 'export const =' }, /cannot parse packed JavaScript dist\/a.js/],
    [{ 'dist/a.js': 'import "./bad.mjs";', 'dist/bad.js': 'export {};' }, /missing packed import target.*bad.mjs/],
  ]) {
    const result = verify({ '.': { import: './dist/a.js' } }, files);
    assert.equal(result.status, 1);
    assert.match(result.output, message);
  }
});

test('guard reads packed export map rather than trusting local manifest', () => {
  const result = verify(corrected, { ...context, ...types }, { packedExports: plainExport });
  assert.equal(result.status, 1);
  assert.match(result.output, /effective "svelte"/);
});

test('wildcard exports inspect every packed JavaScript target', () => {
  const files = { 'dist/a.js': 'export {};', 'dist/b.js': 'export { getContext } from "svelte";' };
  const broken = verify({ './utils/*': { import: './dist/*.js' } }, files);
  assert.equal(broken.status, 1);
  assert.match(broken.output, /dist\/b.js/);
  const fixed = verify({ './utils/*': { svelte: './dist/*.js', import: './dist/*.js' } }, files);
  assert.equal(fixed.status, 0, fixed.output);
});
