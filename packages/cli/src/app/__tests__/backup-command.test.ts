/**
 * `smrt app backup --encrypted --target` and `smrt app backups …` (#4804):
 * configuration without secrets, orchestration, retention per target, the
 * vault entitlement gate, and cleanup on failure.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalDatabaseStorage } from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRetention,
  type BackupTargetDependencies,
  parseTargetConfig,
  readBackupConfig,
} from '../backup-command.js';
import { DRIVE_FILE_SCOPE } from '../backup-target-gdrive.js';
import { BackupTargetError } from '../backup-targets.js';
import { runAppCommand } from '../cli.js';
import { resolveApplicationStateRoot } from '../identity.js';
import type { AppCommandDependencies } from '../runtime.js';
import { decryptSnapshot } from '../snapshot-framing.js';
import {
  ACCOUNT,
  DEVICE,
  entitled,
  FakeDrive,
  keyring,
  relayWithSigner,
  unentitled,
} from './backup-test-support.js';

const ENV_KEYS = ['SMRT_DATA_DIR', 'XDG_STATE_HOME', 'SMRT_APP_ID'] as const;
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const SECRET = 'oauth-refresh-token-must-never-print-0123456789';

interface Fixture {
  root: string;
  app: string;
  data: string;
  stateRoot: string;
  stdout: string[];
  stderr: string[];
  run(
    argv: string[],
    overrides?: Partial<AppCommandDependencies>,
  ): Promise<number>;
  json(): Record<string, any>;
  error(): Record<string, any>;
}

async function makeFixture(): Promise<Fixture> {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-backup-cmd-')),
  );
  roots.push(root);
  const app = join(root, 'app');
  const data = join(root, 'data');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'cmd-app' }));
  process.env.SMRT_DATA_DIR = data;
  process.env.XDG_STATE_HOME = join(root, 'state-home');
  await prepareLocalDatabaseStorage({
    appId: 'cmd-app',
    dataDirectory: data,
    sourceRoot: app,
  });
  writeFileSync(join(data, 'marker.txt'), 'plaintext-marker-for-backup');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fixture: Fixture = {
    root,
    app,
    data,
    stateRoot: resolveApplicationStateRoot({
      appId: 'cmd-app',
      dataDirectory: data,
      sourceRoot: app,
    }),
    stdout,
    stderr,
    async run(argv, overrides = {}) {
      stdout.length = 0;
      stderr.length = 0;
      return runAppCommand(argv, {
        cwd: app,
        io: {
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        },
        dependencies: {
          resolveRuntime: async () =>
            resolveApplicationRuntime({ profile: 'local' }) as never,
          ...overrides,
        },
      });
    },
    json: () => JSON.parse(stdout.join('')),
    error: () => JSON.parse(stderr.join('')),
  };
  return fixture;
}

const noop = {
  retryDelayMs: 0,
  sleep: async () => undefined,
};

describe('target configuration', () => {
  it('adds, lists and removes targets, storing no secrets', async () => {
    const f = await makeFixture();
    const dir = join(f.root, 'offsite');
    expect(
      await f.run([
        'backups',
        'targets',
        'add',
        'disk',
        '--kind',
        'file',
        '--path',
        dir,
        '--keep-last',
        '3',
        '--keep-within-days=30',
      ]),
    ).toBe(0);
    expect(f.json()).toMatchObject({
      status: 'target-added',
      target: {
        name: 'disk',
        kind: 'file',
        path: dir,
        retention: { keepLast: 3, keepWithinDays: 30 },
      },
      secretValuesIncluded: false,
    });
    expect(
      await f.run([
        'backups',
        'targets',
        'add',
        'drive',
        '--kind',
        'gdrive',
        '--credential',
        'my-google',
      ]),
    ).toBe(0);
    expect(f.json().target.credentialRef).toBe('my-google');
    // One folder per application: apps share the OAuth client, so a common
    // folder would let one app's retention reach another app's snapshots.
    expect(f.json().target.folder).toMatch(/^smrt-backups-[0-9a-f]{12}$/);
    expect(
      await f.run([
        'backups',
        'targets',
        'add',
        'vault',
        '--kind',
        'vault',
        '--url',
        'https://vault.example.com',
      ]),
    ).toBe(0);

    expect(await f.run(['backups', 'targets'])).toBe(0);
    expect(f.json().targets.map((t: { name: string }) => t.name)).toEqual([
      'disk',
      'drive',
      'vault',
    ]);
    const file = join(f.stateRoot, 'backup-targets.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.stateRoot).filter((n) => n.endsWith('.tmp'))).toEqual(
      [],
    );

    expect(await f.run(['backups', 'targets', 'remove', 'drive'])).toBe(0);
    expect(Object.keys(readBackupConfig(f.stateRoot).targets)).toEqual([
      'disk',
      'vault',
    ]);
    expect(await f.run(['backups', 'targets', 'remove', 'drive'])).toBe(1);
  });

  it('has no way to store a secret', async () => {
    const f = await makeFixture();
    for (const argv of [
      ['--kind', 'gdrive', '--credential', 'x', '--refresh-token', SECRET],
      ['--kind', 'gdrive', '--credential', 'x', '--client-secret', SECRET],
      ['--kind', 'vault', '--url', 'https://u:p@relay.example'],
      ['--kind', 'vault', '--url', `https://relay.example/?token=${SECRET}`],
      ['--kind', 'file', '--path', join(f.root, 'd'), '--credential', SECRET],
    ]) {
      expect(await f.run(['backups', 'targets', 'add', 't', ...argv])).toBe(1);
      expect(f.stderr.join('')).not.toContain(SECRET);
    }
    expect(existsSync(join(f.stateRoot, 'backup-targets.json'))).toBe(false);

    // A hand-edited file with any other field is refused, not carried along.
    writeFileSync(
      join(f.stateRoot, 'backup-targets.json'),
      JSON.stringify({
        schemaVersion: 1,
        targets: {
          drive: {
            kind: 'gdrive',
            credentialRef: 'ref',
            folder: 'f',
            refreshToken: SECRET,
          },
        },
      }),
      { mode: 0o600 },
    );
    expect(await f.run(['backups', 'targets'])).toBe(1);
    expect(f.stderr.join('')).not.toContain(SECRET);
    expect(() =>
      parseTargetConfig({ kind: 'vault', url: 'https://r.example', key: 'x' }),
    ).toThrow();
  });

  it('keeps file targets out of local storage and the source tree', async () => {
    const f = await makeFixture();
    expect(
      await f.run([
        'backups',
        'targets',
        'add',
        'inside',
        '--kind',
        'file',
        '--path',
        join(f.data, 'backups'),
      ]),
    ).toBe(1);
    expect(f.error().message).toMatch(/outside local storage/);
    expect(
      await f.run([
        'backups',
        'targets',
        'add',
        'src',
        '--kind',
        'file',
        '--path',
        join(f.app, 'backups'),
      ]),
    ).toBe(1);
    expect(
      await f.run(['backups', 'targets', 'add', 'Bad_Name', '--kind', 'file']),
    ).toBe(1);
  });

  it('keeps a file target away from the application state directory', async () => {
    const f = await makeFixture();
    for (const path of [
      f.stateRoot,
      join(f.stateRoot, 'backup-staging'),
      join(f.stateRoot, 'nested'),
      join(f.stateRoot, '..'),
    ]) {
      expect(
        await f.run([
          'backups',
          'targets',
          'add',
          't',
          '--kind',
          'file',
          '--path',
          path,
        ]),
      ).toBe(1);
    }
  });

  it('refuses a duplicate name and invalid retention', async () => {
    const f = await makeFixture();
    const add = (name: string, ...rest: string[]) =>
      f.run([
        'backups',
        'targets',
        'add',
        name,
        '--kind',
        'file',
        '--path',
        join(f.root, name),
        ...rest,
      ]);
    expect(await add('a')).toBe(0);
    expect(await add('a')).toBe(1);
    expect(await add('b', '--keep-last', '0')).toBe(1);
    expect(await add('c', '--keep-within-days', '5')).toBe(1);
    expect(await add('d', '--keep-last', 'many')).toBe(1);
  });
});

describe('smrt app backup --encrypted --target', () => {
  async function withFileTarget(f: Fixture, retention: string[] = []) {
    const dir = join(f.root, 'offsite');
    expect(
      await f.run(
        [
          'backups',
          'targets',
          'add',
          'disk',
          '--kind',
          'file',
          '--path',
          dir,
          ...retention,
        ],
        { snapshotKeys: keyring() },
      ),
    ).toBe(0);
    return dir;
  }

  it('writes one encrypted snapshot to the target that restores with the key', async () => {
    const f = await makeFixture();
    const dir = await withFileTarget(f);
    const keys = keyring(5n);
    expect(
      await f.run(['backup', '--encrypted', '--target', 'disk'], {
        snapshotKeys: keys,
      }),
    ).toBe(0);
    const report = f.json();
    expect(report).toMatchObject({
      status: 'backed-up',
      encrypted: true,
      target: { name: 'disk', kind: 'file' },
      snapshot: { sequence: '5', kind: 'data-root' },
      object: { sequence: '5' },
      retention: { applied: false, removed: [] },
    });
    expect(JSON.stringify(report)).not.toContain('digest');
    const [name] = readdirSync(dir);
    const stored = join(dir, name as string);
    expect(readFileSync(stored).includes('plaintext-marker-for-backup')).toBe(
      false,
    );
    await decryptSnapshot({
      source: stored,
      destination: join(f.root, 'candidate'),
      context: { accountId: ACCOUNT, deviceId: DEVICE, sequence: 5n },
      keys,
      expectedKind: 'data-root',
    });
    expect(readFileSync(join(f.root, 'candidate', 'marker.txt'), 'utf8')).toBe(
      'plaintext-marker-for-backup',
    );
    // Staging is ciphertext-only and removed; locks are released.
    expect(readdirSync(join(f.stateRoot, 'backup-staging'))).toEqual([]);
    expect(existsSync(join(f.stateRoot, 'operation.lock'))).toBe(false);
    expect(existsSync(join(f.stateRoot, 'writer.lease'))).toBe(false);
  });

  it('sweeps only its own staged ciphertext before a backup', async () => {
    const f = await makeFixture();
    await withFileTarget(f);
    const staging = join(f.stateRoot, 'backup-staging');
    mkdirSync(join(staging, 'keep-dir'), { recursive: true });
    writeFileSync(join(staging, 'stale.hvsnap'), 'x');
    writeFileSync(join(staging, 'other.txt'), 'x');
    expect(
      await f.run(['backup', '--encrypted', '--target', 'disk'], {
        snapshotKeys: keyring(),
      }),
    ).toBe(0);
    expect(readdirSync(staging).sort()).toEqual(['keep-dir', 'other.txt']);
  });

  it('refuses a target without --encrypted, with a destination, or unknown', async () => {
    const f = await makeFixture();
    await withFileTarget(f);
    const keys = keyring();
    expect(
      await f.run(['backup', '--target', 'disk'], { snapshotKeys: keys }),
    ).toBe(1);
    expect(f.error().message).toMatch(/only encrypted snapshots/);
    expect(
      await f.run(
        ['backup', '--encrypted', '--target', 'disk', join(f.root, 'x')],
        {
          snapshotKeys: keys,
        },
      ),
    ).toBe(1);
    expect(
      await f.run(['backup', '--encrypted', '--target', 'missing'], {
        snapshotKeys: keys,
      }),
    ).toBe(1);
    expect(f.error().message).toMatch(/No backup target/);
    expect(
      await f.run(['backup', '--encrypted', '--target'], {
        snapshotKeys: keys,
      }),
    ).toBe(1);
    expect(keys.sealed).toBe(0);
  });

  it('fails closed without a key provider', async () => {
    const f = await makeFixture();
    await withFileTarget(f);
    expect(await f.run(['backup', '--encrypted', '--target', 'disk'])).toBe(1);
    expect(f.error().message).toMatch(/vault key provider/);
  });

  it('applies the target retention after a successful upload', async () => {
    const f = await makeFixture();
    const dir = await withFileTarget(f, ['--keep-last', '2']);
    const keys = keyring(1n);
    for (let index = 0; index < 4; index += 1) {
      expect(
        await f.run(['backup', '--encrypted', '--target', 'disk'], {
          snapshotKeys: keys,
        }),
      ).toBe(0);
    }
    expect(f.json().retention).toMatchObject({ applied: true });
    expect(readdirSync(dir).sort()).toEqual([
      'snapshot-00000000000000000003.hvsnap',
      'snapshot-00000000000000000004.hvsnap',
    ]);
  });

  it('keeps the snapshot it just stored when the sequence restarted below the target maximum', async () => {
    const f = await makeFixture();
    const dir = await withFileTarget(f, ['--keep-last', '1']);
    // A previous install uploaded sequences 8 and 9.
    for (const start of [8n, 9n]) {
      expect(
        await f.run(['backup', '--encrypted', '--target', 'disk'], {
          snapshotKeys: keyring(start),
        }),
      ).toBe(0);
    }
    // A reinstalled device restarts its counter at 1.
    expect(
      await f.run(['backup', '--encrypted', '--target', 'disk'], {
        snapshotKeys: keyring(1n),
      }),
    ).toBe(0);
    const report = f.json();
    expect(report).toMatchObject({
      status: 'backed-up',
      object: { sequence: '1' },
      retention: { applied: true },
    });
    // The stored object is the one thing retention must not delete.
    expect(readdirSync(dir).sort()).toEqual([
      'snapshot-00000000000000000001.hvsnap',
      'snapshot-00000000000000000009.hvsnap',
    ]);
    expect(report.retention.removed).toEqual([]);
  });

  it('warns loudly when the stored sequence is not above the target maximum', async () => {
    const f = await makeFixture();
    const dir = await withFileTarget(f);
    expect(
      await f.run(['backup', '--encrypted', '--target', 'disk'], {
        snapshotKeys: keyring(9n),
      }),
    ).toBe(0);
    expect(f.json().warnings).toBeUndefined();
    expect(
      await f.run(['backup', '--encrypted', '--target', 'disk'], {
        snapshotKeys: keyring(2n),
      }),
    ).toBe(0);
    expect(f.json()).toMatchObject({
      status: 'backed-up',
      warnings: [
        {
          code: 'sequence_not_above_target_maximum',
          message: expect.stringContaining('sequence 9'),
        },
      ],
    });
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('reports a retention failure without failing the finished backup', async () => {
    const target = {
      name: 't',
      kind: 'file',
      preflight: async () => undefined,
      put: async () => {
        throw new Error('unused');
      },
      list: async () => [
        { id: 'a', sequence: 2n, byteSize: 1, createdAt: new Date() },
        { id: 'b', sequence: 1n, byteSize: 1, createdAt: new Date() },
      ],
      get: () => (async function* () {})(),
      delete: async () => {
        throw new BackupTargetError('unavailable', 'nope');
      },
    } as const;
    const outcome = await applyRetention(target as never, { keepLast: 1 });
    expect(outcome).toEqual({
      applied: false,
      removed: [],
      error: { code: 'unavailable', message: 'nope' },
    });
    expect(await applyRetention(target as never, undefined)).toEqual({
      applied: false,
      removed: [],
    });
  });

  it('removes its staging file when the target fails', async () => {
    const f = await makeFixture();
    const dir = join(f.root, 'offsite');
    await f.run([
      'backups',
      'targets',
      'add',
      'disk',
      '--kind',
      'file',
      '--path',
      dir,
    ]);
    mkdirSync(dir, { recursive: true });
    // Same sequence already stored: the put is refused after sealing.
    const keys = keyring(1n);
    await f.run(['backup', '--encrypted', '--target', 'disk'], {
      snapshotKeys: keys,
    });
    const again = keyring(1n);
    expect(
      await f.run(['backup', '--encrypted', '--target', 'disk'], {
        snapshotKeys: again,
      }),
    ).toBe(1);
    expect(f.error().message).toMatch(/already exists/);
    expect(readdirSync(join(f.stateRoot, 'backup-staging'))).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  describe('google drive', () => {
    const drive = new FakeDrive();
    const backup = (scope = DRIVE_FILE_SCOPE): BackupTargetDependencies => ({
      credentials: {
        driveCredentials: async (reference) =>
          reference === 'my-google'
            ? {
                clientId: 'id',
                clientSecret: SECRET,
                refreshToken: SECRET,
                scope,
              }
            : undefined,
        vaultSigner: async () => undefined,
      },
      createDriveFilesystem: async () => drive,
    });

    it('uploads through the credential seam and never prints credentials', async () => {
      const f = await makeFixture();
      await f.run([
        'backups',
        'targets',
        'add',
        'drive',
        '--kind',
        'gdrive',
        '--credential',
        'my-google',
      ]);
      expect(
        await f.run(['backup', '--encrypted', '--target', 'drive'], {
          snapshotKeys: keyring(),
          backup: backup(),
        }),
      ).toBe(0);
      expect(drive.visible(drive.folders()[0] as string)).toHaveLength(1);
      expect(f.stdout.join('') + f.stderr.join('')).not.toContain(SECRET);
      expect(
        readFileSync(join(f.stateRoot, 'backup-targets.json'), 'utf8'),
      ).not.toContain(SECRET);
    });

    it('stops before sealing when the grant is too wide', async () => {
      const f = await makeFixture();
      await f.run([
        'backups',
        'targets',
        'add',
        'drive',
        '--kind',
        'gdrive',
        '--credential',
        'my-google',
      ]);
      const keys = keyring();
      expect(
        await f.run(['backup', '--encrypted', '--target', 'drive'], {
          snapshotKeys: keys,
          backup: backup('https://www.googleapis.com/auth/drive'),
        }),
      ).toBe(1);
      expect(f.error().message).toMatch(/wider than backups need/);
      expect(keys.sealed).toBe(0);
      expect(f.stderr.join('')).not.toContain(SECRET);
    });

    it('fails clearly with no credential store wired', async () => {
      const f = await makeFixture();
      await f.run([
        'backups',
        'targets',
        'add',
        'drive',
        '--kind',
        'gdrive',
        '--credential',
        'my-google',
      ]);
      expect(
        await f.run(['backup', '--encrypted', '--target', 'drive'], {
          snapshotKeys: keyring(),
        }),
      ).toBe(1);
      expect(f.error().message).toMatch(/No Google Drive credentials/);
    });
  });

  describe('vault', () => {
    async function configure(f: Fixture) {
      expect(
        await f.run([
          'backups',
          'targets',
          'add',
          'vault',
          '--kind',
          'vault',
          '--url',
          'https://vault.example.com',
        ]),
      ).toBe(0);
    }

    it('below tier: reports an upgrade message, sends nothing, spends no sequence', async () => {
      const f = await makeFixture();
      await configure(f);
      const relay = relayWithSigner();
      const keys = keyring();
      expect(
        await f.run(['backup', '--encrypted', '--target', 'vault'], {
          snapshotKeys: keys,
          backup: {
            credentials: {
              driveCredentials: async () => undefined,
              vaultSigner: async () => relay.identity.signer,
            },
            entitlements: unentitled,
            fetch: relay.relay.fetch,
          },
        }),
      ).toBe(1);
      expect(f.error().message).toMatch(/Vault plan.*Upgrade/s);
      expect(relay.relay.calls).toEqual([]);
      expect(keys.sealed).toBe(0);
      expect(existsSync(join(f.stateRoot, 'backup-staging'))).toBe(false);
    });

    it('with the entitlement: uploads, and the relay holds only ciphertext', async () => {
      const f = await makeFixture();
      await configure(f);
      const relay = relayWithSigner();
      const keys = keyring(1n);
      expect(
        await f.run(['backup', '--encrypted', '--target', 'vault'], {
          snapshotKeys: keys,
          backup: {
            credentials: {
              driveCredentials: async () => undefined,
              vaultSigner: async () => relay.identity.signer,
            },
            entitlements: entitled,
            fetch: relay.relay.fetch,
            vault: noop,
          },
        }),
      ).toBe(0);
      expect(f.json()).toMatchObject({
        target: { kind: 'vault' },
        object: { sequence: '1' },
      });
      const stored = relay.relay.snapshots.get(1);
      expect(stored).toBeDefined();
      const bytes = Buffer.concat(stored?.chunks ?? []);
      expect(bytes.includes('plaintext-marker-for-backup')).toBe(false);
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('HVSF');

      expect(
        await f.run(['backups', 'list'], {
          backup: {
            credentials: {
              driveCredentials: async () => undefined,
              vaultSigner: async () => relay.identity.signer,
            },
            fetch: relay.relay.fetch,
            vault: noop,
          },
        }),
      ).toBe(0);
      expect(f.json().targets[0].snapshots).toHaveLength(1);
    });

    function vaultDeps(relay: ReturnType<typeof relayWithSigner>) {
      return {
        backup: {
          credentials: {
            driveCredentials: async () => undefined,
            vaultSigner: async () => relay.identity.signer,
          },
          entitlements: entitled,
          fetch: relay.relay.fetch,
          vault: noop,
        },
      };
    }

    it('publishes under the writer lease, records the vault position and releases the lease', async () => {
      const f = await makeFixture();
      await configure(f);
      const relay = relayWithSigner();
      const keys = keyring(1n);
      for (const sequence of [1, 2]) {
        expect(
          await f.run(['backup', '--encrypted', '--target', 'vault'], {
            snapshotKeys: keys,
            ...vaultDeps(relay),
          }),
        ).toBe(0);
        expect(f.json().object.sequence).toBe(String(sequence));
        expect(
          JSON.parse(
            readFileSync(join(f.stateRoot, 'vault-sync.json'), 'utf8'),
          ),
        ).toMatchObject({
          baseSequence: sequence,
          highestSeenSequence: sequence,
          localWritesPending: false,
        });
      }
      const calls = relay.relay.calls.map((c) => `${c.method} ${c.path}`);
      expect(calls.filter((c) => c === 'POST /v1/lease/acquire')).toHaveLength(
        2,
      );
      expect(calls.filter((c) => c === 'POST /v1/lease/release')).toHaveLength(
        2,
      );
    });

    it('threat: a device behind the account is refused before a snapshot is sealed', async () => {
      const f = await makeFixture();
      await configure(f);
      const relay = relayWithSigner();
      relay.relay.highWater = 9;
      const keys = keyring(10n);
      expect(
        await f.run(['backup', '--encrypted', '--target', 'vault'], {
          snapshotKeys: keys,
          ...vaultDeps(relay),
        }),
      ).toBe(1);
      expect(f.error().message).toMatch(/restore-latest/);
      expect(keys.sealed).toBe(0);
      expect(relay.relay.snapshots.size).toBe(0);
      expect(existsSync(join(f.stateRoot, 'backup-staging'))).toBe(false);
      expect(existsSync(join(f.stateRoot, 'vault-sync.json'))).toBe(false);
    });

    it("threat: keys of another vault account never seal into this account's line (#4817)", async () => {
      const f = await makeFixture();
      await configure(f);
      const relay = relayWithSigner();
      const ring = keyring(1n);
      // After a restart the lifecycle is on the new account while the target
      // and sync record still name the old one.
      const keys = {
        ...ring,
        async sealingKey() {
          return { ...(await ring.sealingKey()), accountId: 'account-new' };
        },
      };
      expect(
        await f.run(['backup', '--encrypted', '--target', 'vault'], {
          snapshotKeys: keys,
          ...vaultDeps(relay),
        }),
      ).toBe(1);
      expect(f.error().message).toMatch(/different vault account/);
      expect(relay.relay.snapshots.size).toBe(0);
      expect(readdirSync(join(f.stateRoot, 'backup-staging'))).toEqual([]);
      const calls = relay.relay.calls.map((c) => `${c.method} ${c.path}`);
      expect(calls.filter((c) => c === 'POST /v1/uploads')).toEqual([]);
      expect(
        JSON.parse(readFileSync(join(f.stateRoot, 'vault-sync.json'), 'utf8')),
      ).toMatchObject({ baseSequence: 0 });
    });

    it('never prunes a vault target that has no client retention', async () => {
      const f = await makeFixture();
      await configure(f);
      expect(await f.run(['backups', 'prune'])).toBe(0);
      expect(f.json().targets[0].note).toMatch(/relay enforces/);
    });
  });
});

describe('smrt app backups list / prune', () => {
  it('lists every target and reports one failing target without hiding the rest', async () => {
    const f = await makeFixture();
    await f.run([
      'backups',
      'targets',
      'add',
      'disk',
      '--kind',
      'file',
      '--path',
      join(f.root, 'd'),
    ]);
    await f.run([
      'backups',
      'targets',
      'add',
      'drive',
      '--kind',
      'gdrive',
      '--credential',
      'gone',
    ]);
    const keys = keyring(1n);
    await f.run(['backup', '--encrypted', '--target', 'disk'], {
      snapshotKeys: keys,
    });
    expect(await f.run(['backups', 'list'])).toBe(1);
    const report = f.json();
    expect(report.status).toBe('partial');
    expect(report.targets[0].snapshots).toHaveLength(1);
    expect(report.targets[1].error.code).toBe('credentials_unavailable');
    expect(await f.run(['backups', 'list', '--target', 'disk'])).toBe(0);
    expect(await f.run(['backups', 'list', '--target', 'nope'])).toBe(1);
  });

  it('honours retention per target, with a dry run and stale partial cleanup', async () => {
    const f = await makeFixture();
    const keep2 = join(f.root, 'keep2');
    const unbounded = join(f.root, 'unbounded');
    await f.run([
      'backups',
      'targets',
      'add',
      'keep2',
      '--kind',
      'file',
      '--path',
      keep2,
    ]);
    await f.run([
      'backups',
      'targets',
      'add',
      'all',
      '--kind',
      'file',
      '--path',
      unbounded,
    ]);
    const keys = keyring(1n);
    // Add retention after the uploads so the backups themselves do not prune.
    for (let index = 0; index < 3; index += 1) {
      await f.run(['backup', '--encrypted', '--target', 'keep2'], {
        snapshotKeys: keys,
      });
      await f.run(['backup', '--encrypted', '--target', 'all'], {
        snapshotKeys: keys,
      });
    }
    expect(readdirSync(keep2)).toHaveLength(3);
    const config = readBackupConfig(f.stateRoot);
    writeFileSync(
      join(f.stateRoot, 'backup-targets.json'),
      JSON.stringify({
        ...config,
        targets: {
          ...config.targets,
          keep2: { ...config.targets.keep2, retention: { keepLast: 2 } },
        },
      }),
      { mode: 0o600 },
    );

    expect(await f.run(['backups', 'prune', '--dry-run'])).toBe(0);
    expect(f.json().status).toBe('dry-run');
    expect(
      f.json().targets.find((t: { name: string }) => t.name === 'keep2')
        .wouldRemove,
    ).toEqual(['snapshot-00000000000000000001.hvsnap']);
    expect(readdirSync(keep2)).toHaveLength(3);

    expect(await f.run(['backups', 'prune'])).toBe(0);
    expect(readdirSync(keep2)).toHaveLength(2);
    expect(readdirSync(unbounded)).toHaveLength(3);
    const results = f.json().targets as Array<{ name: string; note?: string }>;
    expect(results.find((r) => r.name === 'all')?.note).toMatch(/No retention/);
  });

  it('refuses deployed profiles and unknown commands', async () => {
    const f = await makeFixture();
    expect(await f.run(['backups', 'frobnicate'])).toBe(1);
    expect(
      await f.run(['backups', 'targets'], {
        resolveRuntime: async () =>
          resolveApplicationRuntime({ profile: 'self-hosted' }) as never,
      }),
    ).toBe(1);
    expect(f.error().message).toMatch(/local installations/);
    expect(await f.run(['backups', '--help'])).toBe(0);
    expect(f.stdout.join('')).toMatch(/targets add/);
  });
});
