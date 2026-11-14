/**
 * Package-relative `filePath` for published manifests (#4948).
 *
 * The scanner records the absolute path of each declaring source file. A
 * manifest a package publishes must not depend on where it was built, so a
 * library build rewrites those paths relative to the package root before it
 * writes or inlines the manifest. The result is the same on every machine and
 * on every build.
 */

import type { SmartObjectManifest } from '../scanner/types.js';
import { getNodeBuiltins } from './store.js';

/** True for a POSIX, Windows-drive, UNC, or `file:` absolute path. */
export function isAbsoluteManifestPath(path: string): boolean {
  return (
    path.startsWith('/') ||
    path.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^file:/i.test(path)
  );
}

/**
 * A copy of `manifest` whose absolute object `filePath` values are relative to
 * `packageRoot`, always with `/` separators. Relative paths are left alone.
 */
export function relativizeManifestFilePaths(
  manifest: SmartObjectManifest,
  packageRoot: string,
): SmartObjectManifest {
  const builtins = getNodeBuiltins();
  if (!builtins)
    throw new Error('Relativizing manifest paths requires Node.js');
  const { relative, resolve } = builtins.path;
  const root = resolve(packageRoot);
  const objects: SmartObjectManifest['objects'] = {};
  for (const [key, object] of Object.entries(manifest.objects ?? {})) {
    const filePath = object.filePath;
    objects[key] =
      typeof filePath === 'string' && isAbsoluteManifestPath(filePath)
        ? {
            ...object,
            filePath: relative(root, filePath).replace(/\\/g, '/'),
          }
        : object;
  }
  return { ...manifest, objects };
}

/** `Class (path)` for every object whose `filePath` is still absolute. */
export function findAbsoluteManifestFilePaths(
  manifest: SmartObjectManifest,
): string[] {
  const found: string[] = [];
  for (const [key, object] of Object.entries(manifest.objects ?? {})) {
    if (
      typeof object.filePath === 'string' &&
      isAbsoluteManifestPath(object.filePath)
    ) {
      found.push(`${key} (${object.filePath})`);
    }
  }
  return found;
}

/** Throw when a manifest about to be published holds an absolute `filePath`. */
export function assertPackageRelativeFilePaths(
  manifest: SmartObjectManifest,
  label: string,
): void {
  const absolute = findAbsoluteManifestFilePaths(manifest);
  if (absolute.length > 0) {
    throw new Error(
      `[smrt] ${label} holds ${absolute.length} absolute filePath value(s); ` +
        `a published manifest must use package-relative paths (#4948): ` +
        absolute.slice(0, 5).join(', '),
    );
  }
}
