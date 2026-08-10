import { isAbsolute, resolve, sep, win32 } from 'node:path';
import fg from 'fast-glob';

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
  return fg(
    options.include.map((pattern) => relativeGlobToCwd(pattern, cwd)),
    {
      cwd,
      ignore: [
        ...options.exclude.map((pattern) => relativeGlobToCwd(pattern, cwd)),
        ...MANDATORY_DISCOVERY_EXCLUDES,
      ],
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: options.followSymbolicLinks ?? false,
    },
  );
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

  // fast-glob requires slash separators even when an absolute pattern points
  // outside cwd and therefore cannot be made relative.
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
