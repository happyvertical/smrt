import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
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
import { promisify } from 'node:util';
import { JobHandle, SmrtJobCollection } from '@happyvertical/smrt-jobs';
import * as sql from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as localRuntimeApi from './index.js';
import {
  initializeLocalApplicationRuntime,
  LocalRuntimeError,
  resolveLocalRuntimePaths,
} from './index.js';

const temporaryRoots: string[] = [];
const initializationLockPaths = new Set<string>();
const execFileAsync = promisify(execFile);

const filesystemInterleave = vi.hoisted(() => ({
  beforeLink: undefined as undefined | (() => Promise<void>),
  afterReaddir: undefined as
    | undefined
    | ((
        path: Parameters<typeof import('node:fs/promises').readdir>[0],
      ) => Promise<void>),
  beforeUnlink: undefined as
    | undefined
    | ((
        path: Parameters<typeof import('node:fs/promises').unlink>[0],
      ) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (existingPath: string, newPath: string) => {
      if (newPath.endsWith('/application.secret')) {
        await filesystemInterleave.beforeLink?.();
      }
      return actual.link(existingPath, newPath);
    },
    readdir: async (...args: unknown[]) => {
      const entries = await Reflect.apply(actual.readdir, actual, args);
      await filesystemInterleave.afterReaddir?.(
        args[0] as Parameters<typeof actual.readdir>[0],
      );
      return entries;
    },
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      await filesystemInterleave.beforeUnlink?.(path);
      return actual.unlink(path);
    },
  };
});

afterEach(async () => {
  filesystemInterleave.beforeLink = undefined;
  filesystemInterleave.afterReaddir = undefined;
  filesystemInterleave.beforeUnlink = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  for (const lockPath of initializationLockPaths) {
    await rm(lockPath, { force: true });
    await rm(`${lockPath}-journal`, { force: true });
    await rm(`${lockPath}-shm`, { force: true });
    await rm(`${lockPath}-wal`, { force: true });
    try {
      await rmdir(dirname(lockPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  initializationLockPaths.clear();
});

async function localDirectories(label: string) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `smrt-local-${label}-`));
  const root = await realpath(temporaryRoot);
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const dataDirectory = join(root, 'data');
  await mkdir(sourceRoot);
  await initializationLockPath(dataDirectory);
  return { root, sourceRoot, dataDirectory };
}

async function initializationLockPath(dataDirectory: string): Promise<string> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw new Error('Tests require a numeric uid.');
  const lockRoot = join(await realpath('/tmp'), `.smrt-${currentUid}`);
  const lockIdentity =
    platform() === 'darwin' || platform() === 'win32'
      ? dataDirectory.toLowerCase()
      : dataDirectory;
  const lockKey = createHash('sha256')
    .update(lockIdentity)
    .digest('hex')
    .slice(0, 32);
  const lockPath = join(lockRoot, lockKey, 'initialization.sqlite');
  initializationLockPaths.add(lockPath);
  return lockPath;
}

async function holdInitializationDatabaseUntilKilled(
  lockPath: string,
): Promise<void> {
  await mkdir(join(lockPath, '..'), { recursive: true, mode: 0o700 });
  await rm(lockPath, { force: true });
  await writeFile(lockPath, '', { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.stdout.write('ready\\n');setInterval(()=>{},1000);",
      lockPath,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await once(child.stdout as NodeJS.ReadableStream, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
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
    const exactInteger = await initialized.runtime.db.query(
      "SELECT CAST('9007199254740993' AS INTEGER) AS value",
    );
    expect((exactInteger.rows[0] as { value: unknown }).value).toBe(
      9007199254740993n,
    );
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
    });
    expect(first.bootstrap?.token).toBeTruthy();
    expect(secondBeforeClaim.bootstrap).toBeNull();

    const claim = await secondBeforeClaim.runtime.claimOwner({
      token: first.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
    });
    const roleCount = await countRows(secondBeforeClaim.runtime.db, 'roles');
    const reopenedDb = await sql.getDatabase({
      type: 'sqlite',
      url: first.runtime.paths.database,
      secureFile: {
        driver: 'node:sqlite',
        custody: 'trusted-parent',
        root: first.runtime.paths.root,
      },
      clearCache: true,
    });
    expect(reopenedDb.url).toBe(first.runtime.paths.database);
    const restarted = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
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

  it('never reissues a consumed bootstrap slot when the owner membership becomes inactive', async () => {
    const directories = await localDirectories('consumed-bootstrap');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const claim = await initialized.runtime.claimOwner({
      token: initialized.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
    });
    await initialized.runtime.db.query(
      'UPDATE memberships SET status = ? WHERE id = ?',
      'inactive',
      claim.membershipId,
    );

    const restarted = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    expect(restarted.bootstrap).toBeNull();
    await expect(
      restarted.runtime.rotateBootstrapInvitation(),
    ).rejects.toMatchObject({ code: 'bootstrap_claimed' });
    expect(await countRows(restarted.runtime.db, 'users')).toBe(1);
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

  it('atomically publishes one complete secret under a forced concurrent first-start interleaving', async () => {
    const directories = await localDirectories('secret-race');
    let arrivals = 0;
    let releaseFirst: (() => void) | undefined;
    let enterFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    filesystemInterleave.beforeLink = async () => {
      arrivals += 1;
      if (arrivals === 1) {
        enterFirst?.();
        await firstPaused;
      }
    };

    const first = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await firstEntered;
    const second = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(arrivals).toBe(1);
    releaseFirst?.();
    const startups = await Promise.all([first, second]);
    expect(arrivals).toBe(2);
    const invitations = startups.flatMap((startup) =>
      startup.bootstrap ? [startup.bootstrap] : [],
    );
    expect(invitations).toHaveLength(1);

    const secret = await readFile(
      startups[0].runtime.paths.applicationSecret,
      'utf8',
    );
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    const stored = await startups[0].runtime.db.query(
      'SELECT token_hash FROM _smrt_local_owner_bootstrap WHERE slot = 1',
    );
    expect((stored.rows[0] as { token_hash: string }).token_hash).toBe(
      createHmac('sha256', secret.trim())
        .update(invitations[0].token)
        .digest('hex'),
    );
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

  it.each([
    '0.0.0.0',
    'localhost',
  ])('refuses ambiguous or public bind host %s before touching the filesystem', async (bindHost) => {
    const directories = await localDirectories('public');
    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
        bindHost,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_public_exposure' });
    await expect(stat(directories.dataDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MIN_VALUE,
    0.0001,
    0.0009,
    1.5,
  ])('refuses invalid session TTL %s before filesystem mutation', async (sessionTtlSeconds) => {
    const directories = await localDirectories('session-ttl');
    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
        sessionTtlSeconds,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(stat(directories.dataDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('accepts the one-second session TTL boundary without early expiry', async () => {
    const directories = await localDirectories('session-ttl-minimum');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
      sessionTtlSeconds: 1,
    });
    const beforeClaim = Date.now();
    const claim = await initialized.runtime.claimOwner({
      token: initialized.bootstrap?.token as string,
      name: 'Owner',
      email: 'owner@example.com',
    });

    const stored = await initialized.runtime.db.query(
      'SELECT expires_at FROM sessions WHERE id = ?',
      claim.sessionId,
    );
    const expiresAt = new Date(
      (stored.rows[0] as { expires_at: string }).expires_at,
    ).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(beforeClaim + 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 1000);
    await expect(
      initialized.runtime.restoreSession(claim.sessionId),
    ).resolves.toMatchObject({
      user: { id: claim.userId },
    });
  });

  it('refuses symlinked secret material instead of following it', async () => {
    const directories = await localDirectories('secret-symlink');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const target = join(directories.root, 'outside-secret');
    const secretPath = initialized.runtime.paths.applicationSecret;
    await rm(secretPath);
    await writeFile(target, 'must-not-be-used\n');
    await symlink(target, secretPath);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
      }),
    ).rejects.toThrow(/leaf|symbolic link|unsafe component/i);
    expect(await readFile(target, 'utf8')).toBe('must-not-be-used\n');
  });

  it('rejects an interrupted partial secret without replacing it', async () => {
    const directories = await localDirectories('partial-secret');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await writeFile(initialized.runtime.paths.applicationSecret, 'partial');

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(
      await readFile(initialized.runtime.paths.applicationSecret, 'utf8'),
    ).toBe('partial');
  });

  it('rejects a complete-looking secret with unsafe permissions', async () => {
    const directories = await localDirectories('permissive-secret');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await chmod(initialized.runtime.paths.applicationSecret, 0o644);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(
      (await stat(initialized.runtime.paths.applicationSecret)).mode & 0o777,
    ).toBe(0o644);
  });

  it('recovers from an interrupted temporary secret publication', async () => {
    const directories = await localDirectories('stale-secret-temp');
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const secretPath = initialized.runtime.paths.applicationSecret;
    await rm(secretPath);
    const staleTemp = join(
      initialized.runtime.paths.secrets,
      '.application.secret.tmp-interrupted',
    );
    await writeFile(staleTemp, 'partial', { mode: 0o600 });

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
      }),
    ).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    expect(await readFile(secretPath, 'utf8')).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    await expect(stat(staleTemp)).rejects.toMatchObject({ code: 'ENOENT' });
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
    const lockPath = await initializationLockPath(redirectedData);

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
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an existing broad data root without changing its mode or creating artifacts', async () => {
    const directories = await localDirectories('broad-root');
    const broadRoot = join(directories.root, 'shared');
    await mkdir(broadRoot, { mode: 0o755 });
    await chmod(broadRoot, 0o755);
    const originalMode = (await stat(broadRoot)).mode & 0o777;
    const lockPath = await initializationLockPath(broadRoot);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        sourceRoot: directories.sourceRoot,
        dataDirectory: broadRoot,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });

    expect((await stat(broadRoot)).mode & 0o777).toBe(originalMode);
    await expect(
      stat(join(broadRoot, 'application.sqlite')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(broadRoot, 'assets'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(broadRoot, 'secrets'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unrelated populated private root without changing its contents', async () => {
    const directories = await localDirectories('unmarked-root');
    await mkdir(directories.dataDirectory, { mode: 0o700 });
    await chmod(directories.dataDirectory, 0o700);
    const unrelated = join(directories.dataDirectory, 'personal.txt');
    await writeFile(unrelated, 'keep me\n');
    const lockPath = await initializationLockPath(directories.dataDirectory);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });

    expect(await readFile(unrelated, 'utf8')).toBe('keep me\n');
    await expect(
      stat(join(directories.dataDirectory, 'application.sqlite')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(join(directories.dataDirectory, '.smrt-local-runtime-lolaus')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks an empty private root and reopens it idempotently', async () => {
    const directories = await localDirectories('marked-root');
    await mkdir(directories.dataDirectory, { mode: 0o700 });
    await chmod(directories.dataDirectory, 0o700);

    await initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    const marker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus',
    );
    expect((await stat(marker)).size).toBe(0);
    expect((await stat(marker)).mode & 0o777).toBe(0o600);
    await expect(
      stat(
        join(directories.dataDirectory, '.smrt-local-runtime-lolaus.pending'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
  });

  it('recovers an atomically pending root claim after an interrupted acquisition', async () => {
    const directories = await localDirectories('pending-root');
    await mkdir(directories.dataDirectory, { mode: 0o700 });
    await chmod(directories.dataDirectory, 0o700);
    const pendingMarker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus.pending',
    );
    await writeFile(pendingMarker, '', { mode: 0o600 });
    await writeFile(join(directories.dataDirectory, 'application.sqlite'), '', {
      mode: 0o600,
    });

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    await expect(stat(pendingMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await stat(
          join(directories.dataDirectory, '.smrt-local-runtime-lolaus'),
        )
      ).size,
    ).toBe(0);
  });

  it('preserves an inherited pending claim when database reacquisition fails', async () => {
    const directories = await localDirectories('pending-reacquisition');
    await mkdir(directories.dataDirectory, { mode: 0o700 });
    await chmod(directories.dataDirectory, 0o700);
    const pendingMarker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus.pending',
    );
    const database = join(directories.dataDirectory, 'application.sqlite');
    await writeFile(pendingMarker, '', { mode: 0o600 });
    await writeFile(database, '', { mode: 0o600 });
    vi.spyOn(sql, 'getDatabase').mockRejectedValueOnce(
      new Error('injected database reacquisition failure'),
    );

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).rejects.toThrow('injected database reacquisition failure');
    expect((await stat(pendingMarker)).isFile()).toBe(true);
    expect((await stat(database)).isFile()).toBe(true);

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    await expect(stat(pendingMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(database)).isFile()).toBe(true);
  });

  it('retries read-only preflight when a concurrent initializer removes its pending marker', async () => {
    const directories = await localDirectories('preflight-marker-race');
    const originalGetDatabase = sql.getDatabase;
    let databaseCalls = 0;
    let enterFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    let captureSecondSnapshot: (() => void) | undefined;
    let resumeSecondPreflight: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondSnapshotCaptured = new Promise<void>((resolve) => {
      captureSecondSnapshot = resolve;
    });
    const secondPreflightResumed = new Promise<void>((resolve) => {
      resumeSecondPreflight = resolve;
    });
    vi.spyOn(sql, 'getDatabase').mockImplementation(async (...args) => {
      databaseCalls += 1;
      if (databaseCalls === 1) {
        enterFirst?.();
        await firstReleased;
        throw new Error('injected first acquisition failure');
      }
      return originalGetDatabase(...args);
    });

    const first = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await firstEntered;

    let snapshotPaused = false;
    filesystemInterleave.afterReaddir = async (path) => {
      if (!snapshotPaused && String(path) === directories.dataDirectory) {
        snapshotPaused = true;
        captureSecondSnapshot?.();
        await secondPreflightResumed;
      }
    };
    const second = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await secondSnapshotCaptured;

    releaseFirst?.();
    await expect(first).rejects.toThrow('injected first acquisition failure');
    filesystemInterleave.afterReaddir = undefined;
    resumeSecondPreflight?.();

    await expect(second).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    expect(databaseCalls).toBe(2);
  });

  it('serializes failed and crashing initializers without losing recovery authority', async () => {
    const directories = await localDirectories('initializer-race');
    const pendingMarker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus.pending',
    );
    const database = join(directories.dataDirectory, 'application.sqlite');
    const originalGetDatabase = sql.getDatabase;
    let calls = 0;
    let enterFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    let enterSecond: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondEntered = new Promise<void>((resolve) => {
      enterSecond = resolve;
    });
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const databaseSpy = vi
      .spyOn(sql, 'getDatabase')
      .mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) {
          enterFirst?.();
          await firstReleased;
          throw new Error('injected first acquisition failure');
        }
        if (calls === 2) {
          enterSecond?.();
          await secondReleased;
        }
        return originalGetDatabase(...args);
      });

    const first = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await firstEntered;
    const second = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);

    releaseFirst?.();
    await expect(first).rejects.toThrow('injected first acquisition failure');
    await secondEntered;
    let promotionFailureInjected = false;
    filesystemInterleave.beforeUnlink = async (path) => {
      if (!promotionFailureInjected && String(path) === pendingMarker) {
        promotionFailureInjected = true;
        throw new Error('injected second promotion crash');
      }
    };
    releaseSecond?.();
    await expect(second).rejects.toThrow('injected second promotion crash');
    expect(promotionFailureInjected).toBe(true);
    expect((await stat(pendingMarker)).isFile()).toBe(true);
    expect((await stat(database)).isFile()).toBe(true);

    filesystemInterleave.beforeUnlink = undefined;
    databaseSpy.mockRestore();
    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    await expect(stat(pendingMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(database)).isFile()).toBe(true);
  });

  it('releases the initialization database lease when its owner crashes', async () => {
    const directories = await localDirectories('stale-initializer');
    const lockPath = await initializationLockPath(directories.dataDirectory);
    await holdInitializationDatabaseUntilKilled(lockPath);
    const lockInode = (await stat(lockPath)).ino;

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    expect((await stat(lockPath)).ino).toBe(lockInode);
  });

  it.runIf(platform() === 'darwin')(
    'rejects a permissive ACL on the private lock custody root without acquiring a lease',
    async () => {
      const directories = await localDirectories('lock-root-acl');
      const lockPath = await initializationLockPath(directories.dataDirectory);
      const lockCustodyRoot = dirname(lockPath);
      await mkdir(lockCustodyRoot, { recursive: true, mode: 0o700 });
      await chmod(lockCustodyRoot, 0o700);
      await execFileAsync('/bin/chmod', [
        '+a',
        'everyone allow add_file,add_subdirectory,delete_child',
        lockCustodyRoot,
      ]);
      let prepareDatabaseCalled = false;

      let failure: unknown;
      try {
        await initializeLocalApplicationRuntime({
          appId: 'lolaus',
          ...directories,
          prepareDatabase: async () => {
            prepareDatabaseCalled = true;
          },
        });
      } catch (error) {
        failure = error;
      }

      expectRuntimeError(failure, 'invalid_configuration');
      expect(String((failure as { cause?: unknown }).cause)).toMatch(
        /access control list|custody/i,
      );
      expect(prepareDatabaseCalled).toBe(false);
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(directories.dataDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('elects one successor without deleting or replacing the lock database', async () => {
    const directories = await localDirectories('stale-successors');
    const lockPath = await initializationLockPath(directories.dataDirectory);
    await holdInitializationDatabaseUntilKilled(lockPath);
    const lockInode = (await stat(lockPath)).ino;
    filesystemInterleave.beforeUnlink = async (path) => {
      if (String(path) === lockPath) {
        throw new Error('lock database pathname must never be unlinked');
      }
    };

    let activeMigrations = 0;
    let maximumActiveMigrations = 0;
    let releaseFirstMigration: (() => void) | undefined;
    const firstMigrationPaused = new Promise<void>((resolve) => {
      releaseFirstMigration = resolve;
    });
    let enterFirstMigration: (() => void) | undefined;
    const firstMigrationEntered = new Promise<void>((resolve) => {
      enterFirstMigration = resolve;
    });
    const prepareDatabase = async () => {
      activeMigrations += 1;
      maximumActiveMigrations = Math.max(
        maximumActiveMigrations,
        activeMigrations,
      );
      if (maximumActiveMigrations === 1 && activeMigrations === 1) {
        enterFirstMigration?.();
        await firstMigrationPaused;
      }
      activeMigrations -= 1;
    };
    const first = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
      prepareDatabase,
    });
    const second = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
      prepareDatabase,
    });
    await firstMigrationEntered;
    await new Promise((resolve) => setImmediate(resolve));
    expect(maximumActiveMigrations).toBe(1);
    releaseFirstMigration?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(maximumActiveMigrations).toBe(1);
    expect((await stat(lockPath)).ino).toBe(lockInode);
  });

  it('holds the root lease through migrations and releases it after failure', async () => {
    const directories = await localDirectories('migration-lease');
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    let enterFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const prepareDatabase = async () => {
      calls += 1;
      const call = calls;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (call === 1) {
        enterFirst?.();
        await firstReleased;
      }
      active -= 1;
      if (call === 1) throw new Error('injected migration failure');
    };

    const first = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
      prepareDatabase,
    });
    await firstEntered;
    const second = initializeLocalApplicationRuntime({
      appId: 'lolaus',
      ...directories,
      prepareDatabase,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(maximumActive).toBe(1);
    releaseFirst?.();
    await expect(first).rejects.toThrow('injected migration failure');
    await expect(second).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
  });

  it.runIf(platform() === 'darwin')(
    'serializes differently cased aliases of one macOS application root',
    async () => {
      const directories = await localDirectories('case-alias-lease');
      await mkdir(directories.dataDirectory, { mode: 0o700 });
      const aliasDataDirectory = join(
        dirname(directories.dataDirectory),
        'DATA',
      );
      let aliasesShareInode = false;
      try {
        aliasesShareInode =
          (await stat(directories.dataDirectory)).ino ===
          (await stat(aliasDataDirectory)).ino;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!aliasesShareInode) return;

      let active = 0;
      let maximumActive = 0;
      let calls = 0;
      let enterFirst: (() => void) | undefined;
      let releaseFirst: (() => void) | undefined;
      const firstEntered = new Promise<void>((resolve) => {
        enterFirst = resolve;
      });
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const prepareDatabase = async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) {
          enterFirst?.();
          await firstReleased;
        }
        active -= 1;
      };

      const first = initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
        prepareDatabase,
      });
      await firstEntered;
      const second = initializeLocalApplicationRuntime({
        appId: 'lolaus',
        ...directories,
        dataDirectory: aliasDataDirectory,
        prepareDatabase,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toBe(1);
      expect(maximumActive).toBe(1);
      releaseFirst?.();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(calls).toBe(2);
      expect(maximumActive).toBe(1);
    },
  );

  it('rejects an inherited pending claim with unrelated contents', async () => {
    const directories = await localDirectories('pending-unrelated');
    await mkdir(directories.dataDirectory, { mode: 0o700 });
    await chmod(directories.dataDirectory, 0o700);
    const pendingMarker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus.pending',
    );
    const database = join(directories.dataDirectory, 'application.sqlite');
    const unrelated = join(directories.dataDirectory, 'unrelated.txt');
    const lockPath = await initializationLockPath(directories.dataDirectory);
    await writeFile(pendingMarker, '', { mode: 0o600 });
    await writeFile(database, '', { mode: 0o600 });
    await writeFile(unrelated, 'keep me\n', { mode: 0o600 });

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep me\n');
    expect((await stat(pendingMarker)).isFile()).toBe(true);
    expect((await stat(database)).isFile()).toBe(true);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a malformed inherited pending marker', async () => {
    const directories = await localDirectories('pending-malformed');
    await mkdir(directories.dataDirectory, { mode: 0o700 });
    await chmod(directories.dataDirectory, 0o700);
    const pendingMarker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus.pending',
    );
    const database = join(directories.dataDirectory, 'application.sqlite');
    const lockPath = await initializationLockPath(directories.dataDirectory);
    await writeFile(pendingMarker, 'not-empty\n', { mode: 0o600 });
    await writeFile(database, '', { mode: 0o600 });

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(await readFile(pendingMarker, 'utf8')).toBe('not-empty\n');
    expect((await stat(database)).isFile()).toBe(true);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a recoverable pending claim when promotion fails after database acquisition', async () => {
    const directories = await localDirectories('pending-promotion');
    const pendingMarker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus.pending',
    );
    const finalMarker = join(
      directories.dataDirectory,
      '.smrt-local-runtime-lolaus',
    );
    let injected = false;
    filesystemInterleave.beforeUnlink = async (path) => {
      if (!injected && String(path) === pendingMarker) {
        injected = true;
        const error = new Error('injected pending-marker deletion failure');
        Object.assign(error, { code: 'EIO' });
        throw error;
      }
    };

    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).rejects.toThrow('injected pending-marker deletion failure');
    expect(injected).toBe(true);
    expect(
      (
        await stat(join(directories.dataDirectory, 'application.sqlite'))
      ).isFile(),
    ).toBe(true);
    expect((await stat(pendingMarker)).isFile()).toBe(true);
    expect((await stat(finalMarker)).isFile()).toBe(true);

    filesystemInterleave.beforeUnlink = undefined;
    await expect(
      initializeLocalApplicationRuntime({ appId: 'lolaus', ...directories }),
    ).resolves.toMatchObject({
      diagnostics: { runtime: { profile: 'local' } },
    });
    await expect(stat(pendingMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(finalMarker)).size).toBe(0);
  });

  it('delegates unsafe ancestor custody to secure SQLite and leaves zero artifacts', async () => {
    const directories = await localDirectories('unsafe-ancestor');
    const unsafeAncestor = join(directories.root, 'shared');
    const dataDirectory = join(unsafeAncestor, 'lolaus');
    await mkdir(unsafeAncestor, { mode: 0o777 });
    await chmod(unsafeAncestor, 0o777);
    const lockPath = await initializationLockPath(dataDirectory);

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        sourceRoot: directories.sourceRoot,
        dataDirectory,
      }),
    ).rejects.toThrow(/custody|writable|replacement/i);

    expect((await stat(unsafeAncestor)).mode & 0o777).toBe(0o777);
    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(platform() === 'darwin')(
    'delegates permissive macOS ancestor ACL rejection and leaves zero artifacts',
    async () => {
      const directories = await localDirectories('unsafe-acl');
      const aclAncestor = join(directories.root, 'acl-parent');
      const dataDirectory = join(aclAncestor, 'lolaus');
      await mkdir(aclAncestor, { mode: 0o700 });
      const lockPath = await initializationLockPath(dataDirectory);
      await execFileAsync('/bin/chmod', [
        '+a',
        'everyone allow add_file,add_subdirectory,delete_child',
        aclAncestor,
      ]);

      await expect(
        initializeLocalApplicationRuntime({
          appId: 'lolaus',
          sourceRoot: directories.sourceRoot,
          dataDirectory,
        }),
      ).rejects.toThrow(/access control list|custody/i);
      await expect(stat(dataDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('refuses a data root containing the source tree before changing its mode or contents', async () => {
    const directories = await localDirectories('source-ancestor');
    await chmod(directories.root, 0o711);
    const originalMode = (await stat(directories.root)).mode & 0o777;

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        sourceRoot: directories.sourceRoot,
        dataDirectory: directories.root,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });

    expect((await stat(directories.root)).mode & 0o777).toBe(originalMode);
    await expect(
      stat(join(directories.root, 'application.sqlite')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(directories.root, 'assets'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(directories.root, 'secrets'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  });

  it('refuses the user home itself as a data root even when it is private', async () => {
    const directories = await localDirectories('home-root');
    const homeDirectory = join(directories.root, 'home');
    await mkdir(homeDirectory, { mode: 0o700 });
    await chmod(homeDirectory, 0o700);
    const originalMode = (await stat(homeDirectory)).mode & 0o777;

    await expect(
      initializeLocalApplicationRuntime({
        appId: 'lolaus',
        homeDirectory,
        sourceRoot: directories.sourceRoot,
        dataDirectory: homeDirectory,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });

    expect((await stat(homeDirectory)).mode & 0o777).toBe(originalMode);
    await expect(
      stat(join(homeDirectory, 'application.sqlite')),
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

  it('refuses an existing symlinked database leaf without touching its target', async () => {
    const directories = await localDirectories('database-symlink');
    const target = join(directories.root, 'outside-database');
    await mkdir(directories.dataDirectory, { mode: 0o700 });
    await chmod(directories.dataDirectory, 0o700);
    await writeFile(
      join(directories.dataDirectory, '.smrt-local-runtime-lolaus'),
      '',
      { mode: 0o600 },
    );
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
    ).rejects.toThrow(/leaf|symbolic link/i);
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
  it('does not export a concrete runtime constructor or database injection path', () => {
    expect(localRuntimeApi).not.toHaveProperty('LocalApplicationRuntime');
  });

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
    ).toThrow('does not overlap the source tree');
  });

  it('rejects a data root that contains the source tree', () => {
    expect(() =>
      resolveLocalRuntimePaths({
        appId: 'lolaus',
        sourceRoot: '/workspace/lolaus',
        dataDirectory: '/workspace',
      }),
    ).toThrow('does not overlap the source tree');
  });

  it('rejects the filesystem root as an application data directory', () => {
    expect(() =>
      resolveLocalRuntimePaths({
        appId: 'lolaus',
        sourceRoot: '/workspace/lolaus',
        dataDirectory: '/',
      }),
    ).toThrow('dedicated directory');
  });

  it.each([
    'win32',
    'darwin',
  ] as const)('applies the %s platform override to conservative case-insensitive custody guards', (runtimePlatform) => {
    expect(() =>
      resolveLocalRuntimePaths({
        appId: 'lolaus',
        sourceRoot: '/workspace/lolaus',
        dataDirectory: '/users/test',
        homeDirectory: '/Users/Test',
        platform: runtimePlatform,
      }),
    ).toThrow('dedicated directory');
    expect(() =>
      resolveLocalRuntimePaths({
        appId: 'lolaus',
        sourceRoot: '/Workspace/Lolaus',
        dataDirectory: '/workspace/lolaus/data',
        homeDirectory: '/Users/Test',
        platform: runtimePlatform,
      }),
    ).toThrow('does not overlap the source tree');
  });
});
