import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveRecipeDemo, effectiveRecipeDemo } from '../recipe-demo';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  readFileSync(resolve(srcDir, '../package.json'), 'utf-8'),
) as { exports: Record<string, unknown> };

/**
 * Every module specifier `file` imports or re-exports, except type-only ones
 * (erased at build time, so they never reach a browser bundle).
 */
function runtimeSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf-8');
  const specifiers: string[] = [];
  const pattern =
    /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    if (!match[2]) specifiers.push(match[3]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveSource(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, resolve(base, 'index.ts'), base]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier} (from ${from}) does not resolve`);
}

describe('@happyvertical/smrt-core/recipe-demo (#3719)', () => {
  it('is a published subpath that maps to the built module', () => {
    expect(packageJson.exports['./recipe-demo']).toEqual({
      types: './dist/recipe-demo.d.ts',
      import: './dist/recipe-demo.js',
      default: './dist/recipe-demo.js',
    });
  });

  it('has a module graph with no node: or package imports', () => {
    // The root and `/browser` entries both reach `manifest-loader`, which
    // calls `createRequire` from `node:module` at load. This subpath exists so
    // a browser page can import the demo rules without that graph.
    const pending = [resolve(srcDir, 'recipe-demo.ts')];
    const seen = new Set<string>();
    const offenders: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of runtimeSpecifiers(file)) {
        if (specifier.startsWith('.')) {
          pending.push(resolveSource(file, specifier));
        } else {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('exports the demo rules', () => {
    expect(typeof deriveRecipeDemo).toBe('function');
    expect(typeof effectiveRecipeDemo).toBe('function');
  });
});
