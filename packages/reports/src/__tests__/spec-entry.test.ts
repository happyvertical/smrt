/**
 * The `./spec` subpath is the browser-safe runtime report surface (#4100): a
 * browser bundles it, so nothing it reaches at runtime may import a Node
 * built-in. This walks the entry's source import graph (type-only imports are
 * erased by the compiler and do not count) and checks every specifier.
 */

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(SRC, 'spec.ts');

/**
 * The only package module the entry may import at runtime: smrt-core's
 * dependency-free `SmrtError`. Never smrt-core's root, whose browser entry
 * still reaches the registry and manifest loader (`process.env` at load), so
 * a browser bundle of it fails before any report code runs.
 */
const ALLOWED_PACKAGE_IMPORTS = new Set([
  '@happyvertical/smrt-core/smrt-error',
]);

const BUILTINS = new Set(builtinModules);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Runtime specifiers: `import x from`, `export { x } from`, side-effect and dynamic imports. */
function runtimeSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)[\s}]from\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(statement)) {
    if (match[2]) continue;
    const clause = match[3];
    // `import { type A, type B } from` is erased too.
    const names = clause
      .replace(/^[{\s]+|[}\s]+$/g, '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (
      clause.trim().startsWith('{') &&
      names.length > 0 &&
      names.every((name) => name.startsWith('type '))
    ) {
      continue;
    }
    found.push(match[4]);
  }
  for (const match of code.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    found.push(match[1]);
  }
  for (const match of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push(match[1]);
  }
  return found;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function walk(entry: string): {
  files: string[];
  external: { specifier: string; from: string }[];
} {
  const seen = new Set<string>();
  const external: { specifier: string; from: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      } else {
        external.push({ specifier, from: relative(SRC, file) });
      }
    }
  }
  return { files: [...seen].map((file) => relative(SRC, file)), external };
}

describe('./spec browser entry (#4100)', () => {
  const graph = walk(ENTRY);

  it('reaches the grammar but none of the server modules', () => {
    expect(graph.files).toEqual(
      expect.arrayContaining([
        'runtime-spec.ts',
        'runtime-plan.ts',
        'runtime-memory.ts',
      ]),
    );
    for (const serverOnly of [
      'runtime-spec-hash.ts',
      'runtime-compiler.ts',
      'runtime-report.ts',
      'runtime-server.ts',
      'index.ts',
    ]) {
      expect(graph.files).not.toContain(serverOnly);
    }
  });

  it('imports no Node built-in anywhere in its graph', () => {
    const builtins = graph.external.filter(
      ({ specifier }) =>
        specifier.startsWith('node:') || BUILTINS.has(packageName(specifier)),
    );
    expect(builtins).toEqual([]);
  });

  it('imports no package module but the dependency-free SmrtError', () => {
    const specifiers = new Set(
      graph.external.map(({ specifier }) => specifier),
    );
    for (const specifier of specifiers) {
      expect(ALLOWED_PACKAGE_IMPORTS.has(specifier), specifier).toBe(true);
    }
    // And that module itself imports nothing.
    const core = resolve(
      SRC,
      '..',
      'node_modules',
      '@happyvertical',
      'smrt-core',
    );
    const manifest = JSON.parse(
      readFileSync(resolve(core, 'package.json'), 'utf8'),
    ) as { exports: Record<string, { import?: string }> };
    expect(manifest.exports['./smrt-error']?.import).toBe(
      './dist/smrt-error.js',
    );
    expect(
      runtimeSpecifiers(
        readFileSync(resolve(core, 'src', 'smrt-error.ts'), 'utf8'),
      ),
    ).toEqual([]);
  });

  it('is published as the ./spec subpath', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(SRC, '..', 'package.json'), 'utf8'),
    ) as { exports: Record<string, { import?: string }> };
    expect(manifest.exports['./spec']?.import).toBe('./dist/spec.js');
  });
});
