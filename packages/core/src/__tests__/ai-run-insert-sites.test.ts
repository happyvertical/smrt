/**
 * Every run row is written through one helper, `insertAiRunRowTx`, which
 * reserves the run id's digest in the same transaction (docs/content/
 * ai-runs.md section 8, "Run identity"). A new raw insert into
 * `_smrt_ai_runs` would skip the registry, so no non-test source outside the
 * allow-list may contain one. The helper is not part of the package
 * surface.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesRoot = join(__dirname, '..', '..', '..');

/** Files allowed to insert run rows, and why. */
const ALLOWED = new Map([
  // The one helper; it registers the id first.
  ['core/src/system/ai-run-model.ts', 'insertAiRunRowTx'],
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'test' || name === 'tests') continue;
      sources(path, out);
    } else if (
      /\.(ts|js|mjs|svelte)$/.test(name) &&
      !/\.(test|spec)\.|\.d\.ts$/.test(name)
    ) {
      out.push(path);
    }
  }
  return out;
}

describe('run row insert sites', () => {
  it('only the registered helper inserts into _smrt_ai_runs', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(packagesRoot)) {
      const src = join(packagesRoot, pkg, 'src');
      try {
        statSync(src);
      } catch {
        continue;
      }
      for (const file of sources(src)) {
        const text = readFileSync(file, 'utf8');
        // `_smrt_ai_runs_new` (the compatibility rebuild's copy) is not the
        // run table.
        if (/INSERT\s+INTO\s+_smrt_ai_runs(?![\w])/i.test(text)) {
          const rel = relative(packagesRoot, file).split('\\').join('/');
          if (!ALLOWED.has(rel)) offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the helper is not exported from the package surface', () => {
    const coreSrc = join(packagesRoot, 'core', 'src');
    for (const entry of ['index.ts', 'browser.ts', 'system/browser.ts']) {
      const text = readFileSync(join(coreSrc, entry), 'utf8');
      expect(text, entry).not.toMatch(/insertAiRunRowTx/);
    }
  });
});
