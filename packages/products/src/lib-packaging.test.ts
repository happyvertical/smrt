/**
 * Raw `dist/lib/lib/**` packaging topology guard (#1536).
 *
 * `build:lib` emits the package three ways: the public subpath bundles
 * (`dist/lib/*.js`, wired to `package.json#exports`) plus a raw `.svelte`
 * tree under `dist/lib/lib/` produced by `svelte-package` over
 * `src/lib/{components,features,stores}`. `svelte-package` only emits files
 * from its `-i` input dir, so shared modules that live directly under
 * `src/lib` (e.g. `i18n.ts`, `mock-smrt-client.ts`) — imported by the
 * packaged components as `../i18n.js` / `../mock-smrt-client` — must be
 * emitted into `dist/lib/lib/` by the Vite library build's `lib/*` entries
 * instead. #1536: `lib/i18n` was missing, so packaged components kept an
 * `import { M } from '../i18n.js'` that never resolved.
 *
 * This guard fails if any *runtime* (value) relative import in the raw tree
 * points at a file the build never emitted — catching i18n and any other
 * shared module that drifts out of the packaged set. It is a no-op when the
 * package has not been built (the turbo `test` task depends on `build`, so it
 * always runs against a fresh `dist/` in CI).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawTreeDir = join(packageDir, 'dist', 'lib', 'lib');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolvesAsRuntime(fromDir: string, spec: string): boolean {
  const base = resolve(fromDir, spec);
  return [base, `${base}.js`, `${base}.svelte`, join(base, 'index.js')].some(
    isFile,
  );
}

// `import`/`export ... from '<relative>'` and bare `import '<relative>'`,
// excluding type-only statements (erased at runtime by the Svelte/TS compiler).
const STATEMENT =
  /(import|export)(\s+type\b)?[^;]*?from\s*["'](\.[^"']+)["']|import\s*["'](\.[^"']+)["']/g;

describe('products raw dist/lib/lib packaging', () => {
  it('emits the i18n catalog so packaged components can resolve it', () => {
    if (!existsSync(rawTreeDir)) return; // not built; see file header
    const catalog = join(rawTreeDir, 'i18n.js');
    expect(existsSync(catalog), 'dist/lib/lib/i18n.js missing').toBe(true);
    expect(readFileSync(catalog, 'utf8')).toContain('defineMessages');
  });

  it('resolves every runtime relative import in the raw tree', () => {
    if (!existsSync(rawTreeDir)) return; // not built; see file header
    const files = walk(rawTreeDir).filter(
      (f) => f.endsWith('.js') || f.endsWith('.svelte'),
    );
    const unresolved: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const fromDir = dirname(file);
      STATEMENT.lastIndex = 0;
      let match: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((match = STATEMENT.exec(src))) {
        const isTypeOnly = Boolean(match[2]);
        if (isTypeOnly) continue;
        const spec = match[3] ?? match[4];
        if (spec && !resolvesAsRuntime(fromDir, spec)) {
          unresolved.push(`${relative(rawTreeDir, file)} -> ${spec}`);
        }
      }
    }
    expect(
      unresolved,
      `unresolved runtime imports in dist/lib/lib:\n${unresolved.join('\n')}`,
    ).toEqual([]);
  });
});
