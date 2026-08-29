import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobHandle, SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeLocalApplicationRuntime,
  LocalRuntimeError,
  resolveLocalRuntimePaths,
} from './index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function localDirectories(label: string) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `smrt-local-${label}-`));
  const root = await realpath(temporaryRoot);
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const dataDirectory = join(root, 'data');
  await mkdir(sourceRoot);
  return { root, sourceRoot, dataDirectory };
}

async function countRows(
  db: {
    query: (sql: string, ...params: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  table: string,
): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS count FROM ${table}`);
  const value = (result.rows[0] as { count?: unknown } | undefined)?.count;
  return Number(value ?? 0);
}

function expectRuntimeError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LocalRuntimeError);
  expect((error as LocalRuntimeError).code).toBe(code);
}

describe('local application runtime', () => {
  it('initializes user-owned storage with restrictive permissions and safe SQLite settings', async () => {
    const directories = await localDirectories('storage');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });

    expect(initialized.bootstrap?.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(initialized.diagnostics.runtime.profile).toBe('local');
    expect(initialized.diagnostics.bind).toEqual({
      host: '127.0.0.1',
      loopback: true,
    });
    expect(initialized.diagnostics.jobs).toEqual({
      topology: 'embedded',
      backgroundEnabled: false,
    });
    expect(initialized.diagnostics.paidCapabilitiesEnabled).toBe(false);
    expect(initialized.runtime.paths.root).toBe(directories.dataDirectory);

    expect((await stat(initialized.runtime.paths.root)).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(initialized.runtime.paths.assets)).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await stat(initialized.runtime.paths.applicationSecret)).mode & 0o777,
    ).toBe(0o600);
    expect((await stat(initialized.runtime.paths.database)).mode & 0o777).toBe(
      0o600,
    );

    const journal = await initialized.runtime.db.query('PRAGMA journal_mode');
    const synchronous =
      await initialized.runtime.db.query('PRAGMA synchronous');
    const foreignKeys = await initialized.runtime.db.query(
      'PRAGMA foreign_keys',
    );
    const busyTimeout = await initialized.runtime.db.query(
      'PRAGMA busy_timeout',
    );
    expect(
      String(Object.values(journal.rows[0] as object)[0]).toLowerCase(),
    ).toBe('wal');
    expect(Number(Object.values(synchronous.rows[0] as object)[0])).toBe(2);
    expect(Number(Object.values(foreignKeys.rows[0] as object)[0])).toBe(1);
    expect(Number(Object.values(busyTimeout.rows[0] as object)[0])).toBe(5000);
  });

  it('claims one owner and creates normal identity, tenancy, membership, and session records', async () => {
    const directories = await localDirectories('claim');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const token = initialized.bootstrap?.token;
    expect(token).toBeTruthy();

    const claim = await initialized.runtime.claimOwner({
      token: token as string,
      name: 'Will Griffin',
      email: 'will@example.com',
      tenantName: 'Will Workspace',
      userAgent: 'test-browser',
      ipAddress: '127.0.0.1',
    });

    expect(claim.profileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim.membershipId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const profile = await initialized.runtime.db.query(
      'SELECT _meta_type, tenant_id, name, email FROM profiles WHERE id = ?',
      claim.profileId,
    );
    expect(profile.rows[0]).toMatchObject({
      _meta_type: '@happyvertical/smrt-profiles:Person',
      tenant_id: null,
      name: 'Will Griffin',
      email: 'will@example.com',
    });
    const membership = await initialized.runtime.db.query(
      `SELECT memberships.user_id, memberships.tenant_id, roles.slug
       FROM memberships
       JOIN roles ON roles.id = memberships.role_id
       WHERE memberships.id = ?`,
      claim.membershipId,
    );
    expect(membership.rows[0]).toMatchObject({
      user_id: claim.userId,
      tenant_id: claim.tenantId,
      slug: 'owner',
    });

    const restored = await initialized.runtime.restoreSession(claim.sessionId);
    expect(restored?.user.id).toBe(claim.userId);
    expect(restored?.tenantId).toBe(claim.tenantId);
    expect(restored?.membership?.id).toBe(claim.membershipId);
    expect((await initialized.runtime.diagnostics()).bootstrap.status).toBe(
      'claimed',
    );
  });

  it('is restart-idempotent and never duplicates an active invitation or owner records', async () => {
    const directories = await localDirectories('restart');
    const first = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const secondBeforeClaim = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
      db: first.runtime.db,
    });
    expect(first.bootstrap?.token).toBeTruthy();
    expect(secondBeforeClaim.bootstrap).toBeNull();

    const claim = await secondBeforeClaim.runtime.claimOwner({
      token: first.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
    });
    const roleCount = await countRows(secondBeforeClaim.runtime.db, 'roles');
    const reopenedDb = await getDatabase({
      type: 'sqlite',
      url: first.runtime.paths.database,
      clearCache: true,
    });
    const restarted = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
      db: reopenedDb,
    });
    expect(restarted.bootstrap).toBeNull();
    expect(await countRows(restarted.runtime.db, 'profiles')).toBe(1);
    expect(await countRows(restarted.runtime.db, 'users')).toBe(1);
    expect(await countRows(restarted.runtime.db, 'tenants')).toBe(1);
    expect(await countRows(restarted.runtime.db, 'memberships')).toBe(1);
    expect(await countRows(restarted.runtime.db, 'roles')).toBe(roleCount);
    expect(await countRows(restarted.runtime.db, 'sessions')).toBe(1);
    expect(
      (await restarted.runtime.restoreSession(claim.sessionId))?.user.id,
    ).toBe(claim.userId);
  });

  it('serializes concurrent startup so at most one returned invitation is usable', async () => {
    const directories = await localDirectories('startup-race');
    const startups = await Promise.all([
      initializeLocalApplicationRuntime({
        appId: 'startup-race',
        ...directories,
      }),
      initializeLocalApplicationRuntime({
        appId: 'startup-race',
        ...directories,
      }),
    ]);
    const invitations = startups.flatMap((startup) =>
      startup.bootstrap ? [startup.bootstrap] : [],
    );
    expect(invitations).toHaveLength(1);
    await startups[0].runtime.claimOwner({
      token: invitations[0].token,
      name: 'Owner',
      email: 'owner@example.com',
    });
    expect(await countRows(startups[0].runtime.db, 'users')).toBe(1);
  });

  it('serializes concurrent owner claims so exactly one creates records', async () => {
    const directories = await localDirectories('concurrent');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const input = {
      token: initialized.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
    };

    const claims = await Promise.allSettled([
      initialized.runtime.claimOwner(input),
      initialized.runtime.claimOwner(input),
    ]);
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = claims.find(
      (claim): claim is PromiseRejectedResult => claim.status === 'rejected',
    );
    expectRuntimeError(rejected?.reason, 'bootstrap_claimed');
    expect(await countRows(initialized.runtime.db, 'profiles')).toBe(1);
    expect(await countRows(initialized.runtime.db, 'users')).toBe(1);
    expect(await countRows(initialized.runtime.db, 'tenants')).toBe(1);
    expect(await countRows(initialized.runtime.db, 'memberships')).toBe(1);
    expect(await countRows(initialized.runtime.db, 'sessions')).toBe(1);
  });

  it('rejects replayed, wrong, and expired tokens without consuming a valid claim early', async () => {
    const wrongDirectories = await localDirectories('wrong');
    const wrong = await initializeLocalApplicationRuntime({
      appId: 'wrong-token',
      ...wrongDirectories,
    });
    await expect(
      wrong.runtime.claimOwner({
        token: 'not-the-token',
        name: 'Owner',
        email: 'owner@example.com',
      }),
    ).rejects.toMatchObject({ code: 'bootstrap_invalid' });
    await wrong.runtime.claimOwner({
      token: wrong.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
    });
    await expect(
      wrong.runtime.claimOwner({
        token: wrong.bootstrap?.token as string,
        name: 'Owner',
        email: 'owner@example.com',
      }),
    ).rejects.toMatchObject({ code: 'bootstrap_claimed' });

    const expiredDirectories = await localDirectories('expired');
    let current = new Date('2026-08-29T20:00:00.000Z');
    const expired = await initializeLocalApplicationRuntime({
      appId: 'expired-token',
      ...expiredDirectories,
      bootstrapTtlSeconds: 1,
      now: () => current,
    });
    current = new Date('2026-08-29T20:00:02.000Z');
    await expect(
      expired.runtime.claimOwner({
        token: expired.bootstrap?.token as string,
        name: 'Owner',
        email: 'owner@example.com',
      }),
    ).rejects.toMatchObject({ code: 'bootstrap_expired' });
    expect(await countRows(expired.runtime.db, 'users')).toBe(0);
  });

  it('refuses public exposure before touching the filesystem', async () => {
    const directories = await localDirectories('public');
    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
        bindHost: '0.0.0.0',
      }),
    ).rejects.toMatchObject({ code: 'unsafe_public_exposure' });
    await expect(stat(directories.dataDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses symlinked secret material instead of following it', async () => {
    const directories = await localDirectories('secret-symlink');
    const target = join(directories.root, 'outside-secret');
    const secrets = join(directories.dataDirectory, 'secrets');
    await mkdir(secrets, { recursive: true });
    await writeFile(target, 'must-not-be-used\n');
    await symlink(target, join(secrets, 'application.secret'));

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(await readFile(target, 'utf8')).toBe('must-not-be-used\n');
  });

  it('refuses a symlinked ancestor that redirects storage into the source tree', async () => {
    const directories = await localDirectories('ancestor-source');
    const redirect = join(directories.root, 'source-link');
    const redirectedData = join(redirect, 'local-data');
    await symlink(directories.sourceRoot, redirect);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        sourceRoot: directories.sourceRoot,
        dataDirectory: redirectedData,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(
      stat(join(directories.sourceRoot, 'local-data')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked data root that redirects storage elsewhere', async () => {
    const directories = await localDirectories('root-redirect');
    const external = join(directories.root, 'external');
    const redirectedData = join(directories.root, 'data-link');
    await mkdir(external);
    const externalMode = (await stat(external)).mode & 0o777;
    await symlink(external, redirectedData);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        sourceRoot: directories.sourceRoot,
        dataDirectory: redirectedData,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect((await stat(external)).mode & 0o777).toBe(externalMode);
    await expect(
      stat(join(external, 'application.sqlite')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses nested symlink ancestors before creating redirected descendants', async () => {
    const directories = await localDirectories('nested-redirect');
    const nested = join(directories.root, 'nested');
    const external = join(directories.root, 'external');
    const redirect = join(nested, 'redirect');
    await mkdir(nested);
    await mkdir(external);
    await symlink(external, redirect);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        sourceRoot: directories.sourceRoot,
        dataDirectory: join(redirect, 'deep', 'local-data'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(stat(join(external, 'deep'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('opens an existing database with no-follow semantics', async () => {
    const directories = await localDirectories('database-symlink');
    const target = join(directories.root, 'outside-database');
    await mkdir(directories.dataDirectory);
    await writeFile(target, 'must-not-be-opened\n');
    await symlink(
      target,
      join(directories.dataDirectory, 'application.sqlite'),
    );

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(await readFile(target, 'utf8')).toBe('must-not-be-opened\n');
  });

  it('keeps diagnostics deterministic and free of secret values and token hashes', async () => {
    const directories = await localDirectories('redaction');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const secret = (
      await readFile(initialized.runtime.paths.applicationSecret, 'utf8')
    ).trim();
    const stored = await initialized.runtime.db.query(
      'SELECT token_hash FROM _smrt_local_owner_bootstrap WHERE slot = 1',
    );
    const bootstrapColumns = await initialized.runtime.db.query(
      'PRAGMA table_info(_smrt_local_owner_bootstrap)',
    );
    expect(
      bootstrapColumns.rows.map((row) => (row as { name?: unknown }).name),
    ).not.toContain('token');
    const tokenHash = (stored.rows[0] as { token_hash: string }).token_hash;
    const first = JSON.stringify(await initialized.runtime.diagnostics());
    const second = JSON.stringify(await initialized.runtime.diagnostics());

    expect(first).toBe(second);
    expect(first).not.toContain(secret);
    expect(first).not.toContain(initialized.bootstrap?.token as string);
    expect(first).not.toContain(tokenHash);
    expect(first).toContain('"secretValuesIncluded":false');
    expect(first).toContain('"tokenHashesIncluded":false');
  });

  it('defaults paid/background capabilities off and enables only the embedded runner explicitly', async () => {
    const directories = await localDirectories('jobs-off');
    const disabled = await initializeLocalApplicationRuntime({
      appId: 'jobs-off',
      ...directories,
    });
    await expect(
      disabled.runtime.createEmbeddedJobRunner(),
    ).rejects.toMatchObject({ code: 'capability_disabled' });

    const enabledDirectories = await localDirectories('jobs-on');
    const enabled = await initializeLocalApplicationRuntime({
      appId: 'jobs-on',
      ...enabledDirectories,
      backgroundJobs: true,
      paidCapabilities: true,
    });
    await enabled.runtime.claimOwner({
      token: enabled.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
    });
    const roles = await enabled.runtime.db.query(
      "SELECT id FROM roles WHERE slug = 'owner' AND tenant_id IS NULL LIMIT 1",
    );
    const roleId = (roles.rows[0] as { id: string }).id;
    const jobs = await SmrtJobCollection.create({ db: enabled.runtime.db });
    const job = await jobs.enqueueJob({
      objectType: 'Role',
      objectId: roleId,
      method: 'isSystemRole',
      args: {},
      maxAttempts: 1,
    });
    const runner = await enabled.runtime.createEmbeddedJobRunner({
      pollInterval: 25,
    });
    await runner.start();
    expect(runner.isRunning()).toBe(true);
    const completed = await new JobHandle(job.id as string, jobs).wait({
      timeout: 5000,
      pollInterval: 20,
    });
    expect(completed.success).toBe(true);
    await runner.stop();
    expect(runner.isRunning()).toBe(false);
    expect((await enabled.runtime.diagnostics()).jobs.backgroundEnabled).toBe(
      true,
    );
    expect((await enabled.runtime.diagnostics()).paidCapabilitiesEnabled).toBe(
      true,
    );
  });
});

describe('local runtime paths', () => {
  it('uses native user application-data roots', () => {
    expect(
      resolveLocalRuntimePaths({
        appId: 'lolaus',
        sourceRoot: '/workspace/lolaus',
        platform: 'darwin',
        homeDirectory: '/Users/test',
      }).root,
    ).toBe('/Users/test/Library/Application Support/lolaus');
    expect(
      resolveLocalRuntimePaths({
        appId: 'lolaus',
        sourceRoot: '/workspace/lolaus',
        platform: 'linux',
        homeDirectory: '/home/test',
        env: { XDG_DATA_HOME: '/data/test' },
      }).root,
    ).toBe('/data/test/lolaus');
  });

  it('rejects local state inside the source tree', () => {
    expect(() =>
      resolveLocalRuntimePaths({
        appId: 'lolaus',
        sourceRoot: '/workspace/lolaus',
        dataDirectory: '/workspace/lolaus/.local-data',
      }),
    ).toThrow('outside the source tree');
  });
});
