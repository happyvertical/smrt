/**
 * Owner package of a scanned source file (#5655).
 *
 * An app may compile a workspace package's SOURCE into its own manifest
 * (`smrtPlugin({ include: ['../../packages/work/src/models/**'] })`). Those
 * classes register at runtime under the package that owns them, because the
 * runtime imports that package's own build: `@happyvertical/work:Model`, not
 * `@happyvertical/work-web:Model`. The manifest must therefore name each class
 * by the nearest `package.json` above its source file, so a class carried from
 * the dependency's manifest and the same class found by the local scan share
 * ONE identity.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Build a `filePath -> owner package name` resolver. Lookups are cached per
 * directory. The nearest `package.json` that declares a scoped name owns the
 * file (a nameless or unscoped one is skipped, since qualified names are
 * always scoped); `undefined` means no owner was found, and the caller keeps
 * its own package name.
 */
export function createPackageOwnerResolver(
  rootDir: string,
): (filePath: string) => string | undefined {
  const byDirectory = new Map<string, string | null>();

  const ownerOfDirectory = (directory: string): string | null => {
    const cached = byDirectory.get(directory);
    if (cached !== undefined) return cached;

    let owner: string | null = null;
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      try {
        const name = (
          JSON.parse(readFileSync(candidate, 'utf8')) as {
            name?: unknown;
          }
        ).name;
        if (typeof name === 'string' && name.startsWith('@')) owner = name;
      } catch {
        // Unreadable package.json: keep walking.
      }
    }
    if (owner === null) {
      const parent = dirname(directory);
      if (parent !== directory) owner = ownerOfDirectory(parent);
    }
    byDirectory.set(directory, owner);
    return owner;
  };

  return (filePath) => {
    if (!filePath) return undefined;
    const absolute = isAbsolute(filePath)
      ? filePath
      : resolve(rootDir, filePath);
    return ownerOfDirectory(dirname(absolute)) ?? undefined;
  };
}
