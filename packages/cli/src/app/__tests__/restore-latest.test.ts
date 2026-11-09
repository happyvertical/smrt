/**
 * `smrt app restore-latest` (#4805) end to end in-process: real local
 * installations, real encrypted snapshots, the real custody records and state
 * roots, and an in-memory relay that follows the lease rules (base must be
 * the head; one holder; fencing token per grant).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
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
  INSTALLATION_CUSTODY_FILE,
  initializeLocalApplicationRuntime,
  inspectInstallationCustody,
  prepareApplicationStateRoot,
  readVaultSyncRecord,
  restoreInstallation,
  retireInstallation,
  VaultLeaseClient,
  type VaultRelayResponse,
  writeVaultSyncRecord,
} from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAppCommand } from '../cli.js';
import type { VaultRestoreProvider } from '../restore-latest.js';
import { planDataRootArchive } from '../snapshot-archive.js';
import {
  type SnapshotKeyProvider,
  writeEncryptedSnapshot,
} from '../snapshot-framing.js';

const APP_ID = 'restore-app';
const ACCOUNT = 'acct-family';
const ENV_KEYS = [
  'HOME',
  'SMRT_DATA_DIR',
  'XDG_STATE_HOME',
  'SMRT_APP_ID',
] as const;
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const lockPaths: string[] = [];

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

function trackLock(data: string) {
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
function keyring(accountId: string): SnapshotKeyProvider {
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

interface Published {
  file: string;
  deviceId: string;
}

/** In-memory relay with the lease rules of `@happyvertical/smrt-vault-relay`. */
function fakeRelay(root: string) {
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

function marker(dataRoot: string): string | null {
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

function setMarker(dataRoot: string, value: string): void {
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

async function harness() {
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

function siblings(root: string, data: string): string[] {
  const name = data.slice(root.length + 1);
  return readdirSync(root).filter((entry) => entry.startsWith(`.${name}.`));
}

describe('smrt app restore-latest', () => {
  it('restores the latest snapshot onto a new machine and moves custody there', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'laptop v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);

    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop', ['--origin-retired']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'restored',
      sequence: 1,
      custody: 'moved',
      previousRoot: null,
    });
    // A fresh connection sees the restored data (no stale second view).
    expect(marker(desktop)).toBe('laptop v1');
    expect(readVaultSyncRecord(h.stateRootOf(desktop))).toMatchObject({
      accountId: ACCOUNT,
      baseSequence: 1,
      highestSeenSequence: 1,
      localWritesPending: false,
    });
    h.use(desktop);
    const custody = await inspectInstallationCustody({
      appId: APP_ID,
      dataDirectory: desktop,
      sourceRoot: h.app,
    });
    expect(custody.status).toBe('in-custody');
    // The relay lease was taken at the target and released afterwards.
    expect(h.relay.state.calls).toContain('/v1/lease/acquire');
    expect(h.relay.state.holder).toBeNull();
    expect(siblings(h.root, desktop)).toEqual([]);
  });

  it('replaces a stale data root on a second device of the same installation', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect((await h.run(desktop, 'device-desktop')).code).toBe(0);

    setMarker(laptop, 'v2');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const again = await h.run(desktop, 'device-desktop');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ sequence: 2 });
    expect(marker(desktop)).toBe('v2');
    // The replaced root is always kept: the record says nothing is pending,
    // but the app does not yet mark writes made after the last publish.
    const kept = JSON.parse(again.stdout).previousRoot;
    expect(marker(kept)).toBe('v1');
    expect(siblings(h.root, desktop)).toEqual([kept.slice(h.root.length + 1)]);

    const current = await h.run(desktop, 'device-desktop');
    expect(JSON.parse(current.stdout).status).toBe('up-to-date');
  });

  it('refuses while another writer holds the local lease (two SQLite writers, smrt#3379)', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'desktop local');
    // The running web process: it holds writer.lease and has the database
    // open. Restore must not replace the file underneath that connection.
    const state = h.stateRootOf(desktop);
    writeFileSync(
      join(state, 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, instance: randomBytes(16).toString('hex') })}\n`,
      { mode: 0o600 },
    );
    const web = new DatabaseSync(join(desktop, 'application.sqlite'));
    try {
      const result = await h.run(desktop, 'device-desktop', [
        '--replace-installation',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Another application writer is active');
      expect(h.relay.state.calls).toEqual([]);
      const row = web
        .prepare("SELECT value FROM restore_marker WHERE name = 'marker'")
        .get() as { value: string };
      expect(row.value).toBe('desktop local');
    } finally {
      web.close();
      rmSync(join(state, 'writer.lease'), { force: true });
    }
  });

  it('refuses a downgrade below the highest sequence this device has seen', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect((await h.run(desktop, 'device-desktop')).code).toBe(0);
    // A hostile relay now presents the older snapshot as latest.
    h.relay.state.latestOverride = 1;
    const result = await h.run(desktop, 'device-desktop', ['--discard-local']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('older than sequence 2');
  });

  it('refuses to discard unpublished local writes unless asked, then keeps the previous root', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect((await h.run(desktop, 'device-desktop')).code).toBe(0);
    const state = h.stateRootOf(desktop);
    const sync = readVaultSyncRecord(state);
    writeVaultSyncRecord(state, {
      ...(sync as NonNullable<typeof sync>),
      localWritesPending: true,
    });
    setMarker(desktop, 'unpublished edit');

    const refused = await h.run(desktop, 'device-desktop');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--discard-local');
    expect(marker(desktop)).toBe('unpublished edit');

    const replaced = await h.run(desktop, 'device-desktop', [
      '--discard-local',
    ]);
    expect(replaced.code).toBe(0);
    const report = JSON.parse(replaced.stdout);
    expect(marker(desktop)).toBe('v1');
    expect(marker(report.previousRoot)).toBe('unpublished edit');
  });

  it('refuses a snapshot sealed for another account and leaves the live root alone', async () => {
    const h = await harness();
    const other = join(h.root, 'other');
    await h.boot(other, 'other family');
    // Same key material and an equal-length account id: only the envelope's
    // authenticated account binding can tell the snapshots apart.
    await h.relay.publish(other, 'device-other', h.keys, 'acct-others');
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'desktop local');

    const result = await h.run(desktop, 'device-desktop', [
      '--discard-local',
      '--replace-installation',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed authentication');
    expect(marker(desktop)).toBe('desktop local');
    expect(siblings(h.root, desktop)).toEqual([]);
    expect(h.relay.state.holder).toBeNull();
  });

  it('refuses a snapshot of a different installation without --replace-installation', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'independent install');

    const refused = await h.run(desktop, 'device-desktop', ['--discard-local']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('different installation');
    expect(marker(desktop)).toBe('independent install');
    expect(siblings(h.root, desktop)).toEqual([]);

    const replaced = await h.run(desktop, 'device-desktop', [
      '--discard-local',
      '--replace-installation',
    ]);
    expect(replaced.code).toBe(0);
    expect(marker(desktop)).toBe('v1');
    // The replaced installation was never published: it is kept.
    expect(marker(JSON.parse(replaced.stdout).previousRoot)).toBe(
      'independent install',
    );
  });

  it('treats a data root with no recorded vault position as unpublished', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    // The same installation copied here earlier, then edited offline.
    const desktop = join(h.root, 'desktop');
    const { cpSync } = await import('node:fs');
    cpSync(laptop, desktop, { recursive: true });
    setMarker(desktop, 'offline edit');
    const refused = await h.run(desktop, 'device-desktop');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--discard-local');
    expect(marker(desktop)).toBe('offline edit');
    expect(h.relay.state.calls).toEqual([]);
  });

  it('leaves custody pending without --origin-retired', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).custody).toBe('pending');
    h.use(desktop);
    const custody = await inspectInstallationCustody({
      appId: APP_ID,
      dataDirectory: desktop,
      sourceRoot: h.app,
    });
    expect(custody.status).not.toBe('in-custody');
    expect(custody.resolutions).toContain('restore');
  });

  it('threat: refuses to restore over a retired location, even with --origin-retired, until the retirement is reversed explicitly', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    expect(
      (await h.run(desktop, 'device-desktop', ['--origin-retired'])).code,
    ).toBe(0);
    setMarker(laptop, 'v2');
    await h.relay.publish(laptop, 'device-laptop', h.keys);

    // This location's installation moves away (a move, or a cloud migration).
    h.use(desktop);
    const options = {
      appId: APP_ID,
      dataDirectory: desktop,
      sourceRoot: h.app,
    };
    await retireInstallation(options);
    const callsBefore = h.relay.state.calls.length;

    for (const argv of [[], ['--origin-retired'], ['--discard-local']]) {
      const refused = await h.run(desktop, 'device-desktop', argv);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('retired');
      expect(refused.stderr).toContain('installation restore --origin-retired');
    }
    // Nothing was contacted, replaced or un-retired.
    expect(h.relay.state.calls.length).toBe(callsBefore);
    expect(marker(desktop)).toBe('v1');
    expect((await inspectInstallationCustody(options)).status).toBe('retired');

    // Reversing the retirement is its own explicit declaration; then the
    // restore proceeds as on any other location.
    await restoreInstallation({ ...options, originRetired: true });
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(0);
    expect(marker(desktop)).toBe('v2');
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'restored',
      sequence: 2,
    });
  });

  it('threat: an unreadable custody record refuses the restore instead of overwriting around it', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'desktop local');
    writeFileSync(
      join(h.stateRootOf(desktop), INSTALLATION_CUSTODY_FILE),
      'not a record',
      { mode: 0o600 },
    );
    const result = await h.run(desktop, 'device-desktop', [
      '--discard-local',
      '--replace-installation',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('custody record');
    expect(marker(desktop)).toBe('desktop local');
    expect(h.relay.state.calls).toEqual([]);
  });

  it('removes plaintext leftovers of a restore that crashed before its journal', async () => {
    const h = await harness();
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'original');
    const hex = () => randomBytes(8).toString('hex');
    const candidate = join(h.root, `.desktop.restore-${hex()}`);
    const staging = join(
      h.root,
      `..desktop.restore-${hex()}.123.${hex()}.partial`,
    );
    const download = join(h.root, `.desktop.download-${hex()}`);
    const kept = join(h.root, `.desktop.previous-${hex()}`);
    for (const path of [candidate, staging, kept]) mkdirSync(path);
    writeFileSync(download, 'ciphertext');
    const result = await h.run(desktop, 'device-desktop', ['--recover']);
    expect(result.code).toBe(0);
    for (const path of [candidate, staging, download]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(existsSync(kept)).toBe(true);
    expect(marker(desktop)).toBe('original');
  });

  it('refuses a snapshot whose database fails its integrity check', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    writeFileSync(join(laptop, 'application.sqlite'), randomBytes(8192), {
      mode: 0o600,
    });
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('integrity check');
    expect(existsSync(desktop)).toBe(false);
    expect(siblings(h.root, desktop)).toEqual([]);
  });

  it('aborts without swapping when the relay lease is lost mid-restore', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    const desktop = join(h.root, 'desktop');
    h.relay.state.loseLeaseOnRenew = true;
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(1);
    expect(existsSync(desktop)).toBe(false);
    expect(siblings(h.root, desktop)).toEqual([]);
    expect(readVaultSyncRecord(h.stateRootOf(desktop))).toBeNull();
  });

  it('refuses when another device holds the relay lease', async () => {
    const h = await harness();
    const laptop = join(h.root, 'laptop');
    await h.boot(laptop, 'v1');
    await h.relay.publish(laptop, 'device-laptop', h.keys);
    h.relay.state.holder = 'device-laptop';
    const desktop = join(h.root, 'desktop');
    const result = await h.run(desktop, 'device-desktop');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Another device is writing');
    expect(existsSync(desktop)).toBe(false);
  });

  it('settles an interrupted swap with --recover before anything can write', async () => {
    const h = await harness();
    const desktop = join(h.root, 'desktop');
    await h.boot(desktop, 'original');
    const state = h.stateRootOf(desktop);
    const previous = join(
      h.root,
      `.desktop.previous-${randomBytes(8).toString('hex')}`,
    );
    const candidate = join(
      h.root,
      `.desktop.restore-${randomBytes(8).toString('hex')}`,
    );
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(
      join(state, 'data-root-swap.json'),
      `${JSON.stringify({ schemaVersion: 1, phase: 'swapped', live: desktop, candidate, previous, keepPrevious: false })}\n`,
      { mode: 0o600 },
    );
    const { renameSync } = await import('node:fs');
    renameSync(desktop, previous);
    renameSync(candidate, desktop);

    const recovered = await h.run(desktop, 'device-desktop', ['--recover']);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      status: 'recovered',
      recovery: 'rolled-back',
    });
    expect(marker(desktop)).toBe('original');
  });
});
