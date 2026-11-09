/**
 * Move a location's vault position to a restarted account (#4817).
 *
 * After `lifecycle.restartAccount` created a new vault account on this
 * device, the location must stop following the old account and start the new
 * one at sequence zero. `vaultSyncFor` refuses that switch on purpose (one
 * location follows one account, so a copied record or a confused host cannot
 * move it), so the switch is its own operation with its own checks, and it
 * is the only code that resets the downgrade floor.
 *
 * It resets nothing it cannot justify: the lifecycle must hold the new
 * account and the old one as its parked previous account, the relay must
 * report the new account empty, and the location must still be active.
 */

import { inspectLocationCustodyRecord } from './installation-custody.js';
import type { VaultKeyLifecycle } from './vault-key-lifecycle.js';
import type { VaultLeaseClient } from './vault-lease.js';
import {
  readVaultSyncRecord,
  type VaultSyncRecord,
  writeVaultSyncRecord,
} from './vault-sync-state.js';
import { acquireWriterLease } from './writer-lease.js';

export type VaultAccountSwitchErrorCode =
  | 'restart_not_recorded'
  | 'not_following_from'
  | 'account_not_fresh'
  | 'location_retired'
  | 'custody_unusable';

const MESSAGES: Record<VaultAccountSwitchErrorCode, string> = {
  restart_not_recorded:
    'The key lifecycle on this device does not show a restart from the old vault account to the new one.',
  not_following_from:
    'This installation does not follow the vault account being replaced.',
  account_not_fresh:
    'The new vault account already holds snapshots; a restarted account must start empty.',
  location_retired:
    'This location was retired (its installation moved elsewhere), so it will not start following a vault account.',
  custody_unusable:
    'The installation custody record of this location cannot be verified.',
};

/** Refusal with a stable code and a fixed message. */
export class VaultAccountSwitchError extends Error {
  override readonly name = 'VaultAccountSwitchError';
  constructor(readonly code: VaultAccountSwitchErrorCode) {
    super(MESSAGES[code]);
  }
}

export interface SwitchVaultAccountOptions {
  /** Private state root holding `vault-sync.json`. */
  stateRoot: string;
  /** This device's key lifecycle: restarted, or enrolled after `leaveAccount`. */
  lifecycle: Pick<VaultKeyLifecycle, 'status' | 'previousAccount'>;
  /** The account the location follows now, the one being replaced. */
  from: string;
  /** The restarted account. */
  to: string;
  /** Lease client for the NEW account. */
  lease: Pick<VaultLeaseClient, 'status'>;
  /**
   * `restarted` (default): the device that ran `restartAccount`. The relay
   * must report the new account empty, and the next backup is a full
   * baseline. `follower`: a device that left the old account and enrolled in
   * the new one. The new account may already hold snapshots, and nothing is
   * marked pending, so the next step is restore-latest, never a backup over
   * the new account.
   */
  role?: 'restarted' | 'follower';
  /** The caller's `operation.lock` instance (the caller holds that lock). */
  operationInstance?: string;
}

/**
 * Start following `to` at sequence zero. Idempotent once the location follows
 * `to`. The caller holds the operation lock; this takes the writer lease
 * first and decides under it, so no web process or backup writes while the
 * position is read and changed.
 */
export async function switchVaultAccount(
  options: SwitchVaultAccountOptions,
): Promise<VaultSyncRecord> {
  const { stateRoot, from, to } = options;
  const follower = options.role === 'follower';
  const writer = acquireWriterLease(stateRoot, {
    operationInstance: options.operationInstance,
  });
  try {
    const current = readVaultSyncRecord(stateRoot);
    if (current?.accountId === to) return current;
    const custody = inspectLocationCustodyRecord(stateRoot);
    if (custody === 'retired') {
      throw new VaultAccountSwitchError('location_retired');
    }
    if (custody === 'invalid') {
      throw new VaultAccountSwitchError('custody_unusable');
    }
    if (current !== null && current.accountId !== from) {
      throw new VaultAccountSwitchError('not_following_from');
    }
    const [status, previous] = await Promise.all([
      options.lifecycle.status(),
      options.lifecycle.previousAccount(),
    ]);
    if (
      status?.accountId !== to ||
      previous?.accountId !== from ||
      previous.interrupted
    ) {
      throw new VaultAccountSwitchError('restart_not_recorded');
    }
    if (!follower) {
      const relay = await options.lease.status();
      if (relay.headSequence !== 0 || relay.latestCommittedSequence !== 0) {
        throw new VaultAccountSwitchError('account_not_fresh');
      }
    }
    return writeVaultSyncRecord(stateRoot, {
      accountId: to,
      baseSequence: 0,
      highestSeenSequence: 0,
      localWritesPending: !follower,
    });
  } finally {
    writer.release();
  }
}
