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
    // No ancestor exists (only reachable with a stubbed file system): keep
    // the prospective descendants rather than collapsing to the root.
    if (parent === existing) return resolve(existing, ...descendants);
    descendants.unshift(basename(existing));
    existing = parent;
  }
  const physical = realpathSync.native(existing);
  return descendants.length === 0
    ? physical
    : resolve(physical, ...descendants);
}
