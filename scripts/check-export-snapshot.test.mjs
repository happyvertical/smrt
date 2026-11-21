import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  checkExportSnapshot,
  checkStarAllowlistAgainst,
  resolvePinnedTypeScript,
  toPosixRelative,
} from './check-export-snapshot.mjs';
import { requiredFileAtRef } from './lib/source-scan.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
});

/** A throwaway repository root with one package at `packages/core`. */
function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'export-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = {
    'package.json': JSON.stringify({
      name: 'fixture-root',
      private: true,
      devDependencies: { typescript: ts.version },
    }),
    'packages/core/tsconfig.typecheck.json': TSCONFIG,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

const run = (root, options = {}) =>
  checkExportSnapshot({ root, entries: ['src/index.ts'], ...options });

const snapshotPath = (root, name = 'index') =>
  join(root, 'packages/core/api', `${name}.exports.json`);

const allowlistPath = (root) =>
  join(root, 'packages/core/api/export-star-allowlist.json');

const readSnapshot = (root, name = 'index') =>
  JSON.parse(readFileSync(snapshotPath(root, name), 'utf8'));

const byName = (snapshot) =>
  Object.fromEntries(snapshot.exports.map((row) => [row.name, row]));

/** Writes the allowlist so the ratchet accepts exactly these star lines. */
function allow(root, specifiers) {
  mkdirSync(dirname(allowlistPath(root)), { recursive: true });
  writeFileSync(
    allowlistPath(root),
    JSON.stringify({ 'packages/core/src/index.ts': specifiers }),
  );
}

test('nested star chain: names three stars deep are listed with their declaring module', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': "export * from './a';\n",
    'packages/core/src/a.ts': "export * from './b';\n",
    'packages/core/src/b.ts': "export * from './c';\n",
    'packages/core/src/c.ts':
      'export const deep = 1;\nexport interface DeepShape { a: string }\n',
  });
  allow(root, ['./a']);
  const result = run(root, { write: true });
  assert.deepEqual(result.errors, []);
  const rows = byName(readSnapshot(root));
  assert.deepEqual(rows.deep, {
    name: 'deep',
    kind: 'value',
    module: 'packages/core/src/c.ts',
  });
  assert.equal(rows.DeepShape.kind, 'type');
  assert.equal(rows.DeepShape.module, 'packages/core/src/c.ts');
});

test('ambiguous star fails TS2308 and writes nothing', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts':
      "export * from './a';\nexport * from './b';\n",
    'packages/core/src/a.ts': 'export const dup = 1;\nexport const onlyA = 1;\n',
    'packages/core/src/b.ts': 'export const dup = 2;\n',
  });
  allow(root, ['./a', './b']);
  const result = run(root, { write: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /TS2308/);
  assert.equal(existsSync(snapshotPath(root)), false);
});

test('export type * lists every name, classes included, as a type', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': "export type * from './t';\n",
    'packages/core/src/t.ts': 'export class Thing {}\nexport const v = 1;\n',
  });
  allow(root, ['./t']);
  const result = run(root, { write: true });
  assert.deepEqual(result.errors, []);
  const rows = byName(readSnapshot(root));
  assert.equal(rows.Thing.kind, 'type');
  assert.equal(rows.v.kind, 'type');
});

test('default as X is listed under its exported name as a value', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': "export { default as Widget } from './w';\n",
    'packages/core/src/w.ts': 'export default class Widget {}\n',
  });
  allow(root, []);
  const result = run(root, { write: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(readSnapshot(root).exports, [
    { name: 'Widget', kind: 'value', module: 'packages/core/src/w.ts' },
  ]);
});

test('external type is labelled with its package, not a node_modules path', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts':
      "export type { ExtShape } from 'ext-types';\n",
    'node_modules/ext-types/package.json': JSON.stringify({
      name: 'ext-types',
      version: '1.0.0',
      types: './index.d.ts',
    }),
    'node_modules/ext-types/index.d.ts':
      'export interface ExtShape { a: string }\n',
  });
  allow(root, []);
  const result = run(root, { write: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(readSnapshot(root).exports, [
    { name: 'ExtShape', kind: 'type', module: 'ext-types' },
  ]);
});

test('posix paths: a Windows path is written relative with forward slashes', () => {
  assert.equal(
    toPosixRelative('C:\\repo', 'C:\\repo\\packages\\core\\src\\a.ts'),
    'packages/core/src/a.ts',
  );
  assert.equal(
    toPosixRelative('/repo/', '/repo/packages/core/src/a.ts'),
    'packages/core/src/a.ts',
  );
});

test('new star ratchet: an unlisted export * fails, a removed one must leave the list, and --write never adds one', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts':
      "export * from './a';\nexport * from './b';\n",
    'packages/core/src/a.ts': 'export const a = 1;\n',
    'packages/core/src/b.ts': 'export const b = 1;\n',
  });
  allow(root, ['./a', './gone']);

  const check = run(root);
  assert.equal(check.ok, false);
  const text = check.errors.join('\n');
  assert.match(text, /packages\/core\/src\/index\.ts.*'\.\/b'/);
  assert.match(text, /'\.\/gone'/);

  const write = run(root, { write: true });
  assert.equal(write.ok, false, 'a new star is never accepted by --write');
  assert.equal(existsSync(snapshotPath(root)), false);
  const kept = JSON.parse(readFileSync(allowlistPath(root), 'utf8'));
  assert.deepEqual(kept['packages/core/src/index.ts'], ['./a', './gone']);

  // Removing the new line: --write may shrink the list, never grow it.
  writeFileSync(
    join(root, 'packages/core/src/index.ts'),
    "export * from './a';\n",
  );
  assert.equal(run(root).ok, false, 'the stale entry still fails a check');
  const shrink = run(root, { write: true });
  assert.deepEqual(shrink.errors, []);
  const shrunk = JSON.parse(readFileSync(allowlistPath(root), 'utf8'));
  assert.deepEqual(shrunk['packages/core/src/index.ts'], ['./a']);
  assert.deepEqual(run(root).errors, []);
});

test('TS version mismatch refuses before computing anything', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': 'export const a = 1;\n',
  });
  allow(root, []);
  const result = run(root, {
    write: true,
    ts: { ...ts, version: '0.0.1' },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /0\.0\.1/);
  assert.match(result.errors.join('\n'), new RegExp(ts.version.replace(/\./g, '\\.')));
  assert.equal(existsSync(snapshotPath(root)), false);
});

test('TS pin is read from the pnpm catalog, default or named', (t) => {
  const root = fixture(t, {
    'package.json': JSON.stringify({
      name: 'fixture-root',
      private: true,
      devDependencies: { typescript: 'catalog:' },
    }),
    'pnpm-workspace.yaml': [
      'packages:',
      "  - 'packages/*'",
      'catalog:',
      "  '@types/node': ^24.0.0",
      `  typescript: '${ts.version}' # compiler`,
      'catalogs:',
      '  tools:',
      '    typescript: 1.2.3',
      '',
    ].join('\n'),
    'packages/core/src/index.ts': 'export const a = 1;\n',
  });
  allow(root, []);
  assert.deepEqual(resolvePinnedTypeScript(root), {
    version: ts.version,
    from: 'pnpm-workspace.yaml catalog.typescript',
  });
  assert.deepEqual(run(root, { write: true }).errors, []);

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ devDependencies: { typescript: 'catalog:tools' } }),
  );
  assert.deepEqual(resolvePinnedTypeScript(root), {
    version: '1.2.3',
    from: 'pnpm-workspace.yaml catalogs.tools.typescript',
  });
});

test('a mismatch between the catalog pin and the loaded TypeScript is refused with an actionable message', (t) => {
  const root = fixture(t, {
    'package.json': JSON.stringify({
      devDependencies: { typescript: 'catalog:' },
    }),
    'pnpm-workspace.yaml': 'catalog:\n  typescript: 9.9.9\n',
    'packages/core/src/index.ts': 'export const a = 1;\n',
  });
  allow(root, []);
  const result = run(root, { write: true });
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  assert.match(text, /TypeScript mismatch/);
  assert.match(text, /loaded TypeScript \S+, but the repository pins 9\.9\.9/);
  assert.match(text, /pnpm-workspace\.yaml catalog\.typescript/);
  assert.match(text, /pnpm install --frozen-lockfile/);
  assert.match(text, /pnpm api:snapshot/);
  assert.equal(existsSync(snapshotPath(root)), false);

  // A range or a missing catalog entry is not a pin.
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'catalog:\n  typescript: ^6.0.0\n',
  );
  assert.match(
    run(root).errors.join('\n'),
    /must pin TypeScript to one exact version/,
  );
});

test('a snapshot recorded by another TypeScript says to regenerate it after a bump', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': 'export const a = 1;\n',
  });
  allow(root, []);
  assert.deepEqual(run(root, { write: true }).errors, []);
  const recorded = readFileSync(snapshotPath(root), 'utf8').replace(
    `"typescript": "${ts.version}"`,
    '"typescript": "0.0.1"',
  );
  writeFileSync(snapshotPath(root), recorded);
  const text = run(root).errors.join('\n');
  assert.match(text, /recorded with TypeScript 0\.0\.1/);
  assert.match(text, /run pnpm api:snapshot/);
});

test('type-only alias of class is type, through every hop of the chain', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': [
      "export type { Direct } from './c';",
      "export { Plain } from './c';",
      "export { ViaAlias } from './mid';",
      "export { ViaStar } from './star';",
      '',
    ].join('\n'),
    'packages/core/src/c.ts': [
      'export class Direct {}',
      'export class Plain {}',
      'export class ViaAlias {}',
      'export class ViaStar {}',
      '',
    ].join('\n'),
    'packages/core/src/mid.ts': "export type { ViaAlias } from './c';\n",
    'packages/core/src/star.ts': "export type * from './c';\n",
  });
  allow(root, []);
  const result = run(root, { write: true });
  assert.deepEqual(result.errors, []);
  const rows = byName(readSnapshot(root));
  assert.equal(rows.Direct.kind, 'type');
  assert.equal(rows.Plain.kind, 'value', 'control: a value re-export');
  assert.equal(rows.ViaAlias.kind, 'type');
  assert.equal(rows.ViaStar.kind, 'type');
});

test('unresolved external star fails without write', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts':
      "export const a = 1;\nexport * from 'not-installed-anywhere';\n",
  });
  allow(root, ['not-installed-anywhere']);
  const result = run(root, { write: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not-installed-anywhere/);
  assert.equal(existsSync(snapshotPath(root)), false);
});

test('TS2307 in reached module fails', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': "export * from './a';\n",
    'packages/core/src/a.ts':
      "import { x } from './missing';\nexport const y = x;\n",
  });
  allow(root, ['./a']);
  const result = run(root, { write: true });
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  assert.match(text, /TS2307/);
  assert.match(text, /packages\/core\/src\/a\.ts/);
  assert.equal(existsSync(snapshotPath(root)), false);
});

test('check mode reports added, removed, retyped and moved names; equal is clean', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': [
      "export { kept, moved } from './a';",
      "export { retyped } from './a';",
      "export { removed } from './a';",
      '',
    ].join('\n'),
    'packages/core/src/a.ts': [
      'export const kept = 1;',
      'export const moved = 1;',
      'export class retyped {}',
      'export const removed = 1;',
      '',
    ].join('\n'),
    'packages/core/src/b.ts': 'export const moved = 2;\n',
  });
  allow(root, []);
  assert.deepEqual(run(root, { write: true }).errors, []);
  assert.deepEqual(run(root).errors, [], 'equal → clean');

  writeFileSync(
    join(root, 'packages/core/src/index.ts'),
    [
      "export { kept } from './a';",
      "export { moved } from './b';",
      "export type { retyped } from './a';",
      "export { added } from './c';",
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'packages/core/src/c.ts'), 'export const added = 1;\n');
  const before = readFileSync(snapshotPath(root), 'utf8');
  const result = run(root);
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  assert.match(text, /added +added/);
  assert.match(text, /removed +removed/);
  assert.match(text, /retyped +retyped/);
  assert.match(text, /moved +moved/);
  assert.equal(readFileSync(snapshotPath(root), 'utf8'), before, 'check never writes');
});

test('a workspace package resolved to a /dist/ declaration fails', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts':
      "export type { DepShape } from '@fixture/dep';\n",
    'packages/dep/package.json': JSON.stringify({
      name: '@fixture/dep',
      version: '1.0.0',
      types: './dist/index.d.ts',
    }),
    'packages/dep/dist/index.d.ts': 'export interface DepShape { a: string }\n',
  });
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(join(root, 'packages/dep'), join(root, 'node_modules/@fixture/dep'));
  allow(root, []);
  const result = run(root, { write: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /\/dist\//);
  assert.equal(existsSync(snapshotPath(root)), false);
});

test('a workspace package resolved through source paths is labelled with its package name', (t) => {
  const root = fixture(t, {
    'packages/core/tsconfig.typecheck.json': JSON.stringify({
      compilerOptions: {
        ...JSON.parse(TSCONFIG).compilerOptions,
        paths: { '@fixture/dep': ['../dep/src/index.ts'] },
      },
    }),
    'packages/core/src/index.ts':
      "export type { DepShape } from '@fixture/dep';\n",
    'packages/dep/package.json': JSON.stringify({
      name: '@fixture/dep',
      version: '1.0.0',
    }),
    'packages/dep/src/index.ts': 'export interface DepShape { a: string }\n',
  });
  allow(root, []);
  const result = run(root, { write: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(readSnapshot(root).exports, [
    { name: 'DepShape', kind: 'type', module: '@fixture/dep' },
  ]);
});

test('a nested unresolved star inside a dependency barrel fails even when the imported name resolves', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts': "export { ok } from 'ext-barrel';\n",
    'node_modules/ext-barrel/package.json': JSON.stringify({
      name: 'ext-barrel',
      version: '1.0.0',
      types: './index.d.ts',
    }),
    'node_modules/ext-barrel/index.d.ts':
      "export declare const ok: number;\nexport * from './inner';\n",
    'node_modules/ext-barrel/inner.d.ts':
      "export declare const inner: number;\nexport * from 'missing-in-dependency';\n",
  });
  allow(root, []);
  const result = run(root, { write: true });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join('\n'),
    /node_modules\/ext-barrel\/inner\.d\.ts: export from 'missing-in-dependency' does not resolve/,
  );
  assert.equal(existsSync(snapshotPath(root)), false);

  // Negative control: the same barrel with the nested star resolved passes.
  writeFileSync(
    join(root, 'node_modules/ext-barrel/inner.d.ts'),
    'export declare const inner: number;\n',
  );
  assert.deepEqual(run(root, { write: true }).errors, []);
});

test('a dependency barrel reached through an imported binding is walked like one reached by export from', (t) => {
  for (const entrySource of [
    "export { ok } from 'ext-barrel';\n",
    "import { ok } from 'ext-barrel';\nexport { ok };\n",
  ]) {
    const root = fixture(t, {
      'packages/core/src/index.ts': entrySource,
      'node_modules/ext-barrel/package.json': JSON.stringify({
        name: 'ext-barrel',
        version: '1.0.0',
        types: './index.d.ts',
      }),
      'node_modules/ext-barrel/index.d.ts':
        "export * from './leaf';\nexport * from 'missing-in-dependency';\n",
      'node_modules/ext-barrel/leaf.d.ts': 'export declare const ok: number;\n',
    });
    allow(root, []);
    const result = run(root, { write: true });
    assert.equal(result.ok, false, entrySource);
    assert.match(
      result.errors.join('\n'),
      /node_modules\/ext-barrel\/index\.d\.ts: export from 'missing-in-dependency' does not resolve/,
      entrySource,
    );
    assert.equal(existsSync(snapshotPath(root)), false);

    // Negative control: the barrel without the unresolved star passes.
    writeFileSync(
      join(root, 'node_modules/ext-barrel/index.d.ts'),
      "export * from './leaf';\n",
    );
    assert.deepEqual(run(root, { write: true }).errors, [], entrySource);
  }
});

test('a missing star allowlist is never rebuilt from the current stars; only --init writes the first one', (t) => {
  const root = fixture(t, {
    'packages/core/src/index.ts':
      "export * from './a';\nexport * from './b';\n",
    'packages/core/src/a.ts': 'export const a = 1;\n',
    'packages/core/src/b.ts': 'export const b = 1;\n',
  });
  const write = run(root, { write: true });
  assert.equal(write.ok, false);
  assert.match(write.errors.join('\n'), /export-star-allowlist\.json is missing/);
  assert.equal(existsSync(allowlistPath(root)), false);
  assert.equal(existsSync(snapshotPath(root)), false);

  const first = run(root, { write: true, init: true });
  assert.deepEqual(first.errors, []);
  assert.deepEqual(
    JSON.parse(readFileSync(allowlistPath(root), 'utf8'))[
      'packages/core/src/index.ts'
    ],
    ['./a', './b'],
  );
  const again = run(root, { write: true, init: true });
  assert.equal(again.ok, false, '--init refuses an existing allowlist');
  assert.match(again.errors.join('\n'), /already exists/);
});

test('--against: a star the base allowlist does not hold fails, a shrink passes, a new allowlist passes', (t) => {
  const root = fixture(t, {});
  const allowRel = 'packages/core/api/export-star-allowlist.json';
  const base = { 'packages/core/src/index.ts': ['./a', './b'] };
  const atRef = { text: JSON.stringify(base) };
  const options = {
    root,
    ref: 'base',
    readAtRef: (_root, ref, path) => {
      assert.equal(ref, 'base');
      assert.equal(path, allowRel);
      return atRef.text;
    },
    refResolves: () => true,
  };
  allow(root, ['./a', './b', './c']);
  const grown = checkStarAllowlistAgainst(options);
  assert.equal(grown.ok, false);
  assert.match(grown.errors.join('\n'), /'\.\/c'.*not in the allowlist at base/);
  allow(root, ['./a']);
  assert.deepEqual(checkStarAllowlistAgainst(options).errors, []);
  atRef.text = null;
  assert.deepEqual(checkStarAllowlistAgainst(options).errors, []);
  const unreadable = checkStarAllowlistAgainst({
    ...options,
    refResolves: () => false,
  });
  assert.equal(unreadable.ok, false, 'an unreadable ref never passes');
  rmSync(allowlistPath(root));
  assert.equal(checkStarAllowlistAgainst(options).ok, false);
});

test('--against: a base commit whose allowlist blob cannot be read fails; a base without the file passes', (t) => {
  const root = fixture(t, {});
  const allowRel = 'packages/core/api/export-star-allowlist.json';
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'empty base');
  git('tag', 'no-file');
  allow(root, ['./a']);
  git('add', allowRel);
  git('commit', '-q', '-m', 'base');
  git('tag', 'with-file');
  const options = { root };

  assert.equal(requiredFileAtRef(root, 'no-file', allowRel), null);
  assert.deepEqual(checkStarAllowlistAgainst({ ...options, ref: 'no-file' }).errors, []);
  assert.deepEqual(checkStarAllowlistAgainst({ ...options, ref: 'with-file' }).errors, []);
  allow(root, ['./a', './b']);
  assert.equal(checkStarAllowlistAgainst({ ...options, ref: 'with-file' }).ok, false);

  // The commit resolves but its allowlist blob is gone from the object store.
  const blob = git('rev-parse', `with-file:${allowRel}`);
  rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  assert.throws(() => requiredFileAtRef(root, 'with-file', allowRel));
  const broken = checkStarAllowlistAgainst({ ...options, ref: 'with-file' });
  assert.equal(broken.ok, false, 'a failed blob read is never a missing file');
  assert.match(broken.errors.join('\n'), /cannot read packages\/core\/api\/export-star-allowlist\.json at with-file/);
});

test('a namespace re-export is refused in either form', (t) => {
  for (const index of [
    "export * as ns from './barrel';\n",
    "import * as ns from './barrel';\nexport { ns };\n",
  ]) {
    const root = fixture(t, {
      'packages/core/src/index.ts': index,
      'packages/core/src/barrel.ts': 'export const one = 1;\n',
    });
    allow(root, []);
    const result = run(root, { write: true });
    assert.equal(result.ok, false, index);
    assert.match(result.errors.join('\n'), /'ns' re-exports a whole module/);
    assert.equal(existsSync(snapshotPath(root)), false);
  }
});

test('real core entries resolve workspace packages to src with no dist present and match the committed snapshots', () => {
  const result = checkExportSnapshot({
    root: repoRoot,
    hideWorkspaceDist: true,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  for (const files of Object.values(result.resolvedFiles)) {
    assert.equal(
      files.some((file) => /^packages\/[^/]+\/dist\//.test(file)),
      false,
    );
  }
});
