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
  const { lifecycle, nextSequence } = options;
  return {
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
