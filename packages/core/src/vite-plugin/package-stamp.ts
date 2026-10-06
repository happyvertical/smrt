/**
 * Constructor-bound package identity for library builds (#3490).
 *
 * A consumer that bundles a dependency (a SvelteKit server build inlines
 * Svelte libraries) evaluates the dependency's classes inside the consumer's
 * own output, where the decorator's stack walk can only name the consumer's
 * package, and the bundler may order a class's chunk before the package's
 * `__smrt-register__`. Guessing ownership from a simple name and a table then
 * confuses a dependency's class with a consumer class that happens to share
 * both. Instead the package's own library build stamps each decorated class
 * it declares with `static __smrtPackage__ = '<package>'`: a static field is
 * initialized when the class is defined, before its decorators run, so the
 * registry reads the identity from the exact constructor at decoration time,
 * in any bundle and in any registration order.
 *
 * Positions come from the parser's class node (`bodyStart`), never from
 * rescanning the text: a string, template, comment or regex literal that
 * looks like `class X {` cannot receive the stamp.
 */

/** A decorated class the scanner found in a module. */
export interface PackageStampTarget {
  /** Class name as declared in source. */
  className: string;
  /** Parser offset of the class body's opening `{`. */
  bodyStart?: number;
}

/** The static property the registry reads (`getStampedPackageName`). */
export const PACKAGE_STAMP_PROPERTY = '__smrtPackage__';

/** The text inserted right after a stamped class body's `{`. */
export function packageStampText(packageName: string): string {
  return ` static ${PACKAGE_STAMP_PROPERTY} = ${JSON.stringify(packageName)};`;
}

/**
 * Stamp each target class's body with its package. Returns the new source,
 * or null when there is nothing to stamp.
 *
 * @throws Error when a target has no parser body offset or the offset is not
 *   a class body's `{`: an unstamped class of a stamping package would lose
 *   its identity in consumer bundles, so the library build fails rather than
 *   shipping it.
 */
export function injectPackageStamps(
  code: string,
  targets: readonly PackageStampTarget[],
  packageName: string,
  moduleId = '<module>',
): string | null {
  const insertions = new Set<number>();
  for (const target of targets) {
    const at = target.bodyStart;
    if (typeof at !== 'number' || code[at] !== '{') {
      throw new Error(
        `[smrt] Could not locate the body of class ${target.className} in ${moduleId} to stamp its package (#3490).`,
      );
    }
    insertions.add(at + 1);
  }
  if (insertions.size === 0) return null;
  const stamp = packageStampText(packageName);
  let result = code;
  for (const at of [...insertions].sort((a, b) => b - a)) {
    result = result.slice(0, at) + stamp + result.slice(at);
  }
  return result;
}
