import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from './index.js';

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, '..');
const read = (path: string) => readFileSync(resolve(packageDir, path), 'utf8');

/** The runtime exports of the package root. Adding a name is deliberate. */
const ROOT_EXPORTS = [
  'RESERVED_ENV_KEYS',
  'buildSidecarEnv',
  'parseSidecarManifest',
  'serializeSidecarManifest',
];

describe('the package root exports an explicit list', () => {
  it('never uses export * (a new internal export cannot become public by accident)', () => {
    expect(read('src/index.ts')).not.toMatch(/export\s+\*/);
  });

  it('exports exactly the documented names', () => {
    expect(Object.keys(root).sort()).toEqual([...ROOT_EXPORTS].sort());
  });
});

describe('the package subpaths', () => {
  it('declares exactly the root, bundler and launcher entries', () => {
    const exports = JSON.parse(read('package.json')).exports;
    expect(Object.keys(exports)).toEqual([
      '.',
      './bundler',
      './launcher',
      './package.json',
    ]);
  });

  it('keeps app-runtime an optional peer that only the launcher imports', () => {
    const manifest = JSON.parse(read('package.json'));
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependenciesMeta).toEqual({
      '@happyvertical/smrt-app-runtime': { optional: true },
    });
    expect(read('src/index.ts')).not.toMatch(/launcher|app-runtime/);
  });

  it('builds the bundler as its own entry', () => {
    expect(read('vite.config.ts')).toContain(
      "{ name: 'bundler', source: 'src/bundler/index.ts' }",
    );
  });

  it('builds the launcher as its own entry', () => {
    expect(read('vite.config.ts')).toContain(
      "{ name: 'launcher', source: 'src/launcher/index.ts' }",
    );
  });
});
