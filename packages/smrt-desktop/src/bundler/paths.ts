import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import {
  type AbsolutePath,
  appendSegments,
  flavorOf,
  formatAbsolutePath,
  isInside,
  parentOf,
  parseAbsolutePath,
  samePath,
  separatorOf,
} from '../internal/abs-path.js';
import {
  O_NOFOLLOW,
  O_NONBLOCK,
  O_RDONLY,
  O_WRONLY_CREATE_EXCL,
} from '../internal/fs-seam.js';
import { asciiLower, isValidText } from '../internal/grammar.js';
import { BundleTreeError, toTreeError } from './tree-errors.js';

/**
 * Containment-safe walking, copying, staging and publishing for the bundler.
 *
 * Rules, in the order they bite:
 * 1. Roots are validated absolute paths. Every source and destination path is
 *    built from validated single segments appended to a root and then
 *    re-checked with a whole-segment containment test (ASCII case-folded on
 *    win32 and darwin hosts), never by string concatenation or prefix match.
 * 2. The walk uses `lstat` only. Symlinks, hardlinks, devices, FIFOs and
 *    sockets are refused unless the caller's explicit policy says otherwise.
 *    A caller filter runs first, so an entry it skips (for example
 *    `node_modules/.bin`) is never inspected further.
 * 3. Traversal is deterministic: names are sorted by UTF-16 code unit order,
 *    depth first, on every operating system.
 * 4. Regular files are opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and the open
 *    descriptor's `fstat` must be the same file the walk saw (device, inode,
 *    size). A swap between walk and open is `entry_changed`. Directories are
 *    re-`lstat`ed after `readdir` and must keep their identity.
 * 5. Destination files are created `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and
 *    destination directories with a non-recursive `mkdir`, so nothing that
 *    already exists is ever written through.
 * 6. Size, count, depth and path-length caps are enforced while walking.
 * 7. A bundle is built in a staging directory this run created and is
 *    published by one `rename`. Cleanup removes only a staging directory
 *    created here, with `lstat`-based removal that never follows a symlink.
 *
 * Errors are value-free `BundleTreeError`s; offending bundle-relative paths
 * travel in `subjects`, never in the message.
 */

// ---------------------------------------------------------------------------
// Filesystem seam
// ---------------------------------------------------------------------------

/** The subset of `fs.Stats` the tree code reads. */
export interface TreeStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number;
  readonly size: number;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly nlink: number;
}

export interface TreeHandle {
  stat(): Promise<TreeStats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesRead: number }>;
  write(
    data: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ readonly bytesWritten: number }>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/** Injectable filesystem for the bundler. Defaults to `node:fs/promises`. */
export interface TreeFs {
  lstat(path: string): Promise<TreeStats>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: number, mode?: number): Promise<TreeHandle>;
  /** Non-recursive; fails with `EEXIST` when the path exists. */
  mkdir(path: string, mode: number): Promise<void>;
  /** Creates `<prefix><random>` as a 0700 directory and returns its path. */
  mkdtemp(prefix: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  /**
   * Set access and modification time. Optional so a minimal fake need not
   * provide it; the orchestrator skips the step when absent.
   */
  utimes?(path: string, time: Date): Promise<void>;
}

type NodeStats = Awaited<ReturnType<typeof fsp.lstat>>;

function wrapStats(stats: NodeStats): TreeStats {
  const s = stats as unknown as {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode: bigint;
    size: bigint;
    dev: bigint;
    ino: bigint;
    nlink: bigint;
  };
  return {
    isFile: () => s.isFile(),
    isDirectory: () => s.isDirectory(),
    isSymbolicLink: () => s.isSymbolicLink(),
    mode: Number(s.mode),
    size: Number(s.size),
    dev: s.dev,
    ino: s.ino,
    nlink: Number(s.nlink),
  };
}

/** The default tree filesystem, backed by `node:fs/promises`. */
export const nodeTreeFs: TreeFs = {
  async lstat(path) {
    return wrapStats(await fsp.lstat(path, { bigint: true }));
  },
  readdir: (path) => fsp.readdir(path),
  async open(path, flags, mode) {
    const handle = await fsp.open(path, flags, mode);
    return {
      async stat() {
        return wrapStats(await handle.stat({ bigint: true }));
      },
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      write: (data, offset, length) => handle.write(data, offset, length),
      chmod: (mode) => handle.chmod(mode),
      close: () => handle.close(),
    };
  },
  mkdir: async (path, mode) => {
    await fsp.mkdir(path, { mode });
  },
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  rmdir: (path) => fsp.rmdir(path),
  realpath: (path) => fsp.realpath(path),
  utimes: (path, time) => fsp.utimes(path, time, time),
};

// ---------------------------------------------------------------------------
// Lexical containment
// ---------------------------------------------------------------------------

/** Hosts whose default filesystems fold case; containment folds there. */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function parseRoot(root: string, platform: NodeJS.Platform): AbsolutePath {
  const parsed = parseAbsolutePath(root, flavorOf(platform));
  if (parsed === null) {
    throw new BundleTreeError('invalid_option', { field: 'root' });
  }
  return parsed;
}

/**
 * Case-folded view used for containment on hosts whose filesystems fold case
 * (macOS, Windows). On Windows `isInside` already folds; this adds darwin.
 */
function containmentView(
  path: AbsolutePath,
  platform: NodeJS.Platform,
): AbsolutePath {
  if (!foldsCase(platform) || path.flavor === 'win32') return path;
  return {
    ...path,
    root: asciiLower(path.root),
    segments: path.segments.map(asciiLower),
  };
}

/** True when `candidate` is inside `root` (or equal, when `allowEqual`). */
export function isContained(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  allowEqual = false,
): boolean {
  const flavor = flavorOf(platform);
  const a = parseAbsolutePath(root, flavor);
  const b = parseAbsolutePath(candidate, flavor);
  if (a === null || b === null) return false;
  return isInside(
    containmentView(a, platform),
    containmentView(b, platform),
    allowEqual,
  );
}

function isStructuralSegment(segment: unknown): segment is string {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    isValidText(segment)
  );
}

/**
 * Append single validated `segments` to `root` and prove the result stays
 * inside it. Throws `path_escape` otherwise.
 */
export function resolveInside(
  root: string,
  segments: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const parsedRoot = parseRoot(root, platform);
  if (!segments.every(isStructuralSegment)) {
    throw new BundleTreeError('path_escape');
  }
  const child = appendSegments(parsedRoot, segments);
  if (
    !isInside(
      containmentView(parsedRoot, platform),
      containmentView(child, platform),
      true,
    )
  ) {
    throw new BundleTreeError('path_escape');
  }
  return formatAbsolutePath(child);
}

/**
 * Prove that `inner` really resolves inside `outer` (after `realpath` on
 * both), for example the build directory inside the application. Throws
 * `path_escape` otherwise.
 */
export async function assertRealContained(
  outer: string,
  inner: string,
  options: {
    readonly fs?: TreeFs;
    readonly platform?: NodeJS.Platform;
    readonly allowEqual?: boolean;
  } = {},
): Promise<void> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  let realOuter: string;
  let realInner: string;
  try {
    realOuter = await fs.realpath(outer);
    realInner = await fs.realpath(inner);
  } catch (error) {
    throw toTreeError(error);
  }
  if (!isContained(realOuter, realInner, platform, options.allowEqual)) {
    throw new BundleTreeError('path_escape');
  }
}

/** Parent directory of an absolute path, or `null` for a root. */
export function parentPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const parsed = parseAbsolutePath(path, flavorOf(platform));
  const parent = parsed === null ? null : parentOf(parsed);
  return parent === null ? null : formatAbsolutePath(parent);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const windowsIllegalName = /[\p{Cc}<>:"|?*\\/]/u;
const windowsDeviceName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/**
 * A file or directory name that can be placed in a bundle that may be
 * installed on any supported OS: valid text, at most 255 UTF-8 bytes, not
 * `.`/`..`, none of the Windows-illegal characters, no trailing dot or space
 * and no reserved device name. Broader than `isPortableSegment`, which
 * rejects legitimate package file names such as `@types`, `+esm.js` or
 * `a b.txt`.
 */
export function isSafeName(name: unknown): name is string {
  return (
    isValidText(name) &&
    name.length > 0 &&
    Buffer.byteLength(name, 'utf8') <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !windowsIllegalName.test(name) &&
    !name.endsWith('.') &&
    !name.endsWith(' ') &&
    !windowsDeviceName.test(name)
  );
}

function collisionKey(name: string): string {
  return asciiLower(name.normalize('NFC'));
}

/** UTF-16 code unit order: the same on every OS and locale. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

export type EntryKind = 'file' | 'dir' | 'symlink' | 'special';

export interface TreeEntry {
  /** Forward-slash path relative to the walk root. */
  readonly rel: string;
  readonly kind: 'file' | 'dir';
  readonly size: number;
  /** Permission bits only (`mode & 0o7777`). */
  readonly mode: number;
  readonly nlink: number;
  /** `<dev>:<ino>` as seen by the walk. */
  readonly identity: string;
}

/** What a caller filter sees before any policy or limit is applied. */
export interface FilterEntry {
  readonly rel: string;
  readonly name: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly depth: number;
}

/** `skip` leaves the entry (and, for a directory, its subtree) untouched. */
export type FilterDecision = 'keep' | 'skip';

export interface TreePolicy {
  /** Default `refuse`. `skip` omits the link without following it. */
  readonly symlinks?: 'refuse' | 'skip';
  /** Default `refuse`: a regular file with `nlink > 1`. */
  readonly hardlinks?: 'refuse' | 'allow';
  /** Default `refuse`: devices, FIFOs and sockets. */
  readonly special?: 'refuse' | 'skip';
}

export interface TreeLimits {
  readonly maxFiles: number;
  readonly maxDirectories: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
  readonly maxRelPathLength: number;
}

export const DEFAULT_TREE_LIMITS: TreeLimits = Object.freeze({
  maxFiles: 150_000,
  maxDirectories: 50_000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxDepth: 64,
  maxRelPathLength: 512,
});

export type SkipReason = 'filter' | 'symlink' | 'special';

export interface SkippedEntry {
  readonly rel: string;
  readonly kind: EntryKind;
  readonly reason: SkipReason;
  /** File size; for a skipped directory the total of its files when accounted. */
  readonly bytes: number;
  /** Number of files the skip covers (1 for a file, N for an accounted dir). */
  readonly files: number;
}

export interface WalkOptions {
  /** Absolute root. Must itself be a real directory, not a symlink. */
  readonly root: string;
  readonly fs?: TreeFs;
  /** Selects path flavor and case folding. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  readonly policy?: TreePolicy;
  readonly limits?: Partial<TreeLimits>;
  /** Runs first for every entry; may throw to reject the whole tree. */
  readonly filter?: (entry: FilterEntry) => FilterDecision;
  readonly onSkip?: (entry: SkippedEntry) => void;
  /** Count the files and bytes under skipped directories (lstat only). */
  readonly accountSkipped?: boolean;
  /** Omit directories that end up with no file beneath them. */
  readonly dropEmptyDirectories?: boolean;
  /**
   * Require `root` to equal its own `realpath` (no symlinked ancestors).
   * Default true; pass a canonicalised root.
   */
  readonly canonicalRoot?: boolean;
}

export interface SkipSummary {
  readonly entries: number;
  readonly files: number;
  readonly bytes: number;
}

export interface WalkResult {
  /** Pre-order, sorted. Directories precede their contents. */
  readonly entries: readonly TreeEntry[];
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
  readonly skipped: SkipSummary;
}

function identityOf(stats: TreeStats): string {
  return `${stats.dev}:${stats.ino}`;
}

function classify(stats: TreeStats): EntryKind {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'dir';
  if (stats.isFile()) return 'file';
  return 'special';
}

function limitsOf(partial: Partial<TreeLimits> | undefined): TreeLimits {
  return { ...DEFAULT_TREE_LIMITS, ...partial };
}

async function lstatChecked(fs: TreeFs, path: string): Promise<TreeStats> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    throw toTreeError(error);
  }
}

/** Resolve a root: a real directory, optionally equal to its realpath. */
async function checkRoot(
  fs: TreeFs,
  root: string,
  canonical: boolean,
  platform: NodeJS.Platform,
): Promise<TreeStats> {
  parseRoot(root, platform);
  const stats = await lstatChecked(fs, root);
  if (stats.isSymbolicLink()) throw new BundleTreeError('symlink_refused');
  if (!stats.isDirectory()) throw new BundleTreeError('invalid_option');
  if (canonical) {
    let real: string;
    try {
      real = await fs.realpath(root);
    } catch (error) {
      throw toTreeError(error);
    }
    // A mismatch means a symlinked ancestor (or a non-canonical spelling).
    if (real !== root) throw new BundleTreeError('symlink_refused');
  }
  return stats;
}

async function measureSubtree(
  fs: TreeFs,
  path: string,
  platform: NodeJS.Platform,
  budget: { remaining: number },
): Promise<{ files: number; bytes: number }> {
  const total = { files: 0, bytes: 0 };
  if (budget.remaining-- <= 0) return total;
  let stats: TreeStats;
  try {
    stats = await fs.lstat(path);
  } catch {
    return total;
  }
  if (stats.isDirectory()) {
    let names: string[];
    try {
      names = await fs.readdir(path);
    } catch {
      return total;
    }
    for (const name of names) {
      if (!isStructuralSegment(name)) continue;
      const child = `${path}${separatorOf(flavorOf(platform))}${name}`;
      const sub = await measureSubtree(fs, child, platform, budget);
      total.files += sub.files;
      total.bytes += sub.bytes;
    }
    return total;
  }
  total.files = 1;
  total.bytes = stats.isFile() ? stats.size : 0;
  return total;
}

/**
 * Walk `root` and return the sorted list of entries that would be copied.
 * Nothing is read except directory listings and `lstat` results.
 */
export async function walkTree(options: WalkOptions): Promise<WalkResult> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  const limits = limitsOf(options.limits);
  const policy = {
    symlinks: options.policy?.symlinks ?? 'refuse',
    hardlinks: options.policy?.hardlinks ?? 'refuse',
    special: options.policy?.special ?? 'refuse',
  };
  const rootStats = await checkRoot(
    fs,
    options.root,
    options.canonicalRoot ?? true,
    platform,
  );

  const entries: TreeEntry[] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const skipped = { entries: 0, files: 0, bytes: 0 };
  const accountBudget = { remaining: 1_000_000 };

  async function recordSkip(
    rel: string,
    segments: readonly string[],
    kind: EntryKind,
    reason: SkipReason,
    size: number,
  ): Promise<void> {
    let skippedFiles = kind === 'dir' ? 0 : 1;
    let skippedBytes = kind === 'file' ? size : 0;
    if (kind === 'dir' && options.accountSkipped === true) {
      const measured = await measureSubtree(
        fs,
        resolveInside(options.root, segments, platform),
        platform,
        accountBudget,
      );
      skippedFiles = measured.files;
      skippedBytes = measured.bytes;
    }
    skipped.entries += 1;
    skipped.files += skippedFiles;
    skipped.bytes += skippedBytes;
    options.onSkip?.({
      rel,
      kind,
      reason,
      bytes: skippedBytes,
      files: skippedFiles,
    });
  }

  async function visit(
    segments: readonly string[],
    directoryIdentity: string,
  ): Promise<void> {
    const dirPath = resolveInside(options.root, segments, platform);
    let names: string[];
    try {
      names = await fs.readdir(dirPath);
    } catch (error) {
      throw toTreeError(error);
    }
    const after = await lstatChecked(fs, dirPath);
    if (!after.isDirectory() || identityOf(after) !== directoryIdentity) {
      throw new BundleTreeError('entry_changed', {
        subjects: [segments.join('/')],
      });
    }
    names.sort(compareNames);

    const seen = new Map<string, string>();
    for (const name of names) {
      if (!isStructuralSegment(name)) throw new BundleTreeError('path_escape');
      const childSegments = [...segments, name];
      const rel = childSegments.join('/');
      const stats = await lstatChecked(
        fs,
        resolveInside(options.root, childSegments, platform),
      );
      const kind = classify(stats);

      const decision = options.filter?.({
        rel,
        name,
        kind,
        size: kind === 'file' ? stats.size : 0,
        depth: childSegments.length,
      });
      if (decision === 'skip') {
        await recordSkip(rel, childSegments, kind, 'filter', stats.size);
        continue;
      }
      if (kind === 'symlink') {
        if (policy.symlinks === 'refuse') {
          throw new BundleTreeError('symlink_refused', { subjects: [rel] });
        }
        await recordSkip(rel, childSegments, kind, 'symlink', 0);
        continue;
      }
      if (kind === 'special') {
        if (policy.special === 'refuse') {
          throw new BundleTreeError('special_file', { subjects: [rel] });
        }
        await recordSkip(rel, childSegments, kind, 'special', 0);
        continue;
      }

      if (!isSafeName(name)) {
        throw new BundleTreeError('invalid_name', { subjects: [rel] });
      }
      const key = collisionKey(name);
      if (seen.has(key)) {
        throw new BundleTreeError('name_collision', { subjects: [rel] });
      }
      seen.set(key, name);
      if (childSegments.length > limits.maxDepth) {
        throw new BundleTreeError('tree_too_deep', { subjects: [rel] });
      }
      if (rel.length > limits.maxRelPathLength) {
        throw new BundleTreeError('path_too_long', { subjects: [rel] });
      }

      const entryBase = {
        rel,
        size: kind === 'file' ? stats.size : 0,
        mode: stats.mode & 0o7777,
        nlink: stats.nlink,
        identity: identityOf(stats),
      };
      if (kind === 'file') {
        if (stats.size > limits.maxFileBytes) {
          throw new BundleTreeError('file_too_large', { subjects: [rel] });
        }
        if (stats.nlink > 1 && policy.hardlinks === 'refuse') {
          throw new BundleTreeError('hardlink_refused', { subjects: [rel] });
        }
        files += 1;
        bytes += stats.size;
        if (files > limits.maxFiles)
          throw new BundleTreeError('too_many_files');
        if (bytes > limits.maxTotalBytes) {
          throw new BundleTreeError('tree_too_large');
        }
        entries.push({ ...entryBase, kind: 'file' });
      } else {
        directories += 1;
        if (directories > limits.maxDirectories) {
          throw new BundleTreeError('too_many_files');
        }
        entries.push({ ...entryBase, kind: 'dir' });
        await visit(childSegments, identityOf(stats));
      }
    }
  }

  await visit([], identityOf(rootStats));

  let result = entries;
  if (options.dropEmptyDirectories === true) {
    const populated = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      const parts = entry.rel.split('/');
      for (let n = 1; n < parts.length; n++) {
        populated.add(parts.slice(0, n).join('/'));
      }
    }
    result = entries.filter(
      (entry) => entry.kind === 'file' || populated.has(entry.rel),
    );
  }
  return {
    entries: result,
    files,
    directories: result.filter((entry) => entry.kind === 'dir').length,
    bytes,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/** Receives the bytes of a file as it is copied; `finish` may throw. */
export interface ContentInspector {
  push(chunk: Uint8Array): void;
  finish(): void;
}

export interface CopiedFile {
  readonly rel: string;
  readonly size: number;
  readonly sha256: string;
  /** Final permission bits applied to the copy. */
  readonly mode: number;
}

export interface CopyOptions extends WalkOptions {
  /** Absolute destination root. Must already exist unless `createRoot`. */
  readonly destRoot: string;
  /** Create `destRoot` itself (its parent must exist). */
  readonly createRoot?: boolean;
  /** Mode for a copied file. Default: 0755 if any exec bit, else 0644. */
  readonly fileMode?: (entry: TreeEntry) => number;
  /** Return an inspector to watch the bytes of `entry`, or nothing. */
  readonly inspect?: (entry: TreeEntry) => ContentInspector | undefined;
}

export interface CopyResult extends WalkResult {
  /** Files in copy order with their SHA-256 and final mode. */
  readonly copied: readonly CopiedFile[];
}

const CHUNK_BYTES = 64 * 1024;

function defaultFileMode(entry: TreeEntry): number {
  return (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
}

async function copyOne(
  fs: TreeFs,
  sourcePath: string,
  destPath: string,
  entry: TreeEntry,
  mode: number,
  inspector: ContentInspector | undefined,
  platform: NodeJS.Platform,
  hardlinks: 'refuse' | 'allow',
): Promise<CopiedFile> {
  let source: TreeHandle | undefined;
  let dest: TreeHandle | undefined;
  try {
    source = await fs.open(sourcePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stats = await source.stat();
    if (
      !stats.isFile() ||
      identityOf(stats) !== entry.identity ||
      stats.size !== entry.size
    ) {
      throw new BundleTreeError('entry_changed', { subjects: [entry.rel] });
    }
    if (stats.nlink > 1 && hardlinks === 'refuse') {
      throw new BundleTreeError('hardlink_refused', { subjects: [entry.rel] });
    }

    dest = await fs.open(destPath, O_WRONLY_CREATE_EXCL, mode);
    const hash = createHash('sha256');
    const buffer = new Uint8Array(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > entry.size) {
        throw new BundleTreeError('entry_changed', { subjects: [entry.rel] });
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      inspector?.push(chunk);
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await dest.write(
          chunk,
          offset,
          bytesRead - offset,
        );
        offset += bytesWritten;
      }
    }
    if (total !== entry.size) {
      throw new BundleTreeError('entry_changed', { subjects: [entry.rel] });
    }
    inspector?.finish();
    try {
      // `open` applies the umask; fchmod makes the mode exact.
      await dest.chmod(mode);
    } catch (error) {
      if (platform !== 'win32') throw error;
    }
    return { rel: entry.rel, size: total, sha256: hash.digest('hex'), mode };
  } catch (error) {
    throw toTreeError(error);
  } finally {
    await dest?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}

/**
 * Copy the filtered `root` tree into `destRoot`. Every destination is
 * created exclusively, so a pre-existing entry (or one planted by a racing
 * process) fails the copy instead of being written through.
 */
export async function copyTree(options: CopyOptions): Promise<CopyResult> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  const sourceRoot = options.root;

  // Source and destination must be disjoint, else the walk could feed on
  // its own output.
  if (
    isContained(sourceRoot, options.destRoot, platform, true) ||
    isContained(options.destRoot, sourceRoot, platform, true)
  ) {
    throw new BundleTreeError('path_escape');
  }

  const walk = await walkTree(options);

  if (options.createRoot === true) {
    try {
      await fs.mkdir(options.destRoot, 0o755);
    } catch (error) {
      throw toTreeError(error);
    }
  }
  const destStats = await lstatChecked(fs, options.destRoot);
  if (destStats.isSymbolicLink() || !destStats.isDirectory()) {
    throw new BundleTreeError('symlink_refused');
  }

  const hardlinks = options.policy?.hardlinks ?? 'refuse';
  const copied: CopiedFile[] = [];
  for (const entry of walk.entries) {
    const segments = entry.rel.split('/');
    const sourcePath = resolveInside(sourceRoot, segments, platform);
    const destPath = resolveInside(options.destRoot, segments, platform);
    if (entry.kind === 'dir') {
      try {
        await fs.mkdir(destPath, 0o755);
      } catch (error) {
        throw toTreeError(error);
      }
      continue;
    }
    const mode = (options.fileMode ?? defaultFileMode)(entry);
    copied.push(
      await copyOne(
        fs,
        sourcePath,
        destPath,
        entry,
        mode,
        options.inspect?.(entry),
        platform,
        hardlinks,
      ),
    );
  }
  return { ...walk, copied };
}

/**
 * Create nested directories `segments` under the existing directory `base`,
 * one non-recursive `mkdir` each. An existing component must be a real
 * directory (not a symlink). Returns the path of the last directory.
 */
export async function ensureDirectories(
  base: string,
  segments: readonly string[],
  options: { fs?: TreeFs; platform?: NodeJS.Platform } = {},
): Promise<string> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  let current = resolveInside(base, [], platform);
  for (const segment of segments) {
    if (!isSafeName(segment)) throw new BundleTreeError('invalid_name');
    current = resolveInside(current, [segment], platform);
    try {
      await fs.mkdir(current, 0o755);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'EEXIST') {
        throw toTreeError(error);
      }
      const stats = await lstatChecked(fs, current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new BundleTreeError('symlink_refused');
      }
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Reading single files
// ---------------------------------------------------------------------------

/**
 * Read one regular file (`O_NOFOLLOW`, `fstat` on the open descriptor) of at
 * most `maxBytes`. A symlink, directory or special file is refused.
 */
export async function readRegularFile(
  path: string,
  maxBytes: number,
  options: { fs?: TreeFs } = {},
): Promise<Uint8Array> {
  const fs = options.fs ?? nodeTreeFs;
  let handle: TreeHandle | undefined;
  try {
    handle = await fs.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new BundleTreeError('special_file');
    if (stats.size > maxBytes) throw new BundleTreeError('file_too_large');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const buffer = new Uint8Array(
        Math.min(CHUNK_BYTES, maxBytes + 1 - total),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new BundleTreeError('file_too_large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    throw toTreeError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Create a new file with exactly `mode` and write `data` to it. The create is
 * `O_EXCL|O_NOFOLLOW`, so an existing entry (or a planted symlink) fails the
 * write instead of being written through.
 */
export async function writeNewFile(
  path: string,
  data: Uint8Array | string,
  mode: number,
  options: { fs?: TreeFs; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let handle: TreeHandle | undefined;
  try {
    handle = await fs.open(path, O_WRONLY_CREATE_EXCL, mode);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
      );
      offset += bytesWritten;
    }
    try {
      await handle.chmod(mode);
    } catch (error) {
      if (platform !== 'win32') throw error;
    }
  } catch (error) {
    throw toTreeError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Like `readRegularFile` but decoded as strict UTF-8 (BOM removed). */
export async function readRegularText(
  path: string,
  maxBytes: number,
  options: { fs?: TreeFs } = {},
): Promise<string> {
  const bytes = await readRegularFile(path, maxBytes, options);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw new BundleTreeError('io_failed');
  }
}

/** SHA-256 of a regular file read with the same custody rules. */
export async function hashRegularFile(
  path: string,
  maxBytes: number,
  options: { fs?: TreeFs } = {},
): Promise<string> {
  const bytes = await readRegularFile(path, maxBytes, options);
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Staging and publish
// ---------------------------------------------------------------------------

/** A directory this run created and is allowed to remove. */
export interface Staging {
  readonly path: string;
  readonly parent: string;
}

const owned = new WeakSet<object>();
const STAGING_PREFIX = '.smrt-desktop-bundle-';

function assertOwned(staging: Staging): void {
  if (!owned.has(staging)) throw new BundleTreeError('publish_failed');
}

/**
 * Create a 0700 staging directory inside `parent` (which must be a real,
 * canonical directory). Staging lives next to the final output so the
 * publish `rename` stays on one filesystem.
 */
export async function createStaging(
  parent: string,
  options: { fs?: TreeFs; platform?: NodeJS.Platform } = {},
): Promise<Staging> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  await checkRoot(fs, parent, true, platform);
  const prefix = `${resolveInside(parent, [], platform)}${separatorOf(
    flavorOf(platform),
  )}${STAGING_PREFIX}`;
  let path: string;
  try {
    path = await fs.mkdtemp(prefix);
  } catch (error) {
    throw toTreeError(error);
  }
  if (!isContained(parent, path, platform)) {
    throw new BundleTreeError('path_escape');
  }
  const staging: Staging = Object.freeze({ path, parent });
  owned.add(staging);
  return staging;
}

async function removeTreeNoFollow(
  fs: TreeFs,
  path: string,
  platform: NodeJS.Platform,
  depth: number,
): Promise<void> {
  if (depth > 256) throw new BundleTreeError('tree_too_deep');
  const stats = await fs.lstat(path);
  if (!stats.isDirectory()) {
    await fs.unlink(path);
    return;
  }
  for (const name of await fs.readdir(path)) {
    if (!isStructuralSegment(name)) throw new BundleTreeError('path_escape');
    await removeTreeNoFollow(
      fs,
      `${path}${separatorOf(flavorOf(platform))}${name}`,
      platform,
      depth + 1,
    );
  }
  await fs.rmdir(path);
}

/**
 * Remove a staging directory created by `createStaging` in this process.
 * It refuses any other path, never follows symlinks and ignores a staging
 * directory that is already gone (published or disposed).
 */
export async function disposeStaging(
  staging: Staging,
  options: { fs?: TreeFs; platform?: NodeJS.Platform } = {},
): Promise<void> {
  assertOwned(staging);
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  try {
    await removeTreeNoFollow(fs, staging.path, platform, 0);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return;
    throw toTreeError(error);
  }
}

export interface PublishOptions {
  readonly fs?: TreeFs;
  readonly platform?: NodeJS.Platform;
  /**
   * Publish this single-segment subdirectory of staging instead of staging
   * itself (the rest of staging is then disposed).
   */
  readonly source?: string;
  /**
   * `empty-only` (default): an existing output must be an empty real
   * directory. `replace`: the previous output is renamed aside, the new one
   * renamed in, and the old one removed afterwards.
   */
  readonly existing?: 'empty-only' | 'replace';
  /** Test seam for the aside-name suffix. */
  readonly randomSuffix?: () => string;
}

/**
 * Publish the staged bundle at `finalPath` with a single `rename`. The final
 * path must be a direct child of the staging directory's parent.
 */
export async function publishStaging(
  staging: Staging,
  finalPath: string,
  options: PublishOptions = {},
): Promise<void> {
  assertOwned(staging);
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  const flavor = flavorOf(platform);

  const final = parseAbsolutePath(finalPath, flavor);
  const parent = parseAbsolutePath(staging.parent, flavor);
  const finalParent = final === null ? null : parentOf(final);
  if (
    final === null ||
    parent === null ||
    finalParent === null ||
    !samePath(
      containmentView(finalParent, platform),
      containmentView(parent, platform),
    )
  ) {
    throw new BundleTreeError('publish_failed');
  }
  const finalName = final.segments[final.segments.length - 1];
  if (finalName === undefined || !isSafeName(finalName)) {
    throw new BundleTreeError('publish_failed');
  }
  if (options.source !== undefined && !isSafeName(options.source)) {
    throw new BundleTreeError('publish_failed');
  }
  const sourcePath =
    options.source === undefined
      ? staging.path
      : resolveInside(staging.path, [options.source], platform);

  let existing: TreeStats | undefined;
  try {
    existing = await fs.lstat(finalPath);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT') throw toTreeError(error);
  }

  let aside: string | undefined;
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new BundleTreeError('destination_exists');
    }
    if (options.existing === 'replace') {
      const suffix = (
        options.randomSuffix ?? (() => randomBytes(6).toString('hex'))
      )();
      aside = resolveInside(
        staging.parent,
        [`${finalName}.old-${suffix}`],
        platform,
      );
      try {
        await fs.rename(finalPath, aside);
      } catch (error) {
        throw toTreeError(error);
      }
    } else {
      let names: string[];
      try {
        names = await fs.readdir(finalPath);
      } catch (error) {
        throw toTreeError(error);
      }
      if (names.length > 0) throw new BundleTreeError('out_dir_not_empty');
      try {
        await fs.rmdir(finalPath);
      } catch {
        // Something appeared between the listing and the removal.
        throw new BundleTreeError('out_dir_not_empty');
      }
    }
  }

  try {
    await fs.rename(sourcePath, finalPath);
  } catch {
    if (aside !== undefined) {
      await fs.rename(aside, finalPath).catch(() => undefined);
    }
    throw new BundleTreeError('publish_failed');
  }

  if (aside !== undefined) {
    // The previous bundle was explicitly replaced; failing to remove it must
    // not fail an already published bundle.
    await removeTreeNoFollow(fs, aside, platform, 0).catch(() => undefined);
  }
  if (options.source !== undefined) {
    await disposeStaging(staging, { fs, platform }).catch(() => undefined);
  }
}

/**
 * Run `build` against a fresh staging directory next to `finalPath`, then
 * publish it. On any failure staging is removed and the error is rethrown;
 * `finalPath` is untouched until the final rename.
 */
export async function withStagedPublish<T>(
  finalPath: string,
  build: (staging: Staging) => Promise<T>,
  options: PublishOptions & { keepStaging?: boolean } = {},
): Promise<T> {
  const platform = options.platform ?? process.platform;
  const parent = parentPath(finalPath, platform);
  if (parent === null) throw new BundleTreeError('publish_failed');
  const fsOption = options.fs === undefined ? {} : { fs: options.fs };
  const staging = await createStaging(parent, { ...fsOption, platform });
  try {
    const result = await build(staging);
    await publishStaging(staging, finalPath, options);
    return result;
  } catch (error) {
    if (options.keepStaging !== true) {
      await disposeStaging(staging, { ...fsOption, platform }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}
