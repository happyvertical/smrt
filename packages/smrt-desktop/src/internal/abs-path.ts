import { asciiLower, isValidText } from './grammar.js';

/**
 * Lexical absolute-path rules and the filesystem trust walk. The lexical half
 * is pure and platform-independent: the flavor is chosen by the caller, so
 * Windows rules are testable on any host.
 *
 * Accepted forms are exactly `/a/b` (POSIX) and `X:\a\b` (Windows). Everything
 * else is rejected: relative and drive-relative paths, UNC (`\\server\...`),
 * device and extended-length (`\\?\`, `\\.\`) prefixes, forward slashes on
 * Windows, backslashes on POSIX, NUL, empty, `.` and `..` segments, trailing
 * separators (except a bare root), reserved Windows device names, and
 * Windows-illegal characters and trailing dots/spaces.
 */

export type PathFlavor = 'posix' | 'win32';

export function flavorOf(platform: NodeJS.Platform): PathFlavor {
  return platform === 'win32' ? 'win32' : 'posix';
}

export function separatorOf(flavor: PathFlavor): string {
  return flavor === 'win32' ? '\\' : '/';
}

export interface AbsolutePath {
  readonly flavor: PathFlavor;
  /** `/` or `X:\`. */
  readonly root: string;
  readonly segments: readonly string[];
}

const windowsDriveRoot = /^[A-Za-z]:\\/;
const windowsIllegal = /[\p{Cc}<>:"|?*\\/]/u;
const windowsDevice = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

function validWindowsSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !windowsIllegal.test(segment) &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ') &&
    !windowsDevice.test(segment)
  );
}

function validPosixSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..';
}

/** Parse a normalized absolute path, or return `null` if it is not one. */
export function parseAbsolutePath(
  value: unknown,
  flavor: PathFlavor,
): AbsolutePath | null {
  if (typeof value !== 'string' || !isValidText(value) || value.length === 0) {
    return null;
  }
  if (flavor === 'posix') {
    if (!value.startsWith('/') || value.includes('\\')) return null;
    if (value === '/') return { flavor, root: '/', segments: [] };
    const segments = value.slice(1).split('/');
    if (!segments.every(validPosixSegment)) return null;
    return { flavor, root: '/', segments };
  }
  if (!windowsDriveRoot.test(value)) return null;
  const root = value.slice(0, 3);
  const rest = value.slice(3);
  if (rest.length === 0) return { flavor, root, segments: [] };
  const segments = rest.split('\\');
  if (!segments.every(validWindowsSegment)) return null;
  return { flavor, root, segments };
}

export function formatAbsolutePath(path: AbsolutePath): string {
  return path.root + path.segments.join(separatorOf(path.flavor));
}

function fold(path: AbsolutePath): readonly string[] {
  const parts = [path.root, ...path.segments];
  // NTFS names are case-insensitive. ASCII folding only ever equates names the
  // filesystem also equates, so a fold can fail closed but never alias.
  return path.flavor === 'win32' ? parts.map(asciiLower) : parts;
}

/**
 * True when `child` is strictly inside `parent`, or equal to it when
 * `allowEqual`. Compares whole segments, never string prefixes.
 */
export function isInside(
  parent: AbsolutePath,
  child: AbsolutePath,
  allowEqual = false,
): boolean {
  if (parent.flavor !== child.flavor) return false;
  const a = fold(parent);
  const b = fold(child);
  if (b.length < a.length || (b.length === a.length && !allowEqual)) {
    return false;
  }
  return a.every((part, index) => part === b[index]);
}

export function samePath(a: AbsolutePath, b: AbsolutePath): boolean {
  return (
    a.flavor === b.flavor &&
    fold(a).length === fold(b).length &&
    isInside(a, b, true)
  );
}

/** Parent directory, or `null` for a root. */
export function parentOf(path: AbsolutePath): AbsolutePath | null {
  if (path.segments.length === 0) return null;
  return { ...path, segments: path.segments.slice(0, -1) };
}

/** Append validated child segments to `base`. */
export function appendSegments(
  base: AbsolutePath,
  segments: readonly string[],
): AbsolutePath {
  return { ...base, segments: [...base.segments, ...segments] };
}
