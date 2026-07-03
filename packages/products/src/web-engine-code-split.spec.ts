/**
 * CI-gated proof that the `@happyvertical/smrt-web` client-data engine
 * code-splits out of a public entry (#1761, slice D, ratified condition ①).
 *
 * The heavy lifting lives in `scripts/check-web-engine-code-split.mjs` (a
 * standalone, esbuild-based, oxc-free chunk-graph assertion that CI can also run
 * directly). This spec runs that script inside the normal `vitest run` so the
 * proof is part of the products test suite and gates every PR — the engine
 * NEVER reaching a public / smrt-sites page is the #1 risk of #1761.
 *
 * `.spec.ts` (integration): it shells out to a real esbuild bundle rather than
 * exercising a unit in isolation.
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
  it('keeps the public entry engine-free and isolates @tanstack to a lazy chunk', async () => {
    // The script exits 0 and prints the proof on success; non-zero on any
    // regression (engine leaking into the public entry, or not bundled at
    // all). A non-zero exit makes execFile reject, failing the test.
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT]);

    expect(stdout).toContain('public entry is engine-free');
    expect(stdout).toContain('public-entry @tanstack modules: 0');
    // At least one @tanstack module must be isolated to a lazy chunk, proving
    // the engine is really bundled (the split isn't masking a broken import).
    expect(stdout).toMatch(/lazy-chunk\s+@tanstack modules: [1-9]\d*/);
  }, 120_000); // esbuild-bundles the real engine on a cold run; CI runners are slower.
});
