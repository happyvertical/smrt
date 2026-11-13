import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { LocalRuntimeError } from './local-runtime-error.js';
import {
  createFileVaultKeyStore,
  type VaultKeyStore,
} from './vault-key-store.js';

/** Vault key store item holding the 32-byte secrets master key. */
export const SECRET_MASTER_KEY_ITEM = 'smrt-secrets.master-key';

const MASTER_KEY_BYTES = 32;

/**
 * Where the default file-backed key store lives for a data root: a private
 * sibling of the data root, never inside it, so plain-data exports and
 * backups of the root never carry the key.
 */
export function defaultLocalVaultKeyDirectory(dataRoot: string): string {
  return join(dirname(dataRoot), `.smrt-keys-${basename(dataRoot)}`);
}

/** The key store a local runtime uses: the injected one, else the file store. */
export function localVaultKeyStore(
  dataRoot: string,
  injected?: VaultKeyStore,
): VaultKeyStore {
  return (
    injected ?? createFileVaultKeyStore(defaultLocalVaultKeyDirectory(dataRoot))
  );
}

/** The one failure of this module; it names no key material or path. */
export function secretMasterKeyUnavailable(): LocalRuntimeError {
  return new LocalRuntimeError(
    'secret_master_key_unavailable',
    'The application secrets master key could not be loaded from the local key store.',
  );
}

/**
 * Load the master key from the store, creating it on first use. The caller
 * holds the data root's initialization lock, so two processes cannot each
 * create a different key. A stored item of the wrong size is corruption and
 * fails closed: it is never replaced, because a new key would orphan every
 * secret the old one sealed. Returns the key as 64 hex characters.
 */
export async function loadOrCreateSecretMasterKey(
  store: VaultKeyStore,
): Promise<string> {
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(SECRET_MASTER_KEY_ITEM);
    if (bytes === null) {
      bytes = new Uint8Array(randomBytes(MASTER_KEY_BYTES));
      await store.set(SECRET_MASTER_KEY_ITEM, bytes);
    }
  } catch {
    throw secretMasterKeyUnavailable();
  }
  try {
    if (bytes.length !== MASTER_KEY_BYTES) throw secretMasterKeyUnavailable();
    return Buffer.from(bytes).toString('hex');
  } finally {
    bytes.fill(0);
  }
}
