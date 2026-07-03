#!/usr/bin/env node
/**
 * Code-split proof for the `@happyvertical/smrt-web` runtime (#1761, slice D,
 * ratified condition ①) — asserted against the REAL products app graph.
 *
 * THE #1 risk of #1761: the ~76 kB TanStack client-data engine must NEVER load
 * on public / smrt-sites pages — only surfaces that actually use a live
 * collection may pay for it. Products is the reference consumer, so this script
 * proves the engine is code-split OUT of the standalone app's entry and reached
 * ONLY through a dynamic `import()`.
 *
 * It exercises the ACTUAL public graph (`src/app/main.ts` → `App.svelte` → its
 * pages/components), not a synthetic fixture — so if a real public page ever
 * statically imported `LiveProductList` / `product-collection` / the engine, the
 * check FAILS even though a throwaway-fixture check would still pass.
 *
 * ── Two modes ───────────────────────────────────────────────────────────────
 * 1. REAL BUILD (preferred; what CI uses). Runs the products `--mode standalone`
 *    vite build via the JS API and analyses the emitted rollup chunk graph:
 *      (a) the entry chunk and its transitive STATIC-import closure contain ZERO
 *          `@tanstack/*` modules;
 *      (b) `@tanstack/*` modules appear ONLY in chunks reached via a
 *          `dynamicImports` edge (a lazily-loaded chunk), and at least one such
 *          module exists (so the split isn't masking a broken/empty import).
 *
 * 2. SOURCE-GRAPH FALLBACK (local, when the build cannot run). A full
 *    `vite build --mode standalone` trips a pre-existing nested-git-worktree
 *    failure (`Tsconfig not found .../packages/accounts`, a vite-8 oxc-transform
 *    / pnpm-symlink artifact that does NOT reproduce in CI's isolated checkout).
 *    When the build throws that, this script parses the REAL public entry's
 *    STATIC import graph (following `.ts`/`.svelte` static imports, treating
 *    `import(...)` as a boundary that is NOT followed) and asserts none of the
 *    engine-bearing modules (`stores/product-collection`, `LiveProductList`,
 *    `@happyvertical/smrt-web`, `@happyvertical/smrt-svelte/web`) is reachable
 *    via any static edge from `src/app/main.ts`. Same guarantee, no bundler.
 *
 * Both modes assert PRESENCE / ABSENCE by graph reachability, never byte
 * thresholds — no flaky size gate.
 *
 * Run: `node packages/products/scripts/check-web-engine-code-split.mjs`
 *   --source-only  force the source-graph mode (skip the real build)
 *   --build-only   force the real build (fail instead of falling back)
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..'); // packages/products
const SRC = resolve(PACKAGE_DIR, 'src');

/** Marker identifying a client-data engine module by path/specifier. */
const ENGINE_MARKER = '@tanstack';

/**
 * Engine-bearing module specifiers/paths a public static graph must NOT reach.
 * Used by the source-graph fallback; the real-build mode keys off @tanstack
 * modules directly.
 */
const ENGINE_BEARING = [
  '@happyvertical/smrt-web',
  '@happyvertical/smrt-svelte/web',
  'stores/product-collection',
  'components/LiveProductList.svelte',
];

const argv = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Mode 1 — real vite standalone build + rollup chunk-graph analysis
// ---------------------------------------------------------------------------

/**
 * Run the products `--mode standalone` build via vite's JS API and return the
 * rollup output chunks. Rethrows the pre-existing worktree tsconfig failure so
 * the caller can fall back to the source-graph mode.
 */
async function runStandaloneBuild() {
  const { build } = await import('vite');
  const result = await build({
    root: PACKAGE_DIR,
    mode: 'standalone',
    logLevel: 'silent',
    configFile: resolve(PACKAGE_DIR, 'vite.config.ts'),
    // In-memory only: return the rollup output WITHOUT touching `dist/app`, so
    // this analysis never clobbers a real build artifact other CI steps read.
    build: { write: false },
  });
  // A single non-watch build resolves to one RollupOutput.
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = [];
  for (const out of outputs) {
    for (const item of out.output ?? []) {
      if (item.type === 'chunk') chunks.push(item);
    }
  }
  return chunks;
}

/** True when a rollup chunk contains a module whose id is an engine module. */
function chunkHasEngine(chunk) {
  for (const id of Object.keys(chunk.modules ?? {})) {
    if (id.includes(ENGINE_MARKER)) return true;
  }
  return false;
}

/**
 * Analyse the rollup chunk graph. Returns the assertion outcome:
 * - `entryEngineChunks`: chunks in the entry's STATIC-import closure that carry
 *   the engine (must be empty),
 * - `lazyEngineChunks`: engine chunks reached via a dynamicImports edge,
 * - `totalEngineChunks`: every chunk carrying the engine.
 */
function analyzeChunkGraph(chunks) {
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const entries = chunks.filter((c) => c.isEntry);

  // Transitive STATIC-import closure of all entry chunks (follow `imports`,
  // never `dynamicImports` — the latter is the split boundary).
  const staticClosure = new Set();
  const stack = entries.map((c) => c.fileName);
  while (stack.length) {
    const fileName = stack.pop();
    if (staticClosure.has(fileName)) continue;
    staticClosure.add(fileName);
    const chunk = byFile.get(fileName);
    if (!chunk) continue;
    for (const imported of chunk.imports ?? []) {
      if (byFile.has(imported)) stack.push(imported);
    }
  }

  const totalEngineChunks = chunks.filter(chunkHasEngine);
  const entryEngineChunks = totalEngineChunks.filter((c) =>
    staticClosure.has(c.fileName),
  );
  const lazyEngineChunks = totalEngineChunks.filter(
    (c) => !staticClosure.has(c.fileName),
  );
  return {
    entryEngineChunks,
    lazyEngineChunks,
    totalEngineChunks,
    entryCount: entries.length,
    staticClosureSize: staticClosure.size,
  };
}

async function runBuildMode() {
  const chunks = await runStandaloneBuild();
  const {
    entryEngineChunks,
    lazyEngineChunks,
    totalEngineChunks,
    entryCount,
    staticClosureSize,
  } = analyzeChunkGraph(chunks);

  const failures = [];
  // (a) No engine in the entry's static-import closure.
  if (entryEngineChunks.length > 0) {
    failures.push(
      `the app entry's static-import closure pulls the engine — ${entryEngineChunks.length} @tanstack chunk(s) must be code-split out:\n` +
        entryEngineChunks.map((c) => `    - ${c.fileName}`).join('\n'),
    );
  }
  // (b) The engine must exist, isolated to lazily-imported chunk(s).
  if (totalEngineChunks.length === 0) {
    failures.push(
      'no @tanstack engine chunk found in the standalone build — the app does not ' +
        'actually bundle the runtime, so the proof is vacuous.',
    );
  } else if (lazyEngineChunks.length === 0) {
    failures.push(
      'the engine is present but not isolated to a lazily-imported chunk.',
    );
  }

  if (failures.length > 0) {
    console.error(
      '✗ web-engine-code-split [real build]: the smrt-web engine is NOT correctly code-split (#1761 ①).\n',
    );
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
  }

  console.log(
    '✓ web-engine-code-split [real build]: the products standalone app entry is\n' +
      '  engine-free; @tanstack is isolated to lazily-imported chunk(s).\n' +
      `    entry chunks: ${entryCount}; static-import closure chunks: ${staticClosureSize}\n` +
      `    @tanstack chunks in entry static closure: ${entryEngineChunks.length}\n` +
      `    @tanstack chunks reached only via dynamicImports: ${lazyEngineChunks.length}\n` +
      lazyEngineChunks.map((c) => `      - ${c.fileName}`).join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Mode 2 — real source static-import-graph reachability (bundler-free fallback)
// ---------------------------------------------------------------------------

/**
 * Extract STATIC, RUNTIME import specifiers from a `.ts`/`.svelte` source
 * string. Two exclusions, both because they carry no runtime edge (so the real
 * bundler drops them — the source graph must match):
 *   - dynamic `import(...)` — the split boundary we must NOT follow;
 *   - type-only `import type …` / `export type …` — erased at compile time.
 * Covers `import ... from '...'`, `export ... from '...'`, and bare
 * `import '...'`; scans the whole file (including any `<script>` in `.svelte`).
 */
function staticImportSpecifiers(source) {
  const specs = new Set();
  // Capture the clause between the keyword and `from` so type-only imports can
  // be filtered. `import(` has a paren where `\s+` is required here, so dynamic
  // imports never match. Group 1 = 'import'|'export', 2 = clause, 3 = specifier.
  const fromRe =
    /\b(import|export)\b(\s+[^;'"()]*?)?\bfrom\s*["']([^"']+)["']/g;
  let match;
  while ((match = fromRe.exec(source))) {
    const clause = (match[2] ?? '').trim();
    // Skip `import type { … }` / `export type { … }` — no runtime edge.
    if (/^type\b/.test(clause)) continue;
    specs.add(match[3]);
  }
  // Bare side-effect imports: `import '…';` (always a runtime edge).
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  while ((match = bareRe.exec(source))) {
    specs.add(match[1]);
  }
  return specs;
}

/** Resolve a relative import specifier to an on-disk source file, if it exists. */
function resolveLocalModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // bare package specifier — not local
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.svelte`,
    `${base}.svelte.ts`,
    `${base}.js`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      const source = readFileSync(candidate, 'utf8');
      return { file: candidate, source };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** True when a specifier (or a resolved file path) is an engine-bearing module. */
function isEngineBearing(spec, resolvedFile) {
  for (const marker of ENGINE_BEARING) {
    if (spec.includes(marker)) return true;
    if (resolvedFile && resolvedFile.replaceAll('\\', '/').includes(marker)) {
      return true;
    }
  }
  return spec.includes(ENGINE_MARKER);
}

/**
 * Walk the STATIC import graph from the real public entry and return every
 * engine-bearing specifier reachable via a static edge (must be empty).
 */
function reachableEngineViaStatic(entryFile) {
  const visited = new Set();
  const offenders = [];
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const spec of staticImportSpecifiers(source)) {
      const local = resolveLocalModule(file, spec);
      if (isEngineBearing(spec, local?.file)) {
        offenders.push({
          spec,
          via: relative(PACKAGE_DIR, file),
        });
        continue; // don't recurse into the engine itself
      }
      // Recurse only into local project source (following static edges); bare
      // package specifiers that are not engine-bearing are leaves here.
      if (local && local.file.startsWith(SRC)) stack.push(local.file);
    }
  }
  return offenders;
}

function runSourceMode(reason) {
  const entryFile = resolve(SRC, 'app/main.ts');
  const offenders = reachableEngineViaStatic(entryFile);

  if (offenders.length > 0) {
    console.error(
      '✗ web-engine-code-split [source graph]: an engine-bearing module is reachable\n' +
        '  from the public entry (src/app/main.ts) via a STATIC import — it must only be\n' +
        `  reached through import() (#1761 ①).\n`,
    );
    for (const { spec, via } of offenders) {
      console.error(`    - ${spec}  (static import in ${via})`);
    }
    process.exit(1);
  }

  console.log(
    '✓ web-engine-code-split [source graph]: no engine-bearing module\n' +
      `  (${ENGINE_BEARING.join(', ')})\n` +
      '  is reachable from src/app/main.ts via any static import edge — the engine\n' +
      '  is only reached through import(). (Real-build mode skipped: ' +
      `${reason}.)`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  if (argv.has('--source-only')) {
    runSourceMode('forced via --source-only');
    return;
  }

  try {
    await runBuildMode();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isKnownWorktreeIssue =
      message.includes('Tsconfig not found') ||
      message.includes('packages/accounts');
    if (argv.has('--build-only') || !isKnownWorktreeIssue) {
      console.error(
        '✗ web-engine-code-split [real build]: standalone build failed.\n',
      );
      console.error(message);
      process.exit(1);
    }
    // Known pre-existing nested-worktree failure — fall back to the source graph.
    runSourceMode(
      'standalone vite build hit the pre-existing worktree "Tsconfig not found" issue',
    );
  }
}

// `pathToFileURL` guards against Windows path/URL mismatch when run directly.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { analyzeChunkGraph, reachableEngineViaStatic, staticImportSpecifiers };
