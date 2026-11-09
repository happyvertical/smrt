/**
 * Windows custody rule for the local runtime (smrt#4837).
 *
 * POSIX custody rests on `O_NOFOLLOW`, `uid` and mode bits. Node exposes none
 * of those on Windows, so custody there is a different, explicit rule:
 *
 * - W1 lexical (`windows-paths.ts`): only `X:\seg\seg`, no aliases;
 * - W3 no reparse point on any component (`lstat` plus the `ReparsePoint`
 *   attribute, which also catches mount points and cloud placeholders);
 * - W4 canonical identity: `realpath` must equal the component, ordinal, so
 *   junction ancestors, `subst`, mapped drives, 8.3 names and case variants
 *   are all refused;
 * - W5 handle identity: an opened file is compared with `lstat` on bigint
 *   `dev`/`ino`/`birthtimeNs` and must have a single link;
 * - W6 DACL (`windows-sddl.ts`, fetched by `windows-acl-inspector.ts`): the
 *   actual access-control property. Without it nothing here is a guarantee,
 *   because a directory created under `C:\` inherits an ACE that lets every
 *   local user modify it.
 *
 * The rule is synchronous on purpose: the operator state root
 * (`state-root.ts`) is synchronous, and one implementation serves both it and
 * the async runtime. It runs at startup only. Every filesystem and ACL access
 * goes through {@link WindowsCustodyRuntime}, so every policy decision is
 * testable on any platform with a fake runtime.
 */

import {
  type BigIntStats,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { win32 } from 'node:path';
import { errorCode } from './error-code.js';
import {
  LocalRuntimeError,
  unsafeFilesystemEntry,
} from './local-runtime-error.js';
import {
  createPowerShellAclInspector,
  type WindowsAclInspector,
  type WindowsAclRecord,
} from './windows-acl-inspector.js';
import {
  createIcaclsDirectoryLocker,
  type WindowsDirectoryLocker,
} from './windows-acl-lock.js';
import {
  foldWindowsCase,
  isInsideWindowsPath,
  sameWindowsCanonicalPath,
  validateWindowsPath,
  windowsPathComponents,
} from './windows-paths.js';
import {
  assertWindowsSecurityPolicy,
  parseSddl,
  type WindowsCustodyRole,
} from './windows-sddl.js';

export type { WindowsAclInspector, WindowsAclRecord };

/** An opened regular file. */
export interface WindowsFileHandle {
  stat(): BigIntStats;
  readUtf8(): string;
  close(): void;
}

/**
 * Every effect the Windows rule has on the machine. The default uses
 * `node:fs` (synchronous, bigint) and Windows PowerShell; tests inject fakes.
 */
export interface WindowsCustodyRuntime {
  readonly env: NodeJS.ProcessEnv;
  lstat(path: string): BigIntStats;
  /** Native (`GetFinalPathNameByHandleW`) real path. */
  realpath(path: string): string;
  mkdir(path: string): void;
  /**
   * Disable inheritance on a directory this attempt just created and replace
   * its DACL with full control for `userSid`, SYSTEM and Administrators only
   * (smrt#4843). Never called on a pre-existing directory.
   */
  lockDirectory: WindowsDirectoryLocker;
  rmdir(path: string): void;
  unlink(path: string): void;
  readdir(path: string): string[];
  /** `create` is exclusive creation (`wx`); `read` is read-only. */
  openFile(path: string, mode: 'read' | 'create'): WindowsFileHandle;
  inspectAcl: WindowsAclInspector;
}

export function createNodeWindowsRuntime(
  options: {
    env?: NodeJS.ProcessEnv;
    inspectAcl?: WindowsAclInspector;
    lockDirectory?: WindowsDirectoryLocker;
  } = {},
): WindowsCustodyRuntime {
  const env = options.env ?? process.env;
  return {
    env,
    lstat: (path) => lstatSync(path, { bigint: true }),
    realpath: (path) => realpathSync.native(path),
    mkdir: (path) => {
      // No mode argument: Windows ignores it. The new directory briefly has
      // the DACL it inherited from its parent; `lockDirectory` replaces it
      // right away and W6 then re-inspects the result.
      mkdirSync(path);
    },
    lockDirectory:
      options.lockDirectory ?? createIcaclsDirectoryLocker({ env }),
    rmdir: (path) => rmdirSync(path),
    unlink: (path) => unlinkSync(path),
    readdir: (path) => readdirSync(path),
    openFile: (path, mode) => {
      const descriptor = openSync(path, mode === 'create' ? 'wx' : 'r');
      return {
        stat: () => fstatSync(descriptor, { bigint: true }),
        readUtf8: () => readFileSync(descriptor, 'utf8'),
        close: () => closeSync(descriptor),
      };
    },
    inspectAcl: options.inspectAcl ?? createPowerShellAclInspector({ env }),
  };
}

const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000;
const DRIVE_TYPE_FIXED = 3;

export function missingEntry(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `ENOENT: no such file or directory: ${path}`,
  );
  error.code = 'ENOENT';
  return error;
}

function tryLstat(
  rt: WindowsCustodyRuntime,
  path: string,
): BigIntStats | undefined {
  try {
    return rt.lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function identityOf(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${stats.isDirectory() ? 'd' : 'f'}`;
}

function assertCanonicalPath(path: string, label: string): void {
  if (validateWindowsPath(path, label) !== path) {
    throw unsafeFilesystemEntry(
      `${label} is not in canonical Windows form: ${path}`,
    );
  }
}

export interface WalkedWindowsChain {
  readonly target: string;
  readonly components: readonly string[];
  readonly existing: readonly {
    readonly path: string;
    readonly identity: string;
  }[];
  /** Every component of `target` exists. */
  readonly complete: boolean;
}

/**
 * W3 + W4 without spawning anything: every existing component, from the drive
 * root to the leaf, is a real (non-symlink) directory (a regular file only for
 * the leaf of a `file` walk) whose native real path equals itself.
 * Components after the first missing one are reported missing.
 */
export function walkWindowsChain(
  rt: WindowsCustodyRuntime,
  target: string,
  leafType: 'directory' | 'file',
): WalkedWindowsChain {
  assertCanonicalPath(target, 'Local runtime path');
  const components = windowsPathComponents(target);
  const existing: { path: string; identity: string }[] = [];
  for (const [index, component] of components.entries()) {
    const stats = tryLstat(rt, component);
    if (stats === undefined) {
      if (index === 0) {
        throw unsafeFilesystemEntry(
          `Local runtime drive is not available: ${component}`,
        );
      }
      break;
    }
    const isLeaf = index === components.length - 1;
    if (stats.isSymbolicLink()) {
      throw unsafeFilesystemEntry(
        `Local runtime path component must not be a link or reparse point: ${component}`,
      );
    }
    const expectFile = isLeaf && leafType === 'file';
    if (expectFile ? !stats.isFile() : !stats.isDirectory()) {
      throw unsafeFilesystemEntry(
        `Local runtime path component must be a real ${expectFile ? 'file' : 'directory'}: ${component}`,
      );
    }
    if (!sameWindowsCanonicalPath(rt.realpath(component), component)) {
      throw unsafeFilesystemEntry(
        `Local runtime path must not be redirected: ${component}`,
      );
    }
    existing.push({ path: component, identity: identityOf(stats) });
  }
  return {
    target,
    components,
    existing,
    complete: existing.length === components.length,
  };
}

function assertWindowsRecord(
  record: WindowsAclRecord,
  role: WindowsCustodyRole,
  userSid: string,
  label: string,
): void {
  if (
    record.driveType !== DRIVE_TYPE_FIXED ||
    record.driveFormat.toUpperCase() !== 'NTFS'
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime storage must be on a local fixed NTFS volume (found ${record.driveFormat || 'unknown'}, drive type ${record.driveType}): ${label}`,
    );
  }
  if ((record.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    throw unsafeFilesystemEntry(
      `Local runtime path component is a reparse point (junction, mount point or placeholder): ${label}`,
    );
  }
  if (
    role === 'custodied' &&
    (record.attributes &
      (FILE_ATTRIBUTE_OFFLINE |
        FILE_ATTRIBUTE_RECALL_ON_OPEN |
        FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)) !==
      0
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime path is cloud-managed or offline: ${label}`,
    );
  }
  assertWindowsSecurityPolicy(parseSddl(record.sddl), role, userSid, label);
}

export interface WindowsInspectionOptions {
  /** The first custodied directory; everything above is an ancestor. */
  readonly custodyRoot: string;
  /**
   * Components this attempt just created: they are always held to the
   * custodied rule, because their DACL was inherited from a parent we do not
   * control.
   */
  readonly created?: ReadonlySet<string>;
  /** Extra regular files (directly inside the leaf directory), custodied. */
  readonly files?: readonly string[];
}

/**
 * W6 (+ W3 attributes, W5 bracket): one inspector call for the whole chain and
 * any extra files, then the policy for each. The chain's lstat identities are
 * re-read afterwards so a swap during inspection is refused.
 */
export function inspectWindowsChain(
  rt: WindowsCustodyRuntime,
  chain: WalkedWindowsChain,
  options: WindowsInspectionOptions,
): { userSid: string } {
  const files = options.files ?? [];
  const fileIdentities: string[] = [];
  for (const file of files) {
    assertCanonicalPath(file, 'Local runtime file');
    const stats = rt.lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw unsafeFilesystemEntry(
        `Local runtime file must be a real file: ${file}`,
      );
    }
    if (!sameWindowsCanonicalPath(rt.realpath(file), file)) {
      throw unsafeFilesystemEntry(
        `Local runtime path must not be redirected: ${file}`,
      );
    }
    fileIdentities.push(identityOf(stats));
  }
  const paths = [...chain.existing.map((entry) => entry.path), ...files];
  const inspection = rt.inspectAcl(paths);
  if (inspection.records.length !== paths.length) {
    throw unsafeFilesystemEntry(
      'Windows custody inspector returned an unexpected answer.',
    );
  }
  const created = new Set(
    [...(options.created ?? [])].map((path) => foldWindowsCase(path)),
  );
  for (const [index, path] of paths.entries()) {
    const role: WindowsCustodyRole =
      created.has(foldWindowsCase(path)) ||
      isInsideWindowsPath(options.custodyRoot, path)
        ? 'custodied'
        : 'ancestor';
    assertWindowsRecord(
      inspection.records[index] as WindowsAclRecord,
      role,
      inspection.userSid,
      path,
    );
  }
  for (const entry of chain.existing) {
    if (identityOf(rt.lstat(entry.path)) !== entry.identity) {
      throw unsafeFilesystemEntry(
        `Local runtime path changed while its access controls were verified: ${entry.path}`,
      );
    }
  }
  for (const [index, file] of files.entries()) {
    if (identityOf(rt.lstat(file)) !== fileIdentities[index]) {
      throw unsafeFilesystemEntry(
        `Local runtime file changed while its access controls were verified: ${file}`,
      );
    }
  }
  return { userSid: inspection.userSid };
}

/**
 * W5: an opened regular file is the file `lstat` sees (bigint `dev`, `ino`,
 * `birthtimeNs`, kind, before and after the open), has exactly one link, and
 * has the expected size.
 */
export function verifyWindowsFile(
  rt: WindowsCustodyRuntime,
  path: string,
  options: { size?: number } = {},
): void {
  const before = rt.lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeFilesystemEntry(
      `Local runtime file must be a real file: ${path}`,
    );
  }
  const handle = rt.openFile(path, 'read');
  try {
    const opened = handle.stat();
    const after = rt.lstat(path);
    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      identityOf(opened) !== identityOf(before) ||
      identityOf(opened) !== identityOf(after)
    ) {
      throw unsafeFilesystemEntry(
        `Local runtime file changed while it was being opened: ${path}`,
      );
    }
    if (opened.nlink !== 1n) {
      throw unsafeFilesystemEntry(
        `Local runtime file must have exactly one link: ${path}`,
      );
    }
    if (options.size !== undefined && opened.size !== BigInt(options.size)) {
      throw unsafeFilesystemEntry(
        `Local runtime file has an unexpected size: ${path}`,
      );
    }
  } finally {
    handle.close();
  }
}

/** Existing-file check: chain, ACL, and handle identity. One inspector call. */
export function validateExistingWindowsFile(
  rt: WindowsCustodyRuntime,
  path: string,
  options: { custodyRoot: string; size?: number },
): void {
  const chain = walkWindowsChain(rt, path, 'file');
  if (!chain.complete) throw missingEntry(path);
  inspectWindowsChain(rt, chain, { custodyRoot: options.custodyRoot });
  verifyWindowsFile(rt, path, { size: options.size });
}

function removeQuietly(action: () => void): void {
  try {
    action();
  } catch {
    // Rollback is best effort and only ever removes what this attempt created.
  }
}

/**
 * Lock a directory this attempt just created (smrt#4843). The creation and the
 * lock are two steps, so there is a short window in which the directory has
 * the DACL it inherited; nothing is written into it before it is locked, and
 * a directory swapped for a link or another object in that window is refused.
 */
function lockCreatedDirectory(
  rt: WindowsCustodyRuntime,
  path: string,
  userSid: string,
): void {
  const before = rt.lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw unsafeFilesystemEntry(
      `Local runtime directory changed while it was being created: ${path}`,
    );
  }
  try {
    rt.lockDirectory(path, userSid);
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    throw unsafeFilesystemEntry(
      `Could not restrict the new directory to the current user, SYSTEM and Administrators: ${path}`,
      error,
    );
  }
  if (identityOf(rt.lstat(path)) !== identityOf(before)) {
    throw unsafeFilesystemEntry(
      `Local runtime directory changed while it was being locked: ${path}`,
    );
  }
}

export interface PrivateTreeOptions {
  /** The directory that must end up private (also the custody root). */
  readonly directory: string;
  /** An exclusive-create file directly inside `directory`. */
  readonly file?: { readonly path: string; readonly size?: number };
}

/**
 * Create (or verify) a private directory and, optionally, one file in it.
 *
 * Existing components are verified first, before anything is created beneath
 * them. The private directory itself, when this call creates it, is locked
 * immediately (inheritance off, explicit DACL for the current user, SYSTEM and
 * Administrators; smrt#4843). Every component this call creates is then
 * re-inspected under the *custodied* rule; on failure (including a failed
 * lock) exactly the components this call created are removed and the call
 * fails closed. Pre-existing components are never removed, never locked and
 * never re-permissioned: one that fails the rule is refused.
 */
export function preparePrivateWindowsTree(
  rt: WindowsCustodyRuntime,
  options: PrivateTreeOptions,
): { createdDirectories: string[]; createdFile: boolean } {
  const { directory, file } = options;
  if (
    file !== undefined &&
    foldWindowsCase(win32.dirname(file.path)) !== foldWindowsCase(directory)
  ) {
    throw unsafeFilesystemEntry(
      'Local runtime file must sit directly inside its private directory.',
    );
  }
  const target = file?.path ?? directory;
  const leafType = file === undefined ? 'directory' : 'file';
  const chain = walkWindowsChain(rt, target, leafType);
  const { userSid } = inspectWindowsChain(rt, chain, {
    custodyRoot: directory,
  });
  if (chain.complete) {
    if (file !== undefined)
      verifyWindowsFile(rt, file.path, { size: file.size });
    return { createdDirectories: [], createdFile: false };
  }

  const present = new Set(chain.existing.map((entry) => entry.path));
  const createdDirectories: string[] = [];
  let createdFile = false;
  try {
    for (const component of chain.components) {
      if (present.has(component)) continue;
      if (file !== undefined && component === file.path) {
        try {
          rt.openFile(component, 'create').close();
          createdFile = true;
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        continue;
      }
      try {
        rt.mkdir(component);
        createdDirectories.push(component);
      } catch (error) {
        // Planted or concurrently created: it is verified like any other
        // existing component below, and it is not ours to remove.
        if (errorCode(error) !== 'EEXIST') throw error;
        continue;
      }
      // Only the private directory itself is locked (never an ancestor, and
      // never one that already existed), before anything is written in it.
      if (foldWindowsCase(component) === foldWindowsCase(directory)) {
        lockCreatedDirectory(rt, component, userSid);
      }
    }
    const created = new Set(createdDirectories);
    if (createdFile && file !== undefined) created.add(file.path);
    const final = walkWindowsChain(rt, target, leafType);
    if (!final.complete) throw missingEntry(target);
    inspectWindowsChain(rt, final, { custodyRoot: directory, created });
    if (file !== undefined)
      verifyWindowsFile(rt, file.path, { size: file.size });
  } catch (error) {
    if (createdFile && file !== undefined) {
      const path = file.path;
      removeQuietly(() => rt.unlink(path));
    }
    for (const path of createdDirectories.toReversed()) {
      removeQuietly(() => rt.rmdir(path));
    }
    throw error;
  }
  return { createdDirectories, createdFile };
}

/**
 * Case-folded identity of a path for lock keys: the real path of its deepest
 * existing ancestor (true case, no 8.3 or `subst` aliases) plus the rest. Two
 * spellings of one directory therefore share a key.
 */
export function windowsCanonicalIdentity(
  rt: WindowsCustodyRuntime,
  path: string,
): string {
  assertCanonicalPath(path, 'Local runtime path');
  const components = windowsPathComponents(path);
  let deepest = -1;
  for (const [index, component] of components.entries()) {
    if (tryLstat(rt, component) === undefined) break;
    deepest = index;
  }
  if (deepest < 0) return foldWindowsCase(path);
  const real = rt.realpath(components[deepest] as string);
  const remainder = path.slice((components[deepest] as string).length);
  const joined =
    remainder.length === 0
      ? real
      : `${real.replace(/\\$/, '')}\\${remainder.replace(/^\\/, '')}`;
  return foldWindowsCase(joined);
}
