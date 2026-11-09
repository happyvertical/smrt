import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVaultKeyLifecycle } from './vault-key-lifecycle.js';
import { createFileVaultKeyStore } from './vault-key-store.js';

describe('file vault key store', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'smrt-vault-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps items in an owner-only directory with owner-only files', async () => {
    const directory = join(root, 'keys');
    const store = createFileVaultKeyStore(directory);
    expect(await store.get('device-secret')).toBeNull();
    const value = new Uint8Array(randomBytes(32));
    await store.set('device-secret', value);
    expect(await store.get('device-secret')).toEqual(value);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'device-secret')).mode & 0o777).toBe(0o600);

    const replacement = new Uint8Array(randomBytes(32));
    await store.set('device-secret', replacement);
    expect(await store.get('device-secret')).toEqual(replacement);
    expect(readdirSync(directory)).toEqual(['device-secret']);
    await store.delete('device-secret');
    expect(await store.get('device-secret')).toBeNull();
  });

  it('refuses unsafe names, directories, files and links', async () => {
    expect(() => createFileVaultKeyStore('relative/keys')).toThrow(
      'Vault key store directory must be an absolute path',
    );
    const store = createFileVaultKeyStore(join(root, 'keys'));
    for (const name of ['../escape', '.hidden', 'a/b', 'UPPER', '']) {
      await expect(store.get(name)).rejects.toThrow(
        'Invalid vault key store item name',
      );
    }

    const shared = join(root, 'shared');
    mkdirSync(shared, { mode: 0o750 });
    chmodSync(shared, 0o750);
    await expect(
      createFileVaultKeyStore(shared).get('device-secret'),
    ).rejects.toThrow('Vault key store directory lacks owner-only custody');
    await expect(
      createFileVaultKeyStore(join(root, 'keys'), {
        currentUid: (process.getuid?.() ?? 0) + 1,
      }).get('device-secret'),
    ).rejects.toThrow('Vault key store directory lacks owner-only custody');

    const linked = join(root, 'linked');
    symlinkSync(join(root, 'keys'), linked);
    await expect(
      createFileVaultKeyStore(linked).get('device-secret'),
    ).rejects.toThrow('Vault key store directory lacks owner-only custody');

    writeFileSync(join(root, 'keys', 'readable'), 'x', { mode: 0o644 });
    chmodSync(join(root, 'keys', 'readable'), 0o644);
    await expect(store.get('readable')).rejects.toThrow(
      'Vault key store item lacks owner-only custody',
    );
    writeFileSync(join(root, 'target'), 'x', { mode: 0o600 });
    symlinkSync(join(root, 'target'), join(root, 'keys', 'pointer'));
    await expect(store.get('pointer')).rejects.toThrow(
      'Vault key store item lacks owner-only custody',
    );
  });

  it('skips only the synthetic POSIX mode check on Windows', async () => {
    const shared = join(root, 'shared');
    mkdirSync(shared, { mode: 0o750 });
    chmodSync(shared, 0o750);
    const store = createFileVaultKeyStore(shared, { platform: 'win32' });
    await store.set('device-secret', new Uint8Array(randomBytes(32)));
    expect(await store.get('device-secret')).not.toBeNull();
    const linked = join(root, 'linked');
    symlinkSync(shared, linked);
    await expect(
      createFileVaultKeyStore(linked, { platform: 'win32' }).get('x'),
    ).rejects.toThrow('Vault key store directory lacks owner-only custody');
  });

  it('backs a full lifecycle across separate store instances', async () => {
    const directory = join(root, 'keys');
    const first = createVaultKeyLifecycle({
      store: createFileVaultKeyStore(directory),
    });
    await first.initializeAccount({
      accountId: 'file-account',
      deviceId: 'desktop',
      recoverySecret: 'synthetic recovery credential',
    });
    const key = await first.openSealingKey();
    const reopened = createVaultKeyLifecycle({
      store: createFileVaultKeyStore(directory),
    });
    expect(await reopened.openSealingKey()).toEqual(key);
    for (const name of readdirSync(directory)) {
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
  });
});
