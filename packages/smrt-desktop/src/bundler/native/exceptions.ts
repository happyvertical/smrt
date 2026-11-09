/**
 * Explicit native exceptions: glob patterns over portable relative paths.
 *
 * An exception never lets a foreign binary into the bundle. A file that fails
 * verification and matches an exception is deleted by the tree verifier and
 * recorded; a file that passes is left alone. Patterns support `*` within one
 * path segment and a whole-segment `**` for zero or more segments; there is
 * no other syntax, so matching is linear-time (no regular expressions).
 */

import { NativeVerificationError } from './errors.js';

/** One allowed-but-deleted pattern; `reason` is recorded verbatim. */
export interface NativeException {
  readonly pattern: string;
  readonly reason: string;
}

const MAX_PATTERN_LENGTH = 512;

/** Whether `path` is a relative, forward-slash path with plain segments. */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    return false;
  }
  if (
    path.includes('\0') ||
    path.includes('\\') ||
    /\p{Surrogate}/u.test(path)
  ) {
    return false;
  }
  return path
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Validate a pattern; throws `invalid_exception` with a fixed message. */
export function assertValidException(exception: NativeException): void {
  const { pattern, reason } = exception;
  if (
    typeof reason !== 'string' ||
    reason.length === 0 ||
    reason.length > 512 ||
    typeof pattern !== 'string' ||
    pattern.length > MAX_PATTERN_LENGTH ||
    !isSafeRelativePath(pattern)
  ) {
    throw new NativeVerificationError('invalid_exception');
  }
  const segments = pattern.split('/');
  const last = segments[segments.length - 1] as string;
  // Every segment is either a literal, `**`, or contains `*`; the last one
  // must pin down at least one literal character.
  if (last.replace(/\*/g, '') === '') {
    throw new NativeVerificationError('invalid_exception');
  }
  for (const segment of segments) {
    if (segment.includes('**') && segment !== '**') {
      throw new NativeVerificationError('invalid_exception');
    }
  }
}

/** `*`-only glob over one segment, iterative with a single backtrack point. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Whether `path` matches `pattern` (both already validated). */
export function matchesException(pattern: string, path: string): boolean {
  const pat = pattern.split('/');
  const parts = path.split('/');
  // memo[i][j]: pat[i:] matches parts[j:]
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (parts.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === pat.length) result = j === parts.length;
    else if (pat[i] === '**') {
      result = go(i + 1, j) || (j < parts.length && go(i, j + 1));
    } else {
      result =
        j < parts.length &&
        matchSegment(pat[i] as string, parts[j] as string) &&
        go(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}
