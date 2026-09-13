import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Identifies an output path by its physical location without requiring the
 * final generated directory to exist. Resolving the nearest existing ancestor
 * follows symlinks in either an artifact root or a route-path segment, then
 * appends the prospective descendants unchanged.
 */
export function canonicalSvelteKitPath(path: string): string {
  const descendants: string[] = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return existing;
    descendants.unshift(basename(existing));
    existing = parent;
  }
  const physical = realpathSync.native(existing);
  return descendants.length === 0
    ? physical
    : resolve(physical, ...descendants);
}
