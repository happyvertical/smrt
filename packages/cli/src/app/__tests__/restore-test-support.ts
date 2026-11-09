/**
 * Shared fixtures for the restore-latest tests (#4805) and their composition
 * with installation custody and cloud migration (#4806): real local
 * installations, real encrypted snapshots, real custody records and state
 * roots, and an in-memory relay that follows the lease rules (base must be
 * the head; one holder; fencing token per grant).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  VaultLeaseClient,
  type VaultRelayResponse,
} from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach } from 'vitest';
import { runAppCommand } from '../cli.js';
import type { VaultRestoreProvider } from '../restore-latest.js';
import { planDataRootArchive } from '../snapshot-archive.js';
import {
  type SnapshotKeyProvider,
  writeEncryptedSnapshot,
} from '../snapshot-framing.js';

export const APP_ID = 'restore-app';
export const ACCOUNT = 'acct-family';

const ENV_KEYS = [
  'HOME',
  'SMRT_DATA_DIR',
  'XDG_STATE_HOME',
  'SMRT_APP_ID',
] as const;
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const lockPaths: string[] = [];

/** Register the environment and temp-directory cleanup for a test file. */
export function installRestoreHooks(): void {
  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
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
}

export function trackLock(data: string) {
  const identity = platform() === 'darwin' ? data.toLowerCase() : data;
  lockPaths.push(
    join(
      realpathSync('/tmp'),
      `.smrt-${process.getuid?.()}`,
      createHash('sha256').update(identity).digest('hex').slice(0, 32),
      'initialization.sqlite',
    ),
  );
}

/** One key per account; a provider only opens its own account's snapshots. */
export function keyring(accountId: string): SnapshotKeyProvider {
  const keyId = randomBytes(16).toString('hex');
  const key = randomBytes(32);
  return {
    async sealingKey() {
      throw new Error('tests seal explicitly');
    },
    async openingKey(reference) {
      if (reference.accountId !== accountId || reference.keyId !== keyId) {
        return undefined;
      }
      return new Uint8Array(key);
    },
    ...{ keyId, key },
  } as SnapshotKeyProvider & { keyId: string; key: Buffer };
}

export interface Published {
  file: string;
  deviceId: string;
}

/** In-memory relay with the lease rules of `@happyvertical/smrt-vault-relay`. */
export function fakeRelay(root: string) {
  const state = {
    head: 0,
    holder: null as string | null,
    token: 0,
    snapshots: new Map<number, Published>(),
    latestOverride: null as number | null,
    loseLeaseOnRenew: false,
    calls: [] as string[],
  };
  const latestCommitted = () => Math.max(0, ...state.snapshots.keys());
  const transport = (deviceId: string) => ({
    async send(
      _method: 'GET' | 'POST',
      path: string,
      body?: Record<string, unknown>,
    ): Promise<VaultRelayResponse> {
      state.calls.push(path);
      if (path === '/v1/lease/acquire') {
        if (state.holder && state.holder !== deviceId) {
          return { status: 409, body: { error: 'lease_held' } };
        }
        if (body?.baseSequence !== state.head) {
          return {
            status: 409,
            body: {
              error: 'must_restore_first',
              headSequence: state.head,
              latestSequence: latestCommitted(),
            },
          };
        }
        state.holder = deviceId;
        state.token += 1;
        return {
          status: 200,
          body: {
            fencingToken: state.token,
            ttlMs: 300_000,
            headSequence: state.head,
          },
        };
      }
      if (path === '/v1/lease/renew') {
        if (state.loseLeaseOnRenew || body?.fencingToken !== state.token) {
          return { status: 409, body: { error: 'lease_lost' } };
        }
        return {
          status: 200,
          body: {
            fencingToken: state.token,
            ttlMs: 300_000,
            headSequence: state.head,
          },
        };
      }
      if (path === '/v1/lease/release') {
        if (body?.fencingToken === state.token) state.holder = null;
        return { status: 204, body: null };
      }
      return { status: 404, body: { error: 'not_found' } };
    },
  });
  return {
    state,
    /** Publish a data root as the next sequence, sealed for `accountId`. */
    async publish(
      dataRoot: string,
      deviceId: string,
      keys: SnapshotKeyProvider & { keyId?: string; key?: Buffer },
      accountId = ACCOUNT,
    ) {
      const sequence = state.head + 1;
      const file = join(
        root,
        `snapshot-${sequence}-${randomBytes(4).toString('hex')}.hvsnap`,
      );
      const archive = planDataRootArchive(dataRoot);
      await writeEncryptedSnapshot({
        destination: file,
        kind: 'data-root',
        totalLength: archive.totalLength,
        source: archive.chunks(),
        sealing: {
          accountId,
          deviceId,
          sequence: BigInt(sequence),
          generation: 1n,
          keyId: keys.keyId as string,
          key: new Uint8Array(keys.key as Buffer),
        },
      });
      state.snapshots.set(sequence, { file, deviceId });
      state.head = sequence;
      return sequence;
    },
    provider(deviceId: string): VaultRestoreProvider {
      return {
        accountId: ACCOUNT,
        lease: new VaultLeaseClient(transport(deviceId)),
        snapshots: {
          async latest() {
            const sequence = state.latestOverride ?? latestCommitted();
            const entry = state.snapshots.get(sequence);
            return entry ? { sequence, deviceId: entry.deviceId } : null;
          },
          async download(sequence, destination) {
            const entry = state.snapshots.get(sequence);
            if (!entry) throw new Error('no snapshot');
            const { copyFileSync, constants } = await import('node:fs');
            copyFileSync(entry.file, destination, constants.COPYFILE_EXCL);
          },
        },
      };
    },
  };
}

export function marker(dataRoot: string): string | null {
  const database = new DatabaseSync(join(dataRoot, 'application.sqlite'));
  try {
    const row = database
      .prepare("SELECT value FROM restore_marker WHERE name = 'marker'")
      .get() as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export function setMarker(dataRoot: string, value: string): void {
  const database = new DatabaseSync(join(dataRoot, 'application.sqlite'));
  try {
    database.exec(
      'CREATE TABLE IF NOT EXISTS restore_marker (name TEXT PRIMARY KEY, value TEXT)',
    );
    database
      .prepare(
        "INSERT INTO restore_marker (name, value) VALUES ('marker', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      )
      .run(value);
  } finally {
    database.close();
  }
}

export async function harness() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'smrt-restore-latest-')),
  );
  roots.push(root);
  const app = join(root, 'app');
  const home = join(root, 'home');
  mkdirSync(app);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(root, 'relay'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: APP_ID }));
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, 'state');
  delete process.env.SMRT_APP_ID;
  const use = (data: string) => {
    process.env.SMRT_DATA_DIR = data;
    trackLock(data);
  };
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
  const stateRootOf = (data: string) =>
    prepareApplicationStateRoot({
      appId: APP_ID,
      dataDirectory: data,
      sourceRoot: app,
    });
  const relay = fakeRelay(join(root, 'relay'));
  const keys = keyring(ACCOUNT);
  const run = async (
    data: string,
    deviceId: string,
    argv: string[] = [],
    overrides: { keys?: SnapshotKeyProvider } = {},
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
        snapshotKeys: overrides.keys ?? keys,
        vaultRestore: relay.provider(deviceId),
      },
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  };
  return { root, app, boot, use, run, relay, keys, stateRootOf };
}

export function siblings(root: string, data: string): string[] {
  const name = data.slice(root.length + 1);
  return readdirSync(root).filter((entry) => entry.startsWith(`.${name}.`));
}
