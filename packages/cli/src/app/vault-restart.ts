/**
 * Guided vault restart and rotation, resumable from one call (#4838).
 *
 * A restart touches three stores that are written one after another and so
 * can be left disagreeing by a crash: the key lifecycle (the account this
 * device seals for), `vault-sync.json` (the account the location's position
 * follows) and the host's trusted configuration (the account the app and its
 * backup target follow). This module adds no new state. It reads those
 * stores, works out which step each is at, and runs only the missing steps
 * through the code that already owns each store: `restartAccount`,
 * `switchVaultAccount` and the host's own config writer.
 *
 * Order (each step is idempotent and safe to repeat):
 *
 * 1. `key-lifecycle`: `restartAccount` parks the old account and creates the
 *    new one. The only step that needs the new recovery secret. Until it has
 *    run, nothing else may move.
 * 2. `publish`: the host publishes the returned head, authority record and
 *    recovery record to the new account. Not observable from the stores, so
 *    it repeats whenever the restart is not finished; the host's publish must
 *    be idempotent.
 * 3. `sync-position`: `switchVaultAccount` moves `vault-sync.json` to the new
 *    account at sequence zero. It resets the downgrade floor, so it only runs
 *    once the lifecycle proves this exact restart.
 * 4. `host-config`: the host starts following the new account. Last of the
 *    pointers on purpose: until it flips, the app and a backup still target
 *    the old account while the keys are on the new one, and the backup refuses
 *    (`account_mismatch`) before anything is sealed, so a half restart fails
 *    closed rather than writing into the wrong line.
 * 5. `backup`: the first backup of the new account, a full baseline, taken
 *    immediately. Done once `vault-sync.json` records a published sequence.
 *
 * `discardPreviousAccount()` is not a step: it waits for the other devices to
 * join and is the caller's decision.
 *
 * The caller holds the operation lock, as `switchVaultAccount` requires.
 */

import {
  readVaultSyncRecord,
  type SwitchVaultAccountOptions,
  switchVaultAccount,
} from '@happyvertical/smrt-app-runtime';
import type {
  VaultKeyLifecycle,
  VaultRestartResult,
  VaultRotationResult,
} from '@happyvertical/smrt-app-runtime/vault-key-lifecycle';
import { redactSecrets } from './errors.js';

/** The host's trusted configuration for the account this location follows. */
export interface VaultHostConfig {
  /** The followed vault account, `null` when none is recorded. */
  followedAccount(): Promise<string | null>;
  /** Follow `accountId` from now on. Must be idempotent. */
  followAccount(accountId: string): Promise<void>;
}

export type VaultRestartStepName =
  | 'key-lifecycle'
  | 'publish'
  | 'sync-position'
  | 'host-config'
  | 'backup';

export type VaultStepOutcome = 'done' | 'already-done' | 'failed' | 'not-run';

/** Which account one store follows, relative to the restart. */
export type VaultStoreAccount = 'from' | 'to' | 'none' | 'other';

/** A failure with no free text from the caller's collaborators. */
export interface VaultStepFailure {
  name: string;
  code?: string;
  message: string;
}

export interface VaultRestartStep {
  step: VaultRestartStepName;
  outcome: VaultStepOutcome;
  error?: VaultStepFailure;
}

export interface VaultRestartStores {
  /** The account this device seals for, `none` while parked mid-restart. */
  keyLifecycle: VaultStoreAccount;
  /** The account `vault-sync.json` follows. */
  syncPosition: VaultStoreAccount;
  /** The account the host configuration follows. */
  hostConfig: VaultStoreAccount;
}

/**
 * - `complete`: all steps done, in this call or found already done (a repeat
 *   call changes nothing).
 * - `resumed`: an earlier call stopped part way; this one finished it.
 * - `mismatch`: the stores disagree and the restart is not finished. When
 *   `repairable`, a step failed here and calling again resumes it; otherwise
 *   a store follows an account that is neither `from` nor `to`, nothing was
 *   changed, and a person must look.
 * - `backup_failed`: everything moved but the immediate first backup failed.
 *   Loud on purpose, see {@link VaultRestartReport.message}.
 */
export type VaultRestartState =
  | 'complete'
  | 'resumed'
  | 'mismatch'
  | 'backup_failed';

/** What a backup right after a key change did. */
export type VaultBackupAfterRotation = 'done' | 'failed' | 'skipped';

export interface VaultRestartReport {
  state: VaultRestartState;
  from: string;
  to: string;
  /** The stores as they stand at the end of the call. */
  stores: VaultRestartStores;
  steps: VaultRestartStep[];
  backupAfterRotation: VaultBackupAfterRotation;
  /** False only when nothing was run because a store is unrecognised. */
  repairable: boolean;
  message: string;
  at: string;
}

export interface VaultRestartOptions {
  /** The account being replaced, and the restarted one. */
  from: string;
  to: string;
  deviceId: string;
  /** The NEW recovery secret. Only used when the restart is not finished. */
  recoverySecret: string;
  /** Private state root holding `vault-sync.json`. */
  stateRoot: string;
  lifecycle: Pick<
    VaultKeyLifecycle,
    'status' | 'previousAccount' | 'restartAccount'
  >;
  hostConfig: VaultHostConfig;
  /** Relay lease client for the NEW account (must report it empty). */
  lease: SwitchVaultAccountOptions['lease'];
  /** Publish the new account's head and records. Must be idempotent. */
  publish(publication: VaultRestartResult): Promise<void>;
  /**
   * Back up now under the host's normal path. Resolve once a snapshot is
   * published (the lease keeper then records the sequence in
   * `vault-sync.json`); reject on failure.
   */
  backup(): Promise<void>;
  operationInstance?: string;
  now?: () => Date;
}

const STEPS: VaultRestartStepName[] = [
  'key-lifecycle',
  'publish',
  'sync-position',
  'host-config',
  'backup',
];

function account(
  id: string | null | undefined,
  from: string,
  to: string,
): VaultStoreAccount {
  if (id === null || id === undefined) return 'none';
  return id === from ? 'from' : id === to ? 'to' : 'other';
}

/** What the three stores say now. Read-only. */
export interface VaultRestartInspection {
  stores: VaultRestartStores;
  /** The first backup of the new account is recorded. */
  backedUp: boolean;
  /** Every store is at the new account and the first backup is recorded. */
  finished: boolean;
  /** No store is at an account other than `from` or `to`. */
  repairable: boolean;
  /** The restart began: this call would resume it, not start it. */
  started: boolean;
}

/**
 * Read the three stores and say where each is. Changes nothing, so a host can
 * call it at startup to detect an interrupted restart.
 */
export async function inspectVaultRestart(
  options: Pick<
    VaultRestartOptions,
    'from' | 'to' | 'stateRoot' | 'lifecycle' | 'hostConfig'
  >,
): Promise<VaultRestartInspection> {
  const { from, to } = options;
  const [status, previous, followed] = await Promise.all([
    options.lifecycle.status(),
    options.lifecycle.previousAccount(),
    options.hostConfig.followedAccount(),
  ]);
  let keyLifecycle: VaultStoreAccount;
  if (status === null) {
    // Parked mid-restart: no current account, the old one held.
    keyLifecycle = previous?.accountId === from ? 'none' : 'other';
  } else if (status.accountId === to) {
    // Only this exact restart counts, not an account created from scratch.
    keyLifecycle =
      previous?.accountId === from && !previous.interrupted ? 'to' : 'other';
  } else if (status.accountId === from) {
    keyLifecycle =
      previous === null || previous.accountId === from ? 'from' : 'other';
  } else {
    keyLifecycle = 'other';
  }
  let sync: ReturnType<typeof readVaultSyncRecord>;
  let syncPosition: VaultStoreAccount;
  try {
    sync = readVaultSyncRecord(options.stateRoot);
    syncPosition = account(sync?.accountId, from, to);
  } catch {
    sync = null;
    syncPosition = 'other';
  }
  const stores = {
    keyLifecycle,
    syncPosition,
    hostConfig: account(followed, from, to),
  };
  const backedUp = syncPosition === 'to' && (sync?.baseSequence ?? 0) > 0;
  const values = Object.values(stores);
  return {
    stores,
    backedUp,
    finished: values.every((value) => value === 'to') && backedUp,
    repairable: !values.includes('other'),
    // The host configuration may have been set ahead by the account layer.
    started:
      keyLifecycle === 'none' || keyLifecycle === 'to' || syncPosition === 'to',
  };
}

function failureOf(error: unknown, secrets: string[]): VaultStepFailure {
  const name = error instanceof Error ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const environment = Object.fromEntries(
    secrets.map((secret, index) => [`SECRET_${index}`, secret]),
  );
  return {
    name,
    ...(typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code)
      ? { code }
      : {}),
    message: redactSecrets(raw, environment, { strict: true }).slice(0, 300),
  };
}

/**
 * Restart the vault on this device, or finish a restart an earlier call left
 * part way. Safe to call again at any point and when nothing is left to do.
 *
 * Never throws for a failed step: the failure is in the report, with the
 * stores as they now stand. Nothing in the report carries the recovery
 * secret or any key.
 */
export async function restartVault(
  options: VaultRestartOptions,
): Promise<VaultRestartReport> {
  const { from, to } = options;
  const now = options.now ?? (() => new Date());
  const secrets = [options.recoverySecret];
  const before = await inspectVaultRestart(options);
  const steps: VaultRestartStep[] = STEPS.map((step) => ({
    step,
    outcome: 'not-run',
  }));
  const set = (
    step: VaultRestartStepName,
    outcome: VaultStepOutcome,
    error?: VaultStepFailure,
  ) => {
    const entry = steps.find((candidate) => candidate.step === step);
    if (entry) {
      entry.outcome = outcome;
      if (error) entry.error = error;
    }
  };
  const report = (
    state: VaultRestartState,
    stores: VaultRestartStores,
    message: string,
    extra: Partial<Pick<VaultRestartReport, 'repairable'>> = {},
  ): VaultRestartReport => ({
    state,
    from,
    to,
    stores,
    steps,
    backupAfterRotation:
      steps[4].outcome === 'done'
        ? 'done'
        : steps[4].outcome === 'failed'
          ? 'failed'
          : 'skipped',
    repairable: extra.repairable ?? true,
    message,
    at: now().toISOString(),
  });

  if (!before.repairable) {
    return report(
      'mismatch',
      before.stores,
      'A store follows a vault account that is neither the one being replaced nor the new one. Nothing was changed; inspect the key lifecycle, vault-sync.json and the host configuration.',
      { repairable: false },
    );
  }
  if (before.finished) {
    for (const entry of steps) entry.outcome = 'already-done';
    return report('complete', before.stores, 'The vault restart is complete.');
  }

  // The publication is not stored anywhere but the lifecycle, and whether it
  // reached the relay is not observable, so an unfinished restart asks the
  // lifecycle for it again (idempotent for the same secret) and republishes.
  const restart = () =>
    options.lifecycle.restartAccount({
      accountId: to,
      deviceId: options.deviceId,
      recoverySecret: options.recoverySecret,
      confirmRestart: true,
    });
  let publication: VaultRestartResult | undefined;
  const plan: Array<[VaultRestartStepName, boolean, () => Promise<void>]> = [
    [
      'key-lifecycle',
      before.stores.keyLifecycle === 'to',
      async () => {
        publication = await restart();
      },
    ],
    [
      'publish',
      false,
      async () => {
        publication ??= await restart();
        await options.publish(publication);
      },
    ],
    [
      'sync-position',
      before.stores.syncPosition === 'to',
      async () => {
        await switchVaultAccount({
          stateRoot: options.stateRoot,
          lifecycle: options.lifecycle,
          from,
          to,
          lease: options.lease,
          operationInstance: options.operationInstance,
        });
      },
    ],
    [
      'host-config',
      before.stores.hostConfig === 'to',
      async () => {
        await options.hostConfig.followAccount(to);
        if ((await options.hostConfig.followedAccount()) !== to) {
          throw Object.assign(
            new Error('The host did not follow the account'),
            {
              code: 'host_config_unchanged',
            },
          );
        }
      },
    ],
    [
      'backup',
      before.backedUp,
      async () => {
        await options.backup();
        // A backup that left no recorded position cannot be told from one
        // that never ran, and the next call would repeat it.
        if (!(await inspectVaultRestart(options)).backedUp) {
          throw Object.assign(
            new Error('vault-sync.json does not record a published sequence'),
            { code: 'backup_not_recorded' },
          );
        }
      },
    ],
  ];
  let failed: VaultStepFailure | undefined;
  let failedStep: VaultRestartStepName | undefined;
  for (const [step, already, run] of plan) {
    if (already) {
      set(step, 'already-done');
      continue;
    }
    try {
      await run();
      set(step, 'done');
    } catch (error) {
      failed = failureOf(error, secrets);
      failedStep = step;
      set(step, 'failed', failed);
      break;
    }
  }
  publication = undefined;
  const resumed = before.started;

  const after = await inspectVaultRestart(options).catch(() => before);
  if (failed === undefined) {
    return report(
      resumed ? 'resumed' : 'complete',
      after.stores,
      resumed
        ? 'An interrupted vault restart was finished.'
        : 'The vault restart is complete.',
    );
  }
  if (failedStep === 'backup') {
    return report(
      'backup_failed',
      after.stores,
      'The vault restart finished but the immediate first backup of the new account failed. The new account holds no snapshot yet, so nothing can be restored from it until a backup succeeds. Call restartVault again, or back up, until it does.',
    );
  }
  return report(
    'mismatch',
    after.stores,
    `The vault restart stopped at the ${failedStep} step (${failed.code ?? failed.name}) and the stores disagree. Fix the cause and call restartVault again; it resumes from the first missing step.`,
  );
}

export type VaultRotationState =
  | 'complete'
  | 'backup_failed'
  | 'publish_failed';

export interface VaultRotationReport {
  state: VaultRotationState;
  /** The new key generation, as a decimal string. */
  generation: string;
  backupAfterRotation: VaultBackupAfterRotation;
  message: string;
  error?: VaultStepFailure;
  at: string;
}

export interface VaultRotationOptions {
  lifecycle: Pick<VaultKeyLifecycle, 'rotate'>;
  recoverySecret: string;
  newRecoverySecret?: string;
  /** Publish the rotation (head, records, device grants). Idempotent. */
  publish(rotation: VaultRotationResult): Promise<void>;
  /** Back up under the new generation, right now. */
  backup(): Promise<void>;
  now?: () => Date;
}

/**
 * Rotate the vault keys and back up immediately (smrt#4834, owner decision).
 *
 * Restore refuses snapshots sealed under the older generation until an
 * enrolled device publishes a new one, so the window between rotating and the
 * first backup is the window in which losing the last device loses the
 * history. Hosts rotate through this function rather than calling
 * `lifecycle.rotate` directly. A lifecycle refusal (wrong secret, nothing to
 * rotate) is thrown unchanged: nothing happened.
 */
export async function rotateVaultKeys(
  options: VaultRotationOptions,
): Promise<VaultRotationReport> {
  const now = options.now ?? (() => new Date());
  const secrets = [options.recoverySecret, options.newRecoverySecret].filter(
    (secret): secret is string => typeof secret === 'string',
  );
  const rotation = await options.lifecycle.rotate({
    recoverySecret: options.recoverySecret,
    ...(options.newRecoverySecret === undefined
      ? {}
      : { newRecoverySecret: options.newRecoverySecret }),
  });
  const generation = rotation.generation.toString();
  const result = (
    state: VaultRotationState,
    backupAfterRotation: VaultBackupAfterRotation,
    message: string,
    error?: VaultStepFailure,
  ): VaultRotationReport => ({
    state,
    generation,
    backupAfterRotation,
    message,
    ...(error ? { error } : {}),
    at: now().toISOString(),
  });
  try {
    await options.publish(rotation);
  } catch (error) {
    return result(
      'publish_failed',
      'skipped',
      `The keys rotated to generation ${generation} but publishing the rotation failed, so no backup was taken. Publish the account head, then back up: snapshots from the older generation are refused on restore until a new one is published.`,
      failureOf(error, secrets),
    );
  }
  try {
    await options.backup();
  } catch (error) {
    return result(
      'backup_failed',
      'failed',
      `The keys rotated to generation ${generation} but the immediate backup failed. Snapshots from the older generation are refused on restore until a backup under the new generation succeeds; losing the last device before then loses the history. Back up again now.`,
      failureOf(error, secrets),
    );
  }
  return result(
    'complete',
    'done',
    `The keys rotated to generation ${generation} and the backup under it was published.`,
  );
}
