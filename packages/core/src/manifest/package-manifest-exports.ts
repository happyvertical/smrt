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

import { getNodeBuiltins } from './store.js';

type NodeHost = NonNullable<ReturnType<typeof getNodeBuiltins>>;

// `fs`/`path` come from the lazy Node host, not static `node:` imports: the
// manifest loader imports this module and is part of core's browser entry
// graph (#2838). Without a Node host there is no package to read, so every
// export answers "no candidates".

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
 * Collect every relative target an export map entry can resolve to, in
 * preference order, appending into `targets`.
 *
 * All three shapes Node allows are followed. An array is a FALLBACK list, not
 * a single choice: `['./dist/missing.json', './dist/manifest.json']` must be
 * able to reach the second entry when the first does not exist, so every
 * branch is collected and the caller's existence probe picks the first that
 * is really there. A conditions object contributes each recognized condition
 * in `MANIFEST_EXPORT_CONDITIONS` order for the same reason. `null` (an
 * explicitly blocked subpath) and non-relative specifiers contribute nothing.
 */
function collectExportTargets(entry: unknown, targets: string[]): void {
  if (typeof entry === 'string') {
    if (entry.startsWith('.')) targets.push(entry);
    return;
  }

  if (Array.isArray(entry)) {
    for (const candidate of entry) collectExportTargets(candidate, targets);
    return;
  }

  if (entry && typeof entry === 'object') {
    const conditions = entry as Record<string, unknown>;
    for (const condition of MANIFEST_EXPORT_CONDITIONS) {
      if (condition in conditions) {
        collectExportTargets(conditions[condition], targets);
      }
    }
  }
}

/**
 * Read a package's `package.json`, returning `null` when it is missing or
 * unparseable. Callers that already hold the parsed manifest pass it in.
 */
function readPackageJson(
  { fs, path }: NodeHost,
  packageDir: string,
): ManifestExportsPackageJson | null {
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf-8'),
    ) as ManifestExportsPackageJson;
  } catch {
    return null;
  }
}

/** Lexical containment: `candidate` is at or below `base`. */
function isWithin(
  { path }: NodeHost,
  base: string,
  candidate: string,
): boolean {
  const within = path.relative(base, candidate);
  if (!within) return false;
  if (within === '..' || within.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(within);
}

/**
 * True when `candidate` stays inside `packageDir` once symlinks are followed.
 *
 * `resolve()`/`relative()` are purely lexical, so `dist/manifest.json` can be
 * a symlink pointing anywhere on disk and still pass a textual check. The
 * resolved file is read, JSON-parsed, and for `.js` targets dynamically
 * imported by the consumer build, so the package boundary has to hold against
 * links, not just against `../`.
 *
 * `packageDir` is real-path'd too: a pnpm or workspace install reaches a
 * package through a symlink (`node_modules/@scope/pkg` ->
 * `node_modules/.pnpm/...`), so comparing a real target path against a
 * symlinked base would reject every legitimate manifest in those layouts.
 * A candidate that does not exist cannot be read and is left to the caller's
 * existence probe.
 */
function resolvesWithinPackage(
  host: NodeHost,
  packageDir: string,
  candidate: string,
): boolean {
  if (!host.fs.existsSync(candidate)) return true;
  try {
    return isWithin(
      host,
      host.fs.realpathSync(packageDir),
      host.fs.realpathSync(candidate),
    );
  } catch {
    return false;
  }
}

/**
 * Conventional JSON manifest locations of a package that ships a manifest
 * without exporting a subpath for it, in preference order. Probed after
 * {@link manifestExportCandidates} by every reader that follows the
 * convention (the consumer plugin, and build-time dependency resolution), so
 * they agree on which packages have a manifest.
 */
export function conventionalManifestCandidates(packageDir: string): string[] {
  const host = getNodeBuiltins();
  if (!host) return [];
  return [
    host.path.join(packageDir, 'dist', 'manifest.json'),
    host.path.join(packageDir, 'manifest.json'),
  ];
}

/**
 * Absolute manifest paths declared by `packageDir`'s export map, in
 * preference order and de-duplicated.
 *
 * Targets that escape the package directory are dropped, lexically and after
 * following symlinks: an export map is third-party input, and a manifest is
 * read and possibly imported by the consumer build, so no target may widen
 * what this framework reads.
 *
 * @param packageDir - Installed package root.
 * @param packageJson - Already-parsed `package.json`, when the caller has it.
 * @returns Absolute candidate paths; empty when nothing is declared.
 */
export function manifestExportCandidates(
  packageDir: string,
  packageJson?: ManifestExportsPackageJson | null,
): string[] {
  const host = getNodeBuiltins();
  if (!host) return [];
  const parsed = packageJson ?? readPackageJson(host, packageDir);
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
    const targets: string[] = [];
    collectExportTargets(entries[subpath], targets);

    for (const target of targets) {
      const resolved = host.path.resolve(packageDir, target);
      if (!isWithin(host, packageDir, resolved)) continue;
      if (!resolvesWithinPackage(host, packageDir, resolved)) continue;
      if (candidates.includes(resolved)) continue;

      candidates.push(resolved);
    }
  }

  return candidates;
}
