/**
 * Native binary classification and target verification.
 *
 * Files are classified by their header BYTES, never by extension: a `.js`
 * file that starts like a Mach-O image is still a native and must match the
 * bundle target. The extension only adds a requirement in the other direction:
 * a file named `.node`, `.dylib`, `.so[.N]`, `.dll` or `.exe` must parse as a
 * native of the right role, which catches truncated downloads, HTML error
 * pages and foreign formats saved under a native name.
 *
 * Fail closed. A native that does not match the target, an unknown or
 * unsupported native kind, a symlink or special file, and a hardlinked native
 * are all failures. The only escape hatch is an explicit exception, and an
 * exception DELETES the offending file instead of shipping it.
 *
 * All reads are bounds-checked and budgeted (see `reader.ts`); no error
 * carries a path or byte value.
 */

import {
  parseTargetTriple,
  type TargetSpec,
  type TargetTriple,
} from '../targets.js';
import { hasElfMagic, parseElf } from './elf.js';
import {
  type NativeFailure,
  type NativeFailureReason,
  NativeVerificationError,
} from './errors.js';
import {
  assertValidException,
  isSafeRelativePath,
  matchesException,
  type NativeException,
} from './exceptions.js';
import {
  hasFatMachoMagic,
  hasThinMachoMagic,
  parseFatMacho,
  parseThinMacho,
} from './macho.js';
import { parsePe, peSignatureOffset } from './pe.js';
import {
  type BudgetedReader,
  type ByteReader,
  budgeted,
  bufferReader,
  type ClosableByteReader,
} from './reader.js';
import type {
  NativeFormat,
  NativeInfo,
  NativeKind,
  NativeLibc,
  NativeMachine,
} from './types.js';

export type { NativeException } from './exceptions.js';
export type {
  NativeFormat,
  NativeInfo,
  NativeKind,
  NativeLibc,
  NativeMachine,
} from './types.js';

const SNIFF_BYTES = 64;

/** Role a file name demands, or `undefined` when the name is not native. */
export type NativeRole = 'library' | 'executable';

/** `library` for `.node/.dylib/.so[.N…]/.dll`, `executable` for `.exe`. */
export function nativeRoleOfPath(path: string): NativeRole | undefined {
  const name = (path.slice(path.lastIndexOf('/') + 1) || '').toLowerCase();
  if (name.endsWith('.exe')) return 'executable';
  if (
    name.endsWith('.node') ||
    name.endsWith('.dylib') ||
    name.endsWith('.dll') ||
    /\.so(?:\.\d+)*$/.test(name)
  ) {
    return 'library';
  }
  return undefined;
}

/** Identify the container format from the header bytes alone. */
async function sniff(
  reader: BudgetedReader,
): Promise<NativeFormat | undefined> {
  if (reader.size < 4) return undefined;
  const head = await reader.bytes(0, Math.min(SNIFF_BYTES, reader.size));
  if (hasElfMagic(head)) return 'elf';
  if (hasThinMachoMagic(head)) return 'macho';
  if (hasFatMachoMagic(head)) return 'macho-fat';
  if (peSignatureOffset(head, reader.size) !== undefined) {
    const at = peSignatureOffset(head, reader.size) as number;
    const sig = await reader.bytes(at, 4);
    if (sig[0] === 0x50 && sig[1] === 0x45 && sig[2] === 0 && sig[3] === 0) {
      return 'pe';
    }
  }
  return undefined;
}

function parseFormat(
  format: NativeFormat,
  reader: BudgetedReader,
): Promise<NativeInfo> {
  switch (format) {
    case 'elf':
      return parseElf(reader);
    case 'macho':
      return parseThinMacho(reader);
    case 'macho-fat':
      return parseFatMacho(reader);
    case 'pe':
      return parsePe(reader);
  }
}

function asReader(source: Uint8Array | ByteReader): ByteReader {
  return source instanceof Uint8Array ? bufferReader(source) : source;
}

/**
 * Classify a file by its header bytes. Resolves `undefined` when the bytes are
 * not a native binary; rejects with a `NativeVerificationError` when they
 * start like one but are truncated, malformed or an unsupported variant.
 */
export async function classifyNativeFile(
  source: Uint8Array | ByteReader,
): Promise<NativeInfo | undefined> {
  const reader = budgeted(asReader(source));
  const format = await sniff(reader);
  if (format === undefined) return undefined;
  return parseFormat(format, reader);
}

/** What `verifyNativeFile` found. */
export interface NativeVerdict {
  /** Header-derived format, or `not-native` when no native header was found. */
  readonly kind: NativeFormat | 'not-native';
  readonly ok: boolean;
  /** Set when `ok` is false. */
  readonly reason?: NativeFailureReason;
  /** Set when the header parsed, even if it did not match. */
  readonly info?: NativeInfo;
}

/** Options for `verifyNativeFile`. */
export interface VerifyNativeOptions {
  /** The name demands a native (for example `.node`): non-native fails. */
  readonly requireNative?: boolean;
  /** Role the name demands; `either` ELF files satisfy both roles. */
  readonly expectKind?: NativeRole;
}

const CONTENT_REASONS: ReadonlySet<string> = new Set([
  'truncated',
  'malformed',
  'unsupported_format',
  'read_limit',
  'read_failed',
]);

function reasonOf(error: unknown): NativeFailureReason {
  if (
    error instanceof NativeVerificationError &&
    CONTENT_REASONS.has(error.code)
  ) {
    return error.code as NativeFailureReason;
  }
  return 'malformed';
}

function kindMatches(actual: NativeKind, wanted: NativeRole): boolean {
  return actual === 'either' || actual === wanted;
}

function formatMatches(info: NativeInfo, target: TargetSpec): boolean {
  const expected = target.native.format;
  return expected === 'macho'
    ? info.format === 'macho' || info.format === 'macho-fat'
    : info.format === expected;
}

function libcMatches(
  libc: NativeLibc | undefined,
  target: TargetSpec,
): boolean {
  if (target.native.libc === undefined) return true;
  // A gnu target accepts glibc and libc-free (static) files; musl, an
  // unrecognised interpreter and a missing libc field are all rejected.
  return libc === 'glibc' || libc === 'none';
}

/**
 * Verify one file against the bundle target.
 *
 * `source` is the file's bytes or a `ByteReader` over an open descriptor
 * (`fileHandleReader`). Content problems resolve `{ ok: false, reason }`;
 * only a caller bug (an invalid target) throws.
 */
export async function verifyNativeFile(
  source: Uint8Array | ByteReader,
  target: TargetSpec | TargetTriple,
  options: VerifyNativeOptions = {},
): Promise<NativeVerdict> {
  const spec = typeof target === 'string' ? parseTargetTriple(target) : target;
  const reader = budgeted(asReader(source));

  let format: NativeFormat | undefined;
  try {
    format = await sniff(reader);
  } catch (error) {
    return { kind: 'not-native', ok: false, reason: reasonOf(error) };
  }
  if (format === undefined) {
    return options.requireNative === true
      ? { kind: 'not-native', ok: false, reason: 'not_native' }
      : { kind: 'not-native', ok: true };
  }

  let info: NativeInfo;
  try {
    info = await parseFormat(format, reader);
  } catch (error) {
    return { kind: format, ok: false, reason: reasonOf(error) };
  }

  const fail = (reason: NativeFailureReason): NativeVerdict => ({
    kind: format,
    ok: false,
    reason,
    info,
  });
  if (!formatMatches(info, spec)) return fail('wrong_format');
  if (!info.machines.includes(spec.native.machine))
    return fail('wrong_machine');
  if (!libcMatches(info.libc, spec)) return fail('wrong_libc');
  if (
    options.expectKind !== undefined &&
    !kindMatches(info.kind, options.expectKind)
  ) {
    return fail('wrong_kind');
  }
  return { kind: format, ok: true, info };
}

// ---------------------------------------------------------------------------
// Tree verification
// ---------------------------------------------------------------------------

/** One non-directory entry produced by a `NativeTreeWalker`. */
export interface NativeTreeEntry {
  /** Forward-slash relative path, for example `app/node_modules/x/y.node`. */
  readonly path: string;
  /** From `lstat`, never `stat`. */
  readonly type: 'file' | 'symlink' | 'other';
  readonly size: number;
  readonly nlink: number;
  /** Open the regular file (no-follow); the verifier closes the reader. */
  open(): Promise<ClosableByteReader>;
}

/**
 * The file-walker seam. Implementations walk the bundle output with `lstat`
 * and `O_NOFOLLOW`, yield every non-directory entry, and delete on request.
 */
export interface NativeTreeWalker {
  entries(): AsyncIterable<NativeTreeEntry> | Iterable<NativeTreeEntry>;
  /** Required when exceptions are supplied. */
  remove?(path: string): Promise<void>;
}

/** One native file that passed verification. */
export interface NativeRecord {
  readonly path: string;
  readonly format: NativeFormat;
  readonly kind: NativeKind;
  readonly machines: readonly NativeMachine[];
  readonly libc?: NativeLibc;
}

/** A failing file removed because an explicit exception matched it. */
export interface RemovedNative {
  readonly path: string;
  readonly pattern: string;
  readonly reason: string;
  readonly cause: NativeFailureReason;
}

/** Result of `verifyTreeNatives`; sorted by path (UTF-16 code unit order). */
export interface NativeTreeVerification {
  readonly ok: boolean;
  readonly filesChecked: number;
  readonly natives: readonly NativeRecord[];
  readonly failures: readonly NativeFailure[];
  readonly removed: readonly RemovedNative[];
}

/** Options for `verifyTreeNatives`. */
export interface VerifyTreeOptions {
  readonly exceptions?: readonly NativeException[];
}

const STRUCTURAL: ReadonlySet<NativeFailureReason> = new Set([
  'symlink',
  'special_file',
  'hardlinked',
  'invalid_path',
]);

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Verify every native in a bundle tree against `target`.
 *
 * Rules, all fail-closed:
 * 1. A file whose header is a native must match the target's format, machine
 *    and (Linux) libc.
 * 2. A file named like a native must parse as a native of the right role.
 * 3. Natives must be regular files with `nlink === 1`.
 * 4. Symlinks and special files fail wherever they are (the bundle output
 *    contains none; a symlink cannot be classified safely).
 * 5. An explicit exception that matches a content failure deletes the file
 *    (via `walker.remove`) and records it; it never keeps the file.
 */
export async function verifyTreeNatives(
  walker: NativeTreeWalker,
  target: TargetSpec | TargetTriple,
  options: VerifyTreeOptions = {},
): Promise<NativeTreeVerification> {
  const spec = typeof target === 'string' ? parseTargetTriple(target) : target;
  const exceptions = options.exceptions ?? [];
  for (const exception of exceptions) assertValidException(exception);
  if (exceptions.length > 0 && walker.remove === undefined) {
    throw new NativeVerificationError('invalid_exception');
  }

  const natives: NativeRecord[] = [];
  const failures: NativeFailure[] = [];
  const removed: RemovedNative[] = [];
  let filesChecked = 0;

  const record = async (
    path: string,
    reason: NativeFailureReason,
  ): Promise<void> => {
    if (!STRUCTURAL.has(reason)) {
      const hit = exceptions.find((e) => matchesException(e.pattern, path));
      if (hit !== undefined && walker.remove !== undefined) {
        await walker.remove(path);
        removed.push({
          path,
          pattern: hit.pattern,
          reason: hit.reason,
          cause: reason,
        });
        return;
      }
    }
    failures.push({ path, reason });
  };

  for await (const entry of walker.entries()) {
    filesChecked++;
    if (!isSafeRelativePath(entry.path)) {
      failures.push({ path: '<invalid>', reason: 'invalid_path' });
      continue;
    }
    if (entry.type === 'symlink') {
      failures.push({ path: entry.path, reason: 'symlink' });
      continue;
    }
    if (entry.type !== 'file') {
      failures.push({ path: entry.path, reason: 'special_file' });
      continue;
    }

    const role = nativeRoleOfPath(entry.path);
    if (entry.size === 0) {
      if (role !== undefined) await record(entry.path, 'not_native');
      continue;
    }

    let reader: ClosableByteReader;
    try {
      reader = await entry.open();
    } catch {
      await record(entry.path, 'read_failed');
      continue;
    }
    try {
      if (reader.size !== entry.size) {
        await record(entry.path, 'read_failed');
        continue;
      }
      const verdict = await verifyNativeFile(reader, spec, {
        requireNative: role !== undefined,
        ...(role === undefined ? {} : { expectKind: role }),
      });
      if (!verdict.ok) {
        await record(entry.path, verdict.reason as NativeFailureReason);
      } else if (verdict.info !== undefined) {
        if (entry.nlink !== 1) {
          failures.push({ path: entry.path, reason: 'hardlinked' });
        } else {
          const { info } = verdict;
          natives.push({
            path: entry.path,
            format: info.format,
            kind: info.kind,
            machines: info.machines,
            ...(info.libc === undefined ? {} : { libc: info.libc }),
          });
        }
      }
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  natives.sort(byPath);
  failures.sort(byPath);
  removed.sort(byPath);
  return {
    ok: failures.length === 0,
    filesChecked,
    natives,
    failures,
    removed,
  };
}

/** Throw `verification_failed` (failures as data) unless the tree is clean. */
export function assertTreeNatives(result: NativeTreeVerification): void {
  if (!result.ok) {
    throw new NativeVerificationError('verification_failed', result.failures);
  }
}
