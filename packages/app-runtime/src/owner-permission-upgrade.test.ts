/**
 * An owner claimed before a permission was registered gains it on the next
 * start (the upgrade case behind the shell's "assistant could not start"),
 * without re-granting a removed grant or touching other roles.
 * Everything runs on the real local runtime and SQLite.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { OidcIdentityCollection } from '@happyvertical/smrt-profiles';
import {
  disableTenancy,
  getCurrentTenant,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  registerPermissionDefinitions,
  SessionCollection,
  TenantCollection,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_MCP_TOKEN_PRINCIPAL,
  LOCAL_MCP_TOKEN_TABLE,
  LocalRuntimeError,
  openLocalMcpTokenStore,
} from './index.js';
import {
  createLocalMcpTokenStore,
  ensureLocalMcpTokenTable,
} from './local-mcp-tokens.js';
import {
  createLocalMcpCredentialHandler,
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from './sveltekit.js';

const temporaryRoots: string[] = [];
const initializationLockPaths = new Set<string>();
const openRuntimes: SmrtSvelteKitRuntime[] = [];
const openApplicationDatabases = new Set<DatabaseInterface>();

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    let local: Awaited<ReturnType<SmrtSvelteKitRuntime['localRuntime']>>;
    try {
      local = await runtime.localRuntime();
    } catch {
      // Runtime never started.
      continue;
    }
    // Public collections share the cached application connection with the
    // runtime's membership, permission and session services.
    const users = await UserCollection.create(runtime.classOptions('User'));
    openApplicationDatabases.add(users.db);
    await local.db.close?.();
  }
  for (const db of openApplicationDatabases) await db.close?.();
  openApplicationDatabases.clear();
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

afterAll(() => {
  disableTenancy();
});

async function localDirectories(label: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `smrt-mcp-token-${label}-`)),
  );
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const dataDirectory = join(root, 'data');
  await mkdir(sourceRoot);
  await writeFile(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: `@acme/${label}` }),
  );
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Tests require a numeric uid.');
  const identity =
    platform() === 'darwin' ? dataDirectory.toLowerCase() : dataDirectory;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  initializationLockPaths.add(
    join(await realpath('/tmp'), `.smrt-${uid}`, key, 'initialization.sqlite'),
  );
  return { sourceRoot, dataDirectory };
}

async function start(
  directories: Awaited<ReturnType<typeof localDirectories>>,
) {
  const runtime = createSmrtSvelteKitRuntime({
    ...directories,
    runtime: resolveApplicationRuntime({ profile: 'local' }),
    env: { NODE_ENV: 'development' },
  });
  openRuntimes.push(runtime);
  await runtime.init();
  return { runtime, local: await runtime.localRuntime() };
}

async function claim(local: Awaited<ReturnType<typeof start>>['local']) {
  const invitation = await local.rotateBootstrapInvitation();
  await local.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
}

const define = (slug: string) =>
  registerPermissionDefinitions([
    { slug, category: 'upgrade', name: slug, description: slug },
  ]);

async function roleHolds(
  db: DatabaseInterface,
  roleSlug: string,
  slug: string,
): Promise<boolean> {
  const roles = await RoleCollection.create({ db });
  const role = await roles.findSystemRoleBySlug(roleSlug);
  const permission = await (
    await PermissionCollection.create({ db })
  ).findBySlug(slug);
  if (!role?.id || !permission?.id) return false;
  const ids = await (
    await RolePermissionCollection.create({ db })
  ).getPermissionIds(role.id);
  return ids.includes(permission.id);
}

const mint = (
  local: Awaited<ReturnType<typeof start>>['local'],
  slug: string,
) => local.mcpTokens?.issue({ scopes: [slug], expiresInSeconds: 900 });

describe('owner permission seeding on start', () => {
  it('fresh install: the owner holds a permission registered before the claim', async () => {
    const slug = 'upgrade.fresh';
    define(slug);
    const { local } = await start(await localDirectories('fresh'));
    await claim(local);
    expect(await roleHolds(local.db, 'owner', slug)).toBe(true);
    await expect(mint(local, slug)).resolves.toMatchObject({
      token: expect.stringMatching(/^smrt_mcp_/),
    });
  });

  it('upgrade: an owner claimed before the permission existed gains it on the next start, others do not', async () => {
    const slug = 'upgrade.later';
    const directories = await localDirectories('upgrade');
    const first = await start(directories);
    await claim(first.local);
    // Before the permission is registered, minting it is refused with a code.
    await expect(mint(first.local, slug)).rejects.toMatchObject({
      code: 'invalid_scope',
    });
    await first.local.db.close?.();

    define(slug);
    const second = await start(directories);
    expect(await roleHolds(second.local.db, 'owner', slug)).toBe(true);
    for (const other of ['admin', 'member', 'viewer']) {
      expect(await roleHolds(second.local.db, other, slug)).toBe(false);
    }
    await expect(mint(second.local, slug)).resolves.toMatchObject({
      token: expect.stringMatching(/^smrt_mcp_/),
    });
  });

  it('restart is idempotent and never re-grants a removed owner grant', async () => {
    const slug = 'upgrade.removed';
    define(slug);
    const directories = await localDirectories('removed');
    const first = await start(directories);
    await claim(first.local);
    const roles = await RoleCollection.create({ db: first.local.db });
    const owner = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
    const permission = await (
      await PermissionCollection.create({ db: first.local.db })
    ).findBySlug(slug);
    await (
      await RolePermissionCollection.create({ db: first.local.db })
    ).removePermission(owner?.id as string, permission?.id as string);
    await first.local.db.close?.();

    const second = await start(directories);
    expect(await roleHolds(second.local.db, 'owner', slug)).toBe(false);
    await expect(mint(second.local, slug)).rejects.toMatchObject({
      code: 'invalid_scope',
    });
  });
});
