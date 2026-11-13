import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeLocalApplicationRuntime,
  LocalRuntimeError,
} from './index.js';
import type { VaultKeyStore } from './vault-key-store.js';

const KEY_ITEM = 'smrt-secrets.master-key';
const temporaryRoots: string[] = [];
const legacyLeases: string[] = [];

afterEach(async () => {
  await Promise.all(
    legacyLeases
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directories(label: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `smrt-master-key-${label}-`)),
  );
  temporaryRoots.push(root);
  // The runtime also takes a per-user legacy lease under /tmp; remove it.
  const identity = join(root, 'data');
  const key = createHash('sha256')
    .update(
      platform() === 'darwin' || platform() === 'win32'
        ? identity.toLowerCase()
        : identity,
    )
    .digest('hex')
    .slice(0, 32);
  legacyLeases.push(
    join(await realpath('/tmp'), `.smrt-${process.getuid?.()}`, key),
  );
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  return { root, sourceRoot, dataDirectory: join(root, 'data') };
}

function memoryStore(initial?: Uint8Array) {
  const items = new Map<string, Uint8Array>();
  if (initial) items.set(KEY_ITEM, initial);
  const calls = { set: 0 };
  const store: VaultKeyStore = {
    async get(name) {
      const value = items.get(name);
      return value ? new Uint8Array(value) : null;
    },
    async set(name, value) {
      calls.set += 1;
      items.set(name, new Uint8Array(value));
    },
    async delete(name) {
      items.delete(name);
    },
  };
  return { items, calls, store };
}

describe('local secrets master key', () => {
  it('creates the key once in the file store and reloads it after a restart', async () => {
    const dirs = await directories('restart');
    const first = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...dirs,
    });
    const key = await first.runtime.secretMasterKey?.();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await first.runtime.secretMasterKey?.()).toBe(key);

    const keyDirectory = join(dirs.root, '.smrt-keys-data');
    expect((await stat(keyDirectory)).mode & 0o777).toBe(0o700);
    const item = join(keyDirectory, KEY_ITEM);
    expect((await stat(item)).mode & 0o777).toBe(0o600);
    expect((await readFile(item)).toString('hex')).toBe(key);
    // Beside the data root, never inside it.
    expect(keyDirectory.startsWith(`${dirs.dataDirectory}/`)).toBe(false);

    const restarted = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...dirs,
    });
    expect(await restarted.runtime.secretMasterKey?.()).toBe(key);
  });

  it('shares one creation across concurrent callers and uses an injected store', async () => {
    const dirs = await directories('injected');
    const { store, calls, items } = memoryStore();
    const { runtime } = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...dirs,
      vaultKeyStore: store,
    });
    const [a, b, c] = await Promise.all([
      runtime.secretMasterKey?.(),
      runtime.secretMasterKey?.(),
      runtime.secretMasterKey?.(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls.set).toBe(1);
    expect(Buffer.from(items.get(KEY_ITEM) as Uint8Array).toString('hex')).toBe(
      a,
    );
    // The injected store replaced the file store entirely.
    await expect(
      stat(join(dirs.root, '.smrt-keys-data')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a malformed item or an unreadable store without echoing key material', async () => {
    const dirs = await directories('failure');
    const malformed = memoryStore(new Uint8Array(7).fill(0xab));
    const first = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...dirs,
      vaultKeyStore: malformed.store,
    });
    const bad = await first.runtime.secretMasterKey?.().then(
      () => null,
      (error: unknown) => error,
    );
    expect(bad).toBeInstanceOf(LocalRuntimeError);
    expect((bad as LocalRuntimeError).code).toBe(
      'secret_master_key_unavailable',
    );
    // Never replaced: a new key would orphan what the old one sealed.
    expect(malformed.calls.set).toBe(0);

    const marker = 'abcdef0123-top-secret-marker';
    const second = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...dirs,
      vaultKeyStore: {
        async get() {
          throw new Error(`keychain said ${marker}`);
        },
        async set() {},
        async delete() {},
      },
    });
    const failure = await second.runtime.secretMasterKey?.().then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as LocalRuntimeError).code).toBe(
      'secret_master_key_unavailable',
    );
    expect(JSON.stringify(failure)).not.toContain(marker);
    expect((failure as Error).message).not.toContain(marker);
    expect(String((failure as Error).stack)).not.toContain(marker);
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });
});
