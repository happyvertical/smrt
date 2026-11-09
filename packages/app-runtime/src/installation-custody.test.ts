/**
 * Installation custody (#4704): restore/move versus copy of a local
 * installation's identity seed, copy detection, re-seed and missing-seed
 * recovery. Everything runs on the real local runtime and SQLite, with the
 * state root redirected into the test's own home directory.
 */
import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ROLE_SLUGS,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
} from '@happyvertical/smrt-users';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationStateRootSource,
  assessInstallationCustody,
  describeInstallationStateRoot,
  type InstallationCustodyRecord,
  initializeLocalApplicationRuntime,
  inspectInstallationCustody,
  installationCustodyResolutions,
  LocalRuntimeError,
  openLocalMcpTokenStore,
  prepareApplicationStateRoot,
  recoverInstallationSeed,
  reseedInstallation,
  resolveApplicationStateRoot,
  restoreInstallation,
  retireInstallation,
} from './index.js';
import { stateRootOptions } from './installation-custody.js';
import { deriveLocalInstallationIdentity } from './local-installation-identity.js';

const APP_ID = 'custody';
const SCOPE = 'notes.read';
const temporaryRoots: string[] = [];
const initializationLockPaths = new Set<string>();
const openDatabases: Array<{ close?: () => Promise<void> }> = [];

afterEach(async () => {
  for (const db of openDatabases.splice(0)) await db.close?.();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  for (const lockPath of initializationLockPaths) {
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      await rm(`${lockPath}${suffix}`, { force: true });
    }
    try {
      await rmdir(dirname(lockPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  initializationLockPaths.clear();
});

async function trackInitializationLock(dataDirectory: string) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Tests require a numeric uid.');
  const identity =
    platform() === 'darwin' || platform() === 'win32'
      ? dataDirectory.toLowerCase()
      : dataDirectory;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  initializationLockPaths.add(
    join(await realpath('/tmp'), `.smrt-${uid}`, key, 'initialization.sqlite'),
  );
}

/**
 * One machine's workspace. State roots resolve under this test file's own
 * HOME (`test-home.setup.ts`), keyed by data-root path, as in production.
 */
async function machine(label: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `smrt-custody-${label}-`)),
  );
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  const at = async (name: string) => {
    const dataDirectory = join(root, name);
    await trackInitializationLock(dataDirectory);
    return {
      appId: APP_ID,
      sourceRoot,
      dataDirectory,
    };
  };
  return { root, at };
}

type Options = Awaited<ReturnType<Awaited<ReturnType<typeof machine>>['at']>>;

async function boot(options: Options) {
  const initialized = await initializeLocalApplicationRuntime(options);
  openDatabases.push(initialized.runtime.db);
  return initialized;
}

async function stop(initialized: Awaited<ReturnType<typeof boot>>) {
  await initialized.runtime.db.close?.();
  const index = openDatabases.indexOf(initialized.runtime.db);
  if (index >= 0) openDatabases.splice(index, 1);
}

const stateRootOf = (options: Options) =>
  resolveApplicationStateRoot(stateRootOptions(options));
const seedOf = (options: Options) =>
  join(options.dataDirectory, 'secrets', 'application.secret');
const dataRecordOf = (options: Options) =>
  join(options.dataDirectory, 'secrets', 'installation.json');
const stateRecordOf = (options: Options) =>
  join(stateRootOf(options), 'installation.json');
const readJson = async <T = InstallationCustodyRecord>(path: string) =>
  JSON.parse(await readFile(path, 'utf8')) as T;

async function identityOf(options: Options) {
  return deriveLocalInstallationIdentity(
    await readFile(seedOf(options), 'utf8'),
  );
}

/** A claimed owner holding `notes.read`, and one issued local MCP token. */
async function ownedInstallation(options: Options) {
  const initialized = await boot(options);
  const { runtime, bootstrap } = initialized;
  if (!bootstrap) throw new Error('expected a bootstrap invitation');
  await runtime.claimOwner({
    token: bootstrap.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
  const roles = await RoleCollection.create({ db: runtime.db });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  if (!ownerRole?.id) throw new Error('owner role missing');
  const permissions = await PermissionCollection.create({ db: runtime.db });
  const rolePermissions = await RolePermissionCollection.create({
    db: runtime.db,
  });
  const permission = await permissions.findOrCreate(SCOPE, { name: SCOPE });
  await rolePermissions.addPermission(ownerRole.id, permission.id as string);
  const issued = await runtime.mcpTokens?.issue({ scopes: [SCOPE] });
  if (!issued) throw new Error('token not issued');
  await stop(initialized);
  return { token: issued.token, tokenId: issued.id };
}

async function verifyToken(options: Options, token: string) {
  const store = await openLocalMcpTokenStore(options);
  try {
    return await store.verify(token);
  } finally {
    await store.close();
  }
}

/**
 * A byte copy of the data root made the way `smrt app backup` makes it
 * (synchronous `cpSync`, so copied directories take the default umask).
 */
async function copyDataRoot(from: Options, to: Options) {
  cpSync(from.dataDirectory, to.dataDirectory, { recursive: true });
  await chmod(to.dataDirectory, 0o700);
}

describe('installation custody classification', () => {
  const id = '11111111-1111-8111-8111-111111111111';
  const other = '22222222-2222-8222-8222-222222222222';
  const record = (
    over: Partial<InstallationCustodyRecord> = {},
  ): InstallationCustodyRecord => ({
    schemaVersion: 1,
    installationId: id,
    epoch: 1,
    activationId: 'a'.repeat(32),
    previousInstallationId: null,
    status: 'active',
    ...over,
  });

  it('names every state and the declarations that resolve it', () => {
    const table: Array<
      [Parameters<typeof assessInstallationCustody>[0], string]
    > = [
      [{ data: record(), state: record(), installationId: id }, 'in-custody'],
      [{ data: null, state: null, installationId: id }, 'unrecorded'],
      [{ data: record(), state: null, installationId: id }, 'arrived'],
      [
        {
          data: record(),
          state: record({ activationId: 'b'.repeat(32) }),
          installationId: id,
        },
        'diverged',
      ],
      [
        { data: null, state: record(), installationId: id },
        'data-record-missing',
      ],
      [
        {
          data: record(),
          state: record({ status: 'retired' }),
          installationId: id,
        },
        'retired',
      ],
      [
        { data: record(), state: record(), installationId: other },
        'seed-mismatch',
      ],
      [
        { data: record(), state: record(), installationId: null },
        'seed-missing',
      ],
      [
        { data: 'invalid', state: record(), installationId: id },
        'record-invalid',
      ],
    ];
    for (const [evidence, status] of table) {
      expect(assessInstallationCustody(evidence)).toBe(status);
    }
    expect(installationCustodyResolutions('in-custody')).toEqual([]);
    expect(installationCustodyResolutions('arrived')).toEqual([
      'restore',
      'reseed',
    ]);
    expect(installationCustodyResolutions('seed-missing')).toEqual([
      'recover-seed',
      'reseed',
    ]);
  });
});

describe('installation custody', () => {
  it('establishes custody on first run and keeps it across restarts', async () => {
    const { at } = await machine('first-run');
    const options = await at('data');
    await stop(await boot(options));

    const data = await readJson(dataRecordOf(options));
    const state = await readJson(stateRecordOf(options));
    expect(data).toEqual(state);
    expect(data).toMatchObject({
      schemaVersion: 1,
      epoch: 1,
      previousInstallationId: null,
      status: 'active',
      installationId: (await identityOf(options)).deviceId,
    });
    for (const path of [dataRecordOf(options), stateRecordOf(options)]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // Public identifiers only: the seed never enters a custody record.
      expect(await readFile(path, 'utf8')).not.toContain(
        (await readFile(seedOf(options), 'utf8')).trim(),
      );
    }
    const before = await readFile(dataRecordOf(options), 'utf8');
    await stop(await boot(options));
    expect(await readFile(dataRecordOf(options), 'utf8')).toBe(before);
    expect(await inspectInstallationCustody(options)).toMatchObject({
      status: 'in-custody',
      epoch: 1,
      resolutions: [],
      secretValuesIncluded: false,
    });
  });

  it('adopts an installation that predates custody records (trust on first use)', async () => {
    const { at } = await machine('legacy');
    const options = await at('data');
    await stop(await boot(options));
    await rm(dataRecordOf(options));
    await rm(stateRecordOf(options));

    expect(await inspectInstallationCustody(options)).toMatchObject({
      status: 'unrecorded',
    });
    await stop(await boot(options));
    expect(await inspectInstallationCustody(options)).toMatchObject({
      status: 'in-custody',
      epoch: 1,
    });
  });

  it('replaces stale location records when a data root is started fresh', async () => {
    const { at } = await machine('fresh-start');
    const stale = await at('stale-source');
    await stop(await boot(stale));
    const staleRecord = await readFile(stateRecordOf(stale), 'utf8');

    // A deleted-and-recreated data root: the location still holds a record
    // from an earlier, different installation at the same path.
    const options = await at('data');
    prepareApplicationStateRoot(stateRootOptions(options));
    await writeFile(stateRecordOf(options), staleRecord, { mode: 0o600 });

    await stop(await boot(options));
    const fresh = await readJson(stateRecordOf(options));
    expect(fresh.installationId).toBe((await identityOf(options)).deviceId);
    expect(fresh.installationId).not.toBe(
      (JSON.parse(staleRecord) as InstallationCustodyRecord).installationId,
    );
    expect(fresh.epoch).toBe(1);
    expect(await inspectInstallationCustody(options)).toMatchObject({
      status: 'in-custody',
    });
  });

  describe('same-installation restore or move', () => {
    it('refuses an unverified arrival, then preserves seed, identities and tokens on restore', async () => {
      const { at } = await machine('restore');
      const origin = await at('origin');
      const { token } = await ownedInstallation(origin);
      const identityBefore = await identityOf(origin);
      const seedBefore = await readFile(seedOf(origin), 'utf8');
      expect(await verifyToken(origin, token)).not.toBeNull();

      // Move: copy the data root to a new location and drop the origin.
      const destination = await at('destination');
      await copyDataRoot(origin, destination);
      await rm(origin.dataDirectory, { recursive: true, force: true });
      const arrivedRecord = await readFile(dataRecordOf(destination), 'utf8');

      await expect(boot(destination)).rejects.toMatchObject({
        code: 'installation_unverified',
        message: expect.stringContaining('(arrived)'),
      });
      // Refusal changed nothing: no state record, record bytes untouched.
      await expect(stat(stateRecordOf(destination))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(dataRecordOf(destination), 'utf8')).toBe(
        arrivedRecord,
      );
      expect(await inspectInstallationCustody(destination)).toMatchObject({
        status: 'arrived',
        resolutions: ['restore', 'reseed'],
      });

      // The origin's retirement is an explicit assertion, never assumed.
      await expect(
        restoreInstallation({ ...destination, originRetired: false }),
      ).rejects.toThrow(/origin is no longer active/);
      await expect(boot(destination)).rejects.toMatchObject({
        code: 'installation_unverified',
      });

      const outcome = await restoreInstallation({
        ...destination,
        originRetired: true,
      });
      expect(outcome).toMatchObject({
        declaration: 'restore',
        epoch: 2,
        status: 'in-custody',
        effects: {
          identityChanged: false,
          seedKeyedTokensInvalidated: false,
          mcpTokensRevoked: 0,
        },
        secretValuesIncluded: false,
      });
      await stop(await boot(destination));

      expect(await readFile(seedOf(destination), 'utf8')).toBe(seedBefore);
      expect(await identityOf(destination)).toEqual(identityBefore);
      expect(await verifyToken(destination, token)).not.toBeNull();
      const record = await readJson(stateRecordOf(destination));
      expect(record).toMatchObject({
        epoch: 2,
        installationId: identityBefore.deviceId,
      });
      expect(record.activationId).not.toBe(
        (JSON.parse(arrivedRecord) as InstallationCustodyRecord).activationId,
      );
    });

    it('restores in place from an older backup of the same installation', async () => {
      const { at } = await machine('in-place');
      const options = await at('data');
      await stop(await boot(options));
      const backup = await at('backup');
      await copyDataRoot(options, backup);
      // Custody moved on after the backup (retire, then restore, bumps it).
      await retireInstallation(options);
      await restoreInstallation({ ...options, originRetired: true });
      await rm(options.dataDirectory, { recursive: true, force: true });
      await copyDataRoot(backup, options);

      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'diverged',
        resolutions: ['restore', 'reseed'],
      });
      await expect(boot(options)).rejects.toMatchObject({
        code: 'installation_unverified',
      });
      const outcome = await restoreInstallation({
        ...options,
        originRetired: true,
      });
      // Epoch never goes backwards, even though the restored record says 1.
      expect(outcome.epoch).toBe(3);
      await stop(await boot(options));
    });

    it('refuses a seed copied beside an empty database', async () => {
      const { at } = await machine('seed-only');
      const origin = await at('origin');
      await stop(await boot(origin));
      // Someone copies the data root but drops the database: the new one is
      // empty, yet the seed (and with it every identity) is not new.
      const elsewhere = await at('elsewhere');
      await copyDataRoot(origin, elsewhere);
      for (const suffix of ['', '-wal', '-shm']) {
        await rm(join(elsewhere.dataDirectory, `application.sqlite${suffix}`), {
          force: true,
        });
      }
      await expect(boot(elsewhere)).rejects.toMatchObject({
        code: 'installation_unverified',
        message: expect.stringContaining('(arrived)'),
      });
    });

    it('lets an origin be retired so it can no longer start', async () => {
      const { at } = await machine('retire');
      const origin = await at('origin');
      await stop(await boot(origin));

      const outcome = await retireInstallation(origin);
      expect(outcome).toMatchObject({
        declaration: 'retire',
        status: 'retired',
        effects: { identityChanged: false },
      });
      await expect(boot(origin)).rejects.toMatchObject({
        code: 'installation_unverified',
        message: expect.stringContaining('(retired)'),
      });
      // Reviving a retired origin is an explicit restore and bumps the epoch.
      expect(
        await restoreInstallation({ ...origin, originRetired: true }),
      ).toMatchObject({ epoch: 2, status: 'in-custody' });
      await stop(await boot(origin));
    });
  });

  describe('duplicate active copy', () => {
    it('detects the copy, leaves the original running, and re-seeds the copy into an independent installation', async () => {
      const { at } = await machine('copy');
      const original = await at('original');
      const { token, tokenId } = await ownedInstallation(original);
      const originalIdentity = await identityOf(original);
      const originalSeed = await readFile(seedOf(original), 'utf8');

      const copy = await at('copy');
      await copyDataRoot(original, copy);
      // Byte-identical copies present the same identities and tokens.
      expect(await identityOf(copy)).toEqual(originalIdentity);
      expect(await verifyToken(copy, token)).not.toBeNull();

      // Original stays active and unaffected; the copy is refused.
      const running = await boot(original);
      await expect(boot(copy)).rejects.toMatchObject({
        code: 'installation_unverified',
      });
      expect(await inspectInstallationCustody(original)).toMatchObject({
        status: 'in-custody',
        epoch: 1,
      });

      const outcome = await reseedInstallation(copy);
      expect(outcome).toMatchObject({
        declaration: 'reseed',
        status: 'in-custody',
        epoch: 1,
        previousInstallationId: originalIdentity.deviceId,
        effects: {
          identityChanged: true,
          seedKeyedTokensInvalidated: true,
          mcpTokensRevoked: 1,
        },
        secretValuesIncluded: false,
      });
      const copyIdentity = await identityOf(copy);
      expect(outcome.installationId).toBe(copyIdentity.deviceId);
      // Every derived identifier differs; the original is untouched.
      for (const key of Object.keys(copyIdentity) as Array<
        keyof typeof copyIdentity
      >) {
        expect(copyIdentity[key]).not.toBe(originalIdentity[key]);
      }
      expect(await readFile(seedOf(original), 'utf8')).toBe(originalSeed);
      expect(await readJson(dataRecordOf(copy))).toMatchObject({
        previousInstallationId: originalIdentity.deviceId,
      });

      // Seed-keyed tokens stop working on the copy only, and the copy's
      // listing says so truthfully.
      expect(await verifyToken(copy, token)).toBeNull();
      expect(await verifyToken(original, token)).not.toBeNull();
      const store = await openLocalMcpTokenStore(copy);
      try {
        expect(await store.list()).toMatchObject([
          { id: tokenId, status: 'revoked' },
        ]);
      } finally {
        await store.close();
      }

      // Both installations now run side by side with distinct identities.
      const second = await boot(copy);
      expect(await running.runtime.diagnostics()).toBeDefined();
      expect(await second.runtime.diagnostics()).toBeDefined();
      await stop(second);
      await stop(running);
    });

    it('treats a copy placed at the original path on another machine as an arrival', async () => {
      const { at } = await machine('machine-move');
      const options = await at('data');
      await stop(await boot(options));
      const backup = await at('backup');
      await copyDataRoot(options, backup);

      // "Another machine": the same path, but no state root remembers it.
      await rm(options.dataDirectory, { recursive: true, force: true });
      await rm(stateRootOf(options), { recursive: true, force: true });
      cpSync(backup.dataDirectory, options.dataDirectory, {
        recursive: true,
      });
      await chmod(options.dataDirectory, 0o700);
      await expect(boot(options)).rejects.toMatchObject({
        code: 'installation_unverified',
        message: expect.stringContaining('(arrived)'),
      });
    });

    it('refuses declarations while a writer is active', async () => {
      const { at } = await machine('live-writer');
      const origin = await at('origin');
      await stop(await boot(origin));
      const copy = await at('copy');
      await copyDataRoot(origin, copy);

      // Prepares the state root; then plant a live foreign writer (our parent).
      await inspectInstallationCustody(copy);
      await writeFile(
        join(stateRootOf(copy), 'writer.lease'),
        `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, instance: 'a'.repeat(32) })}\n`,
        { mode: 0o600 },
      );
      await expect(reseedInstallation(copy)).rejects.toThrow(
        /Another application writer is active/,
      );
      await expect(
        restoreInstallation({ ...copy, originRetired: true }),
      ).rejects.toThrow(/Another application writer is active/);
      expect(await inspectInstallationCustody(copy)).toMatchObject({
        status: 'arrived',
      });
    });
  });

  describe('missing or replaced seed', () => {
    it('never regenerates a lost seed; a backed-up seed restores identities and tokens', async () => {
      const { at, root } = await machine('missing-seed');
      const options = await at('data');
      const { token } = await ownedInstallation(options);
      const identity = await identityOf(options);
      const backupSeed = join(root, 'seed-backup');
      await writeFile(backupSeed, await readFile(seedOf(options), 'utf8'), {
        mode: 0o600,
      });
      await rm(seedOf(options));

      await expect(boot(options)).rejects.toMatchObject({
        code: 'installation_seed_missing',
      });
      // Not silently recreated, and the refusal did not touch the database.
      await expect(stat(seedOf(options))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'seed-missing',
        installationId: null,
        recordedInstallationId: identity.deviceId,
        resolutions: ['recover-seed', 'reseed'],
      });

      const outcome = await recoverInstallationSeed({
        ...options,
        seedFile: backupSeed,
      });
      expect(outcome).toMatchObject({
        declaration: 'recover-seed',
        status: 'in-custody',
        installationId: identity.deviceId,
        effects: { identityChanged: false, seedKeyedTokensInvalidated: false },
      });
      expect((await stat(seedOf(options))).mode & 0o777).toBe(0o600);
      await stop(await boot(options));
      expect(await identityOf(options)).toEqual(identity);
      expect(await verifyToken(options, token)).not.toBeNull();
    });

    it('rejects a backup seed that belongs to another installation', async () => {
      const { at, root } = await machine('wrong-seed');
      const options = await at('data');
      const unrelated = await at('unrelated');
      await stop(await boot(options));
      await stop(await boot(unrelated));
      const wrong = join(root, 'wrong-seed');
      await writeFile(wrong, await readFile(seedOf(unrelated), 'utf8'), {
        mode: 0o600,
      });
      await rm(seedOf(options));

      await expect(
        recoverInstallationSeed({ ...options, seedFile: wrong }),
      ).rejects.toThrow(/does not belong to this installation/);
      await expect(stat(seedOf(options))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // A malformed or world-readable backup is refused before any change.
      const lax = join(root, 'lax-seed');
      await writeFile(lax, await readFile(seedOf(unrelated), 'utf8'), {
        mode: 0o644,
      });
      await chmod(lax, 0o644);
      await expect(
        recoverInstallationSeed({ ...options, seedFile: lax }),
      ).rejects.toThrow(/private file/);
      await writeFile(wrong, 'not a seed\n', { mode: 0o600 });
      await expect(
        recoverInstallationSeed({ ...options, seedFile: wrong }),
      ).rejects.toThrow();
    });

    it('needs explicit consent to accept a seed no record can verify', async () => {
      const { at, root } = await machine('unverified-seed');
      const options = await at('data');
      await stop(await boot(options));
      const backup = join(root, 'seed-backup');
      await writeFile(backup, await readFile(seedOf(options), 'utf8'), {
        mode: 0o600,
      });
      await rm(seedOf(options));
      await rm(dataRecordOf(options));
      await rm(stateRecordOf(options));

      await expect(
        recoverInstallationSeed({ ...options, seedFile: backup }),
      ).rejects.toThrow(/cannot be verified/);
      await expect(stat(seedOf(options))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await recoverInstallationSeed({
        ...options,
        seedFile: backup,
        allowUnverified: true,
      });
      await stop(await boot(options));
    });

    it('re-seeds a lost seed with no backup: new identities, tokens invalidated, data kept', async () => {
      const { at } = await machine('lost-seed');
      const options = await at('data');
      const { token } = await ownedInstallation(options);
      const identity = await identityOf(options);
      await rm(seedOf(options));

      const outcome = await reseedInstallation(options);
      expect(outcome).toMatchObject({
        previousInstallationId: identity.deviceId,
        effects: {
          identityChanged: true,
          seedKeyedTokensInvalidated: true,
          mcpTokensRevoked: 1,
        },
      });
      const initialized = await boot(options);
      expect((await identityOf(options)).deviceId).not.toBe(identity.deviceId);
      expect(await verifyToken(options, token)).toBeNull();
      // Existing rows keep the identifiers they were created with.
      const owner = await initialized.runtime.db.query(
        'SELECT id FROM users LIMIT 1',
      );
      expect(owner.rows).toHaveLength(1);
      await stop(initialized);
    });

    it('refuses a replaced seed instead of silently changing identities', async () => {
      const { at } = await machine('replaced-seed');
      const options = await at('data');
      await stop(await boot(options));
      const other = await at('other');
      await stop(await boot(other));
      await writeFile(seedOf(options), await readFile(seedOf(other), 'utf8'), {
        mode: 0o600,
      });

      await expect(boot(options)).rejects.toMatchObject({
        code: 'installation_unverified',
        message: expect.stringContaining('(seed-mismatch)'),
      });
      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'seed-mismatch',
        resolutions: ['recover-seed', 'reseed'],
      });
      // `restore` cannot launder a different seed into the installation.
      await expect(
        restoreInstallation({ ...options, originRetired: true }),
      ).rejects.toThrow(/cannot be resolved by restore/);
    });

    it('re-seeds over a seed that cannot be read safely', async () => {
      const { at } = await machine('unreadable-seed');
      const options = await at('data');
      await stop(await boot(options));
      const identity = await identityOf(options);
      await chmod(seedOf(options), 0o644);
      await expect(inspectInstallationCustody(options)).rejects.toThrow(
        /private file/,
      );

      const outcome = await reseedInstallation(options);
      expect(outcome).toMatchObject({
        previousInstallationId: identity.deviceId,
        effects: { identityChanged: true },
      });
      expect((await stat(seedOf(options))).mode & 0o777).toBe(0o600);
      await stop(await boot(options));
    });

    it('rotates a healthy installation explicitly', async () => {
      const { at } = await machine('rotation');
      const options = await at('data');
      const { token } = await ownedInstallation(options);
      const identity = await identityOf(options);

      const outcome = await reseedInstallation(options);
      expect(outcome.effects).toEqual({
        identityChanged: true,
        seedKeyedTokensInvalidated: true,
        mcpTokensRevoked: 1,
      });
      await stop(await boot(options));
      expect(await verifyToken(options, token)).toBeNull();
      expect((await identityOf(options)).tenantId).not.toBe(identity.tenantId);
    });
  });

  describe('tampered records fail closed', () => {
    it('refuses malformed, extended, lax-mode and linked records', async () => {
      const { at, root } = await machine('tamper');
      const options = await at('data');
      await stop(await boot(options));
      const good = await readFile(dataRecordOf(options), 'utf8');

      const attempts: Array<[string, () => Promise<void>]> = [
        ['malformed', () => writeFile(dataRecordOf(options), '{not json')],
        [
          'extra key',
          () =>
            writeFile(
              dataRecordOf(options),
              JSON.stringify({ ...JSON.parse(good), extra: true }),
            ),
        ],
        [
          'epoch zero',
          () =>
            writeFile(
              dataRecordOf(options),
              JSON.stringify({ ...JSON.parse(good), epoch: 0 }),
            ),
        ],
        [
          'oversized',
          () => writeFile(dataRecordOf(options), ' '.repeat(4096) + good),
        ],
        ['lax mode', () => chmod(dataRecordOf(options), 0o644)],
        [
          'symlink',
          async () => {
            const target = join(root, 'elsewhere.json');
            await writeFile(target, good, { mode: 0o600 });
            await rm(dataRecordOf(options));
            await symlink(target, dataRecordOf(options));
          },
        ],
      ];
      for (const [label, tamper] of attempts) {
        await rm(dataRecordOf(options), { force: true });
        await writeFile(dataRecordOf(options), good, { mode: 0o600 });
        await tamper();
        await expect(boot(options), label).rejects.toMatchObject({
          code: 'installation_unverified',
          message: expect.stringContaining('(record-invalid)'),
        });
      }
      // A tampered record is still resolved only by an explicit declaration.
      await rm(dataRecordOf(options), { force: true });
      await writeFile(dataRecordOf(options), '{not json', { mode: 0o600 });
      await restoreInstallation({ ...options, originRetired: true });
      await stop(await boot(options));
    });
  });

  describe('review hardening', () => {
    it('refuses restore for a substituted seed even when the data record is corrupted', async () => {
      const { at } = await machine('substituted');
      const options = await at('data');
      const other = await at('other');
      await stop(await boot(options));
      await stop(await boot(other));
      const original = (await identityOf(options)).deviceId;
      await writeFile(seedOf(options), await readFile(seedOf(other), 'utf8'), {
        mode: 0o600,
      });
      await writeFile(dataRecordOf(options), '{corrupt', { mode: 0o600 });

      // The location still remembers the original installation.
      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'seed-mismatch',
        resolutions: ['recover-seed', 'reseed'],
      });
      await expect(
        restoreInstallation({ ...options, originRetired: true }),
      ).rejects.toThrow(/cannot be resolved by restore/);
      expect((await readJson(stateRecordOf(options))).installationId).toBe(
        original,
      );
    });

    it('lets a different installation be restored over a location that hosted another', async () => {
      const { at } = await machine('reused-path');
      const options = await at('data');
      await stop(await boot(options));
      const other = await at('other');
      await stop(await boot(other));
      const otherIdentity = await identityOf(other);
      // Installation `other` is restored over this location's data root.
      await rm(options.dataDirectory, { recursive: true, force: true });
      await copyDataRoot(other, options);

      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'diverged',
        installationId: otherIdentity.deviceId,
        resolutions: ['restore', 'reseed'],
      });
      await expect(boot(options)).rejects.toMatchObject({
        code: 'installation_unverified',
      });
      const outcome = await restoreInstallation({
        ...options,
        originRetired: true,
      });
      // The stale record of the other installation never inflates the epoch.
      expect(outcome).toMatchObject({ epoch: 2, status: 'in-custody' });
      expect(await identityOf(options)).toEqual(otherIdentity);
      await stop(await boot(options));
    });

    it('does not regenerate a lost seed when first-run setup never finished', async () => {
      const { at } = await machine('lost-before-init');
      const options = await at('data');
      const initialized = await boot(options);
      // First run that died before the bootstrap table existed.
      await initialized.runtime.db.query(
        'DROP TABLE _smrt_local_owner_bootstrap',
      );
      await stop(initialized);
      await rm(seedOf(options));

      await expect(boot(options)).rejects.toMatchObject({
        code: 'installation_seed_missing',
      });
      await expect(stat(seedOf(options))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('finishes an interrupted first-run activation but refuses the same state once initialized', async () => {
      const { at } = await machine('crash-window');
      const options = await at('data');
      const initialized = await boot(options);
      await initialized.runtime.db.query(
        'DROP TABLE _smrt_local_owner_bootstrap',
      );
      await stop(initialized);
      // Crash after the location record was written, before the data record.
      await rm(dataRecordOf(options));
      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'data-record-missing',
      });
      await stop(await boot(options));
      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'in-custody',
        epoch: 1,
      });

      // Once initialized, a missing data record is no longer a crash window.
      await rm(dataRecordOf(options));
      await expect(boot(options)).rejects.toMatchObject({
        code: 'installation_unverified',
        message: expect.stringContaining('(data-record-missing)'),
      });
      await restoreInstallation({ ...options, originRetired: true });
      await stop(await boot(options));
    });

    it('serializes a declaration behind a runtime that is initializing', async () => {
      const { at } = await machine('init-lock');
      const options = await at('data');
      await stop(await boot(options));
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: (() => void) | undefined;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const starting = initializeLocalApplicationRuntime({
        ...options,
        prepareDatabase: async () => {
          entered?.();
          await gate;
        },
      });
      await inside;
      let settled = false;
      const reseeding = reseedInstallation(options).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      release?.();
      const initialized = await starting;
      openDatabases.push(initialized.runtime.db);
      await stop(initialized);
      await reseeding;
      expect(await inspectInstallationCustody(options)).toMatchObject({
        status: 'in-custody',
      });
    });

    it('never puts the seed in refusals, status or outcomes', async () => {
      const { at } = await machine('no-seed-leak');
      const origin = await at('origin');
      await stop(await boot(origin));
      const seed = (await readFile(seedOf(origin), 'utf8')).trim();
      const copy = await at('copy');
      await copyDataRoot(origin, copy);

      const seen: string[] = [];
      const refusal = await boot(copy).catch((error: Error) => error);
      seen.push(String((refusal as Error).message));
      seen.push(JSON.stringify(await inspectInstallationCustody(copy)));
      seen.push(JSON.stringify(await reseedInstallation(copy)));
      await rm(seedOf(copy));
      const missing = await boot(copy).catch((error: Error) => error);
      seen.push(String((missing as Error).message));
      seen.push(JSON.stringify(await inspectInstallationCustody(copy)));
      for (const text of seen) expect(text).not.toContain(seed);
      for (const path of [
        dataRecordOf(copy),
        stateRecordOf(copy),
        dataRecordOf(origin),
        stateRecordOf(origin),
      ]) {
        expect(await readFile(path, 'utf8')).not.toContain(seed);
      }
    });
  });

  it('does not let a failed custody check create application schema or tokens', async () => {
    const { at } = await machine('no-side-effects');
    const origin = await at('origin');
    await stop(await boot(origin));
    const copy = await at('copy');
    await copyDataRoot(origin, copy);
    let migrations = 0;

    await expect(
      initializeLocalApplicationRuntime({
        ...copy,
        prepareDatabase: async () => {
          migrations += 1;
        },
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeError);
    expect(migrations).toBe(0);
  });
});

/**
 * A container that persists the data volume but recreates HOME hits `arrived`
 * on the second start (the location's record died with the old home). The fix
 * is operational: put the state root on a persistent path (XDG_STATE_HOME on
 * Linux). The refusal names the state root so the operator can see why.
 */
describe('state root persistence', () => {
  const linux = { platformName: 'linux', homeDirectory: '/home/run' };

  it('derives the state root from XDG_STATE_HOME when set, else from HOME', async () => {
    const { at } = await machine('state-root-source');
    const options = await at('data');
    const persistent = { XDG_STATE_HOME: '/data/state' };
    expect(
      applicationStateRootSource({ ...options, ...linux, environment: {} }),
    ).toBe('home-directory');
    expect(
      applicationStateRootSource({
        ...options,
        ...linux,
        environment: persistent,
      }),
    ).toBe('xdg-state-home');
    // XDG_STATE_HOME is ignored off Linux, so the docs say so.
    expect(
      applicationStateRootSource({
        ...options,
        platformName: 'darwin',
        environment: persistent,
      }),
    ).toBe('home-directory');
    expect(
      applicationStateRootSource({
        ...options,
        platformName: 'win32',
        environment: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      }),
    ).toBe('local-app-data');

    // The lockout mechanism: a recreated home moves the state root, while a
    // persistent XDG_STATE_HOME keeps it where it was.
    const at1 = resolveApplicationStateRoot({
      ...options,
      ...linux,
      environment: {},
    });
    const at2 = resolveApplicationStateRoot({
      ...options,
      platformName: 'linux',
      homeDirectory: '/home/run-2',
      environment: {},
    });
    expect(at1).not.toBe(at2);
    const persisted = (home: string) =>
      resolveApplicationStateRoot({
        ...options,
        platformName: 'linux',
        homeDirectory: home,
        environment: persistent,
      });
    expect(persisted('/home/run')).toBe(persisted('/home/run-2'));
    expect(persisted('/home/run').startsWith('/data/state/')).toBe(true);
  });

  it('names the state root and what to persist in the refusal text', () => {
    const fromHome = describeInstallationStateRoot({
      stateRoot: '/home/run/.local/state/.app-abc-state',
      source: 'home-directory',
      platformName: 'linux',
    });
    expect(fromHome).toContain('/home/run/.local/state/.app-abc-state');
    expect(fromHome).toContain('derived from the home directory');
    expect(fromHome).toContain('XDG_STATE_HOME');
    expect(fromHome).toContain('persistent data volume');
    const fromXdg = describeInstallationStateRoot({
      stateRoot: '/data/state/.app-abc-state',
      source: 'xdg-state-home',
      platformName: 'linux',
    });
    expect(fromXdg).toContain('from XDG_STATE_HOME');
    expect(fromXdg).toContain('must persist');
    // Off Linux there is no XDG_STATE_HOME to recommend.
    const mac = describeInstallationStateRoot({
      stateRoot: '/Users/x/Library/Application Support/.app-abc-state',
      source: 'home-directory',
      platformName: 'darwin',
    });
    expect(mac).not.toContain('XDG_STATE_HOME');
    expect(mac).toContain('persistent user profile');
  });

  it('refuses a recreated home with the state root in the message, and keeps custody when it persists', async () => {
    const { at, root } = await machine('recreated-home');
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_STATE_HOME;
    const homes = ['home-1', 'home-2', 'home-3'].map((name) =>
      join(root, name),
    );
    try {
      // Without a persistent state root: the second start is refused.
      const lost = await at('lost');
      process.env.HOME = homes[0];
      delete process.env.XDG_STATE_HOME;
      await mkdir(homes[0], { recursive: true });
      await stop(await boot(lost));
      process.env.HOME = homes[1];
      await mkdir(homes[1], { recursive: true });
      const refusal = await boot(lost).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(LocalRuntimeError);
      expect((refusal as LocalRuntimeError).code).toBe(
        'installation_unverified',
      );
      expect((refusal as LocalRuntimeError).message).toContain('(arrived)');
      expect((refusal as LocalRuntimeError).message).toContain(
        resolveApplicationStateRoot(stateRootOptions(lost)),
      );
      expect((refusal as LocalRuntimeError).message).toContain(
        'derived from the home directory',
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'survives a recreated home when XDG_STATE_HOME is a persistent path',
    async () => {
      const { at, root } = await machine('persistent-xdg');
      const savedHome = process.env.HOME;
      const savedXdg = process.env.XDG_STATE_HOME;
      try {
        const persistent = join(root, 'volume-state');
        await mkdir(persistent, { recursive: true });
        process.env.XDG_STATE_HOME = persistent;
        const options = await at('kept');
        for (const name of ['home-1', 'home-2', 'home-3']) {
          const home = join(root, name);
          await mkdir(home, { recursive: true });
          process.env.HOME = home;
          await stop(await boot(options));
        }
        expect(await inspectInstallationCustody(options)).toMatchObject({
          status: 'in-custody',
        });
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = savedXdg;
      }
    },
  );
});
