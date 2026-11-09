/**
 * Backup and restore through the real in-process relay with real local
 * installations (#4804 + #4805): device A backs up under the writer lease,
 * device B restores the latest snapshot (taking the lease at that sequence),
 * and from then on only B may publish; A is told to restore first.
 */
import { createHash, randomBytes, sign } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeLocalApplicationRuntime,
  prepareApplicationStateRoot,
  readVaultSyncRecord,
} from '@happyvertical/smrt-app-runtime';
import {
  BackupTargetError,
  planDataRootArchive,
  runAppCommand,
  type SnapshotKeyProvider,
  type VaultDeviceSigner,
  VaultRelayBackupTarget,
  writeEncryptedSnapshot,
} from '@happyvertical/smrt-cli/app';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  type Harness,
  newDevice,
  registerDevice,
  type TestDevice,
} from './helpers.js';

const APP_ID = 'vault-e2e-app';
const ACCOUNT = 'acct-a';
const ENV_KEYS = ['HOME', 'SMRT_DATA_DIR', 'XDG_STATE_HOME', 'SMRT_APP_ID'];
const KEY_ID = 'ef'.repeat(16);
const KEY = randomBytes(32);

const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const lockPaths: string[] = [];
let h: Harness;

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  h = await createHarness({
    policy: {
      quota: { maxBytes: 50_000_000, maxSnapshots: 8 },
      retention: { keepLast: 5, keepWithinMs: 0 },
      limits: {
        maxChunkBytes: 4 * 1024 * 1024,
        uploadTtlMs: 60_000,
        maxClockSkewMs: 30_000,
        leaseTtlMs: 30_000,
      },
    },
  });
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await h.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const lockPath of lockPaths.splice(0)) {
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      rmSync(`${lockPath}${suffix}`, { force: true });
    }
    try {
      rmdirSync(dirname(lockPath));
    } catch {
      // Shared or already removed.
    }
  }
});

function keysFor(deviceId: string): SnapshotKeyProvider {
  let sequence = 0n;
  return {
    async sealingKey() {
      sequence += 1n;
      return {
        accountId: ACCOUNT,
        deviceId,
        sequence,
        generation: 1n,
        keyId: KEY_ID,
        key: new Uint8Array(KEY),
      };
    },
    async advanceSealingSequence(above) {
      if (sequence < above) sequence = above;
    },
    async openingKey(reference) {
      return reference.accountId === ACCOUNT &&
        reference.generation === 1n &&
        reference.keyId === KEY_ID
        ? new Uint8Array(KEY)
        : undefined;
    },
  };
}

function signerFor(test: TestDevice): VaultDeviceSigner {
  return {
    accountId: test.accountId,
    deviceId: test.deviceId,
    async sign(message) {
      return new Uint8Array(sign(null, message, test.privateKey));
    },
  };
}

function makeEnvironment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-vault-e2e-')));
  roots.push(root);
  const app = join(root, 'app');
  const home = join(root, 'home');
  mkdirSync(app);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: APP_ID }));
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, 'state');
  delete process.env.SMRT_APP_ID;

  const use = (data: string) => {
    process.env.SMRT_DATA_DIR = data;
    const identity = platform() === 'darwin' ? data.toLowerCase() : data;
    lockPaths.push(
      join(
        realpathSync('/tmp'),
        `.smrt-${process.getuid?.()}`,
        createHash('sha256').update(identity).digest('hex').slice(0, 32),
        'initialization.sqlite',
      ),
    );
  };
  const stateRootOf = (data: string) =>
    prepareApplicationStateRoot({
      appId: APP_ID,
      dataDirectory: data,
      sourceRoot: app,
    });
  const boot = async (data: string, value: string) => {
    use(data);
    const { runtime } = await initializeLocalApplicationRuntime({
      appId: APP_ID,
      dataDirectory: data,
      sourceRoot: app,
      bindHost: '127.0.0.1',
      prepareDatabase: async (db) => {
        await getTestDatabase({ db });
      },
    });
    await runtime.db.close?.();
    setMarker(data, value);
  };
  const setMarker = (data: string, value: string) => {
    const database = new DatabaseSync(join(data, 'application.sqlite'));
    try {
      database.exec(
        'CREATE TABLE IF NOT EXISTS e2e_marker (name TEXT PRIMARY KEY, value TEXT)',
      );
      database
        .prepare(
          "INSERT INTO e2e_marker (name, value) VALUES ('marker', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
        )
        .run(value);
    } finally {
      database.close();
    }
  };
  const marker = (data: string): string | null => {
    const database = new DatabaseSync(join(data, 'application.sqlite'));
    try {
      const row = database
        .prepare("SELECT value FROM e2e_marker WHERE name = 'marker'")
        .get() as { value?: string } | undefined;
      return row?.value ?? null;
    } finally {
      database.close();
    }
  };
  const target = (test: TestDevice, data: string) =>
    new VaultRelayBackupTarget({
      name: 'vault',
      url: 'https://relay.test',
      signer: async () => signerFor(test),
      stateRoot: stateRootOf(data),
      entitlements: { status: async () => ({ featureKeys: ['backup.vault'] }) },
      accountTrust: async () => ({
        minimumGeneration: 1n,
        revokedDeviceIds: [],
      }),
      fetch: (async (input, init) =>
        h.relay.handle(
          new Request(String(input), init as RequestInit),
        )) as typeof fetch,
      now: () => h.clock.now,
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
  /** `smrt app backup`'s publish: seal the data root, put it under the lease. */
  const backup = async (
    test: TestDevice,
    data: string,
    keys: SnapshotKeyProvider,
  ) => {
    use(data);
    const vault = target(test, data);
    try {
      await vault.preflight();
      const staged = join(root, `staged-${randomBytes(4).toString('hex')}`);
      const archive = planDataRootArchive(data);
      const summary = await writeEncryptedSnapshot({
        destination: staged,
        kind: 'data-root',
        totalLength: archive.totalLength,
        source: archive.chunks(),
        sealing: await keys.sealingKey(),
      });
      const bytes = readFileSync(staged);
      return await vault.put({
        sequence: BigInt(summary.sequence),
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        source: (async function* () {
          yield bytes;
        })(),
      });
    } finally {
      await vault.close();
    }
  };
  const restore = async (
    test: TestDevice,
    data: string,
    keys: SnapshotKeyProvider,
    argv: string[] = [],
  ) => {
    use(data);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runAppCommand(['restore-latest', ...argv], {
      cwd: app,
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      dependencies: {
        resolveRuntime: async () =>
          resolveApplicationRuntime({ profile: 'local' }) as never,
        snapshotKeys: keys,
        vaultRestore: await target(test, data).restoreProvider(),
      },
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  };
  return { root, boot, marker, setMarker, backup, restore, stateRootOf };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackupTargetError) return error.code;
    throw error;
  }
  throw new Error('expected a BackupTargetError');
}

describe('vault backup then restore across two devices', () => {
  it('moves the primary-writer role with the restore and fences the stale device', async () => {
    const laptopDevice = newDevice(ACCOUNT, 'device-a1');
    const desktopDevice = newDevice(ACCOUNT, 'device-a2');
    await registerDevice(h, laptopDevice);
    await registerDevice(h, desktopDevice);
    const env = makeEnvironment();
    const laptop = join(env.root, 'laptop');
    const desktop = join(env.root, 'desktop');

    // Device A backs up under the lease.
    await env.boot(laptop, 'laptop v1');
    const laptopKeys = keysFor('device-a1');
    expect(await env.backup(laptopDevice, laptop, laptopKeys)).toMatchObject({
      sequence: 1n,
    });
    expect(readVaultSyncRecord(env.stateRootOf(laptop))).toMatchObject({
      baseSequence: 1,
      localWritesPending: false,
    });

    // Device B restores sequence 1 through the relay's lease routes.
    const desktopKeys = keysFor('device-a2');
    const restored = await env.restore(desktopDevice, desktop, desktopKeys, [
      '--origin-retired',
    ]);
    expect(restored.stderr).toBe('');
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      status: 'restored',
      sequence: 1,
      custody: 'moved',
    });
    expect(env.marker(desktop)).toBe('laptop v1');
    expect(readVaultSyncRecord(env.stateRootOf(desktop))).toMatchObject({
      baseSequence: 1,
      localWritesPending: false,
    });

    // B publishes the next sequence at the position it restored.
    await env.boot(desktop, 'desktop v2');
    // Restore moved this device's sealing counter past the head it restored,
    // so the very next backup is sequence 2 with nothing burned by hand.
    expect(await env.backup(desktopDevice, desktop, desktopKeys)).toMatchObject(
      { sequence: 2n },
    );

    // A never saw sequence 2: its next publish is refused, and nothing lands.
    expect(await code(env.backup(laptopDevice, laptop, laptopKeys))).toBe(
      'must_restore_first',
    );
    expect((await h.relay.operatorView(ACCOUNT)).snapshots).toHaveLength(2);

    // A can only catch up by restoring; its unpublished state is kept safe.
    // Writes made on A after its backup are not recorded as pending (the app
    // does not mark them yet, #4810); restoring still keeps A's previous root.
    env.setMarker(laptop, 'laptop edit after backup');
    const behind = await env.restore(laptopDevice, laptop, laptopKeys);
    expect(behind.code).toBe(0);
    expect(env.marker(laptop)).toBe('desktop v2');
    expect(env.marker(JSON.parse(behind.stdout).previousRoot)).toBe(
      'laptop edit after backup',
    );
  });
});
