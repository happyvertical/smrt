#!/usr/bin/env node

/**
 * Publish-time guard: verify a package's `dist/manifest.json` includes every
 * `@smrt()` object declared in its source. A stale manifest that omits an object
 * silently breaks downstream `smrt db:migrate` (the object's table is never
 * created), which is exactly how `@happyvertical/smrt-jobs@0.27.41` shipped a
 * manifest missing `SmrtWorker` and broke every consumer's `TaskRunner.start()`.
 *
 * Usage: node scripts/verify-manifest-completeness.mjs [packageDir] [--release]
 *   - packageDir defaults to the current working directory (so `prepack` can
 *     invoke it without arguments from each package directory).
 *   - `--release` is the fail-closed mode the release pipeline uses for every
 *     publishable package (`scripts/release-manifest-guards.mjs`, issue #2853):
 *     an unbuilt or unloadable scanner fails instead of skipping, and a package
 *     that declares `@smrt()` objects without a `./manifest` export fails
 *     instead of skipping. The framework-infrastructure exemption still applies.
 *
 * Exit codes:
 *   0 — manifest complete, or check not applicable (package publishes no
 *       manifest / is framework infrastructure / scanner not built, the last
 *       two only outside `--release`).
 *   1 — manifest is stale/incomplete or missing while objects exist in source.
 *
 * @see https://github.com/happyvertical/smrt/issues/1483
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const releaseMode = args.includes('--release');
const unknownFlags = args.filter(
  (arg) => arg.startsWith('-') && arg !== '--release',
);
if (unknownFlags.length > 0) {
  console.error(
    `[verify-manifest] ❌ unknown option(s): ${unknownFlags.join(', ')}`,
  );
  process.exit(1);
}
const packageDir = resolve(
  args.find((arg) => !arg.startsWith('-')) ?? process.cwd(),
);

// Outside --release a missing scanner is a skip (prepack may run before a full
// build); at release time it would silently disable the guard, so it fails.
function scannerUnavailable(message) {
  if (releaseMode) {
    console.error(
      `[verify-manifest] ❌ ${message}; release mode requires the manifest completeness check to run.`,
    );
    process.exit(1);
  }
  console.warn(`[verify-manifest] ${message}; skipping manifest completeness check.`);
  process.exit(0);
}

// The scanner exposes verifyManifestCompleteness from its built output. The
// publish pipeline builds every workspace package before per-package prepack
// runs, so dist is present where this guard matters. When it is absent (e.g. a
// single-package publish before a full build), skip rather than block — the
// guard is a safety net, not a hard dependency of every publish path.
const scannerDist = resolve(repoRoot, 'packages/scanner/dist/index.js');
if (!existsSync(scannerDist)) {
  scannerUnavailable(
    `@happyvertical/smrt-scanner is not built at ${scannerDist}`,
  );
}

let verifyManifestCompleteness;
try {
  ({ verifyManifestCompleteness } = await import(
    pathToFileURL(scannerDist).href
  ));
} catch (error) {
  scannerUnavailable(`Could not load scanner module (${error.message})`);
}

const result = await verifyManifestCompleteness({
  packageDir,
  requireManifestExport: releaseMode,
});
const label = result.packageName ?? packageDir;

if (result.status === 'ok') {
  console.log(
    `[verify-manifest] ✅ ${label}: dist/manifest.json includes all ${result.expectedCount} source object(s).`,
  );
  process.exit(0);
}

if (result.status === 'skipped') {
  console.log(`[verify-manifest] ⏭️  ${label}: skipped (${result.reason}).`);
  process.exit(0);
}

if (result.status === 'scan-error') {
  // A source parse error drops @smrt classes from the re-scan, so the manifest
  // cannot be verified — fail loudly rather than waving the package through.
  console.error(
    `\n[verify-manifest] ❌ ${label}: source scan failed; manifest completeness cannot be verified.`,
  );
  console.error(`[verify-manifest]    ${result.reason}`);
  console.error(
    '[verify-manifest]    Fix: resolve the parse error(s) in src/ and rebuild.',
  );
  process.exit(1);
}

// status: 'incomplete' | 'missing-manifest'
console.error(
  `\n[verify-manifest] ❌ ${label}: published manifest is stale or incomplete.`,
);
console.error(
  `[verify-manifest]    ${
    result.reason ??
    `${result.missing.length} object(s) declared in src/ are missing from ${result.manifestPath}`
  }`,
);
if (result.missing.length > 0) {
  console.error('[verify-manifest]    Missing objects:');
  for (const missing of result.missing) {
    console.error(`[verify-manifest]      - ${missing}`);
  }
}
console.error(
  '[verify-manifest]    Fix: rebuild the package so dist/manifest.json is regenerated from src/.',
);
console.error(
  '[verify-manifest]    Guards issue #1483 (a stale manifest omitting @smrt classes breaks downstream db:migrate).',
);
process.exit(1);
