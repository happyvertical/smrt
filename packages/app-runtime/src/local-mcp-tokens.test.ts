/**
 * Owner-minted local MCP tokens (#3413): issuance, HMAC-only storage, live
 * permission capping, expiry, revocation, the operator store used by
 * `smrt app token`, and the runtime's membership-backed hosted resolver.
 * Everything runs on the real local runtime and SQLite.
 */
import { createHash } from 'node:crypto';
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
  TenantCollection,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_MCP_TOKEN_PRINCIPAL,
  LOCAL_MCP_TOKEN_TABLE,
  LocalRuntimeError,
  openLocalMcpTokenStore,
} from './index.js';
import {
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from './sveltekit.js';

const temporaryRoots: string[] = [];
const initializationLockPaths = new Set<string>();
const openRuntimes: SmrtSvelteKitRuntime[] = [];

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    try {
      await (await runtime.localRuntime()).db.close?.();
    } catch {
      // Runtime never started.
    }
  }
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

const READ = 'notes.read';
const EXPORT = 'notes.export';

/** A local runtime with a claimed owner holding `notes.read` and `notes.export`. */
async function ownedRuntime(label: string, clock?: { now: Date }) {
  const directories = await localDirectories(label);
  const runtime = createSmrtSvelteKitRuntime({
    ...directories,
    runtime: resolveApplicationRuntime({ profile: 'local' }),
    env: { NODE_ENV: 'development' },
    ...(clock ? { now: () => clock.now } : {}),
  });
  openRuntimes.push(runtime);
  await runtime.init();
  const local = await runtime.localRuntime();
  const invitation = await local.rotateBootstrapInvitation();
  const owner = await local.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
  const roles = await RoleCollection.create({ db: local.db });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  if (!ownerRole?.id) throw new Error('owner role missing');
  const permissions = await PermissionCollection.create({ db: local.db });
  const rolePermissions = await RolePermissionCollection.create({
    db: local.db,
  });
  const ids: Record<string, string> = {};
  for (const slug of [READ, EXPORT]) {
    const permission = await permissions.findOrCreate(slug, { name: slug });
    ids[slug] = permission.id as string;
    await rolePermissions.addPermission(ownerRole.id, permission.id as string);
  }
  const revokePermission = (slug: string) =>
    rolePermissions.removePermission(ownerRole.id as string, ids[slug]);
  return { runtime, local, owner, directories, revokePermission };
}

async function tokenRows(db: DatabaseInterface) {
  return (await db.query(`SELECT * FROM ${LOCAL_MCP_TOKEN_TABLE}`))
    .rows as Array<Record<string, unknown>>;
}

describe('local MCP tokens', () => {
  it('refuses to issue before an owner exists', async () => {
    const directories = await localDirectories('no-owner');
    const runtime = createSmrtSvelteKitRuntime({
      ...directories,
      runtime: resolveApplicationRuntime({ profile: 'local' }),
      env: { NODE_ENV: 'development' },
    });
    openRuntimes.push(runtime);
    await runtime.init();
    const local = await runtime.localRuntime();
    await expect(local.mcpTokens?.issue({ scopes: [READ] })).rejects.toThrow(
      expect.objectContaining({ code: 'owner_unavailable' }),
    );
    expect(await tokenRows(local.db)).toEqual([]);
  });

  it('issues an owner-bound token, stores only its HMAC, and verifies it', async () => {
    const { runtime, local, owner } = await ownedRuntime('issue');
    const store = local.mcpTokens;
    if (!store) throw new Error('token store missing');
    const issued = await store.issue({
      scopes: [READ, READ, EXPORT],
      label: 'Claude Desktop',
    });
    expect(issued.token).toMatch(/^smrt_mcp_[A-Za-z0-9_-]{43}$/);
    expect(issued.scopes).toEqual([EXPORT, READ]);
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.createdAt)).toBe(
      30 * 24 * 60 * 60 * 1000,
    );

    const rows = await tokenRows(local.db);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    expect(JSON.stringify(rows)).not.toContain(issued.token.slice(9));
    expect(String(rows[0].token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]).toMatchObject({
      user_id: owner.userId,
      tenant_id: owner.tenantId,
    });

    const listed = await store.list();
    expect(listed).toEqual([
      {
        id: issued.id,
        scopes: [EXPORT, READ],
        label: 'Claude Desktop',
        createdAt: issued.createdAt,
        expiresAt: issued.expiresAt,
        revokedAt: null,
        status: 'active',
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(issued.token);

    const principal = {
      id: owner.userId,
      tenantId: owner.tenantId,
      kind: 'human',
      scopes: [EXPORT, READ],
      tenantBinding: 'direct',
      [LOCAL_MCP_TOKEN_PRINCIPAL]: true,
    };
    expect(await store.verify(issued.token)).toEqual(principal);
    expect(await runtime.verifyLocalMcpToken(issued.token)).toEqual(principal);
  });

  it('rejects malformed, unknown, and look-alike tokens', async () => {
    const { runtime, local } = await ownedRuntime('garbage');
    const issued = await local.mcpTokens?.issue({ scopes: [READ] });
    if (!issued) throw new Error('not issued');
    for (const token of [
      '',
      'not-a-token',
      issued.token.slice(0, -1),
      `${issued.token}x`,
      issued.token.replace('smrt_mcp_', 'smrt_mcq_'),
      `smrt_mcp_${'A'.repeat(43)}`,
      local.db as unknown as string,
    ]) {
      expect(await runtime.verifyLocalMcpToken(token)).toBeNull();
    }
  });

  it('rejects scopes the owner does not hold and invalid requests, writing nothing', async () => {
    const { local } = await ownedRuntime('invalid');
    const store = local.mcpTokens;
    if (!store) throw new Error('token store missing');
    const cases: Array<[Parameters<typeof store.issue>[0], string]> = [
      [{ scopes: [READ, 'admin.everything'] }, 'invalid_scope'],
      [{ scopes: [] }, 'invalid_scope'],
      [{ scopes: ['has space'] }, 'invalid_scope'],
      [{ scopes: ['quote"d'] }, 'invalid_scope'],
      [{ scopes: undefined as unknown as string[] }, 'invalid_scope'],
      [{ scopes: [READ], expiresInSeconds: 59 }, 'invalid_configuration'],
      [
        { scopes: [READ], expiresInSeconds: 366 * 24 * 60 * 60 },
        'invalid_configuration',
      ],
      [{ scopes: [READ], expiresInSeconds: 1.5 }, 'invalid_configuration'],
      [{ scopes: [READ], label: '  ' }, 'invalid_configuration'],
      [{ scopes: [READ], label: 'line\nbreak' }, 'invalid_configuration'],
    ];
    for (const [input, code] of cases) {
      const failure = await store.issue(input).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(LocalRuntimeError);
      expect(failure).toMatchObject({ code });
    }
    expect(await tokenRows(local.db)).toEqual([]);
  });

  it('cannot widen a verified principal by mutating its scopes', async () => {
    const { runtime, local } = await ownedRuntime('frozen-scopes');
    // The owner holds both, but the token was minted for READ only.
    const issued = await local.mcpTokens?.issue({ scopes: [READ] });
    if (!issued) throw new Error('not issued');
    const verified = await runtime.verifyLocalMcpToken(issued.token);
    if (!verified) throw new Error('not verified');
    let pushError: unknown;
    try {
      (verified.scopes as string[]).push(EXPORT);
    } catch (error) {
      pushError = error;
    }
    // The bound scopes stay the minted token ∩ live permissions.
    await expect(
      runtime.runAsPrincipal(verified, async (bound) => bound.scopes),
    ).resolves.toEqual([READ]);
    expect(pushError).toBeInstanceOf(TypeError);
    expect(Object.isFrozen(verified.scopes)).toBe(true);
    expect(verified.scopes).toEqual([READ]);
    // A fresh verification is equally frozen.
    const again = await runtime.verifyLocalMcpToken(issued.token);
    if (!again) throw new Error('not verified');
    expect(() => {
      (again.scopes as string[]).push(EXPORT);
    }).toThrow(TypeError);
  });

  it('binds one snapshot of the principal even if the caller mutates it mid-flight', async () => {
    const { runtime, owner } = await ownedRuntime('snapshot');
    const principal: {
      id: string;
      tenantId: string;
      scopes: string[];
      kind?: string;
    } = {
      id: owner.userId,
      tenantId: owner.tenantId,
      scopes: [READ],
      kind: 'human',
    };
    const pending = runtime.runAsPrincipal(principal, async (bound) => ({
      bound,
      frozen: Object.isFrozen(bound) && Object.isFrozen(bound.scopes),
      contextTenant: getCurrentTenant()?.tenantId,
    }));
    // Membership resolution is awaiting: swap the caller's identity.
    principal.id = 'attacker-user';
    principal.tenantId = 'attacker-tenant';
    principal.kind = 'service';
    const { bound, frozen, contextTenant } = await pending;
    expect(bound).toMatchObject({
      id: owner.userId,
      tenantId: owner.tenantId,
      kind: 'human',
      scopes: [READ],
      tenantBinding: 'direct-or-inherited',
    });
    expect(contextTenant).toBe(owner.tenantId);
    expect(frozen).toBe(true);
  });

  it('copies caller scopes before binding', async () => {
    const { runtime, owner } = await ownedRuntime('copied-scopes');
    const scopes = [READ];
    const bound = await runtime.runAsPrincipal(
      { id: owner.userId, tenantId: owner.tenantId, scopes },
      async (value) => {
        scopes.push(EXPORT);
        return value.scopes;
      },
    );
    expect(bound).toEqual([READ]);
  });

  it('never grants more than the owner holds now', async () => {
    const { runtime, local, owner, revokePermission } =
      await ownedRuntime('live');
    const issued = await local.mcpTokens?.issue({ scopes: [READ, EXPORT] });
    if (!issued) throw new Error('not issued');
    await revokePermission(EXPORT);
    const principal = await runtime.verifyLocalMcpToken(issued.token);
    expect(principal?.scopes).toEqual([READ]);
    // The route binding narrows again inside the request permission context.
    const bound = await runtime.runAsPrincipal(
      { id: owner.userId, tenantId: owner.tenantId, scopes: [READ, EXPORT] },
      async (value) => value.scopes,
    );
    expect(bound).toEqual([READ]);
    // A token cannot be minted for a scope the owner no longer holds.
    await expect(
      local.mcpTokens?.issue({ scopes: [EXPORT] }),
    ).rejects.toMatchObject({ code: 'invalid_scope' });
  });

  it('fails closed for an expired token and reports it as expired', async () => {
    const clock = { now: new Date('2026-10-03T12:00:00.000Z') };
    const { runtime, local } = await ownedRuntime('expiry', clock);
    const issued = await local.mcpTokens?.issue({
      scopes: [READ],
      expiresInSeconds: 3600,
    });
    if (!issued) throw new Error('not issued');
    expect(issued.expiresAt).toBe('2026-10-03T13:00:00.000Z');
    clock.now = new Date('2026-10-03T12:59:59.000Z');
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    clock.now = new Date('2026-10-03T13:00:00.000Z');
    expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
    expect((await local.mcpTokens?.list())?.[0].status).toBe('expired');
  });

  it('revokes idempotently and rejects unknown ids', async () => {
    const { runtime, local } = await ownedRuntime('revoke');
    const store = local.mcpTokens;
    if (!store) throw new Error('token store missing');
    const kept = await store.issue({ scopes: [READ] });
    const revoked = await store.issue({ scopes: [READ] });
    expect(await store.revoke(revoked.id)).toBe('revoked');
    expect(await store.revoke(revoked.id)).toBe('already-revoked');
    expect(await runtime.verifyLocalMcpToken(revoked.token)).toBeNull();
    expect(await runtime.verifyLocalMcpToken(kept.token)).not.toBeNull();
    const statuses = Object.fromEntries(
      (await store.list()).map((record) => [record.id, record.status]),
    );
    expect(statuses).toEqual({ [kept.id]: 'active', [revoked.id]: 'revoked' });
    for (const id of [
      '00000000-0000-4000-8000-000000000000',
      'not-an-id',
      "' OR 1=1 --",
    ]) {
      await expect(store.revoke(id)).rejects.toMatchObject({
        code: 'invalid_configuration',
      });
    }
  });

  it('requires the direct membership of the bound tenant; inheritance never substitutes for it', async () => {
    const { runtime, local, owner } = await ownedRuntime('inherited');
    // A child workspace under the owner's tenant, joined directly, while the
    // owner role also inherits to descendants.
    const { childTenantId, childMembershipId } = await withSystemContext(
      async () => {
        const roles = await RoleCollection.create({ db: local.db });
        const role = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
        if (!role?.id) throw new Error('owner role missing');
        role.inheritsToDescendants = true;
        await role.save();
        const tenants = await TenantCollection.create({ db: local.db });
        const child = await tenants.createChild(owner.tenantId, {
          name: 'Child',
          slug: 'child',
        });
        await child.save();
        const memberships = await MembershipCollection.create({ db: local.db });
        const direct = await memberships.create({
          userId: owner.userId,
          tenantId: child.id as string,
          roleId: role.id,
        });
        await direct.save();
        return {
          childTenantId: child.id as string,
          childMembershipId: direct.id as string,
        };
      },
    );
    const issued = await local.mcpTokens?.issue({ scopes: [READ] });
    if (!issued) throw new Error('not issued');
    // A token bound to the child workspace (where a direct membership exists).
    await local.db.query(
      `UPDATE ${LOCAL_MCP_TOKEN_TABLE} SET tenant_id = ? WHERE id = ?`,
      childTenantId,
      issued.id,
    );
    const verified = await runtime.verifyLocalMcpToken(issued.token);
    expect(verified).toMatchObject({ tenantId: childTenantId, scopes: [READ] });
    if (!verified) throw new Error('not verified');
    // The two public runtime APIs compose directly.
    await expect(
      runtime.runAsPrincipal(verified, async (bound) => bound.scopes),
    ).resolves.toEqual([READ]);
    await expect(
      runtime.runAsPrincipal(
        { id: owner.userId, tenantId: childTenantId, scopes: [READ] },
        async (bound) => bound.scopes,
      ),
    ).resolves.toEqual([READ]);

    // Deleting the direct membership (as application code would, through
    // the runtime's collection options) leaves only the inherited one.
    const appMemberships = await MembershipCollection.create(
      runtime.classOptions('Membership'),
    );
    const directRow = await withSystemContext(() =>
      appMemberships.get({ id: childMembershipId }),
    );
    if (!directRow) throw new Error('direct membership missing');
    await withSystemContext(() => directRow.delete());
    expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
    // A principal verified earlier, passed straight to runAsPrincipal, still
    // binds direct-only: the inheriting ancestor cannot replace the row.
    await expect(
      runtime.runAsPrincipal(verified, async () => 'ran'),
    ).rejects.toThrow('no active direct membership');
    // Widening a token-derived principal's binding is rejected, not ignored.
    await expect(
      runtime.runAsPrincipal(
        { ...verified, tenantBinding: 'direct-or-inherited' as const },
        async () => 'ran',
      ),
    ).rejects.toThrow('local MCP token principal');
    // The verified principal is immutable and always direct-only.
    expect(verified.tenantBinding).toBe('direct');
    expect(Object.isFrozen(verified)).toBe(true);
    expect(() => {
      (verified as { tenantBinding: string }).tenantBinding =
        'direct-or-inherited';
    }).toThrow();
    // The local-token binding mode is direct-only.
    await expect(
      runtime.runAsPrincipal(
        {
          id: owner.userId,
          tenantId: childTenantId,
          scopes: [READ],
          tenantBinding: 'direct',
        },
        async () => 'ran',
      ),
    ).rejects.toThrow('no active direct membership');
  });

  it('lets a hosted binding use legitimately inherited authority, pinned to the ancestor', async () => {
    const { runtime, local, owner } = await ownedRuntime('hosted-inherit');
    const childTenantId = await withSystemContext(async () => {
      const roles = await RoleCollection.create({ db: local.db });
      const role = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
      if (!role?.id) throw new Error('owner role missing');
      role.inheritsToDescendants = true;
      await role.save();
      const tenants = await TenantCollection.create({ db: local.db });
      const child = await tenants.createChild(owner.tenantId, {
        name: 'Child',
        slug: 'child',
      });
      await child.save();
      return child.id as string;
    });
    const bind = (tenantBinding?: 'direct' | 'direct-or-inherited') =>
      runtime.runAsPrincipal(
        {
          id: owner.userId,
          tenantId: childTenantId,
          scopes: [READ, 'notes.unheld'],
          ...(tenantBinding ? { tenantBinding } : {}),
        },
        async (bound) => bound.scopes,
      );
    // A custom hosted mapping to a tenant held only through an inheritable
    // ancestor membership gets the ancestor's permissions (capped by scopes).
    await expect(bind('direct-or-inherited')).resolves.toEqual([READ]);
    await expect(bind()).resolves.toEqual([READ]);
    // A direct-only binding (local tokens, default hosted resolver) refuses.
    await expect(bind('direct')).rejects.toThrow('no active direct membership');

    // Suspending the authorizing ancestor membership denies the inheritance.
    // Writes go through the runtime's collection options, as app code does.
    const memberships = await MembershipCollection.create(
      runtime.classOptions('Membership'),
    );
    const ancestor = await withSystemContext(() =>
      memberships.get({ id: owner.membershipId }),
    );
    if (!ancestor) throw new Error('membership missing');
    ancestor.status = MembershipStatus.SUSPENDED;
    await withSystemContext(() => ancestor.save());
    await expect(bind('direct-or-inherited')).rejects.toThrow('membership');
    ancestor.status = MembershipStatus.ACTIVE;
    await withSystemContext(() => ancestor.save());
    await expect(bind('direct-or-inherited')).resolves.toEqual([READ]);

    // A suspended direct row of the same tenant is authoritative: inheritance
    // never substitutes for it.
    const role = await (
      await RoleCollection.create(runtime.classOptions('Role'))
    ).findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
    const direct = await withSystemContext(async () => {
      const row = await memberships.create({
        userId: owner.userId,
        tenantId: childTenantId,
        roleId: role?.id as string,
      });
      row.status = MembershipStatus.SUSPENDED;
      await row.save();
      return row;
    });
    expect(direct.status).toBe(MembershipStatus.SUSPENDED);
    await expect(bind('direct-or-inherited')).rejects.toThrow('membership');
  });

  it('rejects an unknown binding mode', async () => {
    const { runtime, owner } = await ownedRuntime('binding-mode');
    await expect(
      runtime.runAsPrincipal(
        {
          id: owner.userId,
          tenantId: owner.tenantId,
          scopes: [READ],
          tenantBinding: 'anything' as never,
        },
        async () => 'ran',
      ),
    ).rejects.toThrow('binding');
  });

  it('denies a token whose owner lost the tenant membership or was suspended', async () => {
    const { runtime, local, owner } = await ownedRuntime('membership');
    const issued = await local.mcpTokens?.issue({ scopes: [READ] });
    if (!issued) throw new Error('not issued');
    const memberships = await MembershipCollection.create({ db: local.db });
    const membership = await memberships.get({ id: owner.membershipId });
    if (!membership) throw new Error('membership missing');
    membership.status = MembershipStatus.SUSPENDED;
    await membership.save();
    expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
    // The bound tenant is the authority: binding to any other tenant fails.
    await expect(
      runtime.runAsPrincipal(
        {
          id: owner.userId,
          tenantId: 'another-tenant',
          scopes: [READ],
          tenantBinding: 'direct',
        },
        async () => 'ran',
      ),
    ).rejects.toThrow('no active direct membership');

    membership.status = MembershipStatus.ACTIVE;
    await membership.save();
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    const users = await UserCollection.create({ db: local.db });
    const user = await users.get({ id: owner.userId });
    if (!user) throw new Error('user missing');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
  });

  it('lets the operator store issue and revoke while the web runtime keeps running', async () => {
    const { runtime, directories } = await ownedRuntime('operator');
    const appId = runtime.applicationId();
    const store = await openLocalMcpTokenStore({ appId, ...directories });
    try {
      const issued = await store.issue({ scopes: [READ] });
      // The running runtime sees the operator's write on its own connection.
      expect(await runtime.verifyLocalMcpToken(issued.token)).toMatchObject({
        scopes: [READ],
      });
      expect(await store.revoke(issued.id)).toBe('revoked');
      expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
    } finally {
      await store.close();
    }
    // Closing the operator store never closes the runtime's connection.
    const local = await runtime.localRuntime();
    await expect(local.mcpTokens?.list()).resolves.toHaveLength(1);
  });

  it('refuses the operator store for an application that was never set up', async () => {
    const directories = await localDirectories('never');
    await expect(
      openLocalMcpTokenStore({ appId: 'never-set-up', ...directories }),
    ).rejects.toThrow();
  });

  it('accepts no local tokens outside the local profile', async () => {
    const runtime = createSmrtSvelteKitRuntime({
      appId: 'hosted-token',
      runtime: resolveApplicationRuntime({ profile: 'cloud' }),
      env: { DATABASE_URL: 'postgres://unused.invalid/db' },
      enableTenancy: false,
    });
    expect(
      await runtime.verifyLocalMcpToken(`smrt_mcp_${'A'.repeat(43)}`),
    ).toBeNull();
  });
});

describe('membership-backed hosted MCP principal', () => {
  const ISSUER = 'https://id.example.test/';

  async function hosted(label: string) {
    const owned = await ownedRuntime(label);
    const db = owned.local.db;
    const hostedRuntime = createSmrtSvelteKitRuntime({
      appId: `hosted-${label}`,
      runtime: resolveApplicationRuntime({ profile: 'self-hosted' }),
      // Only a selector; every class below is overridden onto the SQLite db.
      env: { DATABASE_URL: 'postgres://unused.invalid/db' },
      classOverrides: Object.fromEntries(
        ['OidcIdentity', 'User', 'Membership'].map((name) => [name, { db }]),
      ),
    });
    const identities = await OidcIdentityCollection.create({ db });
    const identity = await identities.create({
      profileId: owned.owner.profileId,
      provider: 'test',
      issuer: ISSUER,
      subject: 'subject-1',
      email: 'owner@example.test',
    });
    await identity.save();
    return { ...owned, hostedRuntime };
  }

  it('maps a linked subject to its user and only active tenant', async () => {
    const { hostedRuntime, owner, runtime } = await hosted('resolve');
    await expect(
      hostedRuntime.resolveMcpPrincipal({
        issuer: ISSUER,
        subject: 'subject-1',
      }),
    ).resolves.toEqual({
      id: owner.userId,
      tenantId: owner.tenantId,
      kind: 'human',
      // It maps only direct memberships, so its binding is direct-only.
      tenantBinding: 'direct',
    });
    // The local profile never resolves hosted identities.
    await expect(
      runtime.resolveMcpPrincipal({ issuer: ISSUER, subject: 'subject-1' }),
    ).resolves.toBeNull();
  });

  it('denies unknown subjects, other issuers, and malformed identities', async () => {
    const { hostedRuntime } = await hosted('unknown');
    for (const identity of [
      { issuer: ISSUER, subject: 'subject-2' },
      { issuer: 'https://id.example.test', subject: 'subject-1' },
      { issuer: 'https://other.example.test/', subject: 'subject-1' },
      { issuer: ISSUER, subject: '' },
      {} as { issuer: string; subject: string },
    ]) {
      await expect(
        hostedRuntime.resolveMcpPrincipal(identity),
      ).resolves.toBeNull();
    }
  });

  it('denies an ambiguous tenant and an inactive user', async () => {
    const { hostedRuntime, local, owner } = await hosted('ambiguous');
    const tenants = await TenantCollection.create({ db: local.db });
    const second = await tenants.create({ name: 'Second', slug: 'second' });
    await second.save();
    const roles = await RoleCollection.create({ db: local.db });
    const role = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
    const memberships = await MembershipCollection.create({ db: local.db });
    const extra = await memberships.create({
      userId: owner.userId,
      tenantId: second.id as string,
      roleId: role?.id as string,
    });
    await extra.save();
    const identity = { issuer: ISSUER, subject: 'subject-1' };
    await expect(hostedRuntime.resolveMcpPrincipal(identity)).resolves.toBe(
      null,
    );
    extra.status = MembershipStatus.SUSPENDED;
    await extra.save();
    await expect(
      hostedRuntime.resolveMcpPrincipal(identity),
    ).resolves.toMatchObject({ tenantId: owner.tenantId });

    const users = await UserCollection.create({ db: local.db });
    const user = await users.get({ id: owner.userId });
    if (!user) throw new Error('user missing');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    await expect(hostedRuntime.resolveMcpPrincipal(identity)).resolves.toBe(
      null,
    );
  });
});
