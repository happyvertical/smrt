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
 */

/** A decorated class the scanner found in a module. */
export interface PackageStampTarget {
  /** Class name as declared in source. */
  className: string;
  /** 1-based line the class node (decorators included) starts on. */
  startLine: number;
}

/** The static property the registry reads (`getStampedPackageName`). */
export const PACKAGE_STAMP_PROPERTY = '__smrtPackage__';

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

/** Index just past the string, template or comment starting at `index`, or -1. */
function skipNonCode(code: string, index: number): number {
  const char = code[index];
  if (char === '/' && code[index + 1] === '/') {
    const end = code.indexOf('\n', index);
    return end === -1 ? code.length : end;
  }
  if (char === '/' && code[index + 1] === '*') {
    const end = code.indexOf('*/', index + 2);
    return end === -1 ? code.length : end + 2;
  }
  if (char === '"' || char === "'" || char === '`') {
    let cursor = index + 1;
    while (cursor < code.length && code[cursor] !== char) {
      cursor += code[cursor] === '\\' ? 2 : 1;
    }
    return cursor + 1;
  }
  return -1;
}

/** Offset of the first character of a 1-based line. */
function lineOffset(code: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line && offset !== -1; current++) {
    offset = code.indexOf('\n', offset);
    if (offset !== -1) offset += 1;
  }
  return offset === -1 ? code.length : offset;
}

/**
 * Offset just past the `{` opening the body of `class <className>`, searching
 * code (not strings or comments) from `from`; -1 when not found.
 */
function findClassBody(code: string, className: string, from: number): number {
  const keyword = `class`;
  let cursor = from;
  while (cursor < code.length) {
    const skipped = skipNonCode(code, cursor);
    if (skipped !== -1) {
      cursor = skipped;
      continue;
    }
    if (
      code.startsWith(keyword, cursor) &&
      !isIdentifierChar(code[cursor - 1]) &&
      /\s/.test(code[cursor + keyword.length] ?? '')
    ) {
      let nameStart = cursor + keyword.length;
      while (/\s/.test(code[nameStart] ?? '')) nameStart++;
      const nameEnd = nameStart + className.length;
      if (
        code.slice(nameStart, nameEnd) === className &&
        !isIdentifierChar(code[nameEnd])
      ) {
        // Walk the heritage clause to the body, ignoring nested brackets
        // (`extends Base<{ a: 1 }>`, `extends mixin(A, { b })`).
        let depth = 0;
        let scan = nameEnd;
        while (scan < code.length) {
          const inner = skipNonCode(code, scan);
          if (inner !== -1) {
            scan = inner;
            continue;
          }
          const char = code[scan];
          if (char === '(' || char === '[' || char === '<') depth++;
          else if (char === ')' || char === ']') depth--;
          else if (char === '>' && code[scan - 1] !== '=') depth--;
          else if (char === '{') {
            if (depth === 0) return scan + 1;
            depth++;
          } else if (char === '}') depth--;
          scan++;
        }
        return -1;
      }
    }
    cursor++;
  }
  return -1;
}

/**
 * Stamp each target class's body with its package. Returns the new source,
 * or null when nothing was stamped.
 *
 * @throws Error when a target class cannot be located: an unstamped class
 *   of a stamping package would lose its identity in consumer bundles, so the
 *   library build fails rather than shipping it.
 */
export function injectPackageStamps(
  code: string,
  targets: readonly PackageStampTarget[],
  packageName: string,
  moduleId = '<module>',
): string | null {
  const insertions: number[] = [];
  for (const target of targets) {
    const at = findClassBody(
      code,
      target.className,
      lineOffset(code, target.startLine),
    );
    if (at === -1) {
      throw new Error(
        `[smrt] Could not locate the body of class ${target.className} in ${moduleId} to stamp its package (#3490).`,
      );
    }
    insertions.push(at);
  }
  if (insertions.length === 0) return null;
  const stamp = ` static ${PACKAGE_STAMP_PROPERTY} = ${JSON.stringify(packageName)};`;
  let result = code;
  for (const at of [...new Set(insertions)].sort((a, b) => b - a)) {
    result = result.slice(0, at) + stamp + result.slice(at);
  }
  return result;
}
