/**
 * `smrt app restore-latest` (#4805): replace the local data root with the
 * vault account's latest snapshot, then make this device the primary writer's
 * successor.
 *
 * Order (security review on #4668):
 * 1. Under `operation.lock` and the writer lease (taken with swap recovery
 *    allowed), settle any interrupted swap. Nothing else can write: the web
 *    process and every operator command need the same lease, so no SQLite
 *    connection is open on the live root while it is replaced (smrt#3379).
 * 2. Refuse a retired location (moved away or migrated to the cloud) and an
 *    unreadable custody record, so a restore never undoes a retirement.
 *    Refuse to discard unpublished local writes without `--discard-local`,
 *    and refuse a latest sequence below this location's highest seen one
 *    (the relay is untrusted; the sequence is bound into every envelope).
 * 3. Acquire the relay lease with base = the target sequence, so no other
 *    device can publish past it while this one restores.
 * 4. Download the ciphertext beside the data root, decrypt it into a new
 *    candidate (authenticated against the trusted account and sequence), and
 *    verify SQLite integrity and the installation it carries.
 * 5. Swap the roots under the journal (rollback on failure) and record the
 *    new vault position. Installation custody moves here only on the
 *    operator's explicit `--origin-retired` (#4704): releasing the relay
 *    lease does not stop the origin, which may re-acquire.
 */

import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  acquireWriterLease,
  dataRootSiblingPath,
  inspectDataRootInstallation,
  inspectLocationCustodyRecord,
  readActiveWriterLease,
  readVaultSyncRecord,
  recoverDataRootSwap,
  removeStaleRestoreSiblings,
  restoreInstallation,
  swapDataRoot,
  type VaultLeaseClient,
  vaultSyncFor,
  withOperationLock,
  writeVaultSyncRecord,
} from '@happyvertical/smrt-app-runtime';
import { errorCode } from './errors.js';
import { type AppContext, preparedStateRoot } from './runtime.js';
import {
  decryptSnapshot,
  type SnapshotKeyProvider,
} from './snapshot-framing.js';

/** Usage of `smrt app restore-latest`. */
export const RESTORE_LATEST_USAGE =
  'Usage: smrt app restore-latest [--discard-local] [--replace-installation] [--origin-retired] [--recover]';

/** Latest snapshot on a vault target, as the relay client reports it. */
export interface VaultSnapshotReference {
  sequence: number;
  /** Device that produced it; checked by the envelope's authenticated data. */
  deviceId: string;
}

/**
 * Read side of a vault backup target (the relay client of #4804 implements
 * it). Values are untrusted: the snapshot's own authentication decides.
 */
export interface VaultSnapshotSource {
  /** Latest committed snapshot, or `null` when the account has none. */
  latest(): Promise<VaultSnapshotReference | null>;
  /** Write that snapshot's ciphertext to `destination`, a new file. */
  download(sequence: number, destination: string): Promise<void>;
}

/** Vault collaborators for restore-latest, supplied by the embedding host. */
export interface VaultRestoreProvider {
  /** The vault account this installation follows (trusted local config). */
  accountId: string;
  lease: VaultLeaseClient;
  snapshots: VaultSnapshotSource;
  /** Application schema compatibility check of the candidate root. */
  verifyCandidate?(root: string): Promise<void> | void;
}

/** Restore refusal with a stable code for callers and the UI. */
export class RestoreLatestError extends Error {
  readonly code:
    | 'vault_not_configured'
    | 'local_writes_pending'
    | 'no_snapshot'
    | 'downgrade_refused'
    | 'candidate_invalid'
    | 'installation_mismatch'
    | 'location_retired'
    | 'custody_unusable'
    | 'writer_lost';

  constructor(code: RestoreLatestError['code'], message: string) {
    super(message);
    this.name = 'RestoreLatestError';
    this.code = code;
  }
}

/** Options for {@link restoreLatest}. */
export interface RestoreLatestOptions {
  appId: string;
  sourceRoot: string;
  dataDirectory?: string;
  stateRoot: string;
  /** The live data root (`resolveLocalRuntimePaths(...).root`). */
  liveRoot: string;
  operationInstance?: string;
  /** Required unless `recoverOnly`. */
  vault?: VaultRestoreProvider;
  keys?: Pick<SnapshotKeyProvider, 'openingKey'>;
  /** Replace unpublished local writes. The previous root is always kept. */
  discardLocal?: boolean;
  /** Accept a snapshot of a different installation than the live one. */
  replaceInstallation?: boolean;
  /**
   * Operator asserts the device the snapshot came from is no longer active,
   * so installation custody moves here (`restoreInstallation`). Without it
   * custody stays pending and the app refuses to start until declared.
   */
  originRetired?: boolean;
  /** Only settle an interrupted swap. */
  recoverOnly?: boolean;
}

/** Secret-free outcome. */
export interface RestoreLatestReport {
  schemaVersion: 1;
  status: 'restored' | 'up-to-date' | 'recovered';
  recovery: 'none' | 'rolled-back' | 'finished';
  sequence: number | null;
  previousRoot: string | null;
  custody: 'moved' | 'pending';
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** SQLite integrity of the candidate. The connection closes before the swap. */
function verifyDatabase(candidate: string): void {
  const file = join(candidate, 'application.sqlite');
  if (!exists(file)) {
    throw new RestoreLatestError(
      'candidate_invalid',
      'The snapshot does not contain an application database.',
    );
  }
  let database: DatabaseSync | undefined;
  try {
    // Read-write, so a WAL left in the snapshot is checkpointed into the
    // candidate rather than leaving a shared-memory file behind.
    database = new DatabaseSync(file);
    const rows = database.prepare('PRAGMA integrity_check').all() as Array<
      Record<string, unknown>
    >;
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') {
      throw new Error('integrity');
    }
  } catch {
    throw new RestoreLatestError(
      'candidate_invalid',
      'The snapshot database failed its integrity check.',
    );
  } finally {
    database?.close();
  }
}

/** The candidate must carry one consistent installation, the live one unless replacing. */
function verifyInstallation(
  candidate: string,
  liveRoot: string,
  replaceInstallation: boolean,
): void {
  const restored = inspectDataRootInstallation(join(candidate, 'secrets'));
  if (restored.status !== 'consistent' && restored.status !== 'unrecorded') {
    throw new RestoreLatestError(
      'candidate_invalid',
      `The snapshot's installation identity is not usable (${restored.status}).`,
    );
  }
  if (!exists(liveRoot) || replaceInstallation) return;
  const current = exists(join(liveRoot, 'secrets'))
    ? inspectDataRootInstallation(join(liveRoot, 'secrets'))
    : ({ installationId: null, status: 'empty' } as const);
  const comparable =
    current.status === 'consistent' ||
    current.status === 'unrecorded' ||
    current.status === 'empty';
  if (
    !comparable ||
    (current.installationId !== null &&
      current.installationId !== restored.installationId)
  ) {
    throw new RestoreLatestError(
      'installation_mismatch',
      'The snapshot belongs to a different installation than this data root; pass --replace-installation to replace it.',
    );
  }
}

/**
 * Restore the vault account's latest snapshot into the live data root. The
 * caller holds `operation.lock`; this takes the writer lease itself.
 */
export async function restoreLatest(
  options: RestoreLatestOptions,
): Promise<RestoreLatestReport> {
  const { stateRoot, liveRoot } = options;
  const writer = acquireWriterLease(stateRoot, {
    operationInstance: options.operationInstance,
    dataRootSwapRecovery: true,
  });
  try {
    const recovery = recoverDataRootSwap(stateRoot, liveRoot);
    // No swap is pending now: plaintext left by a crash before the journal
    // existed (candidate, decrypt staging, ciphertext) is removed.
    removeStaleRestoreSiblings(liveRoot);
    if (options.recoverOnly) {
      return {
        schemaVersion: 1,
        status: 'recovered',
        recovery,
        sequence: null,
        previousRoot: null,
        custody: 'pending',
      };
    }
    const { vault, keys } = options;
    if (!vault || !keys) {
      throw new RestoreLatestError(
        'vault_not_configured',
        'Restore-latest needs a vault account and key provider, and none is configured for this installation.',
      );
    }
    // A location whose installation was moved away (a move, or a migration
    // to the cloud, #4806) must not be silently brought back into service by
    // a restore: the swap would put a live-looking data root where the
    // retirement says none belongs, and `--origin-retired` would re-activate
    // it. The operator reverses a retirement explicitly first.
    const location = inspectLocationCustodyRecord(stateRoot);
    if (location === 'retired') {
      throw new RestoreLatestError(
        'location_retired',
        'This location was retired (its installation moved to another device or to the cloud), so restoring here would silently put it back in service; run "smrt app installation restore --origin-retired" first if that is what you intend.',
      );
    }
    if (location === 'invalid') {
      throw new RestoreLatestError(
        'custody_unusable',
        'The installation custody record of this location cannot be verified; run "smrt app installation status" and resolve it before restoring.',
      );
    }
    const sync = vaultSyncFor(stateRoot, vault.accountId);
    // A data root with no recorded vault position may hold writes nobody
    // published, exactly like one whose keeper marked writes pending.
    const unpublished =
      sync.localWritesPending ||
      (readVaultSyncRecord(stateRoot) === null &&
        exists(join(liveRoot, 'application.sqlite')));
    if (unpublished && !options.discardLocal) {
      throw new RestoreLatestError(
        'local_writes_pending',
        'This device may have writes that were never published; publish them, or pass --discard-local to replace them (the current data root is kept).',
      );
    }
    const latest = await vault.snapshots.latest();
    if (!latest) {
      throw new RestoreLatestError(
        'no_snapshot',
        'The vault account has no snapshot to restore.',
      );
    }
    if (
      !Number.isSafeInteger(latest.sequence) ||
      latest.sequence < 1 ||
      latest.sequence < sync.highestSeenSequence
    ) {
      throw new RestoreLatestError(
        'downgrade_refused',
        `The vault offered sequence ${latest.sequence}, older than sequence ${sync.highestSeenSequence} this device has already seen.`,
      );
    }
    if (
      latest.sequence === sync.baseSequence &&
      exists(liveRoot) &&
      !unpublished
    ) {
      return {
        schemaVersion: 1,
        status: 'up-to-date',
        recovery,
        sequence: latest.sequence,
        previousRoot: null,
        custody: 'pending',
      };
    }

    const grant = await vault.lease.acquire(latest.sequence);
    const download = dataRootSiblingPath(liveRoot, 'download');
    const candidate = dataRootSiblingPath(liveRoot, 'restore');
    let swapped = false;
    let previousRoot: string | null = null;
    try {
      mkdirSync(dirname(liveRoot), { recursive: true, mode: 0o700 });
      await vault.snapshots.download(latest.sequence, download);
      await vault.lease.renew(grant.fencingToken);
      await decryptSnapshot({
        source: download,
        destination: candidate,
        context: {
          accountId: vault.accountId,
          deviceId: latest.deviceId,
          sequence: BigInt(latest.sequence),
        },
        keys,
        expectedKind: 'data-root',
      });
      rmSync(download, { force: true });
      verifyDatabase(candidate);
      verifyInstallation(
        candidate,
        liveRoot,
        options.replaceInstallation === true,
      );
      await vault.verifyCandidate?.(candidate);
      await vault.lease.renew(grant.fencingToken);
      const result = await swapDataRoot({
        stateRoot,
        liveRoot,
        candidateRoot: candidate,
        // Always kept: nothing in the running app marks writes made after the
        // last recorded publish yet (#4810), so "published" cannot be proven
        // from the position record alone. Never auto-deleted.
        keepPrevious: true,
        assertWriter: () => {
          if (readActiveWriterLease(stateRoot)?.pid !== process.pid) {
            throw new RestoreLatestError(
              'writer_lost',
              'The local writer lease changed during the restore.',
            );
          }
        },
      });
      swapped = true;
      previousRoot = result.previousRoot;
      // Only after the commit: a rolled-back swap must never claim the new
      // base, or the next acquire would succeed on old data. A failure here
      // fails safe (the old base is refused), but say what to do.
      try {
        writeVaultSyncRecord(stateRoot, {
          accountId: vault.accountId,
          baseSequence: latest.sequence,
          highestSeenSequence: Math.max(
            sync.highestSeenSequence,
            latest.sequence,
          ),
          localWritesPending: false,
        });
      } catch (error) {
        throw new Error(
          `The data root was restored to sequence ${latest.sequence}, but its vault position could not be recorded; run restore-latest again before writing.`,
          { cause: error },
        );
      }
    } finally {
      rmSync(download, { force: true });
      if (!swapped) rmSync(candidate, { recursive: true, force: true });
      await vault.lease.release(grant.fencingToken).catch(() => undefined);
    }

    let custody: RestoreLatestReport['custody'] = 'pending';
    if (options.originRetired === true) {
      try {
        await restoreInstallation({
          appId: options.appId,
          dataDirectory: options.dataDirectory,
          sourceRoot: options.sourceRoot,
          operationInstance: options.operationInstance,
          originRetired: true,
        });
        custody = 'moved';
      } catch {
        custody = 'pending';
      }
    }
    return {
      schemaVersion: 1,
      status: 'restored',
      recovery,
      sequence: latest.sequence,
      previousRoot,
      custody,
    };
  } finally {
    writer.release();
  }
}

/** `smrt app restore-latest [--discard-local] [--replace-installation] [--origin-retired] [--recover]`. */
export async function runRestoreLatestOperation(
  context: AppContext,
  args: string[],
): Promise<number> {
  const known = new Set([
    '--discard-local',
    '--replace-installation',
    '--origin-retired',
    '--recover',
  ]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown !== undefined) {
    throw new Error(`Unknown restore-latest argument. ${RESTORE_LATEST_USAGE}`);
  }
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  if (runtime.profile !== 'local') {
    throw new Error('app:restore-latest is local-profile only.');
  }
  const dataDirectory = process.env.SMRT_DATA_DIR;
  const paths = context.deps.runtime.resolveLocalRuntimePaths({
    appId: context.appId,
    dataDirectory,
    sourceRoot: context.sourceRoot,
  });
  const stateRoot = preparedStateRoot(context);
  const report = await withOperationLock(stateRoot, 'restore-latest', (lock) =>
    restoreLatest({
      appId: context.appId,
      sourceRoot: context.sourceRoot,
      dataDirectory,
      stateRoot,
      liveRoot: paths.root,
      operationInstance: lock.instance,
      vault: context.deps.vaultRestore,
      keys: context.deps.snapshotKeys,
      discardLocal: args.includes('--discard-local'),
      replaceInstallation: args.includes('--replace-installation'),
      originRetired: args.includes('--origin-retired'),
      recoverOnly: args.includes('--recover'),
    }),
  );
  context.io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}
