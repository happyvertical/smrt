import { randomBytes } from 'node:crypto';
import {
  type VaultDeviceKeyContext,
  wrapVaultDeviceKey,
} from './vault-device-key.js';
import { wrapVaultRecoveryKey } from './vault-recovery.js';

const MAX_GENERATION = (1n << 64n) - 1n;

export interface PrepareVaultKeyGenerationOptions {
  accountId: string;
  deviceId: string;
  deviceSecret: Uint8Array;
  recoverySecret: string;
  /** Trusted current generation. Pass null to prepare the first generation. */
  currentGeneration: bigint | null;
}

export interface PreparedVaultKeyGeneration extends VaultDeviceKeyContext {
  deviceRecord: Uint8Array;
  recoveryRecord: Uint8Array;
}

/** Prepare two records for a fresh key before the caller publishes either. */
export async function prepareVaultKeyGeneration({
  accountId,
  deviceId,
  deviceSecret,
  recoverySecret,
  currentGeneration,
}: PrepareVaultKeyGenerationOptions): Promise<PreparedVaultKeyGeneration> {
  if (
    currentGeneration !== null &&
    (typeof currentGeneration !== 'bigint' ||
      currentGeneration < 0n ||
      currentGeneration >= MAX_GENERATION)
  ) {
    throw new Error('Vault key generation cannot be advanced');
  }

  const context = {
    accountId,
    deviceId,
    generation: (currentGeneration ?? 0n) + 1n,
    keyId: randomBytes(16).toString('hex'),
  };
  const dataKey = randomBytes(32);
  try {
    const deviceRecord = wrapVaultDeviceKey(dataKey, deviceSecret, context);
    const recoveryRecord = await wrapVaultRecoveryKey(
      { keyId: context.keyId, key: dataKey },
      recoverySecret,
      context,
    );
    return { ...context, deviceRecord, recoveryRecord };
  } finally {
    dataKey.fill(0);
  }
}
