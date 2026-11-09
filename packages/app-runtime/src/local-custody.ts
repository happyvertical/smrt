/**
 * Filesystem custody for the local runtime profile.
 *
 * Everything that decides whether a path may hold the private local
 * application state lives here: the read-only preflight, the data-root and
 * lease-directory construction, the initialization lease, the marker and
 * secret checks, and the no-follow open helpers. `index.ts` composes these
 * into the public entry points; it does not reimplement any of them.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { platform } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import {
  type DatabaseInterface,
  getDatabase,
  type SecureSqliteWindowsCustody,
} from '@happyvertical/sql';
import { custodyContext } from './custody-context.js';
import type {
  LocalRuntimePaths,
  ResolveLocalRuntimePathsOptions,
} from './index.js';
import {
  describeInstallationStateRoot,
  enforceInstallationCustody,
  INSTALLATION_CUSTODY_FILE,
  type InstallationCustodyReport,
  type InstallationStateRootNote,
  installationCustodyHint,
  stateRootOptions,
} from './installation-custody.js';
import {
  deriveLocalInstallationIdentity,
  type LocalInstallationIdentity,
} from './local-installation-identity.js';
import {
  LocalRuntimeError,
  unsafeFilesystemEntry,
} from './local-runtime-error.js';
import {
  applicationStateRootSource,
  prepareApplicationStateRoot,
} from './state-root.js';

/** The owner-bootstrap table; its presence proves the runtime initialized. */
export const BOOTSTRAP_TABLE = '_smrt_local_owner_bootstrap';

import { lookupWindowsEnvironment } from './windows-acl-inspector.js';
import {
  createWindowsDatabaseVerifier,
  inspectWindowsChain,
  missingEntry,
  preparePrivateWindowsTree,
  verifyWindowsFile,
  type WindowsCustodyRuntime,
  walkWindowsChain,
  windowsCanonicalIdentity,
} from './windows-custody.js';
import {
  foldWindowsCase,
  isInsideWindowsPath,
  validateWindowsApplicationId,
  validateWindowsPath,
  WINDOWS_DERIVED_PATH_RESERVE,
} from './windows-paths.js';

export const SECRET_FILE_NAME = 'application.secret';
export const DATABASE_FILE_NAME = 'application.sqlite';
const ROOT_MARKER_PREFIX = '.smrt-local-runtime-';
const LEASE_DIRECTORY_PREFIX = '.smrt-lease-';
const UID_MAP_PATH = '/proc/self/uid_map';
const PREFLIGHT_RETRY_LIMIT = 4;
const INITIALIZATION_LOCK_TIMEOUT_MS = 120_000;
const INITIALIZATION_LOCK_WORKER = `
  const { parentPort, workerData } = require('node:worker_threads');
  let database;
  let transaction;
  (async () => {
    try {
      if (workerData.lockOnly) {
        // Legacy /tmp lease probe (#3877): the same BEGIN IMMEDIATE lock an
        // older release's secure acquisition takes, on a pre-validated,
        // already-existing, never-written lock file.
        const { DatabaseSync } = require('node:sqlite');
        const lockDatabase = new DatabaseSync(workerData.path, {
          timeout: workerData.timeout,
        });
        database = { close: async () => lockDatabase.close() };
        lockDatabase.exec('BEGIN IMMEDIATE');
        transaction = { rollback: async () => lockDatabase.exec('ROLLBACK') };
        parentPort.postMessage({ type: 'acquired' });
      } else {
      const { getDatabase } = await import(workerData.sqlModuleUrl);
      database = await getDatabase({
        type: 'sqlite',
        url: workerData.path,
        secureFile: {
          driver: 'node:sqlite',
          custody: 'trusted-parent',
          root: workerData.custodyRoot,
        },
        transactionQueueTimeout: workerData.timeout,
      });
      if (!database.beginTransaction) {
        throw new Error('Secure SQLite does not expose beginTransaction().');
      }
      await database.query('PRAGMA busy_timeout = ' + workerData.timeout);
      transaction = await database.beginTransaction();
      parentPort.postMessage({ type: 'acquired' });
      }
    } catch (error) {
      try { await database?.close?.(); } catch {}
      parentPort.postMessage({ type: 'error', message: String(error) });
      parentPort.close();
      return;
    }
    parentPort.once('message', async (message) => {
      if (message?.type !== 'release') return;
      let releaseError;
      try { await transaction.rollback(); } catch (error) { releaseError = String(error); }
      try { await database.close?.(); } catch (error) { releaseError ??= String(error); }
      parentPort.postMessage({ type: 'released', error: releaseError });
      parentPort.close();
    });
  })().catch((error) => {
    parentPort.postMessage({ type: 'error', message: String(error) });
    parentPort.close();
  });
`;
const execFileAsync = promisify(execFile);

interface PreparedLocalRoot {
  createdDirectories: string[];
  pendingMarker: string | null;
  pendingMarkerCreatedByAttempt: boolean;
  finalMarker: string;
}

interface LocalInitializationLock {
  release(): Promise<void>;
}

export async function preflightLocalApplicationRoot(
  root: string,
  sourceRoot: string,
  appId: string,
): Promise<void> {
  for (let attempt = 0; attempt < PREFLIGHT_RETRY_LIMIT; attempt += 1) {
    try {
      await preflightLocalApplicationRootOnce(root, sourceRoot, appId);
      return;
    } catch (error) {
      if (!isMissingFile(error) && !hasMissingFileCause(error)) throw error;
      if (attempt === PREFLIGHT_RETRY_LIMIT - 1) {
        throw unsafeFilesystemEntry(
          'Local application data changed repeatedly during read-only preflight.',
          error,
        );
      }
      await new Promise<void>((resolveRetry) => setImmediate(resolveRetry));
    }
  }
}

async function preflightLocalApplicationRootOnce(
  root: string,
  sourceRoot: string,
  appId: string,
): Promise<void> {
  if (isWindowsCustody()) {
    preflightWindowsRoot(root, sourceRoot, appId);
    return;
  }
  requireNoFollowSupport();
  const canonicalSourceRoot = await realpath(sourceRoot);
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw unsafeFilesystemEntry(
      'Local runtime storage requires a numeric current-user identity.',
    );
  }
  if (
    isInside(canonicalSourceRoot, root) ||
    isInside(root, canonicalSourceRoot)
  ) {
    throw unsafeFilesystemEntry(
      'Local application data must remain outside the canonical source tree.',
    );
  }

  let rootExists = true;
  for (const component of absolutePathComponents(root)) {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(component);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      rootExists = false;
      break;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw unsafeFilesystemEntry(
        `Local runtime path component must be a real directory: ${component}`,
      );
    }
    await assertCanonicalEntry(component, canonicalSourceRoot);
    const sharedStickyRoot = details.uid === 0 && (details.mode & 0o1000) !== 0;
    if (
      (details.uid !== currentUid && details.uid !== 0) ||
      ((details.mode & 0o022) !== 0 && !sharedStickyRoot)
    ) {
      throw unsafeFilesystemEntry(
        `Local runtime path ancestry does not have trusted-parent custody: ${component}`,
      );
    }
    await assertNoPermissiveDarwinAcl(component);
  }

  if (!rootExists) return;
  const rootDetails = await lstat(root);
  if (rootDetails.uid !== currentUid || (rootDetails.mode & 0o777) !== 0o700) {
    throw unsafeFilesystemEntry(
      `Existing local application data root must already be owned by the current user with mode 0700: ${root}`,
    );
  }
  await preflightDedicatedRoot(root, canonicalSourceRoot, appId);
}

async function preflightDedicatedRoot(
  root: string,
  canonicalSourceRoot: string,
  appId: string,
): Promise<void> {
  const finalMarker = resolve(root, `${ROOT_MARKER_PREFIX}${appId}`);
  const pendingMarker = resolve(root, `${ROOT_MARKER_PREFIX}${appId}.pending`);
  const entries = await readdir(root);
  const finalMarkerName = finalMarker.slice(root.length + 1);
  const pendingMarkerName = pendingMarker.slice(root.length + 1);
  const hasFinalMarker = entries.includes(finalMarkerName);
  const hasPendingMarker = entries.includes(pendingMarkerName);

  if (hasFinalMarker) {
    await validateRootMarker(finalMarker, canonicalSourceRoot);
    if (hasPendingMarker) {
      await validateRootMarker(pendingMarker, canonicalSourceRoot);
    }
    return;
  }
  if (hasPendingMarker) {
    await validateRootMarker(pendingMarker, canonicalSourceRoot);
    const permittedInterruptedEntries = new Set([
      pendingMarkerName,
      DATABASE_FILE_NAME,
      `${DATABASE_FILE_NAME}-shm`,
      `${DATABASE_FILE_NAME}-wal`,
    ]);
    if (entries.some((entry) => !permittedInterruptedEntries.has(entry))) {
      throw unsafeFilesystemEntry(
        'Interrupted local application root contains unexpected artifacts.',
      );
    }
    return;
  }
  if (entries.length > 0) {
    throw unsafeFilesystemEntry(
      'Existing local application data root is populated but has no valid ownership marker.',
    );
  }
}

async function assertNoPermissiveDarwinAcl(path: string): Promise<void> {
  if (platform() !== 'darwin') return;
  let listing: string;
  try {
    const result = await execFileAsync('/bin/ls', ['-lde', '--', path], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    listing = result.stdout;
  } catch (error) {
    throw unsafeFilesystemEntry(
      `Local runtime could not inspect macOS access controls: ${path}`,
      error,
    );
  }
  for (const line of listing.split('\n')) {
    if (!/^\s*\d+:/.test(line)) continue;
    const entry = line.match(/^\s*\d+:\s+.+\s+(allow|deny)\s+\S.*$/);
    if (entry?.[1] !== 'deny') {
      throw unsafeFilesystemEntry(
        `Local runtime path contains a permissive macOS access control list: ${path}`,
      );
    }
  }
}

export async function acquireLocalDatabase(
  paths: LocalRuntimePaths,
  sourceRoot: string,
  appId: string,
): Promise<{
  canonicalSourceRoot: string;
  db: DatabaseInterface;
}> {
  if (isWindowsCustody()) {
    return acquireWindowsLocalDatabase(paths, sourceRoot, appId);
  }
  requireNoFollowSupport();
  const canonicalSourceRoot = await realpath(sourceRoot);
  const createdDirectories = await ensureSafeDirectoryTree(
    paths.root,
    canonicalSourceRoot,
    true,
  );
  const prepared = await prepareDedicatedRoot(
    paths.root,
    canonicalSourceRoot,
    appId,
    createdDirectories,
  );
  let db: DatabaseInterface | undefined;
  try {
    db = await getDatabase({
      type: 'sqlite',
      url: paths.database,
      secureFile: {
        driver: 'node:sqlite',
        custody: 'trusted-parent',
        root: paths.root,
        ...windowsSecureFileCustody(paths),
      },
    });
    await enforcePrivateDatabaseMode(paths.database, canonicalSourceRoot);
  } catch (error) {
    if (db) throw await closeDatabaseAfterFailure(db, error);
    if (prepared.pendingMarkerCreatedByAttempt) {
      await removeMarkerIfPresent(prepared.pendingMarker, canonicalSourceRoot);
      await removeCreatedDirectories(createdDirectories);
    }
    throw error;
  }
  if (!db) {
    throw new Error('Local runtime database acquisition returned no database.');
  }

  // Once SQLite acquisition succeeds, the database is an authoritative
  // artifact. Keep the pending marker through every promotion failure so a
  // later startup can resume rather than seeing an unmarked populated root.
  try {
    await publishRootMarker(prepared.finalMarker, canonicalSourceRoot);
    await removeMarkerIfPresent(prepared.pendingMarker, canonicalSourceRoot);
  } catch (error) {
    throw await closeDatabaseAfterFailure(db, error);
  }
  return { canonicalSourceRoot, db };
}

async function enforcePrivateDatabaseMode(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const database = await openSafeFile(
    path,
    constants.O_RDWR,
    0o600,
    'Local application database',
    canonicalSourceRoot,
  );
  try {
    await database.chmod(0o600);
    await database.sync();
  } finally {
    await database.close();
  }
}

export async function closeDatabaseAfterFailure(
  db: DatabaseInterface,
  primaryFailure: unknown,
): Promise<unknown> {
  try {
    await db.close?.();
  } catch (cleanupFailure) {
    return preservePrimaryFailure(
      primaryFailure,
      cleanupFailure,
      'databaseCleanupError',
      'Local runtime initialization and database cleanup both failed.',
    );
  }
  return primaryFailure;
}

export function preservePrimaryFailure(
  primaryFailure: unknown,
  secondaryFailure: unknown,
  secondaryProperty: string,
  aggregateMessage: string,
): unknown {
  if (primaryFailure instanceof Error) {
    try {
      Object.defineProperty(primaryFailure, secondaryProperty, {
        value: secondaryFailure,
        configurable: true,
      });
    } catch {
      // A frozen application error must remain primary even when secondary
      // failure context cannot be attached to it.
    }
    return primaryFailure;
  }
  return new AggregateError(
    [primaryFailure, secondaryFailure],
    aggregateMessage,
  );
}

export async function prepareLocalFilesystem(
  paths: LocalRuntimePaths,
  canonicalSourceRoot: string,
  db: DatabaseInterface,
  options: ResolveLocalRuntimePathsOptions,
): Promise<LocalInstallationIdentity> {
  if (isWindowsCustody()) {
    // Same private-tree rule as the data root: existing directories are
    // verified, directories created here are locked to the current user,
    // SYSTEM and Administrators and re-inspected, or removed again.
    const rt = custodyContext().windows;
    preparePrivateWindowsTree(rt, { directory: paths.assets });
    preparePrivateWindowsTree(rt, { directory: paths.secrets });
  } else {
    await ensureSafeDirectoryTree(paths.assets, canonicalSourceRoot);
    await ensureSafeDirectoryTree(paths.secrets, canonicalSourceRoot);
  }
  // The bootstrap table is created only after the seed exists, and the data
  // root's custody record is written as soon as it does, so either proves a
  // seed once existed. A missing seed then means loss, never a first run:
  // regenerating it would silently replace every derived identity and token
  // key (#4704).
  const initialized = await hasInitializedInstallation(db);
  const seedPresent = await pathExists(paths.applicationSecret);
  if (
    !seedPresent &&
    (initialized ||
      (await pathExists(resolve(paths.secrets, INSTALLATION_CUSTODY_FILE))))
  ) {
    throw new LocalRuntimeError(
      'installation_seed_missing',
      installationSeedMissingMessage(),
    );
  }
  // Only a seed this call itself published is new; one that appears between
  // the check and the publish (a sync tool) is an arrival like any other.
  const seedIsNew = await ensureApplicationSecret(
    paths.applicationSecret,
    canonicalSourceRoot,
  );
  const identity = deriveLocalInstallationIdentity(
    await validateApplicationSecret(
      paths.applicationSecret,
      canonicalSourceRoot,
    ),
  );
  const stateOptions = stateRootOptions(options);
  const stateRoot = prepareApplicationStateRoot(stateOptions);
  const enforcement = enforceInstallationCustody({
    secretsDirectory: paths.secrets,
    stateRoot,
    installationId: identity.deviceId,
    seedIsNew,
    initialized,
  });
  if (enforcement.kind === 'refused') {
    throw installationUnverified(enforcement.report, {
      stateRoot,
      source: applicationStateRootSource(stateOptions),
    });
  }
  return identity;
}

async function hasInitializedInstallation(
  db: DatabaseInterface,
): Promise<boolean> {
  const result = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    BOOTSTRAP_TABLE,
  );
  return result.rows.length > 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

// A function, not a constant: installation-custody.ts and this module import
// each other, and a top-level call could run before that module's constants.
const installationSeedMissingMessage = () =>
  `The installation seed is missing from an initialized data root; nothing was changed. ${installationCustodyHint('seed-missing')}`;

export function installationUnverified(
  report: InstallationCustodyReport,
  stateRoot: InstallationStateRootNote,
): LocalRuntimeError {
  // Only statuses that concern this location's own record can be caused by a
  // state root that was lost; a seed problem cannot.
  const location = report.resolutions.includes('restore')
    ? ` ${describeInstallationStateRoot(stateRoot)}`
    : '';
  return new LocalRuntimeError(
    'installation_unverified',
    `This data root is not in this location's custody (${report.status}); nothing was changed. Run "smrt app installation status". ${installationCustodyHint(report.status)}${location}`,
  );
}

async function prepareDedicatedRoot(
  path: string,
  canonicalSourceRoot: string,
  appId: string,
  createdDirectories: string[],
): Promise<PreparedLocalRoot> {
  const finalMarker = resolve(path, `${ROOT_MARKER_PREFIX}${appId}`);
  const pendingMarker = resolve(path, `${ROOT_MARKER_PREFIX}${appId}.pending`);
  const entries = await readdir(path);
  const hasFinalMarker = entries.includes(finalMarker.slice(path.length + 1));
  const hasPendingMarker = entries.includes(
    pendingMarker.slice(path.length + 1),
  );

  if (hasFinalMarker) {
    await validateRootMarker(finalMarker, canonicalSourceRoot);
    if (hasPendingMarker) {
      await validateRootMarker(pendingMarker, canonicalSourceRoot);
    }
    return {
      createdDirectories,
      pendingMarker: hasPendingMarker ? pendingMarker : null,
      pendingMarkerCreatedByAttempt: false,
      finalMarker,
    };
  }

  if (hasPendingMarker) {
    await validateRootMarker(pendingMarker, canonicalSourceRoot);
    const permittedInterruptedEntries = new Set([
      pendingMarker.slice(path.length + 1),
      DATABASE_FILE_NAME,
      `${DATABASE_FILE_NAME}-shm`,
      `${DATABASE_FILE_NAME}-wal`,
    ]);
    if (entries.some((entry) => !permittedInterruptedEntries.has(entry))) {
      throw unsafeFilesystemEntry(
        'Interrupted local application root contains unexpected artifacts.',
      );
    }
    return {
      createdDirectories,
      pendingMarker,
      pendingMarkerCreatedByAttempt: false,
      finalMarker,
    };
  }

  if (entries.length > 0) {
    throw unsafeFilesystemEntry(
      'Existing local application data root is populated but has no valid ownership marker.',
    );
  }
  const pendingMarkerCreatedByAttempt = await publishRootMarker(
    pendingMarker,
    canonicalSourceRoot,
  );
  return {
    createdDirectories,
    pendingMarker,
    pendingMarkerCreatedByAttempt,
    finalMarker,
  };
}

/**
 * Serialize initialization of one data root across processes.
 *
 * The primary lease lives beside the data it protects, in a private
 * `.smrt-lease-<key>` directory inside the data root's parent: that parent has
 * already passed trusted-parent custody preflight, and it is the only
 * location every process sharing the data directory is guaranteed to see,
 * including processes in a user namespace where `/tmp` reads as owned by the
 * overflow uid (#3877). The historical per-user `/tmp/.smrt-<uid>` leases are
 * still taken afterwards — for the in-namespace uid, then for its host
 * mapping when that differs — so a process running an older release that
 * knows only that lease stays excluded, whether it runs in this namespace or
 * on the host: each through the secure boundary when its ancestry is
 * trusted, otherwise as a lock-only probe that fails closed (see
 * {@link acquireLegacyLeaseWithoutTrustedAncestry}). When the parent cannot
 * hold a lease (not writable by the current user, or a read-only filesystem)
 * the secure `/tmp` leases are required exactly as before.
 */
export async function acquireInitializationLock(
  root: string,
): Promise<LocalInitializationLock> {
  if (isWindowsCustody()) return acquireWindowsInitializationLock(root);
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw unsafeFilesystemEntry(
      'Local runtime initialization locks require a numeric current-user identity.',
    );
  }
  const lockKey = createHash('sha256')
    .update(normalizeFilesystemIdentity(root))
    .digest('hex')
    .slice(0, 32);

  const besideData = await prepareDataParentLeaseRoot(
    root,
    lockKey,
    currentUid,
  );
  // Legacy `/tmp/.smrt-<uid>` candidates, in this fixed order: the
  // in-namespace uid (what an older release running in this same namespace
  // locks), then that uid mapped through `/proc/self/uid_map` (what an older
  // release on the host locks). Identical paths are taken once, so a host
  // process with an identity map takes exactly the one lease it always did.
  const canonicalTemporaryRoot = await realpath('/tmp');
  const mappedUid = await legacyLeaseUid(currentUid);
  const legacyLockRoots = [...new Set([currentUid, mappedUid])].map((uid) =>
    resolve(canonicalTemporaryRoot, `.smrt-${uid}`),
  );
  // In a remapping namespace the in-namespace uid can equal a real host uid
  // (`unshare -Ur` reads as 0), so its `.smrt-<uid>` root may belong to that
  // host user and read as a foreign owner here. No process in this namespace
  // can create or hold a lease beneath a root it does not own (an older
  // in-namespace release fails there too), so that one candidate is skipped.
  // A symlink or non-directory still falls through and fails closed.
  if (
    mappedUid !== currentUid &&
    (await isForeignOwnedDirectory(legacyLockRoots[0], currentUid))
  ) {
    legacyLockRoots.shift();
  }

  const held: LocalInitializationLock[] = [];
  try {
    if (besideData === null) {
      // The parent cannot hold a lease: every legacy lease is required on
      // the secure boundary, exactly as before.
      for (const lockRoot of legacyLockRoots) {
        held.push(
          await acquireTemporaryInitializationLease(
            lockRoot,
            lockKey,
            currentUid,
          ),
        );
      }
    } else {
      // Every new process takes the beside-data lease first, which
      // serializes new processes against each other before any legacy lease
      // is requested; older releases hold only one legacy lease and wait on
      // nothing, so the fixed legacy order below cannot deadlock.
      held.push(
        await acquireInitializationDatabaseLease(
          resolve(besideData, 'initialization.sqlite'),
          besideData,
        ),
      );
      for (const lockRoot of legacyLockRoots) {
        const legacy = (await hasTrustedLeaseAncestry(lockRoot, currentUid))
          ? await acquireTemporaryInitializationLease(
              lockRoot,
              lockKey,
              currentUid,
            )
          : await acquireLegacyLeaseWithoutTrustedAncestry(
              lockRoot,
              lockKey,
              currentUid,
            );
        if (legacy) held.push(legacy);
      }
    }
  } catch (error) {
    try {
      await releaseInitializationLeases(held);
    } catch (releaseError) {
      throw preservePrimaryFailure(
        error,
        releaseError,
        'initializationLockReleaseError',
        'Local runtime initialization-lock acquisition and release both failed.',
      );
    }
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await releaseInitializationLeases(held);
    },
  };
}

/**
 * Run `callback` while holding the data root's initialization lock, so a
 * custody declaration cannot interleave with a runtime initializing the same
 * root. The caller must already have preflighted the root.
 *
 * @internal Operator custody declarations only.
 */
export async function withLocalInitializationLock<T>(
  root: string,
  callback: () => Promise<T> | T,
): Promise<T> {
  const lock = await acquireInitializationLock(root);
  let result: T;
  try {
    result = await callback();
  } catch (error) {
    try {
      await lock.release();
    } catch (releaseError) {
      throw preservePrimaryFailure(
        error,
        releaseError,
        'initializationLockReleaseError',
        'Local installation custody operation and lock release both failed.',
      );
    }
    throw error;
  }
  await lock.release();
  return result;
}

async function isForeignOwnedDirectory(
  path: string,
  currentUid: number,
): Promise<boolean> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  return (
    !details.isSymbolicLink() &&
    details.isDirectory() &&
    details.uid !== currentUid
  );
}

/** Release leases in reverse acquisition order, reporting the first failure. */
async function releaseInitializationLeases(
  leases: readonly LocalInitializationLock[],
): Promise<void> {
  let failure: unknown;
  for (const lease of leases.toReversed()) {
    try {
      await lease.release();
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : preservePrimaryFailure(
              failure,
              error,
              'initializationLockReleaseError',
              'Several local runtime initialization leases failed to release.',
            );
    }
  }
  if (failure !== undefined) throw failure;
}

/**
 * The uid that names the legacy `/tmp/.smrt-<uid>` lease directory.
 *
 * An older release names it after the uid it sees. Inside a user namespace
 * that remaps the uid (`unshare -Ur` maps host uid 1000 to 0), an older host
 * process locks the host uid's directory, so the current uid is translated
 * through `/proc/self/uid_map` into the parent namespace and that lease is
 * taken in addition to the in-namespace one. Ownership checks keep using
 * the in-namespace uid, which is how the remapped owner reads here. Without
 * the file (non-Linux) the uid is used as is; an unreadable, malformed, or
 * non-covering map fails closed. Only one namespace level is visible.
 */
async function legacyLeaseUid(currentUid: number): Promise<number> {
  let map: string;
  try {
    map = await readFile(UID_MAP_PATH, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return currentUid;
    throw unsafeFilesystemEntry(
      'Local runtime could not read the user-namespace uid map for its legacy lease.',
      error,
    );
  }
  for (const line of map.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    const [inside, outside, count] = fields.map((field) =>
      /^\d+$/.test(field) ? Number(field) : Number.NaN,
    );
    if (
      fields.length !== 3 ||
      !Number.isSafeInteger(inside) ||
      !Number.isSafeInteger(outside) ||
      !Number.isSafeInteger(count)
    ) {
      throw unsafeFilesystemEntry(
        'Local runtime could not parse the user-namespace uid map for its legacy lease.',
      );
    }
    if (currentUid >= inside && currentUid - inside < count) {
      return outside + (currentUid - inside);
    }
  }
  throw unsafeFilesystemEntry(
    'The user-namespace uid map does not cover the current user; the legacy local runtime lease cannot be located.',
  );
}

/**
 * Create (or validate) the private lease directory beside the data root.
 * Returns `null` only when the parent cannot hold a lease for the current
 * user; any other unexpected state fails closed.
 */
async function prepareDataParentLeaseRoot(
  root: string,
  lockKey: string,
  currentUid: number,
): Promise<string | null> {
  const parent = resolve(root, '..');
  const leaseRoot = resolve(parent, `${LEASE_DIRECTORY_PREFIX}${lockKey}`);
  try {
    // Preflight has already verified every existing ancestor of the data root
    // (real directories, trusted owners, no foreign write access); missing
    // components are created private, as data-root creation would.
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(leaseRoot, { mode: 0o700 });
  } catch (error) {
    if (isLeaseLocationUnavailable(error)) return null;
    if (!isFileAlreadyExists(error)) throw error;
  }
  await assertPrivateLeaseDirectory(leaseRoot, currentUid);
  return leaseRoot;
}

async function acquireTemporaryInitializationLease(
  lockRoot: string,
  lockKey: string,
  currentUid: number,
): Promise<LocalInitializationLock> {
  try {
    await mkdir(lockRoot, { mode: 0o700 });
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  }
  await assertPrivateLeaseDirectory(lockRoot, currentUid);
  const custodyRoot = resolve(lockRoot, lockKey);
  try {
    await mkdir(custodyRoot, { mode: 0o700 });
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  }
  const path = resolve(custodyRoot, 'initialization.sqlite');
  return acquireInitializationDatabaseLease(path, custodyRoot);
}

async function assertPrivateLeaseDirectory(
  path: string,
  currentUid: number,
): Promise<void> {
  const details = await lstat(path);
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    details.uid !== currentUid ||
    (details.mode & 0o777) !== 0o700
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime lock directory must be current-user-owned with mode 0700: ${path}`,
    );
  }
}

/**
 * Take the legacy `/tmp` lease when `/tmp` fails the secure ancestry rule
 * only because its owner is not mapped into this user namespace (#3877).
 *
 * An older release on the host takes nothing but this lease, so skipping it
 * would let both initialize one data root at once. The lock database is only
 * ever locked, never written or read for content, so this path relaxes the
 * ancestor *owner* check alone: every ancestor must still be a real directory
 * that is not group/world writable unless sticky, and the per-user lock
 * directory, key directory, and lock file must be current-user-owned and
 * private, exactly as the secure path requires. Returns `null` only when the
 * lock directory cannot be created at all (not writable, read-only), where no
 * process sharing this view of `/tmp` can hold the lease either.
 */
async function acquireLegacyLeaseWithoutTrustedAncestry(
  lockRoot: string,
  lockKey: string,
  currentUid: number,
): Promise<LocalInitializationLock | null> {
  for (const component of absolutePathComponents(resolve(lockRoot, '..'))) {
    const details = await lstat(component);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      ((details.mode & 0o022) !== 0 && (details.mode & 0o1000) === 0)
    ) {
      throw unsafeFilesystemEntry(
        `Legacy local runtime lock ancestry permits replacement by another principal: ${component}`,
      );
    }
  }
  const custodyRoot = resolve(lockRoot, lockKey);
  const path = resolve(custodyRoot, 'initialization.sqlite');
  try {
    await mkdir(lockRoot, { mode: 0o700 });
  } catch (error) {
    if (isLeaseLocationUnavailable(error)) {
      try {
        await lstat(path);
      } catch (probeError) {
        if (isMissingFile(probeError)) return null;
        throw probeError;
      }
      // A legacy lease file exists but this process cannot lock it: fail
      // closed rather than risk overlapping an older live initializer.
      throw error;
    }
    if (!isFileAlreadyExists(error)) throw error;
  }
  await assertPrivateLeaseDirectory(lockRoot, currentUid);
  try {
    await mkdir(custodyRoot, { mode: 0o700 });
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  }
  await assertPrivateLeaseDirectory(custodyRoot, currentUid);
  let created: FileHandle | undefined;
  try {
    created = await open(
      path,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  } finally {
    await created?.close();
  }
  const leaf = await lstat(path);
  if (
    leaf.isSymbolicLink() ||
    !leaf.isFile() ||
    leaf.uid !== currentUid ||
    (leaf.mode & 0o022) !== 0
  ) {
    throw unsafeFilesystemEntry(
      `Legacy local runtime lock file must be a current-user-owned private file: ${path}`,
    );
  }
  return acquireInitializationDatabaseLease(path, custodyRoot, true);
}

/**
 * Whether every existing ancestor of `path` meets the secure SQLite ancestry
 * rule (owned by the current user or root; group/world writable only when
 * sticky). In a user namespace an unmapped owner reads as the overflow uid,
 * so the shared `/tmp` fails this and the legacy lease is taken through
 * {@link acquireLegacyLeaseWithoutTrustedAncestry} instead.
 */
async function hasTrustedLeaseAncestry(
  path: string,
  currentUid: number,
): Promise<boolean> {
  for (const component of absolutePathComponents(resolve(path, '..'))) {
    const details = await lstat(component);
    if (details.isSymbolicLink() || !details.isDirectory()) return false;
    if (details.uid !== currentUid && details.uid !== 0) return false;
    if ((details.mode & 0o022) !== 0 && (details.mode & 0o1000) === 0) {
      return false;
    }
  }
  return true;
}

function isLeaseLocationUnavailable(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

async function acquireInitializationDatabaseLease(
  path: string,
  custodyRoot: string,
  lockOnly = false,
): Promise<LocalInitializationLock> {
  const worker = new Worker(INITIALIZATION_LOCK_WORKER, {
    eval: true,
    workerData: {
      path,
      custodyRoot,
      lockOnly,
      timeout: INITIALIZATION_LOCK_TIMEOUT_MS,
      sqlModuleUrl: import.meta.resolve('@happyvertical/sql'),
    },
  });
  const acquisitionFailure = (cause: unknown) => {
    const failure = new LocalRuntimeError(
      'invalid_configuration',
      'Could not acquire the local runtime initialization lease within two minutes.',
    );
    Object.defineProperty(failure, 'cause', { value: cause });
    return failure;
  };
  let workerError: unknown;
  const exited = new Promise<never>((_resolve, reject) => {
    worker.once('error', (error) => {
      workerError = error;
    });
    worker.once('exit', (code) => {
      reject(
        acquisitionFailure(
          workerError ??
            new Error(`Initialization lock worker exited ${code}.`),
        ),
      );
    });
  });
  const acquired = new Promise<void>((resolvePromise, reject) => {
    const onMessage = (message: { type?: string; message?: string }) => {
      if (message.type === 'acquired') {
        worker.off('message', onMessage);
        resolvePromise();
      } else if (message.type === 'error') {
        worker.off('message', onMessage);
        reject(acquisitionFailure(new Error(message.message)));
      }
    };
    worker.on('message', onMessage);
  });
  await Promise.race([acquired, exited]);

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      const releaseCompleted = new Promise<void>((resolvePromise, reject) => {
        const onMessage = (message: { type?: string; error?: string }) => {
          if (message.type !== 'released') return;
          worker.off('message', onMessage);
          if (message.error) reject(new Error(message.error));
          else resolvePromise();
        };
        worker.on('message', onMessage);
        worker.postMessage({ type: 'release' });
      });
      try {
        await Promise.race([releaseCompleted, exited]);
      } finally {
        await worker.terminate();
      }
    },
  };
}

async function ensureSafeDirectoryTree(
  path: string,
  canonicalSourceRoot: string,
  dedicatedRoot = false,
): Promise<string[]> {
  const components = absolutePathComponents(path);
  const createdDirectories: string[] = [];
  for (const component of components) {
    let created = false;
    try {
      const details = await lstat(component);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw unsafeFilesystemEntry(
          `Local runtime path component must be a real directory: ${component}`,
        );
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      try {
        await mkdir(component, { mode: 0o700 });
        created = true;
        createdDirectories.push(component);
      } catch (mkdirError) {
        // A concurrent initializer may have created the component. It is still
        // opened and validated without following links below.
        if (!isFileAlreadyExists(mkdirError)) throw mkdirError;
      }
    }

    const directory = await openSafeDirectory(component, canonicalSourceRoot);
    try {
      await assertCanonicalEntry(component, canonicalSourceRoot);
      if (component === path && dedicatedRoot && !created) {
        await assertExistingDedicatedRoot(
          directory,
          component,
          canonicalSourceRoot,
        );
      }
      if (created || (component === path && !dedicatedRoot)) {
        await directory.chmod(0o700);
      }
    } finally {
      await directory.close();
    }
  }
  await validateExistingPathChain(path, canonicalSourceRoot, 'directory');
  return createdDirectories;
}

async function assertExistingDedicatedRoot(
  directory: FileHandle,
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const canonical = await realpath(path);
  if (
    isInside(canonicalSourceRoot, canonical) ||
    isInside(canonical, canonicalSourceRoot)
  ) {
    throw unsafeFilesystemEntry(
      'Local application data must be a dedicated directory that does not overlap the canonical source tree.',
    );
  }

  const details = await directory.stat();
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    details.uid !== currentUid ||
    (details.mode & 0o777) !== 0o700
  ) {
    throw unsafeFilesystemEntry(
      `Existing local application data root must already be owned by the current user with mode 0700: ${path}`,
    );
  }
}

async function publishRootMarker(
  path: string,
  canonicalSourceRoot: string,
): Promise<boolean> {
  let marker: FileHandle | undefined;
  let created = false;
  try {
    marker = await openSafeFile(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
      'Local application root marker',
      canonicalSourceRoot,
    );
    created = true;
    await marker.sync();
  } catch (error) {
    if (!isFileAlreadyExists(error)) throw error;
  } finally {
    await marker?.close();
  }
  await validateRootMarker(path, canonicalSourceRoot);
  await syncDirectory(resolve(path, '..'), canonicalSourceRoot);
  return created;
}

async function validateRootMarker(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  await validateExistingPathChain(path, canonicalSourceRoot, 'file');
  const marker = await openSafeFile(
    path,
    constants.O_RDONLY,
    0o600,
    'Local application root marker',
    canonicalSourceRoot,
  );
  try {
    const details = await marker.stat();
    const currentUid = process.getuid?.();
    if (
      currentUid === undefined ||
      details.uid !== currentUid ||
      (details.mode & 0o777) !== 0o600 ||
      details.size !== 0
    ) {
      throw unsafeFilesystemEntry(
        `Local application root marker must be an empty current-user-owned mode-0600 file: ${path}`,
      );
    }
  } finally {
    await marker.close();
  }
}

async function removeMarkerIfPresent(
  path: string | null,
  canonicalSourceRoot: string,
): Promise<void> {
  if (path === null) return;
  try {
    await validateRootMarker(path, canonicalSourceRoot);
    await unlink(path);
    await syncDirectory(resolve(path, '..'), canonicalSourceRoot);
  } catch (error) {
    if (!isMissingFile(error) && !hasMissingFileCause(error)) throw error;
  }
}

async function removeCreatedDirectories(paths: string[]): Promise<void> {
  for (const path of paths.toReversed()) {
    try {
      await rmdir(path);
    } catch (error) {
      if (!isMissingFile(error) && !isDirectoryNotEmpty(error)) throw error;
    }
  }
}

/**
 * Publish the application secret if none exists; `true` only when this call
 * created it. `@internal`: exported for the tests.
 */
export async function ensureApplicationSecret(
  path: string,
  canonicalSourceRoot: string,
): Promise<boolean> {
  if (isWindowsCustody()) return ensureWindowsApplicationSecret(path);
  const directoryPath = resolve(path, '..');
  const temporaryPath = resolve(
    directoryPath,
    `.${SECRET_FILE_NAME}.tmp-${randomBytes(16).toString('hex')}`,
  );
  let temporary: FileHandle | undefined;
  let failure: unknown;
  let created = false;
  try {
    temporary = await openSafeFile(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
      'Temporary application secret',
      canonicalSourceRoot,
    );
    await temporary.writeFile(
      `${randomBytes(32).toString('base64url')}\n`,
      'utf8',
    );
    await temporary.sync();
    await temporary.close();
    temporary = undefined;

    try {
      await link(temporaryPath, path);
      created = true;
    } catch (error) {
      if (!isFileAlreadyExists(error)) throw error;
    }

    await validateApplicationSecret(path, canonicalSourceRoot);
    await syncDirectory(directoryPath, canonicalSourceRoot);
  } catch (error) {
    failure = error;
  }
  try {
    await temporary?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!isMissingFile(error)) failure ??= error;
  }
  if (failure !== undefined) throw failure;
  await removeStaleSecretTemps(directoryPath);
  return created;
}

export async function validateApplicationSecret(
  path: string,
  canonicalSourceRoot: string,
): Promise<string> {
  if (isWindowsCustody()) return validateWindowsApplicationSecret(path);
  await validateExistingPathChain(path, canonicalSourceRoot, 'file');
  const file = await openSafeFile(
    path,
    constants.O_RDONLY,
    0o600,
    'Application secret',
    canonicalSourceRoot,
  );
  try {
    const details = await file.stat();
    const currentUid = process.getuid?.();
    const secret = await file.readFile('utf8');
    await validateExistingPathChain(path, canonicalSourceRoot, 'file');
    if (
      currentUid === undefined ||
      details.uid !== currentUid ||
      (details.mode & 0o777) !== 0o600 ||
      details.size !== 44 ||
      !/^[A-Za-z0-9_-]{43}\n$/.test(secret)
    ) {
      throw unsafeFilesystemEntry(
        'Application secret must be a complete current-user-owned mode-0600 value in the expected format.',
      );
    }
    return secret;
  } finally {
    await file.close();
  }
}

async function syncDirectory(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const directory = await openSafeDirectory(path, canonicalSourceRoot);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeStaleSecretTemps(directoryPath: string): Promise<void> {
  const prefix = `.${SECRET_FILE_NAME}.tmp-`;
  for (const entry of await readdir(directoryPath)) {
    if (!entry.startsWith(prefix)) continue;
    try {
      await unlink(resolve(directoryPath, entry));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

async function openSafeDirectory(path: string, canonicalSourceRoot: string) {
  let directory: FileHandle | undefined;
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await validateOpenHandlePath(
      directory,
      path,
      'directory',
      canonicalSourceRoot,
    );
    return directory;
  } catch (error) {
    await directory?.close();
    if (error instanceof LocalRuntimeError) throw error;
    throw unsafeFilesystemEntry(
      `Could not safely open local runtime directory: ${path}`,
      error,
    );
  }
}

async function openSafeFile(
  path: string,
  flags: number,
  mode: number,
  label: string,
  canonicalSourceRoot: string,
) {
  let file: FileHandle | undefined;
  try {
    file = await open(path, flags | constants.O_NOFOLLOW, mode);
    await validateOpenHandlePath(file, path, 'file', canonicalSourceRoot);
    return file;
  } catch (error) {
    await file?.close();
    if (error instanceof LocalRuntimeError || isFileAlreadyExists(error)) {
      throw error;
    }
    throw unsafeFilesystemEntry(
      `${label} could not be opened without following symbolic links.`,
      error,
    );
  }
}

async function validateOpenHandlePath(
  handle: FileHandle,
  path: string,
  expectedType: 'directory' | 'file',
  canonicalSourceRoot: string,
): Promise<void> {
  const opened = await handle.stat();
  const current = await lstat(path);
  const expectedDirectory = expectedType === 'directory';
  if (
    current.isSymbolicLink() ||
    (expectedDirectory ? !opened.isDirectory() : !opened.isFile()) ||
    (expectedDirectory ? !current.isDirectory() : !current.isFile()) ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime ${expectedType} changed while it was being opened: ${path}`,
    );
  }
  await validateExistingPathChain(path, canonicalSourceRoot, expectedType);
  const afterValidation = await lstat(path);
  if (
    afterValidation.isSymbolicLink() ||
    opened.dev !== afterValidation.dev ||
    opened.ino !== afterValidation.ino
  ) {
    throw unsafeFilesystemEntry(
      `Local runtime ${expectedType} changed during validation: ${path}`,
    );
  }
}

async function validateExistingPathChain(
  path: string,
  canonicalSourceRoot: string,
  leafType: 'directory' | 'file',
): Promise<void> {
  const components = absolutePathComponents(path);
  for (const [index, component] of components.entries()) {
    const details = await lstat(component);
    const expectedFile = index === components.length - 1 && leafType === 'file';
    if (
      details.isSymbolicLink() ||
      (expectedFile ? !details.isFile() : !details.isDirectory())
    ) {
      throw unsafeFilesystemEntry(
        `Local runtime path contains an unsafe component: ${component}`,
      );
    }
    await assertCanonicalEntry(component, canonicalSourceRoot);
  }
}

async function assertCanonicalEntry(
  path: string,
  canonicalSourceRoot: string,
): Promise<void> {
  const canonical = await realpath(path);
  if (!sameFilesystemPath(canonical, path)) {
    throw unsafeFilesystemEntry(
      `Local runtime path must not be redirected: ${path}`,
    );
  }
  if (isInside(canonicalSourceRoot, canonical)) {
    throw unsafeFilesystemEntry(
      'Local application data must remain outside the canonical source tree.',
    );
  }
}

function absolutePathComponents(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  const components = [root];
  for (const part of parts) {
    components.push(resolve(components.at(-1) as string, part));
  }
  return components;
}

function requireNoFollowSupport(): void {
  if (
    typeof constants.O_NOFOLLOW !== 'number' ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_DIRECTORY !== 'number' ||
    constants.O_DIRECTORY === 0
  ) {
    throw unsafeFilesystemEntry(
      'This platform cannot safely initialize local storage without no-follow filesystem support.',
    );
  }
}

export function sameFilesystemPath(
  left: string,
  right: string,
  runtimePlatform: NodeJS.Platform = platform(),
): boolean {
  return (
    normalizeFilesystemIdentity(left, runtimePlatform) ===
    normalizeFilesystemIdentity(right, runtimePlatform)
  );
}

function usesCaseInsensitivePathGuards(
  runtimePlatform: NodeJS.Platform,
): boolean {
  return runtimePlatform === 'win32' || runtimePlatform === 'darwin';
}

function normalizeFilesystemIdentity(
  value: string,
  runtimePlatform: NodeJS.Platform = platform(),
): string {
  if (runtimePlatform === 'win32') {
    return foldWindowsCase(win32.resolve(value));
  }
  const normalized = resolve(value);
  return usesCaseInsensitivePathGuards(runtimePlatform)
    ? normalized.toLowerCase()
    : normalized;
}

export function defaultApplicationDataRoot(
  runtimePlatform: NodeJS.Platform,
  runtimeHome: string,
  env: NodeJS.ProcessEnv,
): string {
  if (runtimePlatform === 'darwin') {
    return resolve(runtimeHome, 'Library', 'Application Support');
  }
  if (runtimePlatform === 'win32') {
    // Machine-local only. Never the roaming profile (APPDATA can be folder
    // redirected to a network share) and never the home directory.
    const base = lookupWindowsEnvironment(env, 'LOCALAPPDATA');
    if (base === undefined || base === '') {
      throw new LocalRuntimeError(
        'invalid_configuration',
        'LOCALAPPDATA is not set, so the Windows application data directory cannot be determined (the roaming APPDATA directory and the home directory are never used). Set dataDirectory explicitly.',
      );
    }
    return validateWindowsPath(base, 'LOCALAPPDATA');
  }
  return resolve(env.XDG_DATA_HOME ?? resolve(runtimeHome, '.local', 'share'));
}

export function isInside(
  parent: string,
  child: string,
  runtimePlatform: NodeJS.Platform = platform(),
): boolean {
  const normalizedParent = normalizeFilesystemIdentity(parent, runtimePlatform);
  const normalizedChild = normalizeFilesystemIdentity(child, runtimePlatform);
  if (runtimePlatform === 'win32') {
    return isInsideWindowsPath(normalizedParent, normalizedChild);
  }
  const path = relative(normalizedParent, normalizedChild);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function hasMissingFileCause(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'cause' in error &&
    isMissingFile((error as { cause?: unknown }).cause)
  );
}

function isFileAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOTEMPTY'
  );
}

/**
 * Verify the on-disk custody of an already-initialized local database root
 * without creating or changing anything (the body of
 * `validateLocalDatabaseStorage()`).
 */
export async function validateLocalStorageCustody(
  paths: { root: string; database: string },
  sourceRoot: string,
  appId: string,
): Promise<void> {
  if (isWindowsCustody()) {
    validateWindowsStorage(paths, sourceRoot, appId);
    return;
  }
  await preflightLocalApplicationRoot(paths.root, sourceRoot, appId);
  const canonicalSourceRoot = await realpath(sourceRoot);
  await validateRootMarker(
    resolve(paths.root, `${ROOT_MARKER_PREFIX}${appId}`),
    canonicalSourceRoot,
  );
  await validateExistingPathChain(paths.database, canonicalSourceRoot, 'file');
  const database = await lstat(paths.database);
  const currentUid = process.getuid?.();
  if (
    database.isSymbolicLink() ||
    !database.isFile() ||
    (currentUid !== undefined && database.uid !== currentUid) ||
    (database.mode & 0o777) !== 0o600
  ) {
    throw unsafeFilesystemEntry(
      `Local application database must be a current-user-owned mode-0600 file: ${paths.database}`,
    );
  }
}

function isWindowsCustody(): boolean {
  return custodyContext().platform === 'win32';
}

/**
 * The `windowsCustody` option of `@happyvertical/sql`'s `secureFile` for this
 * runtime: on Windows, the verifier that applies the runtime's own Windows
 * custody rule (W3/W4/W6 on the database's directory chain and file, see
 * {@link createWindowsDatabaseVerifier}); nothing elsewhere, so the option
 * object a macOS or Linux host passes the SDK is unchanged. Every place that
 * opens the secure database spreads this into its `secureFile`.
 */
export function windowsSecureFileCustody(paths: {
  root: string;
  database: string;
}): { windowsCustody?: SecureSqliteWindowsCustody } {
  if (!isWindowsCustody()) return {};
  return {
    windowsCustody: {
      verify: createWindowsDatabaseVerifier(custodyContext().windows, {
        custodyRoot: validateWindowsPath(
          paths.root,
          'Local application data root',
          WINDOWS_DERIVED_PATH_RESERVE,
        ),
        database: validateWindowsPath(
          paths.database,
          'Local application database',
        ),
      }),
    },
  };
}

/**
 * The canonical (real) path of the source checkout. On Windows it is the
 * native real path through the custody runtime; elsewhere `realpath`.
 */
export async function canonicalLocalSourceRoot(
  sourceRoot: string,
): Promise<string> {
  if (isWindowsCustody()) {
    return custodyContext().windows.realpath(win32.resolve(sourceRoot));
  }
  return realpath(sourceRoot);
}

function removeWindowsQuietly(action: () => void): void {
  try {
    action();
  } catch {
    // Rollback only ever removes what this attempt created; best effort.
  }
}

/**
 * Windows form of {@link acquireLocalDatabase}. The same steps, with the
 * Windows custody rule in place of `O_NOFOLLOW`, uid and mode bits: the
 * read-only preflight (W1, overlap, chain, markers), the data root created
 * private (every directory this call creates is locked and re-inspected, or
 * removed again), the pending marker, the SDK open with `windowsCustody.verify`
 * bound to the same rule (it runs before and after the SDK creates the file),
 * then the final marker. There is no mode to repair; the DACL is the
 * guarantee.
 */
async function acquireWindowsLocalDatabase(
  paths: LocalRuntimePaths,
  sourceRoot: string,
  appId: string,
): Promise<{ canonicalSourceRoot: string; db: DatabaseInterface }> {
  const rt = custodyContext().windows;
  preflightWindowsRoot(paths.root, sourceRoot, appId);
  const root = validateWindowsPath(
    paths.root,
    'Local application data root',
    WINDOWS_DERIVED_PATH_RESERVE,
  );
  const canonicalSourceRoot = rt.realpath(win32.resolve(sourceRoot));
  const finalMarker = win32.join(root, `${ROOT_MARKER_PREFIX}${appId}`);
  const pendingName = `${ROOT_MARKER_PREFIX}${appId}.pending`;
  const pendingPath = win32.join(root, pendingName);

  const { createdDirectories } = preparePrivateWindowsTree(rt, {
    directory: root,
  });
  let pendingMarkerCreatedByAttempt = false;
  let db: DatabaseInterface | undefined;
  try {
    const entries = rt.readdir(root);
    const hasFinal = entries.includes(win32.basename(finalMarker));
    const hasPending = entries.includes(pendingName);
    if (!hasFinal && !hasPending) {
      pendingMarkerCreatedByAttempt = preparePrivateWindowsTree(rt, {
        directory: root,
        file: { path: pendingPath, size: 0 },
      }).createdFile;
    }
    db = await getDatabase({
      type: 'sqlite',
      url: paths.database,
      secureFile: {
        driver: 'node:sqlite',
        custody: 'trusted-parent',
        root: paths.root,
        ...windowsSecureFileCustody(paths),
      },
    });
  } catch (error) {
    if (db) throw await closeDatabaseAfterFailure(db, error);
    if (pendingMarkerCreatedByAttempt) {
      removeWindowsQuietly(() => rt.unlink(pendingPath));
      for (const directory of createdDirectories.toReversed()) {
        removeWindowsQuietly(() => rt.rmdir(directory));
      }
    }
    throw error;
  }

  // As on POSIX: once SQLite acquisition succeeds the database is an
  // authoritative artifact, so the pending marker is kept through every
  // promotion failure and a later start resumes.
  try {
    preparePrivateWindowsTree(rt, {
      directory: root,
      file: { path: finalMarker, size: 0 },
    });
    if (rt.readdir(root).includes(pendingName)) {
      verifyWindowsFile(rt, pendingPath, { size: 0 });
      rt.unlink(pendingPath);
    }
  } catch (error) {
    throw await closeDatabaseAfterFailure(db, error);
  }
  return { canonicalSourceRoot, db };
}

/** The Windows application secret: a custodied one-link file in `secrets`. */
function validateWindowsApplicationSecret(path: string): string {
  const rt = custodyContext().windows;
  // The data root is two levels up: `<root>\secrets\application.secret`.
  const root = win32.dirname(win32.dirname(path));
  const chain = walkWindowsChain(rt, path, 'file');
  if (!chain.complete) throw missingEntry(path);
  inspectWindowsChain(rt, chain, { custodyRoot: root });
  const secret = verifyWindowsFile(rt, path, { size: 44, read: true });
  if (secret === undefined || !/^[A-Za-z0-9_-]{43}\n$/.test(secret)) {
    throw unsafeFilesystemEntry(
      'Application secret must be a complete current-user-owned value in the expected format.',
    );
  }
  return secret;
}

/**
 * Publish the Windows application secret the way POSIX does: complete content
 * in a temporary file, then an exclusive hard link to the final name, so a
 * crash leaves no partial secret and a secret that appeared meanwhile wins.
 */
function ensureWindowsApplicationSecret(path: string): boolean {
  const rt = custodyContext().windows;
  const directory = win32.dirname(path);
  const temporaryPath = win32.join(
    directory,
    `.${SECRET_FILE_NAME}.tmp-${randomBytes(16).toString('hex')}`,
  );
  let created = false;
  try {
    const handle = rt.openFile(temporaryPath, 'create');
    try {
      handle.writeUtf8(`${randomBytes(32).toString('base64url')}\n`);
    } finally {
      handle.close();
    }
    try {
      rt.link(temporaryPath, path);
      created = true;
    } catch (error) {
      if (!isFileAlreadyExists(error)) throw error;
    }
  } finally {
    removeWindowsQuietly(() => rt.unlink(temporaryPath));
  }
  validateWindowsApplicationSecret(path);
  for (const entry of rt.readdir(directory)) {
    if (entry.startsWith(`.${SECRET_FILE_NAME}.tmp-`)) {
      removeWindowsQuietly(() => rt.unlink(win32.join(directory, entry)));
    }
  }
  return created;
}

/**
 * Windows read-only preflight: W1 on the root and appId, the source-tree
 * overlap guard on canonical paths, W3/W4 on every existing component, W6 on
 * the chain and on any marker (plus `extraFiles`), then the same
 * dedicated-root marker rules as POSIX. One inspector call in total.
 */
function preflightWindowsRoot(
  root: string,
  sourceRoot: string,
  appId: string,
  extraFiles: readonly string[] = [],
): void {
  const rt = custodyContext().windows;
  validateWindowsApplicationId(appId);
  const normalizedRoot = validateWindowsPath(
    root,
    'Local application data root',
    WINDOWS_DERIVED_PATH_RESERVE,
  );
  const canonicalSourceRoot = rt.realpath(win32.resolve(sourceRoot));
  if (
    isInsideWindowsPath(canonicalSourceRoot, normalizedRoot) ||
    isInsideWindowsPath(normalizedRoot, canonicalSourceRoot)
  ) {
    throw unsafeFilesystemEntry(
      'Local application data must remain outside the canonical source tree.',
    );
  }
  const chain = walkWindowsChain(rt, normalizedRoot, 'directory');
  if (!chain.complete) {
    inspectWindowsChain(rt, chain, { custodyRoot: normalizedRoot });
    // A read-only validation of stored files has nothing to validate here.
    if (extraFiles.length > 0) throw missingEntry(normalizedRoot);
    return;
  }
  const finalName = `${ROOT_MARKER_PREFIX}${appId}`;
  const pendingName = `${finalName}.pending`;
  const entries = rt.readdir(normalizedRoot);
  const hasFinalMarker = entries.includes(finalName);
  const hasPendingMarker = entries.includes(pendingName);
  const markers = [
    ...(hasFinalMarker ? [win32.join(normalizedRoot, finalName)] : []),
    ...(hasPendingMarker ? [win32.join(normalizedRoot, pendingName)] : []),
  ];
  const files = [...new Set([...markers, ...extraFiles])];
  inspectWindowsChain(rt, chain, { custodyRoot: normalizedRoot, files });
  for (const file of files) {
    verifyWindowsFile(rt, file, {
      size: markers.includes(file) ? 0 : undefined,
    });
  }
  if (hasFinalMarker) return;
  if (hasPendingMarker) {
    const permitted = new Set([
      pendingName,
      DATABASE_FILE_NAME,
      `${DATABASE_FILE_NAME}-shm`,
      `${DATABASE_FILE_NAME}-wal`,
    ]);
    if (entries.some((entry) => !permitted.has(entry))) {
      throw unsafeFilesystemEntry(
        'Interrupted local application root contains unexpected artifacts.',
      );
    }
    return;
  }
  if (entries.length > 0) {
    throw unsafeFilesystemEntry(
      'Existing local application data root is populated but has no valid ownership marker.',
    );
  }
}

/** `validateLocalDatabaseStorage()` on Windows: one read-only inspection. */
function validateWindowsStorage(
  paths: { root: string; database: string },
  sourceRoot: string,
  appId: string,
): void {
  const root = validateWindowsPath(
    paths.root,
    'Local application data root',
    WINDOWS_DERIVED_PATH_RESERVE,
  );
  preflightWindowsRoot(root, sourceRoot, appId, [
    win32.join(root, `${ROOT_MARKER_PREFIX}${appId}`),
    validateWindowsPath(paths.database, 'Local application database'),
  ]);
}

/**
 * The Windows initialization lease: the beside-data `.smrt-lease-<key>`
 * directory and its SQLite lock file, created under the W6 rule and locked
 * with the lock-only worker (the lease file holds no data, so this needs no
 * secure-file support from the SDK). There are no legacy `/tmp` leases: no
 * release ever initialized on Windows. The key hashes the case-folded
 * realpath-canonical root, so spellings of one directory share one lease.
 */
async function acquireWindowsInitializationLock(
  root: string,
): Promise<LocalInitializationLock> {
  const rt: WindowsCustodyRuntime = custodyContext().windows;
  const normalizedRoot = validateWindowsPath(
    root,
    'Local application data root',
    WINDOWS_DERIVED_PATH_RESERVE,
  );
  const key = createHash('sha256')
    .update(windowsCanonicalIdentity(rt, normalizedRoot))
    .digest('hex')
    .slice(0, 32);
  const leaseDirectory = win32.join(
    win32.dirname(normalizedRoot),
    `${LEASE_DIRECTORY_PREFIX}${key}`,
  );
  const leaseFile = win32.join(leaseDirectory, 'initialization.sqlite');
  preparePrivateWindowsTree(rt, {
    directory: leaseDirectory,
    file: { path: leaseFile },
  });
  return acquireInitializationDatabaseLease(leaseFile, leaseDirectory, true);
}
