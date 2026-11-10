/**
 * Windows custody rule W1: pure, lexical path validation.
 *
 * Nothing here touches the filesystem and nothing depends on the host
 * platform (every function uses `node:path`'s `win32` flavour explicitly), so
 * the same rule runs, and is tested, on every platform.
 *
 * The only accepted form is `X:\seg\seg`. Windows resolves a long list of
 * aliases to one object (`\\?\`, `\\.\`, UNC, drive-relative, 8.3 short names,
 * trailing dots and spaces, device names, `::$DATA` streams); rather than
 * model each alias, every alias form is refused here and the canonical form is
 * proven against `realpath` later (see `windows-custody.ts`).
 */

import { win32 } from 'node:path';
import { unsafeFilesystemEntry } from './local-runtime-error.js';

/**
 * Longest accepted path in UTF-16 code units, counting the longest path the
 * runtime derives beneath it. Staying well under `MAX_PATH` (260) means
 * behaviour never depends on `LongPathsEnabled` or on SQLite's long-path
 * handling.
 */
export const WINDOWS_MAX_PATH_UNITS = 240;

/**
 * Longest suffix the runtime appends to a root it owns: the pending marker
 * `\.smrt-local-runtime-<63-char appId>.pending` is the longest at 92 units;
 * the extra margin covers SQLite's `-wal`/`-shm`/`-journal` siblings and the
 * state root's own files.
 */
export const WINDOWS_DERIVED_PATH_RESERVE = 110;

const WINDOWS_MAX_SEGMENT_UNITS = 255;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const RESERVED_DEVICE_STEM =
  /^(?:CON|PRN|AUX|NUL|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3]|CONIN\$|CONOUT\$)$/;

/**
 * Whether Windows treats `segment` as a DOS device, with or without an
 * extension (`CON`, `con.txt`, `NUL.tar.gz`, `COM¹`, `CONIN$`).
 */
export function isWindowsReservedName(segment: string): boolean {
  const stem = segment.split('.')[0].replace(/ +$/, '').toUpperCase();
  return RESERVED_DEVICE_STEM.test(stem);
}

/**
 * Validate one path component. Throws a {@link LocalRuntimeError} with a
 * fixed, secret-free reason when the component is not a plain NTFS name.
 */
export function validateWindowsSegment(segment: string, label: string): void {
  const reject = (reason: string): never => {
    throw unsafeFilesystemEntry(
      `${label} is not a safe Windows name: ${reason}`,
    );
  };
  if (segment.length === 0) reject('empty component');
  if (segment.length > WINDOWS_MAX_SEGMENT_UNITS) reject('component too long');
  if (segment === '.' || segment === '..') {
    reject('relative component');
  }
  // `:` covers alternate data streams (`name:ads`, `name::$DATA`,
  // `name::$INDEX_ALLOCATION`) and drive-relative forms in the middle.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[<>:"|?*\\/\u0000-\u001f\u007f]/.test(segment)) {
    reject('reserved or control character');
  }
  if (/[. ]$/.test(segment)) reject('trailing dot or space');
  if (isWindowsReservedName(segment)) reject('reserved device name');
}

/**
 * Validate an `appId` for use as a Windows path component. The generic
 * `validateApplicationId()` accepts `con`, `nul`, `com1`, `con.app` and `foo.`,
 * which on Windows name a device or alias another directory.
 */
export function validateWindowsApplicationId(appId: string): string {
  validateWindowsSegment(appId, 'appId');
  return appId;
}

/**
 * W1. Validate an absolute Windows path *before* it is resolved (resolution
 * would silently fold `..`, `/`, doubled separators and short names away).
 * Returns the canonical lexical form: upper-case drive letter, `\`
 * separators, no trailing separator (except a bare drive root `X:\`).
 *
 * `reserve` is the length of the longest path the runtime derives beneath the
 * result; the sum must stay within {@link WINDOWS_MAX_PATH_UNITS}.
 */
export function validateWindowsPath(
  input: string,
  label: string,
  reserve = 0,
): string {
  const reject = (reason: string): never => {
    throw unsafeFilesystemEntry(
      `${label} is not a safe Windows path: ${reason}`,
    );
  };
  if (typeof input !== 'string' || input.length === 0) reject('empty');
  if (LONE_SURROGATE.test(input)) reject('not well-formed Unicode');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting NUL/control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(input)) reject('control character');
  // Forward slashes are plain separators on Windows; turning them into `\`
  // first means `//server/share` and `//?/C:/x` hit the UNC/device refusals.
  const path = input.replaceAll('/', '\\');
  if (path.startsWith('\\\\')) {
    reject('UNC, device (\\\\?\\, \\\\.\\) and WSL paths are not supported');
  }
  const match = /^([A-Za-z]):\\(.*)$/s.exec(path);
  if (!match) {
    reject(
      'an absolute path on a local drive (X:\\...) is required; drive-relative and rooted forms are refused',
    );
  }
  const [, drive, remainder] = match as RegExpExecArray;
  const rest = remainder.endsWith('\\') ? remainder.slice(0, -1) : remainder;
  const segments = rest.length === 0 ? [] : rest.split('\\');
  for (const segment of segments) validateWindowsSegment(segment, label);
  const normalized = [`${drive.toUpperCase()}:`, ...segments].join('\\');
  const canonical = segments.length === 0 ? `${normalized}\\` : normalized;
  if (canonical.length + reserve > WINDOWS_MAX_PATH_UNITS) {
    reject(
      `longer than ${WINDOWS_MAX_PATH_UNITS - reserve} UTF-16 units (Windows long paths are not relied upon)`,
    );
  }
  return canonical;
}

/**
 * Case folding used wherever two spellings must not become two identities
 * (lock keys, state-root identity, overlap guards). NTFS compares with its own
 * up-case table, which JavaScript's folding does not reproduce exactly; a fold
 * can only make unequal strings compare equal, which is the safe direction for
 * a key or an overlap guard. It is never used to *prove* a path canonical.
 */
export function foldWindowsCase(value: string): string {
  return value.toUpperCase().toLowerCase();
}

/** Drive-letter-insensitive, otherwise ordinal comparison (W4). */
export function sameWindowsCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    /^[A-Za-z]:/.test(value)
      ? `${value[0].toUpperCase()}${value.slice(1)}`
      : value;
  return normalize(left) === normalize(right);
}

/** `X:\`, `X:\a`, `X:\a\b` for a path already accepted by W1. */
export function windowsPathComponents(path: string): string[] {
  const drive = `${path.slice(0, 2)}\\`;
  const rest = path.slice(3);
  const components = [drive];
  if (rest.length === 0) return components;
  for (const segment of rest.split('\\')) {
    components.push(
      win32.join(components[components.length - 1] as string, segment),
    );
  }
  return components;
}

/** Fold-insensitive containment: `child` is `parent` or beneath it. */
export function isInsideWindowsPath(parent: string, child: string): boolean {
  const normalizedParent = foldWindowsCase(win32.resolve(parent));
  const normalizedChild = foldWindowsCase(win32.resolve(child));
  const path = win32.relative(normalizedParent, normalizedChild);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith('..\\') && !win32.isAbsolute(path))
  );
}
