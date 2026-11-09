import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * Custody seam for vault key material on one device.
 *
 * The desktop shell injects an OS keychain provider; headless and development
 * installs use {@link createFileVaultKeyStore}. Items hold the device secret,
 * wrapped data keys, recovery records and the device registry. Providers must
 * replace an item atomically: a reader sees the previous or the new value,
 * never a partial one.
 */
export interface VaultKeyStore {
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

const ITEM_NAME = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const MAX_ITEM_BYTES = 1024 * 1024;

/** Reject item names that could escape a provider's namespace. */
export function assertVaultKeyStoreItemName(name: string): void {
  if (typeof name !== 'string' || !ITEM_NAME.test(name)) {
    throw new Error('Invalid vault key store item name');
  }
}

export interface FileVaultKeyStoreOptions {
  /** Testable uid override; it cannot disable the ownership check. */
  currentUid?: number;
  /** Testable platform override. */
  platform?: NodeJS.Platform;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Owner-only file custody for headless and development installs.
 *
 * The directory must be absolute, is created with mode 0700 when absent, and
 * must be a real directory owned by the current user with no group or other
 * permissions. On Windows, where POSIX modes are synthetic and there is no
 * uid, no custody check applies: place the directory under the user's
 * profile and prefer a keychain provider. Items are mode 0600 files
 * replaced by atomic rename. Keep the
 * directory outside the application state root so plain-data exports and
 * backups never include it.
 */
export function createFileVaultKeyStore(
  directory: string,
  options: FileVaultKeyStoreOptions = {},
): VaultKeyStore {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new Error('Vault key store directory must be an absolute path');
  }
  const currentUid = options.currentUid ?? process.getuid?.();
  // Windows reports synthetic POSIX modes; custody there rests on the
  // profile directory's ACLs, and desktop shells inject a keychain instead.
  const checkMode = (options.platform ?? process.platform) !== 'win32';
  let prepared: Promise<void> | undefined;

  async function verifyDirectory(): Promise<void> {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const details = await lstat(directory);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      (currentUid !== undefined && details.uid !== currentUid) ||
      (checkMode && (details.mode & 0o077) !== 0)
    ) {
      throw new Error('Vault key store directory lacks owner-only custody');
    }
  }

  function ready(): Promise<void> {
    prepared ??= verifyDirectory().catch((error) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  }

  return {
    async get(name) {
      assertVaultKeyStoreItemName(name);
      await ready();
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          join(directory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw new Error('Vault key store item lacks owner-only custody');
      }
      try {
        const details = await handle.stat();
        if (
          !details.isFile() ||
          (currentUid !== undefined && details.uid !== currentUid) ||
          (checkMode && (details.mode & 0o077) !== 0) ||
          details.size > MAX_ITEM_BYTES
        ) {
          throw new Error('Vault key store item lacks owner-only custody');
        }
        const value = await handle.readFile();
        return new Uint8Array(value);
      } finally {
        await handle.close();
      }
    },

    async set(name, value) {
      assertVaultKeyStoreItemName(name);
      if (!(value instanceof Uint8Array) || value.length > MAX_ITEM_BYTES) {
        throw new Error('Invalid vault key store item value');
      }
      await ready();
      const temporary = join(
        directory,
        `.${name}.${randomBytes(8).toString('hex')}.tmp`,
      );
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        try {
          await handle.writeFile(value);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, join(directory, name));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } catch {
        // Some platforms cannot fsync a directory; rename is still atomic.
      } finally {
        await directoryHandle.close();
      }
    },

    async delete(name) {
      assertVaultKeyStoreItemName(name);
      await ready();
      await rm(join(directory, name), { force: true });
    },
  };
}
