/**
 * Snapshot key custody from the vault key lifecycle (#4785 -> #4797).
 *
 * `createLifecycleSnapshotKeys` satisfies the {@link SnapshotKeyProvider}
 * seam of the encrypted snapshot framing from a
 * `@happyvertical/smrt-app-runtime/vault-key-lifecycle` instance:
 *
 * | Seam                  | Lifecycle                                          |
 * | --------------------- | -------------------------------------------------- |
 * | `sealingKey()`        | `openSealingKey()` (gated) + the caller's sequence |
 * | `openingKey(ref)`     | `status()` account check, then `openReadingKey()`  |
 *
 * Sealing a snapshot therefore only ever goes through the gated sealing path:
 * it is refused with `rotation_required` while a revocation waits for its
 * rotation, with `generation_conflict` after fork evidence, and with
 * `key_missing` when this device lacks the current key. It never falls back to
 * an older generation, and it never calls `openReadingKey`. The gate runs
 * before the snapshot sequence is requested, so a refused seal spends no
 * sequence. Reading is not gated, because restoring older data during a
 * pending rotation is legitimate; the framing never seals with a reading key.
 */

import type {
  VaultKeyLifecycle,
  VaultKeyLifecycleError,
} from '@happyvertical/smrt-app-runtime/vault-key-lifecycle';
import type {
  SnapshotKeyProvider,
  SnapshotKeyReference,
  SnapshotSealingKey,
} from './snapshot-framing.js';

/** The slice of the lifecycle the snapshot seam needs. */
export type SnapshotKeyLifecycle = Pick<
  VaultKeyLifecycle,
  'status' | 'openSealingKey' | 'openReadingKey'
>;

/** Options for {@link createLifecycleSnapshotKeys}. */
export interface LifecycleSnapshotKeysOptions {
  lifecycle: SnapshotKeyLifecycle;
  /**
   * Sequence for the next snapshot. Called only after the sealing gate has
   * opened; must be a positive bigint that the account has not used.
   */
  nextSequence(): bigint | Promise<bigint>;
  /**
   * Make `nextSequence()` return a value above `above` from now on (raise
   * the host's counter, never lower it). Supplying it lets restore-latest
   * move this device's sealing sequence past the restored head (#4805).
   */
  advanceSequence?(above: bigint): void | Promise<void>;
}

/** What restore-latest enforces about a snapshot, from the adopted head. */
export interface SnapshotAccountTrust {
  /** Lowest key generation a restored snapshot may be sealed under. */
  minimumGeneration: bigint;
  /** Devices the adopted head has revoked; their snapshots are refused. */
  revokedDeviceIds: string[];
  /**
   * A revocation (or fork evidence) still waits for the rotation that
   * excludes the device. Until then the revoked device holds the current
   * generation's key, so no generation floor can tell its forgeries from
   * real snapshots and restore refuses.
   */
  rotationPending: boolean;
}

/**
 * Derive restore trust from the lifecycle's adopted signed head.
 *
 * A revoked device keeps the keys of every generation below its
 * `effectiveGeneration`, so a hostile relay plus that device can forge
 * snapshots under any of them. The floor is therefore the highest effective
 * generation among revoked devices; snapshots sealed before the rotation that
 * revoked a device must be re-published by a remaining device before they are
 * restorable. Throws when the device has no account state.
 */
export async function snapshotAccountTrustFromLifecycle(
  lifecycle: Pick<VaultKeyLifecycle, 'status'>,
): Promise<SnapshotAccountTrust> {
  const status = await lifecycle.status();
  if (!status) {
    throw new Error('This device has no vault account state to restore from.');
  }
  let minimumGeneration = 1n;
  for (const revoked of status.revokedDevices) {
    if (
      revoked.effectiveGeneration !== null &&
      revoked.effectiveGeneration > minimumGeneration
    ) {
      minimumGeneration = revoked.effectiveGeneration;
    }
  }
  return {
    minimumGeneration,
    revokedDeviceIds: status.revokedDevices.map((revoked) => revoked.deviceId),
    rotationPending:
      status.rotationRequired ||
      status.conflict ||
      status.revokedDevices.some(
        (revoked) => revoked.effectiveGeneration === null,
      ),
  };
}

function isKeyMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Partial<VaultKeyLifecycleError>).name ===
      'VaultKeyLifecycleError' &&
    (error as Partial<VaultKeyLifecycleError>).code === 'key_missing'
  );
}

/** Build the snapshot key provider backed by a vault key lifecycle. */
export function createLifecycleSnapshotKeys(
  options: LifecycleSnapshotKeysOptions,
): SnapshotKeyProvider {
  const { lifecycle, nextSequence, advanceSequence } = options;
  return {
    ...(advanceSequence
      ? {
          async advanceSealingSequence(above: bigint): Promise<void> {
            await advanceSequence(above);
          },
        }
      : {}),
    async sealingKey(): Promise<SnapshotSealingKey> {
      // The only sealing path; a refusal propagates untouched.
      const sealing = await lifecycle.openSealingKey();
      try {
        const sequence = await nextSequence();
        if (typeof sequence !== 'bigint' || sequence < 1n) {
          throw new Error('The next snapshot sequence is invalid.');
        }
        return {
          accountId: sealing.accountId,
          deviceId: sealing.deviceId,
          sequence,
          generation: sealing.generation,
          keyId: sealing.keyId,
          key: sealing.key,
        };
      } catch (error) {
        sealing.key.fill(0);
        throw error;
      }
    },

    async openingKey(
      reference: SnapshotKeyReference,
    ): Promise<Uint8Array | undefined> {
      const status = await lifecycle.status();
      if (!status || status.accountId !== reference.accountId) return undefined;
      try {
        const reading = await lifecycle.openReadingKey({
          generation: reference.generation,
          keyId: reference.keyId,
        });
        return reading.key;
      } catch (error) {
        if (isKeyMissing(error)) return undefined;
        throw error;
      }
    },
  };
}
