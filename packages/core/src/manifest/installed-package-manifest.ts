/**
 * Where an installed SMRT provider package and its JSON manifest live, found
 * the way the consumer plugin finds them: the nearest `node_modules/<name>`
 * at or above the project, so hoisted and workspace installs resolve too.
 *
 * Synchronous and JSON-only, for build-time readers that must not import
 * provider code (cookbook hosting, the carried-forward manifest cache).
 */

import fs from 'node:fs';
import path from 'node:path';
import { manifestExportCandidates } from './package-manifest-exports.js';

/** Resolve installed package metadata through the actual host/workspace links. */
export function findInstalledPackageJson(
  packageName: string,
  searchFrom: string,
): string | undefined {
  let currentDir = fs.existsSync(searchFrom)
    ? fs.realpathSync(searchFrom)
    : path.resolve(searchFrom);
  while (true) {
    const candidate = path.join(
      currentDir,
      'node_modules',
      packageName,
      'package.json',
    );
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

/** The legacy executable manifest some providers still publish. */
export function legacyStaticManifestPath(packageDir: string): string {
  return path.join(packageDir, 'dist', 'manifest', 'static-manifest.js');
}

/**
 * Manifest locations probed for a consumed package, in preference order.
 *
 * The package's own `package.json#exports` map comes first: it is the
 * published contract for where the manifest lives, and a package whose build
 * emits outside this framework's conventional layout (for example
 * `"./manifest.json": "./dist/lib/manifest.json"`) is otherwise skipped
 * entirely (issue #2923). The conventional paths remain as a fallback for
 * packages that ship a manifest without exporting a subpath for it.
 */
export function packageManifestCandidates(
  packageDir: string,
  packageJson?: { exports?: unknown } | null,
): string[] {
  return [
    ...manifestExportCandidates(packageDir, packageJson),
    legacyStaticManifestPath(packageDir),
    path.join(packageDir, 'dist', 'manifest.json'),
    path.join(packageDir, 'manifest.json'),
  ];
}

export interface InstalledPackageManifest<TManifest> {
  packageDir: string;
  /** `version` from the installed package.json. */
  version?: string;
  /** The first JSON candidate with an `objects` map, or null when none is readable. */
  manifest: TManifest | null;
}

/**
 * The installed package and its JSON manifest, or `null` when the package is
 * not installed where the project can reach it. A package whose only manifest
 * is the executable static module reports `manifest: null`.
 */
export function readInstalledPackageManifest<
  TManifest extends { objects?: unknown },
>(
  packageName: string,
  projectRoot: string,
): InstalledPackageManifest<TManifest> | null {
  const packageJsonPath = findInstalledPackageJson(packageName, projectRoot);
  if (!packageJsonPath) return null;
  const packageDir = path.dirname(packageJsonPath);
  let packageJson: { version?: unknown; exports?: unknown } | null = null;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    packageJson = null;
  }
  const version =
    typeof packageJson?.version === 'string' ? packageJson.version : undefined;
  for (const file of packageManifestCandidates(packageDir, packageJson)) {
    if (!file.endsWith('.json') || !fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TManifest;
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.objects &&
        typeof parsed.objects === 'object'
      ) {
        return { packageDir, version, manifest: parsed };
      }
    } catch {
      // Keep probing; the consumer plugin reports an unreadable manifest.
    }
  }
  return { packageDir, version, manifest: null };
}

interface CarriedEntryShape {
  packageName?: unknown;
  providerPackageName?: unknown;
  packageVersion?: unknown;
  qualifiedName?: unknown;
  className?: unknown;
}

interface ProviderManifestShape {
  packageName?: unknown;
  packageVersion?: unknown;
  objects?: Record<string, CarriedEntryShape | null | undefined>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The installed provider's own entry for a carried manifest key. */
function findProviderEntry(
  manifest: ProviderManifestShape,
  key: string,
): CarriedEntryShape | undefined {
  const objects = manifest.objects ?? {};
  const direct = objects[key];
  if (direct && typeof direct === 'object') return direct;
  const fallbackPackage = stringValue(manifest.packageName);
  for (const candidate of Object.values(objects)) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (stringValue(candidate.qualifiedName) === key) return candidate;
    const className = stringValue(candidate.className);
    const owner = stringValue(candidate.packageName) ?? fallbackPackage;
    if (className && owner && `${owner}:${className}` === key) return candidate;
  }
  return undefined;
}

/**
 * Keep only the carried-forward consumed-package entries that still describe
 * what is installed. `.smrt/manifest.json` carries a consumed package's
 * entries from one build to the next; an entry is dropped when its provider
 * is no longer installed, when the provider's installed manifest no longer
 * declares it, or when its recorded `packageVersion` differs from the
 * installed one (#5035).
 */
export function retainInstalledCarriedEntries<TEntry>(
  entries: Record<string, TEntry>,
  projectRoot: string,
): { retained: Record<string, TEntry>; dropped: string[] } {
  const installed = new Map<
    string,
    InstalledPackageManifest<ProviderManifestShape> | null
  >();
  const lookup = (packageName: string) => {
    if (!installed.has(packageName)) {
      installed.set(
        packageName,
        readInstalledPackageManifest<ProviderManifestShape>(
          packageName,
          projectRoot,
        ),
      );
    }
    return installed.get(packageName) ?? null;
  };

  const retained: Record<string, TEntry> = {};
  const dropped: string[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const carried = (entry ?? {}) as CarriedEntryShape;
    const provider =
      stringValue(carried.providerPackageName) ??
      stringValue(carried.packageName);
    if (!provider) {
      retained[key] = entry;
      continue;
    }
    const current = lookup(provider);
    let expectedVersion = current?.version;
    let stillInstalled = current !== null;
    if (current?.manifest) {
      const declared = findProviderEntry(current.manifest, key);
      stillInstalled = declared !== undefined;
      expectedVersion =
        stringValue(declared?.packageVersion) ??
        stringValue(current.manifest.packageVersion) ??
        current.version;
    }
    const recordedVersion = stringValue(carried.packageVersion);
    if (
      stillInstalled &&
      recordedVersion &&
      expectedVersion &&
      recordedVersion !== expectedVersion
    ) {
      stillInstalled = false;
    }
    if (stillInstalled) retained[key] = entry;
    else dropped.push(key);
  }
  return { retained, dropped };
}
