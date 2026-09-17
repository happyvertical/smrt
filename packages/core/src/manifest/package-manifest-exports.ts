/**
 * Resolve a consumed package's SMRT manifest through its own
 * `package.json#exports` map.
 *
 * A package's published manifest location is declared by its export map, not
 * by where this framework happens to guess. Probing only conventional paths
 * (`dist/manifest.json`, `dist/manifest/static-manifest.js`, `manifest.json`)
 * silently skips any package whose build emits elsewhere — for example a
 * triple-purpose package that builds its library into `dist/lib` and maps
 * `"./manifest.json": "./dist/lib/manifest.json"` (issue #2923). The export
 * map is the published contract, so it is consulted first and the
 * conventional paths remain as a fallback for packages that ship a manifest
 * without exporting it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Export subpaths a SMRT package may use to publish its manifest, in
 * preference order. `./manifest.json` is the documented spelling;
 * `./manifest` is its extensionless alias; `./static-manifest` covers
 * packages that publish the executable static-manifest module instead.
 */
const MANIFEST_EXPORT_SUBPATHS = [
  './manifest.json',
  './manifest',
  './static-manifest',
] as const;

/**
 * Export conditions to follow, most specific first. `smrt` lets a package
 * point build tooling at a manifest distinct from its runtime entry.
 */
const MANIFEST_EXPORT_CONDITIONS = [
  'smrt',
  'node',
  'import',
  'require',
  'default',
] as const;

/** Minimal structural view of the fields read here. */
interface ManifestExportsPackageJson {
  exports?: unknown;
}

/**
 * Follow one export map entry to a relative target. Handles the three shapes
 * Node allows: a string target, a conditions object, and an array of
 * fallbacks. Returns the first target that is a relative path; `null`
 * (an explicitly blocked subpath) and unknown shapes yield `undefined`.
 */
function resolveExportTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    return entry.startsWith('.') ? entry : undefined;
  }

  if (Array.isArray(entry)) {
    for (const candidate of entry) {
      const target = resolveExportTarget(candidate);
      if (target) return target;
    }
    return undefined;
  }

  if (entry && typeof entry === 'object') {
    const conditions = entry as Record<string, unknown>;
    for (const condition of MANIFEST_EXPORT_CONDITIONS) {
      if (!(condition in conditions)) continue;
      const target = resolveExportTarget(conditions[condition]);
      if (target) return target;
    }
  }

  return undefined;
}

/**
 * Read a package's `package.json`, returning `null` when it is missing or
 * unparseable. Callers that already hold the parsed manifest pass it in.
 */
function readPackageJson(
  packageDir: string,
): ManifestExportsPackageJson | null {
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(
      readFileSync(packageJsonPath, 'utf-8'),
    ) as ManifestExportsPackageJson;
  } catch {
    return null;
  }
}

/**
 * Absolute manifest paths declared by `packageDir`'s export map, in
 * preference order and de-duplicated.
 *
 * Targets that escape the package directory are dropped: an export map is
 * third-party input, and a manifest is imported/evaluated by the consumer
 * build, so a `../` target must never widen what this framework reads.
 *
 * @param packageDir - Installed package root.
 * @param packageJson - Already-parsed `package.json`, when the caller has it.
 * @returns Absolute candidate paths; empty when nothing is declared.
 */
export function manifestExportCandidates(
  packageDir: string,
  packageJson?: ManifestExportsPackageJson | null,
): string[] {
  const parsed = packageJson ?? readPackageJson(packageDir);
  const exportsMap = parsed?.exports;
  if (
    !exportsMap ||
    typeof exportsMap !== 'object' ||
    Array.isArray(exportsMap)
  )
    return [];

  const entries = exportsMap as Record<string, unknown>;
  const candidates: string[] = [];

  for (const subpath of MANIFEST_EXPORT_SUBPATHS) {
    const target = resolveExportTarget(entries[subpath]);
    if (!target) continue;

    const resolved = resolve(packageDir, target);
    const within = relative(packageDir, resolved);
    if (!within || within === '..' || within.startsWith(`..${sep}`)) continue;
    if (isAbsolute(within)) continue;
    if (candidates.includes(resolved)) continue;

    candidates.push(resolved);
  }

  return candidates;
}
