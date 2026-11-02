import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { glob, isDynamicPattern } from 'tinyglobby';

const MANDATORY_DISCOVERY_EXCLUDES: readonly string[] = Object.freeze([
  '**/node_modules/**',
  '**/.*/**',
  '**/.*',
]);

export interface SourceDiscoveryOptions {
  cwd: string;
  include: string[];
  exclude: string[];
  followSymbolicLinks?: boolean;
}

/**
 * Discover authored source files with the bounded policy shared by every
 * scanner entry point, including ManifestBuilder's preflight (#2275).
 */
export async function discoverSourceFiles(
  options: SourceDiscoveryOptions,
): Promise<string[]> {
  const cwd = resolve(options.cwd);
  const patterns = options.include.map((pattern) =>
    relativeGlobToCwd(pattern, cwd),
  );
  const exclusions = options.exclude.map((pattern) =>
    relativeGlobToCwd(pattern, cwd),
  );
  // tinyglobby loses cwd-local patterns and misapplies ignores when any pattern
  // climbs outside cwd. Normalize every anchored pattern to one shared ancestor
  // first, so its crawler never has to interpret parent-relative patterns.
  let discoveryCwd = cwd;
  for (const pattern of [...patterns, ...exclusions]) {
    const body =
      pattern.startsWith('!') && !pattern.startsWith('!(')
        ? pattern.slice(1)
        : pattern;
    const target = resolve(cwd, body);
    while (relative(discoveryCwd, target).split(sep)[0] === '..') {
      discoveryCwd = dirname(discoveryCwd);
    }
  }
  const rebase = (pattern: string, bound: boolean): string => {
    const negative = pattern.startsWith('!') && !pattern.startsWith('!(');
    const body = negative ? pattern.slice(1) : pattern;
    // Unanchored global bounds retain their meaning for all selected roots.
    const rebased =
      bound && (body === '**' || body.startsWith('**/'))
        ? body
        : normalizeGlobSeparators(relative(discoveryCwd, resolve(cwd, body)));
    return negative ? `!${rebased}` : rebased;
  };
  // Prune beneath each selected source root, not its ancestors. A caller cwd
  // inside .worktrees remains authored input when another include reaches a
  // sibling; explicit hidden/node_modules descendants still stay forbidden.
  const sourcePrunes = new Set<string>();
  const boundedPatterns = patterns.filter((pattern) => {
    if (pattern.startsWith('!') && !pattern.startsWith('!(')) return true;
    const parts = normalizeGlobSeparators(
      relative(cwd, resolve(cwd, pattern)),
    ).split('/');
    const dynamic = parts.findIndex((part) => isDynamicPattern(part));
    const literal = dynamic < 0 ? parts : parts.slice(0, dynamic);
    if (
      literal.some(
        (part) =>
          part === 'node_modules' ||
          (part.startsWith('.') && part !== '.' && part !== '..'),
      )
    )
      return false;
    const prefix = dynamic < 0 ? literal.slice(0, -1) : literal;
    const root = normalizeGlobSeparators(
      relative(discoveryCwd, resolve(cwd, ...prefix)),
    );
    for (const prune of MANDATORY_DISCOVERY_EXCLUDES)
      sourcePrunes.add(root ? `${root}/${prune}` : prune);
    return true;
  });
  const files = await glob(
    boundedPatterns.map((pattern) =>
      rebase(pattern, pattern.startsWith('!') && !pattern.startsWith('!(')),
    ),
    {
      cwd: discoveryCwd,
      expandDirectories: false,
      ignore: [
        ...exclusions.map((pattern) => rebase(pattern, true)),
        ...sourcePrunes,
      ],
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: options.followSymbolicLinks ?? false,
    },
  );
  return [...new Set(files)].sort();
}

/** Preserve relative glob escapes; normalize separators only after rewriting. */
export function relativeGlobToCwd(pattern: string, cwd: string): string {
  const windowsAbsolute = win32.isAbsolute(pattern);
  if (!isAbsolute(pattern) && !windowsAbsolute) return pattern;

  const cwdVariants = [
    cwd,
    cwd.replaceAll('\\', '/'),
    cwd.replaceAll('/', '\\'),
  ];
  for (const prefix of new Set(cwdVariants)) {
    const comparablePattern = windowsAbsolute ? pattern.toLowerCase() : pattern;
    const comparablePrefix = windowsAbsolute ? prefix.toLowerCase() : prefix;
    if (comparablePattern === comparablePrefix) return '.';

    const boundary = pattern.charAt(prefix.length);
    if (
      comparablePattern.startsWith(comparablePrefix) &&
      (boundary === '/' || boundary === '\\')
    ) {
      const rewritten = pattern.slice(prefix.length + 1);
      // A slash-authored glob can contain meaningful backslash escapes such as
      // `\\[id\\]`; only native Windows path syntax needs separator rewriting.
      return boundary === '\\'
        ? normalizeGlobSeparators(rewritten, '\\')
        : rewritten;
    }
  }

  // tinyglobby (like fast-glob before it) requires slash separators even when
  // an absolute pattern points outside cwd and therefore cannot be made
  // relative.
  const slashAuthoredWindows = /^[A-Za-z]:\//.test(pattern);
  return windowsAbsolute && !slashAuthoredWindows
    ? normalizeGlobSeparators(pattern, '\\')
    : pattern;
}

export function normalizeGlobSeparators(
  pattern: string,
  pathSeparator = sep,
): string {
  return pathSeparator === '/'
    ? pattern
    : pattern.replaceAll(pathSeparator, '/');
}
