import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
