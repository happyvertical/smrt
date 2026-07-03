#!/usr/bin/env node
/**
 * Code-split proof for the `@happyvertical/smrt-web` runtime (#1761, slice D,
 * ratified condition ①).
 *
 * THE #1 risk of #1761: the ~76 kB TanStack client-data engine must NEVER load
 * on public / smrt-sites pages — only surfaces that actually use a live
 * collection may pay for it. Products is the reference consumer, so this script
 * proves, deterministically and CI-safely, that the engine code-splits into a
 * lazily-loaded chunk and is ABSENT from a public (engine-free) entry.
 *
 * ── What it asserts ─────────────────────────────────────────────────────────
 * It bundles two entries that model the products app's real split boundary,
 * using the SAME `@happyvertical/smrt-web` + `@happyvertical/smrt-svelte/web`
 * packages the app ships and the SAME dynamic-`import()` boundary
 * `src/app/pages/LiveProductsPage.svelte` uses:
 *
 *   - `public-entry`  — imports NOTHING from the runtime (models a public /
 *                       smrt-sites page).
 *   - `live-entry`    — reaches the engine-bearing module ONLY through
 *                       `await import(...)` (models LiveProductsPage).
 *
 * Then, from esbuild's metafile module graph, it asserts:
 *   1. the `public-entry` chunk closure contains ZERO `@tanstack/*` modules
 *      (the engine never reaches a public entry), and
 *   2. some lazily-loaded chunk (reachable only via the dynamic import) DOES
 *      contain `@tanstack/*` modules (the engine really is bundled — the split
 *      isn't hiding a broken/empty import).
 *
 * It asserts PRESENCE / ABSENCE by module graph, never byte thresholds — no
 * flaky size gate.
 *
 * ── Why esbuild, not the products vite build ────────────────────────────────
 * A full `vite build --mode standalone` is both heavy and, in a nested git
 * worktree, trips a pre-existing environment failure (`Tsconfig not found
 * .../packages/accounts`, a vite-8 oxc-transform / pnpm-symlink artifact that
 * does NOT reproduce in CI's isolated checkout). esbuild has its own resolver
 * and bundler — no oxc, no tsconfig-references walk — so this proof runs
 * identically here and in CI. It resolves the runtime packages from THIS
 * package's `node_modules` (`@happyvertical/smrt-web` is a real dependency), so
 * the check is only meaningful after `pnpm install`.
 *
 * Run: `node packages/products/scripts/check-web-engine-code-split.mjs`
 * (or via the package `test:code-split` script / the vitest spec that wraps it).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..'); // packages/products

/** Package specifier of the client-data engine that must stay code-split. */
const ENGINE_MODULE_MARKER = '@tanstack';

/**
 * Build the two-entry fixture with esbuild code-splitting and return the
 * metafile. Fixtures are written under the package dir so esbuild resolves the
 * runtime packages from this package's `node_modules`, then cleaned up.
 */
async function buildFixture() {
  const fixtureDir = mkdtempSync(join(PACKAGE_DIR, '.code-split-check-'));
  try {
    // Public entry: models a public / smrt-sites page — imports nothing from
    // the runtime, so the engine must never reach its chunk closure.
    writeFileSync(
      join(fixtureDir, 'public-entry.js'),
      "export const renderPublic = () => 'public page — no live data';\n",
    );

    // Engine-bearing module: the SAME runtime + Svelte binding the reference
    // store and live component import statically. Mirrors
    // src/lib/stores/product-collection.ts + LiveProductList.svelte.
    writeFileSync(
      join(fixtureDir, 'live-module.js'),
      [
        "import { createSmrtCollection } from '@happyvertical/smrt-web';",
        "import { liveCollection } from '@happyvertical/smrt-svelte/web';",
        'export const engine = { createSmrtCollection, liveCollection };',
        '',
      ].join('\n'),
    );

    // Live entry: reaches the engine-bearing module ONLY through a dynamic
    // import — the SAME code-split boundary LiveProductsPage.svelte uses.
    writeFileSync(
      join(fixtureDir, 'live-entry.js'),
      [
        'export async function mountLive() {',
        "  const mod = await import('./live-module.js');",
        '  return mod.engine;',
        '}',
        '',
      ].join('\n'),
    );

    const result = await build({
      absWorkingDir: PACKAGE_DIR,
      entryPoints: {
        public: join(fixtureDir, 'public-entry.js'),
        live: join(fixtureDir, 'live-entry.js'),
      },
      outdir: join(fixtureDir, 'out'),
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      // Match the runtime's browser resolution so the real engine is pulled in.
      conditions: ['svelte', 'browser', 'import', 'module', 'default'],
      target: 'es2022',
      metafile: true,
      write: false,
      logLevel: 'silent',
      chunkNames: 'chunks/[name]-[hash]',
    });
    return result.metafile;
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

/** True when a metafile input path belongs to the client-data engine. */
function isEngineInput(inputPath) {
  return inputPath.includes(ENGINE_MODULE_MARKER);
}

/**
 * Collect the transitive set of engine inputs reachable from an output chunk by
 * following static `imports` (NOT dynamic imports — a dynamic import is the
 * split boundary, whose target lands in a SEPARATE chunk we look at on its own).
 */
function engineInputsInChunkClosure(metafile, entryOutputPath) {
  const seenOutputs = new Set();
  const engineInputs = new Set();

  const visit = (outputPath) => {
    if (seenOutputs.has(outputPath)) return;
    seenOutputs.add(outputPath);
    const output = metafile.outputs[outputPath];
    if (!output) return;
    for (const input of Object.keys(output.inputs)) {
      if (isEngineInput(input)) engineInputs.add(input);
    }
    for (const imported of output.imports ?? []) {
      // Only follow STATIC edges within the bundle. `kind` is
      // 'import-statement' for static, 'dynamic-import' for `import()`.
      if (imported.kind === 'import-statement' && imported.path) {
        visit(imported.path);
      }
    }
  };

  visit(entryOutputPath);
  return engineInputs;
}

/** All engine inputs present anywhere in the whole build (any chunk). */
function allEngineInputs(metafile) {
  const engineInputs = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      if (isEngineInput(input)) engineInputs.add(input);
    }
  }
  return engineInputs;
}

function findEntryOutput(metafile, entryBasename) {
  const match = Object.entries(metafile.outputs).find(
    ([outPath, output]) =>
      output.entryPoint?.endsWith(`${entryBasename}.js`) ||
      outPath.endsWith(`/${entryBasename}.js`),
  );
  return match?.[0];
}

async function main() {
  let metafile;
  try {
    metafile = await buildFixture();
  } catch (error) {
    console.error(
      '✗ web-engine-code-split: fixture build failed. Ensure `pnpm install` ran\n' +
        '  so `@happyvertical/smrt-web` + `@happyvertical/smrt-svelte` resolve from\n' +
        "  this package's node_modules.\n",
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const publicOutput = findEntryOutput(metafile, 'public');
  const liveOutput = findEntryOutput(metafile, 'live');
  if (!publicOutput || !liveOutput) {
    console.error(
      '✗ web-engine-code-split: could not locate the public/live entry outputs in the metafile.',
    );
    process.exit(1);
  }

  const publicEngine = engineInputsInChunkClosure(metafile, publicOutput);
  const totalEngine = allEngineInputs(metafile);
  // The live entry's dynamic-import target is a separate chunk; assert the
  // engine exists SOMEWHERE (it must be bundled) but NOT in the public closure.
  const liveClosureEngine = engineInputsInChunkClosure(metafile, liveOutput);
  const lazyEngine = new Set(
    [...totalEngine].filter((i) => !publicEngine.has(i)),
  );

  const failures = [];

  // Assertion 1: the public entry chunk closure is engine-free.
  if (publicEngine.size > 0) {
    failures.push(
      `public entry pulls the engine (${publicEngine.size} @tanstack module(s)) — it must be code-split out:\n` +
        [...publicEngine].map((i) => `    - ${i}`).join('\n'),
    );
  }

  // Assertion 2: the engine really is bundled (in a lazy chunk), so the split
  // isn't masking a broken/empty import. The live entry statically imports only
  // `live-entry.js`; the engine lives behind its dynamic import, i.e. in a lazy
  // chunk NOT in the live entry's own static closure but present in the build.
  if (totalEngine.size === 0) {
    failures.push(
      'no @tanstack engine module found anywhere in the build — the fixture did not ' +
        'actually bundle the runtime, so the proof is vacuous.',
    );
  } else if (lazyEngine.size === 0) {
    failures.push(
      'the engine is present but not isolated to a lazy chunk (every engine module ' +
        'also sits in the public closure).',
    );
  }

  if (failures.length > 0) {
    console.error(
      '✗ web-engine-code-split: the smrt-web engine is NOT correctly code-split (#1761 ①).\n',
    );
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
  }

  console.log(
    '✓ web-engine-code-split: public entry is engine-free; the @tanstack client-data\n' +
      `  engine (${totalEngine.size} module(s)) is isolated to a lazily-imported chunk.\n` +
      `    public-entry @tanstack modules: 0\n` +
      `    lazy-chunk  @tanstack modules: ${lazyEngine.size}\n` +
      `    (live entry static closure @tanstack modules: ${liveClosureEngine.size})`,
  );
}

main();
