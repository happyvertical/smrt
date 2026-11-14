import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  createFileVaultKeyStore,
  type VaultKeyStore,
} from './file-vault-key-store.js';
import {
  createKeychainVaultKeyStore,
  type OsKeychain,
} from './keychain-vault-key-store.js';
import { LocalRuntimeError } from './local-runtime-error.js';

/**
 * Supervisor-owned marker the desktop wrapper exports to the sidecar. When it
 * is exactly `1` and no store was injected, the local runtime keeps vault key
 * material in the OS-keychain-wrapped store.
 */
export const DESKTOP_KEYCHAIN_ENV = 'SMRT_DESKTOP_KEYCHAIN';

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

/**
 * Where the keychain-wrapped store keeps its sealed items: a private sibling
 * of the data root, never inside it, next to (and distinct from) the plain
 * file store directory.
 */
export function defaultLocalSealedKeyDirectory(dataRoot: string): string {
  return join(dirname(dataRoot), `.smrt-sealed-keys-${basename(dataRoot)}`);
}

export interface LocalVaultKeyStoreSelection {
  /** Application identity; namespaces the keychain service. */
  appId: string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Testable keychain; the real one for the platform by default. */
  keychain?: OsKeychain | null;
}

/**
 * The key store a local runtime uses. An injected store always wins. Else,
 * when the desktop wrapper started the process ({@link DESKTOP_KEYCHAIN_ENV}),
 * the keychain-wrapped store, which falls back to the file store outside the
 * data root where no keychain is usable. Else the owner-only file store.
 */
export function localVaultKeyStore(
  dataRoot: string,
  injected?: VaultKeyStore,
  selection?: LocalVaultKeyStoreSelection,
): VaultKeyStore {
  if (injected) return injected;
  const fileDirectory = defaultLocalVaultKeyDirectory(dataRoot);
  if (
    selection &&
    (selection.env ?? process.env)[DESKTOP_KEYCHAIN_ENV] === '1'
  ) {
    return createKeychainVaultKeyStore({
      productId: selection.appId,
      directory: defaultLocalSealedKeyDirectory(dataRoot),
      fallbackDirectory: fileDirectory,
      ...(selection.keychain !== undefined
        ? { keychain: selection.keychain }
        : {}),
    });
  }
  return createFileVaultKeyStore(fileDirectory);
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
