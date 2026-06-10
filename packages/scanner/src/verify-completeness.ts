/**
 * Manifest completeness verification.
 *
 * Re-scans a package's `src/` with the same OXC scanner the build uses and
 * asserts that every `@smrt()`-decorated object (and its collection) is present
 * in the package's published `dist/manifest.json`. This is a publish-time guard:
 * downstream schema migration is manifest-driven, so a stale manifest that omits
 * an object means consumers can never create its table via `smrt db:migrate`.
 *
 * Root cause it guards against (issue #1483): `@happyvertical/smrt-jobs@0.27.41`
 * shipped a `dist/manifest.json` generated before `SmrtWorker` existed. The
 * source, exports, and `__smrt-register__` path were all correct, but the
 * published manifest had only 4 of 6 objects, so `_smrt_workers` was never
 * created and `TaskRunner.start()` threw on every consumer that upgraded.
 *
 * The check compares object-key SETS only. The downstream manifest-enrichment
 * passes (schema/validation/agent generation) mutate object entries but never
 * add or remove object keys, so the scanner + adapter object set is the source
 * of truth for "which objects the published manifest must contain". The
 * comparison is `expected ⊆ dist`: enrichment passes that add keys to `dist`
 * (e.g. STI children) never trigger a false failure.
 *
 * @see https://github.com/happyvertical/smrt/issues/1483
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ManifestAdapter } from './manifest-adapter.js';
import { OxcScanner } from './scanner.js';

/**
 * Source globs for the completeness scan. The build (`vite.config.base.ts`)
 * passes `include: ['src/**\/*.ts']` and excludes `*.test.ts` / `*.spec.ts` (the
 * plugin also drops `*.svelte`); we reproduce that so the expected object set
 * matches what the build would publish. We additionally exclude
 * `**\/__tests__\/**` so any `@smrt()` fixtures in non-test helper modules under
 * `src/__tests__/` (e.g. `src/__tests__/helpers/*.ts`) are never required in the
 * published manifest. These extra exclusions can only shrink `expected` relative
 * to the build, so they can never cause a false failure — the check is
 * `expected ⊆ dist`.
 */
const DEFAULT_INCLUDE = ['src/**/*.ts'];
const DEFAULT_EXCLUDE = [
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/__tests__/**',
  '**/*.svelte',
  '**/node_modules/**',
  '**/dist/**',
  '**/*.d.ts',
];

/**
 * Framework-infrastructure packages whose published manifest is NOT produced by
 * the OXC scanner path (e.g. `@happyvertical/smrt-core` ships a curated static
 * manifest). Mirrors `skipSmrtPlugin` in `vite.config.base.ts`. Keyed by package
 * directory basename.
 */
const DEFAULT_SKIP_PACKAGES = [
  'core',
  'types',
  'config',
  'scanner',
  'vitest',
  'smrt-playground',
];

export type VerifyManifestStatus =
  | 'ok'
  | 'incomplete'
  | 'missing-manifest'
  | 'skipped';

export interface VerifyManifestCompletenessOptions {
  /** Absolute or relative path to the package directory to verify. */
  packageDir: string;
  /** Source include globs (default mirrors the build). */
  include?: string[];
  /** Source exclude globs (default mirrors the build). */
  exclude?: string[];
  /** Package directory basenames to skip (default: framework infrastructure). */
  skipPackages?: string[];
}

export interface VerifyManifestCompletenessResult {
  status: VerifyManifestStatus;
  packageName?: string;
  manifestPath?: string;
  /** Qualified object keys present in source but missing from the manifest. */
  missing: string[];
  /** Number of objects the source is expected to contribute. */
  expectedCount: number;
  /** Number of objects present in the published manifest. */
  distCount: number;
  /** Human-readable explanation for `skipped` / `missing-manifest`. */
  reason?: string;
}

interface MinimalPackageJson {
  name?: string;
  version?: string;
  exports?: Record<string, unknown>;
}

/**
 * Resolve the `./manifest` (or `./manifest.json`) export target to an absolute
 * path. Returns `null` when the package does not publish a manifest.
 */
function resolveManifestPath(
  packageDir: string,
  pkgJson: MinimalPackageJson,
): string | null {
  const exportsMap = pkgJson.exports ?? {};
  const entry = exportsMap['./manifest'] ?? exportsMap['./manifest.json'];

  let relativeTarget: string | undefined;
  if (typeof entry === 'string') {
    relativeTarget = entry;
  } else if (entry && typeof entry === 'object') {
    const conditional = entry as Record<string, unknown>;
    const candidate =
      conditional.default ?? conditional.import ?? conditional.types;
    if (typeof candidate === 'string') {
      relativeTarget = candidate;
    }
  }

  if (!relativeTarget) {
    return null;
  }

  return resolve(packageDir, relativeTarget);
}

/**
 * Verify that `dist/manifest.json` contains every `@smrt()` object declared in
 * the package source. See module docs for the rationale and guarantees.
 */
export async function verifyManifestCompleteness(
  options: VerifyManifestCompletenessOptions,
): Promise<VerifyManifestCompletenessResult> {
  const packageDir = resolve(options.packageDir);
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const skipPackages = options.skipPackages ?? DEFAULT_SKIP_PACKAGES;

  const packageJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      status: 'skipped',
      missing: [],
      expectedCount: 0,
      distCount: 0,
      reason: `no package.json at ${packageDir}`,
    };
  }

  const pkgJson: MinimalPackageJson = JSON.parse(
    readFileSync(packageJsonPath, 'utf-8'),
  );
  const packageName = pkgJson.name;

  if (skipPackages.includes(basename(packageDir))) {
    return {
      status: 'skipped',
      packageName,
      missing: [],
      expectedCount: 0,
      distCount: 0,
      reason:
        'framework infrastructure package (does not use scanner manifest)',
    };
  }

  const manifestPath = resolveManifestPath(packageDir, pkgJson);
  if (!manifestPath) {
    return {
      status: 'skipped',
      packageName,
      missing: [],
      expectedCount: 0,
      distCount: 0,
      reason: 'package does not publish a ./manifest export',
    };
  }

  // Derive the object set the source SHOULD produce, using the same scanner and
  // adapter the build uses (vite-plugin scanWithOxc).
  const scanner = new OxcScanner({ cwd: packageDir, include, exclude });
  const { results, resolved } = await scanner.scanAndResolve();
  const adapter = new ManifestAdapter();
  const expected = adapter.toManifest(resolved, {
    packageName,
    packageVersion: pkgJson.version,
    typeAliases: results.typeAliases,
  });
  const expectedKeys = Object.keys(expected.objects);

  // Nothing to verify if the package declares no SMRT objects (e.g. a package
  // that publishes ./manifest but only ships base classes).
  if (expectedKeys.length === 0) {
    return {
      status: 'skipped',
      packageName,
      manifestPath,
      missing: [],
      expectedCount: 0,
      distCount: 0,
      reason: 'no @smrt() objects found in source',
    };
  }

  if (!existsSync(manifestPath)) {
    return {
      status: 'missing-manifest',
      packageName,
      manifestPath,
      missing: expectedKeys,
      expectedCount: expectedKeys.length,
      distCount: 0,
      reason: `published manifest not found at ${manifestPath}`,
    };
  }

  let distObjects: Record<string, unknown> = {};
  try {
    const distManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    distObjects =
      distManifest && typeof distManifest.objects === 'object'
        ? distManifest.objects
        : {};
  } catch (error) {
    return {
      status: 'missing-manifest',
      packageName,
      manifestPath,
      missing: expectedKeys,
      expectedCount: expectedKeys.length,
      distCount: 0,
      reason: `published manifest is not valid JSON: ${(error as Error).message}`,
    };
  }

  const distKeys = new Set(Object.keys(distObjects));
  const missing = expectedKeys.filter((key) => !distKeys.has(key));

  return {
    status: missing.length > 0 ? 'incomplete' : 'ok',
    packageName,
    manifestPath,
    missing,
    expectedCount: expectedKeys.length,
    distCount: distKeys.size,
  };
}
