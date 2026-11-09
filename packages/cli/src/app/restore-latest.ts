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
 *    verify SQLite integrity and the installation it carries. The relay lease
 *    is renewed on a timer through the download and decrypt (the lease is
 *    shorter than a large download) and a lost lease aborts them. The snapshot
 *    must come from a device the adopted account head has not revoked and be
 *    sealed at or above that head's key-generation floor.
 * 5. Swap the roots under the journal (rollback on failure) and record the
 *    new vault position. Installation custody moves here only on the
 *    operator's explicit `--origin-retired` (#4704): releasing the relay
 *    lease does not stop the origin, which may re-acquire. The key provider's
 *    sealing sequence moves above the relay head, so the next backup is not
 *    refused as behind a head this device just restored.
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
  VaultLeaseError,
  type VaultLeaseTimers,
  vaultSyncFor,
  withOperationLock,
  writeVaultSyncRecord,
} from '@happyvertical/smrt-app-runtime';
import { errorCode } from './errors.js';
import { type AppContext, preparedStateRoot } from './runtime.js';
import {
  decryptSnapshot,
  readSnapshotHeader,
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
  /**
   * Write that snapshot's ciphertext to `destination`, a new file. When
   * `signal` aborts (the relay lease was lost) the download stops and rejects.
   */
  download(
    sequence: number,
    destination: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

/**
 * What the adopted, signed account head says about whom to believe. The relay
 * is untrusted, so which devices are revoked and which key generations may
 * still be accepted come from the local key lifecycle, never the relay.
 */
export interface VaultAccountTrust {
  /** Lowest key generation a restored snapshot may be sealed under. */
  minimumGeneration: bigint;
  /** Devices the head has revoked; their snapshots are never restored. */
  revokedDeviceIds: readonly string[];
  /**
   * A revocation still waits for its key rotation, so the revoked device
   * still holds the current key and nothing about a snapshot can exclude it.
   * Restore refuses until the rotation is published.
   */
  rotationPending?: boolean;
}

/** Vault collaborators for restore-latest, supplied by the embedding host. */
export interface VaultRestoreProvider {
  /** The vault account this installation follows (trusted local config). */
  accountId: string;
  lease: VaultLeaseClient;
  snapshots: VaultSnapshotSource;
  /**
   * Revoked devices and the key-generation floor of the adopted account head
   * (`snapshotAccountTrustFromLifecycle` derives it from the key lifecycle).
   * Fails closed: restore refuses when it cannot be read.
   */
  accountTrust(): Promise<VaultAccountTrust>;
  /** Timer seam for lease renewal during the restore (tests, embedding). */
  leaseTimers?: VaultLeaseTimers;
  /** Monotonic milliseconds for renewal deadlines. Default `performance.now()`. */
  leaseMonotonicNow?: () => number;
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
    | 'writer_lost'
    | 'revoked_device'
    | 'rotation_pending'
    | 'generation_too_old'
    | 'account_state_unavailable'
    | 'relay_inconsistent';

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
  keys?: Pick<SnapshotKeyProvider, 'openingKey' | 'advanceSealingSequence'>;
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
  /**
   * The sequence this device's next backup must exceed after the restore, or
   * `null` when the key provider does not manage a sealing counter.
   */
  sealingFloor: number | null;
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

/** Furthest the relay's head may sit above its latest committed snapshot. */
const MAX_SEQUENCE_HOLE = 1_000;
/** Margin before a granted lease lapses, as in the lease keeper. */
const RENEWAL_SAFETY_MARGIN_MS = 5_000;

const defaultLeaseTimers: VaultLeaseTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Renews the relay lease on a timer while a long restore step runs. The relay
 * grants minutes; a download of a large snapshot can take longer. A refused
 * renewal (or relay failure past the lease's local deadline) aborts the step
 * through `signal` and is rethrown by {@link check}. Transient relay errors
 * are retried until the deadline, like the lease keeper.
 */
class LeaseRenewal {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly lease: VaultLeaseClient;
  private readonly timers: VaultLeaseTimers;
  private readonly now: () => number;
  private token: number;
  private deadline: number;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private failure: unknown;
  private stopped = false;

  constructor(
    vault: VaultRestoreProvider,
    granted: { fencingToken: number; ttlMs: number },
    sentAt: number,
  ) {
    this.lease = vault.lease;
    this.timers = vault.leaseTimers ?? defaultLeaseTimers;
    this.now = vault.leaseMonotonicNow ?? (() => performance.now());
    this.token = granted.fencingToken;
    this.deadline = sentAt + granted.ttlMs - RENEWAL_SAFETY_MARGIN_MS;
    this.signal = this.controller.signal;
    this.schedule(granted.ttlMs);
  }

  private schedule(delayBasisMs: number, fixed = false): void {
    if (this.stopped || this.failure !== undefined) return;
    this.timer = this.timers.set(
      () => {
        this.timer = null;
        this.inFlight = this.renew();
      },
      fixed ? delayBasisMs : Math.max(1_000, Math.floor(delayBasisMs / 3)),
    );
  }

  private async renew(): Promise<void> {
    const sentAt = this.now();
    try {
      const granted = await this.lease.renew(this.token);
      this.token = granted.fencingToken;
      this.deadline = sentAt + granted.ttlMs - RENEWAL_SAFETY_MARGIN_MS;
      this.schedule(granted.ttlMs);
    } catch (error) {
      if (
        error instanceof VaultLeaseError &&
        error.code === 'relay_error' &&
        this.now() < this.deadline
      ) {
        this.schedule(1_000, true);
        return;
      }
      this.failure = error;
      this.controller.abort();
    }
  }

  /** Throw the renewal failure, if any, once any renewal in flight settles. */
  async check(): Promise<void> {
    await this.inFlight;
    if (this.failure !== undefined) throw this.failure;
  }

  /** The fencing token to use for explicit renew and release calls. */
  get fencingToken(): number {
    return this.token;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}

/** The sequence the next backup must exceed; bounded against a hostile head. */
function sealingFloorFor(latest: number, head: number): number {
  if (!Number.isSafeInteger(head) || head > latest + MAX_SEQUENCE_HOLE) {
    throw new RestoreLatestError(
      'relay_inconsistent',
      `The vault relay reports its head at sequence ${head} but its latest snapshot at ${latest}; restore refuses a head that far ahead of any committed snapshot.`,
    );
  }
  return Math.max(latest, head);
}

/** Raise the key provider's sealing counter; `null` when it has none. */
async function advanceSealing(
  keys: Pick<SnapshotKeyProvider, 'advanceSealingSequence'>,
  floor: number,
): Promise<number | null> {
  if (!keys.advanceSealingSequence) return null;
  await keys.advanceSealingSequence(BigInt(floor));
  return floor;
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
        sealingFloor: null,
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
      // Already at the latest, but a device whose sealing counter sits at or
      // below the head would be refused on every backup, and restoring again
      // is how it is told to recover: so move the counter here too.
      const sealingFloor = keys.advanceSealingSequence
        ? await advanceSealing(
            keys,
            sealingFloorFor(
              latest.sequence,
              (await vault.lease.status()).headSequence,
            ),
          )
        : null;
      return {
        schemaVersion: 1,
        status: 'up-to-date',
        recovery,
        sequence: latest.sequence,
        previousRoot: null,
        custody: 'pending',
        sealingFloor,
      };
    }

    // The relay is untrusted: who produced the snapshot and which key
    // generation it may use are judged against the adopted signed head.
    let trust: VaultAccountTrust;
    try {
      trust = await vault.accountTrust();
      if (
        typeof trust?.minimumGeneration !== 'bigint' ||
        trust.minimumGeneration < 1n ||
        !Array.isArray(trust.revokedDeviceIds)
      ) {
        throw new Error('invalid');
      }
    } catch {
      throw new RestoreLatestError(
        'account_state_unavailable',
        'The vault account state (revoked devices and key generations) could not be read from this device, so the latest snapshot cannot be trusted; check "smrt app vault status".',
      );
    }
    if (trust.rotationPending === true) {
      throw new RestoreLatestError(
        'rotation_pending',
        'A device revocation on this account has not been rotated yet, so the revoked device still holds the current key and its snapshots cannot be told from real ones; rotate the vault keys first, then restore.',
      );
    }
    if (trust.revokedDeviceIds.includes(latest.deviceId)) {
      throw new RestoreLatestError(
        'revoked_device',
        'The latest snapshot was produced by a device that has been revoked from this account, so it is not restored. A device that is still enrolled must publish a new snapshot first.',
      );
    }

    const acquiredAt = (vault.leaseMonotonicNow ?? (() => performance.now()))();
    const grant = await vault.lease.acquire(latest.sequence);
    let sealingFloor: number | null = null;
    let renewal: LeaseRenewal | undefined;
    const download = dataRootSiblingPath(liveRoot, 'download');
    const candidate = dataRootSiblingPath(liveRoot, 'restore');
    let swapped = false;
    let previousRoot: string | null = null;
    try {
      const floor = sealingFloorFor(latest.sequence, grant.headSequence);
      mkdirSync(dirname(liveRoot), { recursive: true, mode: 0o700 });
      renewal = new LeaseRenewal(vault, grant, acquiredAt);
      try {
        await vault.snapshots.download(latest.sequence, download, {
          signal: renewal.signal,
        });
      } catch (error) {
        // A lost lease aborts the download; report that, not the abort.
        await renewal.check();
        throw error;
      }
      await renewal.check();
      await vault.lease.renew(renewal.fencingToken);
      const header = await readSnapshotHeader(download);
      if (header.generation < trust.minimumGeneration) {
        throw new RestoreLatestError(
          'generation_too_old',
          `The latest snapshot is sealed under key generation ${header.generation}, below generation ${trust.minimumGeneration} that the adopted account head requires after a device revocation, so it is not restored. A device that is still enrolled must publish a new snapshot first.`,
        );
      }
      await decryptSnapshot({
        source: download,
        destination: candidate,
        context: {
          accountId: vault.accountId,
          deviceId: latest.deviceId,
          sequence: BigInt(latest.sequence),
        },
        keys,
        minimumGeneration: trust.minimumGeneration,
        expectedKind: 'data-root',
      });
      await renewal.check();
      rmSync(download, { force: true });
      verifyDatabase(candidate);
      verifyInstallation(
        candidate,
        liveRoot,
        options.replaceInstallation === true,
      );
      await vault.verifyCandidate?.(candidate);
      await renewal.check();
      await renewal.stop();
      await vault.lease.renew(renewal.fencingToken);
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
      // The restored position is now the base. Move the sealing counter past
      // the relay head, or the next backup is refused as behind it and
      // restoring again could not fix that. A failure here is safe (the
      // backup is refused, not corrupted) and rerunning restore repeats this.
      try {
        sealingFloor = await advanceSealing(keys, floor);
      } catch (error) {
        throw new Error(
          `The data root was restored to sequence ${latest.sequence}, but this device's next snapshot sequence could not be moved past the vault head; run restore-latest again before backing up.`,
          { cause: error },
        );
      }
    } finally {
      await renewal?.stop();
      rmSync(download, { force: true });
      if (!swapped) rmSync(candidate, { recursive: true, force: true });
      await vault.lease
        .release(renewal?.fencingToken ?? grant.fencingToken)
        .catch(() => undefined);
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
      sealingFloor,
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
