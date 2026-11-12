import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve(import.meta.dirname, 'check-direct-model-construction.mjs');

const MODEL = `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
@smrt()
export class Widget extends SmrtObject {}
`;

function run(files, baseline) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-direct-model-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, source);
    }
    const args = [script, '--root', root, '--baseline', join(root, 'baseline.json')];
    writeFileSync(join(root, 'baseline.json'), JSON.stringify({ entries: baseline ?? [] }));
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { status: result.status, out: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const service = (body) => `import { Widget } from './widget.js';\n${body}\n`;

test('fails on a new direct construction of a registered model in a package service', () => {
  const r = run({
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/service.ts': service('export const make = () => new Widget({});'),
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /packages\/a\/src\/service\.ts: new Widget/);
});

test('fails on a subclass of a registered model', () => {
  const r = run({
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/sub.ts': `import { Widget } from './widget.js';\nexport class Gadget extends Widget {}\n`,
    'packages/a/src/service.ts': `import { Gadget } from './sub.js';\nexport const make = () => new Gadget({});\n`,
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /new Gadget/);
});

test('passes when the service uses a collection or the registry constructor', () => {
  const r = run({
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/service.ts': service(
      'export const make = (c) => c.create({});\nexport const ctor = () => ObjectRegistry.resolveEffectiveConstructor(Widget);',
    ),
  });
  assert.equal(r.status, 0, r.out);
});

test('ignores tests, fixtures, comments and strings', () => {
  const r = run({
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/__tests__/widget.test.ts': service('new Widget({});'),
    'packages/a/src/widget.test.ts': service('new Widget({});'),
    'packages/a/src/test-support/make.ts': service('new Widget({});'),
    'packages/a/src/service.ts': service('// new Widget({}) is wrong\n/* new Widget({}) */\nexport const s = "new Widget({})";'),
  });
  assert.equal(r.status, 0, r.out);
});

test('does not flag a same-named class imported from a third-party package', () => {
  const r = run({
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/service.ts': `import { Widget } from 'some-library';\nexport const make = () => new Widget();\n`,
  });
  assert.equal(r.status, 0, r.out);
});

test('accepts a baselined call that states a reason', () => {
  const files = {
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/service.ts': service('export const make = () => new Widget({});'),
  };
  const entry = { file: 'packages/a/src/service.ts', model: 'Widget', count: 1, reason: 'fixture only' };
  assert.equal(run(files, [entry]).status, 0);
  assert.equal(run(files, [{ ...entry, reason: '' }]).status, 1);
});

test('the baseline may only shrink', () => {
  const files = {
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/service.ts': service('export const a = () => new Widget({});\nexport const b = () => new Widget({});'),
  };
  const entry = { file: 'packages/a/src/service.ts', model: 'Widget', count: 1, reason: 'r' };
  const grown = run(files, [entry]);
  assert.equal(grown.status, 1);
  assert.match(grown.out, /may only shrink/);

  const stale = run(
    { 'packages/a/src/widget.ts': MODEL, 'packages/a/src/service.ts': service('export const a = 1;') },
    [entry],
  );
  assert.equal(stale.status, 1);
  assert.match(stale.out, /Lower it|only 0 remain/);
});

test('flags a model loaded with a dynamic import', () => {
  const r = run({
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/service.ts': `export async function make() {\n  const { Widget } = await import('./widget.js');\n  return new Widget({});\n}\n`,
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /new Widget/);
});

test('does not flag a plain class that shares a model name through a relative import', () => {
  const r = run({
    'packages/a/src/widget.ts': MODEL,
    'packages/a/src/plain/widget.ts': `export class Widget {}\n`,
    'packages/a/src/service.ts': `import { Widget } from './plain/widget.js';\nexport const make = () => new Widget();\n`,
  });
  assert.equal(r.status, 0, r.out);
});
