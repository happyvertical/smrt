/**
 * Shared detection for OPTIONAL workspace dependencies
 * (`@happyvertical/smrt-users`, and since #2051 `@happyvertical/smrt-agents`
 * for the dormant learning schedules).
 *
 * A leaf module (no package-internal imports) so every dynamic-import seam —
 * the resolver's default tenant-hierarchy loader, the permission catalog
 * registration, and the schedule installer — shares one matcher without
 * creating an import cycle through the resolver/collection/model chain.
 */

/** Node's missing-module message shapes, capturing the quoted specifier. */
const MISSING_MODULE_TARGET_PATTERN =
  /Cannot find (?:package|module) '([^']+)'/;

/** Whether a missing-module TARGET specifier is `packageName` (or a subpath). */
function isPackageSpecifier(target: string, packageName: string): boolean {
  return target === packageName || target.startsWith(`${packageName}/`);
}

/**
 * Whether an import failure means the named workspace package is simply not
 * installed (→ graceful degradation) rather than installed-but-broken
 * (→ rethrow, surfacing the problem instead of silently degrading).
 *
 * The decision is made on the missing-module TARGET parsed from Node's
 * `Cannot find package/module '<specifier>'` message (walking the full
 * `cause` chain): only a target that IS the package (or one of its subpaths)
 * counts. A transitive failure INSIDE an installed package names the other
 * module as the target — with the package path merely appearing as the
 * importer — and therefore rethrows. `importWorkspaceModule`'s own
 * source-fallback wrapper (`Failed to load <packageName> for ...`) is also
 * accepted: it is thrown only when the package itself cannot be located.
 *
 * Exported for direct testing; not re-exported from the package index.
 */
export function isMissingWorkspaceDependency(
  error: unknown,
  packageName: string,
): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);

    const match = current.message.match(MISSING_MODULE_TARGET_PATTERN);
    if (match && isPackageSpecifier(match[1], packageName)) {
      return true;
    }

    if (current.message.includes(`Failed to load ${packageName} for`)) {
      return true;
    }

    current = current.cause;
  }

  return false;
}

/** {@link isMissingWorkspaceDependency} for `@happyvertical/smrt-users`. */
export function isMissingUsersDependency(error: unknown): boolean {
  return isMissingWorkspaceDependency(error, '@happyvertical/smrt-users');
}
