import { type DesktopFs, FsTrustError, toFsTrustError } from './fs-seam.js';
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

export interface TrustWalkOptions {
  readonly fs: DesktopFs;
  readonly platform: NodeJS.Platform;
  /** Effective uid; `undefined` skips ownership checks (Windows). */
  readonly uid: number | undefined;
  /** What `target` must be. */
  readonly leaf: 'file' | 'directory';
  /** Require an execute bit on the leaf (POSIX only). */
  readonly executable?: boolean;
}

/**
 * Walk from `root` down to `target`, one component at a time, and throw an
 * `FsTrustError` unless every component exists, is not a symlink, and `root`
 * resolves to itself (so no ancestor is a symlink either). On POSIX every
 * component must also be owned by the current user or root and not be group
 * or other writable; the leaf must be a regular file or directory as asked,
 * with an execute bit when `executable`.
 *
 * Windows ACLs cannot be read from Node, so there only existence, file kind
 * and reparse points are checked; real ACL checks belong to the native shell.
 */
export async function assertTrustedChain(
  root: AbsolutePath,
  target: AbsolutePath,
  options: TrustWalkOptions,
): Promise<void> {
  if (!isInside(root, target, true)) throw new FsTrustError('untrusted');
  const posix = options.platform !== 'win32';

  const chain: AbsolutePath[] = [];
  for (let n = root.segments.length; n <= target.segments.length; n++) {
    chain.push({ ...target, segments: target.segments.slice(0, n) });
  }

  for (const [index, current] of chain.entries()) {
    const path = formatAbsolutePath(current);
    const isLeaf = index === chain.length - 1;
    try {
      const stat = await options.fs.lstat(path);
      if (stat.isSymbolicLink()) throw new FsTrustError('untrusted');
      const wantFile = isLeaf && options.leaf === 'file';
      if (wantFile ? !stat.isFile() : !stat.isDirectory()) {
        throw new FsTrustError('untrusted');
      }
      if (posix) {
        if (
          options.uid !== undefined &&
          stat.uid !== options.uid &&
          stat.uid !== 0
        ) {
          throw new FsTrustError('untrusted');
        }
        if ((stat.mode & 0o022) !== 0) throw new FsTrustError('untrusted');
        if (isLeaf && options.executable && (stat.mode & 0o111) === 0) {
          throw new FsTrustError('untrusted');
        }
        if ((await options.fs.realpath(path)) !== path) {
          throw new FsTrustError('untrusted');
        }
      }
    } catch (error) {
      throw toFsTrustError(error);
    }
  }
}
