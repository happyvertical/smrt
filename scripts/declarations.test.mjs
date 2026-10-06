import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
import test from 'node:test';
import { declarations } from './declarations.ts';

function fixture(t, source) {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-declaration-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {
    target: 'ES2023', module: 'ESNext', moduleResolution: 'bundler', strict: true, types: [],
  }}));
  writeFileSync(join(dir, 'src/index.ts'), source);
  return dir;
}

test('declarations retain globals in their owning module and preserve public imports', (t) => {
  const dir = fixture(t, "export type { Value } from './registry.js';\n");
  writeFileSync(join(dir, 'src/registry.ts'), `export interface Value { name: string }
declare global { var __smrtDeclarationTestRegistry: Map<string, Value> | undefined; }
export const getRegistry = () => globalThis.__smrtDeclarationTestRegistry;
`);
  declarations({ packageDir: dir, entries: { public: join(dir, 'src/registry.ts') } }).closeBundle();
  const index = readFileSync(join(dir, 'dist/index.d.ts'), 'utf8');
  const registry = readFileSync(join(dir, 'dist/registry.d.ts'), 'utf8');
  assert.match(index, /from ['"]\.\/registry\.js['"]/);
  assert.doesNotMatch(index, /declare global/);
  assert.match(registry, /declare global/);
  assert.match(registry, /Map<string, Value>/);
  assert.match(readFileSync(join(dir, 'dist/public.d.ts'), 'utf8'), /export \* from '\.\/registry.js'/);
});

test('invalid declarations fail the build and leave no emitted files', (t) => {
  const dir = fixture(t, 'export const invalid: string = 42;');
  assert.throws(() => declarations({ packageDir: dir }).closeBundle(), /Declaration generation failed/);
  assert.equal(existsSync(join(dir, 'dist/index.d.ts')), false);
});

test('declaration generation excludes tests and fixture trees with custom exclusions', (t) => {
  const dir = fixture(t, 'export const value = 1;');
  for (const path of ['src/__tests__/fixture.ts', 'src/test-stubs/mock.ts', 'src/value.test.ts', 'src/value.spec.ts']) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), 'export const fixture = true;');
  }
  declarations({ packageDir: dir, exclude: ['**/*.config.ts'] }).closeBundle();
  assert.equal(existsSync(join(dir, 'dist/index.d.ts')), true);
  for (const path of ['__tests__/fixture', 'test-stubs/mock', 'value.test', 'value.spec']) {
    assert.equal(existsSync(join(dir, `dist/${path}.d.ts`)), false, path);
    assert.equal(existsSync(join(dir, `dist/${path}.d.ts.map`)), false, path);
  }
});

function compileConsumer(dir, mode) {
  const config = join(dir, `consumer-${mode}.json`);
  writeFileSync(config, JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext',
    moduleResolution: mode, strict: true, skipLibCheck: false, noEmit: true, types: [],
  }, files: ['consumer.ts'] }));
  return spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], { encoding: 'utf8' });
}

test('packed declarations resolve file and index imports without silently losing inherited types', (t) => {
  const dir = fixture(t, `export * from './models';
export type { Value } from './value';
export type Imported = import('./value').Value;
export type Self = import('.').Value;
export { explicit } from './explicit.js';
`);
  mkdirSync(join(dir, 'src/models'));
  writeFileSync(join(dir, 'src/value.ts'), 'export interface Value { title: string }');
  writeFileSync(join(dir, 'src/models/index.ts'), `import type { Value } from '../value';
export class Collection { async get(): Promise<Value | null> { return null; } }
export class Derived extends Collection {}
export type ParentValue = import('..').Value;
`);
  writeFileSync(join(dir, 'src/explicit.ts'), 'export const explicit = true;');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'declaration-fixture', version: '1.0.0', type: 'module', files: ['dist'], exports: { '.': { types: './dist/index.d.ts' } } }));
  declarations({ packageDir: dir }).closeBundle();
  const pack = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: dir, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const consumer = join(dir, 'consumer');
  const installed = join(consumer, 'node_modules/declaration-fixture');
  mkdirSync(installed, { recursive: true });
  const extract = spawnSync('tar', ['-xzf', join(dir, JSON.parse(pack.stdout)[0].filename), '--strip-components=1', '-C', installed], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  writeFileSync(join(consumer, 'package.json'), '{"type":"module"}');
  writeFileSync(join(consumer, 'consumer.ts'), `import { Derived, explicit, type Value, type Imported, type Self, type ParentValue } from 'declaration-fixture';
const result = new Derived().get();
const typed: Promise<Value | null> = result;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const inheritedIsAny: IsAny<Awaited<typeof result>> = false;
const imported: Imported = { title: 'typed' };
const self: Self = { title: 'same-directory index' };
const parent: ParentValue = { title: 'parent-directory index' };
// @ts-expect-error A string is not a typed inherited collection result.
const invalid: Awaited<typeof result> = 'untyped';
void [typed, inheritedIsAny, imported, self, parent, explicit, invalid];
`);
  for (const mode of ['Bundler', 'NodeNext']) {
    const result = compileConsumer(consumer, mode);
    assert.equal(result.status, 0, `${mode}: ${result.stdout}${result.stderr}`);
  }
  const emitted = readFileSync(join(dir, 'dist/index.d.ts'), 'utf8');
  assert.match(emitted, /['"]\.\/models\/index\.js['"]/);
  assert.match(emitted, /['"]\.\/value\.js['"]/);
  assert.match(emitted, /['"]\.\/explicit\.js['"]/);
});

function decodedMappings(encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let source = 0, sourceLine = 0, sourceColumn = 0;
  return encoded.split(';').flatMap((line, generatedLine) => {
    let generatedColumn = 0;
    return line.split(',').filter(Boolean).map((segment) => {
      const values = [];
      let value = 0, shift = 0;
      for (const character of segment) {
        const digit = alphabet.indexOf(character);
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) { shift += 5; continue; }
        values.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0; shift = 0;
      }
      generatedColumn += values[0];
      if (values.length < 4) return { generatedLine, generatedColumn };
      source += values[1]; sourceLine += values[2]; sourceColumn += values[3];
      return { generatedLine, generatedColumn, source, sourceLine, sourceColumn };
    });
  });
}

test('rewritten specifiers retain declaration map source positions', (t) => {
  const source = "export type { Value } from './nested';\n";
  const dir = fixture(t, source);
  mkdirSync(join(dir, 'src/nested'));
  writeFileSync(join(dir, 'src/nested/index.ts'), 'export interface Value { title: string }');
  declarations({ packageDir: dir }).closeBundle();
  const declaration = readFileSync(join(dir, 'dist/index.d.ts'), 'utf8');
  const map = JSON.parse(readFileSync(join(dir, 'dist/index.d.ts.map'), 'utf8'));
  assert.equal(map.file, 'index.d.ts');
  assert.deepEqual(map.sources, ['../src/index.ts']);
  const end = declaration.indexOf(';');
  const mapping = decodedMappings(map.mappings).find((value) => value.generatedLine === 0 && value.generatedColumn === end);
  assert.ok(mapping, `Expected mapping at expanded module end ${end}: ${map.mappings}`);
  assert.equal(mapping.sourceLine, 0);
  assert.equal(mapping.sourceColumn, source.indexOf(';'));
});

test('explicit module and asset suffixes survive while TS module variants resolve', (t) => {
  const dir = fixture(t, `export type { Value as Esm } from './esm.mts';
export type { Value as Cjs } from './common.cts';
export type { Value as ExplicitEsm } from './esm.mjs';
export type { Value as ExplicitCjs } from './common.cjs';
export type Asset = typeof import('./settings.json');
export type Widget = import('./Widget.svelte').default;
export type Builtin = import('external-types').External;
`);
  const config = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  Object.assign(config.compilerOptions, { allowImportingTsExtensions: true, resolveJsonModule: true });
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'src/esm.mts'), 'export interface Value { esm: true }');
  writeFileSync(join(dir, 'src/common.cts'), 'export interface Value { cjs: true }');
  writeFileSync(join(dir, 'src/settings.json'), '{"enabled":true}');
  writeFileSync(join(dir, 'src/Widget.svelte.d.ts'), 'export default class Widget {}');
  writeFileSync(join(dir, 'ambient.d.ts'), "declare module 'external-types' { export interface External { external: true } }");
  declarations({ packageDir: dir, entries: { esmAlias: join(dir, 'src/esm.mts'), cjsAlias: join(dir, 'src/common.cts') } }).closeBundle();
  assert.match(readFileSync(join(dir, 'dist/esmAlias.d.ts'), 'utf8'), /esm\.mjs/);
  assert.match(readFileSync(join(dir, 'dist/cjsAlias.d.ts'), 'utf8'), /common\.cjs/);
  const declaration = readFileSync(join(dir, 'dist/index.d.ts'), 'utf8');
  for (const name of ['./esm.mjs', './common.cjs', './settings.json', './Widget.svelte', 'external-types']) {
    assert.ok(declaration.includes(`'${name}'`) || declaration.includes(`"${name}"`), name);
  }
  assert.doesNotMatch(declaration, /['"]\.\/(?:esm\.mts|common\.cts)['"]/);
  assert.ok(existsSync(join(dir, 'dist/esm.d.mts')));
  assert.ok(existsSync(join(dir, 'dist/common.d.cts')));
});

test('declaration transformer type-checks against the pinned compiler API', () => {
  const packageDir = new URL('../packages/core/', import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--types', 'node', '../../scripts/declarations-emitter.ts'], { cwd: packageDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
