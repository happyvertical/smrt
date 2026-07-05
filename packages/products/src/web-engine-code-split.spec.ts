/**
 * CI-gated proof that the `@happyvertical/smrt-web` client-data engine
 * code-splits out of the products standalone app's public entry (#1761, slice D,
 * ratified condition ①).
 *
 * The analysis lives in `scripts/check-web-engine-code-split.mjs`, which
 * exercises the REAL app graph — not a synthetic fixture:
 *   - in CI (and whenever the build runs) it runs the products `--mode
 *     standalone` vite build and asserts, over the emitted rollup chunk graph,
 *     that the entry's STATIC-import closure has zero `@tanstack/*` and the
 *     engine appears only in `dynamicImports`-reached chunks;
 *   - locally, if the build hits the pre-existing nested-worktree `Tsconfig not
 *     found` failure, it falls back to parsing the real `src/app/main.ts` static
 *     import graph and asserts no engine-bearing module is reachable via a static
 *     edge.
 *
 * This spec runs that script inside the normal `vitest run` so the proof gates
 * every PR — the engine NEVER reaching a public / smrt-sites page is the #1 risk
 * of #1761. `.spec.ts` (integration): it shells out to a real build / graph walk.
 */

import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/check-web-engine-code-split.mjs');

describe('smrt-web engine code-split (#1761 ①)', () => {
  it('keeps the standalone app entry engine-free and reaches @tanstack only via import()', async () => {
    // The script exits 0 and prints the proof on success; non-zero on any
    // regression (engine reachable from the public entry via a static edge, or
    // not bundled at all). A non-zero exit makes execFile reject, failing the
    // test. maxBuffer is raised for the vite build's verbose stdout.
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT], {
      maxBuffer: 32 * 1024 * 1024,
    });

    // Robust to both the real-build and source-graph modes.
    expect(stdout).toContain('✓ web-engine-code-split');
    expect(stdout).toMatch(
      /engine-free|no engine-bearing module|only reached through import\(\)/,
    );
  }, 240_000); // The real standalone vite build runs here; CI runners are slower.
});
