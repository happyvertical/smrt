/**
 * Owner-minted local MCP tokens (#3413): issuance, HMAC-only storage, live
 * permission capping, expiry, revocation, the operator store used by
 * `smrt app token`, and the runtime's membership-backed hosted resolver.
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

async function expectDatabaseIntegrity(...databases: DatabaseInterface[]) {
  for (const db of databases) {
    expect((await db.query('PRAGMA integrity_check')).rows).toEqual([
      { integrity_check: 'ok' },
    ]);
  }
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
        holder: null,
        renewable: true,
        createdAt: issued.createdAt,
        expiresAt: issued.expiresAt,
        lastUsedAt: null,
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

  it('deep-snapshots every array and object field before resolution awaits', async () => {
    const { runtime, owner } = await ownedRuntime('deep-snapshot');
    const principal = {
      id: owner.userId,
      tenantId: owner.tenantId,
      kind: 'human',
      scopes: [READ],
      roles: ['viewer'],
      allowCrossTenant: false,
      // An application-defined extra field (kept as a frozen deep copy).
      meta: { flags: ['a'], nested: { level: 'basic' } },
    };
    const pending = runtime.runAsPrincipal(principal, async (bound) => {
      const deepFrozen = (value: unknown): boolean =>
        value === null ||
        typeof value !== 'object' ||
        (Object.isFrozen(value) &&
          Object.values(value as object).every(deepFrozen));
      return { bound, deepFrozen: deepFrozen(bound) };
    });
    // Membership resolution is awaiting: mutate every array/object field.
    principal.scopes.push(EXPORT);
    principal.roles.push('owner');
    principal.allowCrossTenant = true;
    principal.meta.flags.push('admin');
    principal.meta.nested.level = 'admin';
    principal.meta = { flags: ['replaced'], nested: { level: 'replaced' } };
    const { bound, deepFrozen } = await pending;
    expect(bound).toMatchObject({
      id: owner.userId,
      tenantId: owner.tenantId,
      scopes: [READ],
      roles: ['viewer'],
      allowCrossTenant: false,
      meta: { flags: ['a'], nested: { level: 'basic' } },
    });
    expect(deepFrozen).toBe(true);
  });

  it('rejects principals carrying non-data fields', async () => {
    const { runtime, owner } = await ownedRuntime('non-data');
    for (const extra of [
      { callback: () => 'x' },
      { when: new Date() },
      { roles: ['ok', 1] },
      { kind: 1 },
      { allowCrossTenant: 'yes' },
    ]) {
      await expect(
        runtime.runAsPrincipal(
          { id: owner.userId, tenantId: owner.tenantId, ...extra } as never,
          async () => 'ran',
        ),
      ).rejects.toThrow('bound principal');
    }
  });

  it('rejects prototype-pollution and inherited authority in a bound principal', async () => {
    const { runtime, owner } = await ownedRuntime('proto-poison');
    const ownerJson = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ id: owner.userId, tenantId: owner.tenantId, ...extra });
    const victim = {
      id: owner.userId,
      tenantId: owner.tenantId,
      scopes: [READ],
      roles: ['owner'],
      kind: 'human',
      tenantBinding: 'direct-or-inherited',
      allowCrossTenant: true,
    };
    const poisoned: unknown[] = [
      // Every authority field supplied only through a JSON `__proto__` key.
      ...Object.entries(victim).map(([field, value]) =>
        JSON.parse(
          `{"__proto__":${JSON.stringify({ [field]: value })}${
            field === 'id' || field === 'tenantId'
              ? ''
              : `,${ownerJson().slice(1, -1)}`
          }}`,
        ),
      ),
      JSON.parse(`{"__proto__":${JSON.stringify(victim)}}`),
      // Authority only on the prototype chain.
      Object.create({ id: owner.userId, tenantId: owner.tenantId }),
      // Nested poison keys, at any depth.
      JSON.parse(ownerJson({ meta: JSON.parse('{"__proto__":{"a":1}}') })),
      JSON.parse(
        `{"id":"${owner.userId}","tenantId":"${owner.tenantId}","meta":{"deep":{"__proto__":{"a":1}}}}`,
      ),
      JSON.parse(ownerJson({ constructor: 'x' })),
      JSON.parse(ownerJson({ meta: { prototype: { a: 1 } } })),
      JSON.parse(ownerJson({ roles: [{ constructor: 1 }] })),
      // Accessors are never invoked or trusted.
      Object.defineProperty({ tenantId: owner.tenantId }, 'id', {
        enumerable: true,
        get: () => owner.userId,
      }),
      // Arrays must be dense, plain data.
      { ...JSON.parse(ownerJson()), scopes: Object.assign([READ], { x: 1 }) },
      // biome-ignore lint/suspicious/noSparseArray: a sparse array is the case under test.
      { ...JSON.parse(ownerJson()), scopes: [READ, , READ] },
    ];
    for (const principal of poisoned) {
      await expect(
        runtime.runAsPrincipal(principal as never, async () => 'ran'),
        JSON.stringify(principal),
      ).rejects.toThrow(/bound principal/u);
    }
    // A polluted Object.prototype never supplies a missing bound field.
    const bound = await runtime.runAsPrincipal(
      { id: owner.userId, tenantId: owner.tenantId, scopes: [READ] },
      async (value) => value,
    );
    expect(Object.getPrototypeOf(bound)).toBeNull();
    expect('allowCrossTenant' in bound).toBe(false);
    // A null-prototype plain object with own data is accepted.
    const own = Object.assign(Object.create(null), {
      id: owner.userId,
      tenantId: owner.tenantId,
      scopes: [READ],
    });
    await expect(
      runtime.runAsPrincipal(own, async (bound) => bound.scopes),
    ).resolves.toEqual([READ]);
  });

  it('reads token issue input from own data only', async () => {
    const { local } = await ownedRuntime('proto-issue');
    for (const input of [
      JSON.parse(`{"__proto__":{"scopes":["${READ}"]}}`),
      Object.create({ scopes: [READ] }),
    ]) {
      await expect(local.mcpTokens?.issue(input)).rejects.toMatchObject({
        code: 'invalid_configuration',
      });
    }
    await expect(
      local.mcpTokens?.issue(
        JSON.parse(`{"scopes":["${READ}"],"__proto__":{"expiresInSeconds":1}}`),
      ),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
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
    openApplicationDatabases.add(appMemberships.db);
    expect(appMemberships.db).not.toBe(local.db);
    const users = await UserCollection.create(runtime.classOptions('User'));
    const permissions = await PermissionCollection.create(
      runtime.classOptions('Permission'),
    );
    expect(users.db).toBe(appMemberships.db);
    expect(permissions.db).toBe(appMemberships.db);
    await expectDatabaseIntegrity(local.db, appMemberships.db);
    const directRow = await withSystemContext(() =>
      appMemberships.get({ id: childMembershipId }),
    );
    if (!directRow) throw new Error('direct membership missing');
    // A failed write on the separately acquired application handle rolls back
    // without changing what the original runtime handle authorizes.
    const transaction = appMemberships.db.transaction?.bind(appMemberships.db);
    if (!transaction) throw new Error('SQLite transaction support missing');
    await expect(
      transaction(async (tx) => {
        await tx.delete(directRow.tableName, { id: childMembershipId });
        throw new Error('rollback membership deletion');
      }),
    ).rejects.toThrow('rollback membership deletion');
    await expectDatabaseIntegrity(local.db, appMemberships.db);
    expect(await runtime.verifyLocalMcpToken(issued.token)).toMatchObject({
      tenantId: childTenantId,
      scopes: [READ],
    });
    await withSystemContext(() => directRow.delete());
    await expectDatabaseIntegrity(local.db, appMemberships.db);
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
    openApplicationDatabases.add(memberships.db);
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

describe('self-renewing local MCP tokens (#4874)', () => {
  const HOUR = 60 * 60 * 1000;
  const WINDOW = 30 * 24 * HOUR;
  const T0 = '2026-10-03T12:00:00.000Z';

  async function storeFor(label: string) {
    const clock = { now: new Date(T0) };
    const fixture = await ownedRuntime(label, clock);
    const store = fixture.local.mcpTokens;
    if (!store) throw new Error('token store missing');
    const advance = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    const expiryOf = async (id: string) =>
      (await tokenRows(fixture.local.db)).find((row) => row.id === id)
        ?.expires_at;
    return { ...fixture, store, clock, advance, expiryOf };
  }

  it('rotates a holder atomically: one active token, scopes kept per issue', async () => {
    const { runtime, local, store } = await storeFor('rotate');
    const other = await store.issue({ scopes: [READ] });
    const first = await store.issue({
      scopes: [READ, EXPORT],
      holder: 'laptop',
    });
    const second = await store.issue({ scopes: [READ], holder: 'laptop' });
    expect(second.holder).toBe('laptop');
    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(await runtime.verifyLocalMcpToken(first.token)).toBeNull();
    expect(await runtime.verifyLocalMcpToken(second.token)).toMatchObject({
      scopes: [READ],
    });
    // A token with no holder is unaffected, and so is another holder.
    expect(await runtime.verifyLocalMcpToken(other.token)).not.toBeNull();
    const phone = await store.issue({ scopes: [READ], holder: 'phone' });
    expect(await runtime.verifyLocalMcpToken(phone.token)).not.toBeNull();
    expect(await runtime.verifyLocalMcpToken(second.token)).not.toBeNull();
    const listed = await store.list();
    const active = listed.filter(
      (record) => record.status === 'active' && record.holder === 'laptop',
    );
    expect(active.map((record) => record.id)).toEqual([second.id]);
    expect(listed.find((record) => record.id === first.id)?.status).toBe(
      'revoked',
    );
    expect(JSON.stringify(await tokenRows(local.db))).not.toContain(
      second.token,
    );
  });

  it('rotates over an expired holder token and never leaves two valid', async () => {
    const { runtime, store, advance } = await storeFor('rotate-expired');
    const first = await store.issue({
      scopes: [READ],
      holder: 'tv',
      expiresInSeconds: 60,
    });
    advance(5 * 60 * 1000);
    const second = await store.issue({ scopes: [READ], holder: 'tv' });
    expect(await runtime.verifyLocalMcpToken(first.token)).toBeNull();
    expect(await runtime.verifyLocalMcpToken(second.token)).not.toBeNull();
  });

  it('keeps the previous token valid when a rotation fails midway', async () => {
    const { runtime, local, store } = await storeFor('rotate-fail');
    const first = await store.issue({ scopes: [READ], holder: 'laptop' });
    await local.db.query(
      `CREATE TRIGGER fail_rotation BEFORE INSERT ON ${LOCAL_MCP_TOKEN_TABLE}
       WHEN NEW.label = 'boom'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    await expect(
      store.issue({ scopes: [READ], holder: 'laptop', label: 'boom' }),
    ).rejects.toThrow();
    expect(await runtime.verifyLocalMcpToken(first.token)).not.toBeNull();
    expect((await store.list())[0]).toMatchObject({
      id: first.id,
      status: 'active',
      revokedAt: null,
    });
    expect(await tokenRows(local.db)).toHaveLength(1);
  });

  it('enforces one unrevoked token per holder in the database', async () => {
    const { local, store } = await storeFor('holder-index');
    const issued = await store.issue({ scopes: [READ], holder: 'laptop' });
    await expect(
      local.db.query(
        `INSERT INTO ${LOCAL_MCP_TOKEN_TABLE}
         (id, token_hash, user_id, tenant_id, scopes, created_at, expires_at, holder)
         VALUES (?, 'x', 'u', 't', '[]', 'c', 'e', 'laptop')`,
        randomUUID(),
      ),
    ).rejects.toThrow();
    await store.revoke(issued.id);
    await local.db.query(
      `INSERT INTO ${LOCAL_MCP_TOKEN_TABLE}
       (id, token_hash, user_id, tenant_id, scopes, created_at, expires_at, holder)
       VALUES (?, 'y', 'u', 't', '[]', 'c', 'e', 'laptop')`,
      randomUUID(),
    );
  });

  it('validates the holder like a label', async () => {
    const { local, store } = await storeFor('holder-invalid');
    for (const holder of ['', '   ', 'x'.repeat(81), 'bad\nholder', 5]) {
      await expect(
        store.issue({ scopes: [READ], holder: holder as string }),
      ).rejects.toMatchObject({ code: 'invalid_configuration' });
    }
    await expect(store.revokeHolder('')).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    expect(await tokenRows(local.db)).toEqual([]);
    const ok = await store.issue({ scopes: [READ], holder: '  tablet  ' });
    expect(ok.holder).toBe('tablet');
  });

  it('slides a renewable token on use, writing at most once an hour', async () => {
    const { runtime, store, advance, expiryOf } = await storeFor('slide');
    const issued = await store.issue({ scopes: [READ] });
    expect(issued.renewable).toBe(true);
    expect(await expiryOf(issued.id)).toBe(
      new Date(Date.parse(T0) + WINDOW).toISOString(),
    );
    // First use records the slide (never used before).
    advance(10 * 60 * 1000);
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    const firstSlide = new Date(
      Date.parse(T0) + 10 * 60 * 1000 + WINDOW,
    ).toISOString();
    expect(await expiryOf(issued.id)).toBe(firstSlide);
    expect((await store.list())[0]).toMatchObject({
      renewable: true,
      lastUsedAt: '2026-10-03T12:10:00.000Z',
    });
    // Within the hour: verify succeeds without writing.
    advance(59 * 60 * 1000);
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    expect(await expiryOf(issued.id)).toBe(firstSlide);
    // At the hour: slides again, to exactly now + window.
    advance(60 * 1000);
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    expect(await expiryOf(issued.id)).toBe(
      new Date(Date.parse(T0) + 70 * 60 * 1000 + WINDOW).toISOString(),
    );
  });

  it('keeps a token alive across windows while used, and lapses it after a full unused window', async () => {
    const { runtime, store, advance } = await storeFor('lapse');
    const issued = await store.issue({ scopes: [READ], holder: 'laptop' });
    for (let day = 0; day < 4; day += 1) {
      advance(20 * 24 * HOUR);
      expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    }
    // 80 days after issue, past the original 30-day expiry, still active.
    expect((await store.list())[0].status).toBe('active');
    advance(WINDOW - 1000);
    expect((await store.list())[0].status).toBe('active');
    advance(1000);
    expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
    expect((await store.list())[0].status).toBe('expired');
  });

  it('never revives an expired token by sliding, nor slides a revoked one', async () => {
    const { runtime, local, store, advance, expiryOf } =
      await storeFor('no-revive');
    const issued = await store.issue({ scopes: [READ] });
    const before = await expiryOf(issued.id);
    advance(WINDOW + 1000);
    expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
    expect(await expiryOf(issued.id)).toBe(before);
    expect((await tokenRows(local.db))[0].last_used_at).toBeNull();

    const revoked = await store.issue({ scopes: [READ] });
    const revokedBefore = await expiryOf(revoked.id);
    await store.revoke(revoked.id);
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(revoked.token)).toBeNull();
    expect(await expiryOf(revoked.id)).toBe(revokedBefore);
  });

  it('never shortens an expiry and does not slide when the owner is inactive', async () => {
    const { runtime, local, owner, store, advance, expiryOf } =
      await storeFor('no-shorten');
    const issued = await store.issue({ scopes: [READ] });
    // Push the stored expiry beyond now + window; a slide must not pull it in.
    const far = new Date(Date.parse(T0) + 2 * WINDOW).toISOString();
    await local.db.query(
      `UPDATE ${LOCAL_MCP_TOKEN_TABLE} SET expires_at = ? WHERE id = ?`,
      far,
      issued.id,
    );
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    expect(await expiryOf(issued.id)).toBe(far);

    const second = await store.issue({ scopes: [READ] });
    const users = await UserCollection.create({ db: local.db });
    const user = await users.get({ id: owner.userId });
    if (!user) throw new Error('user missing');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    const slidBefore = await expiryOf(second.id);
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(second.token)).toBeNull();
    expect(await expiryOf(second.id)).toBe(slidBefore);
  });

  it('never slides a desktop slot credential (#4874)', async () => {
    const { runtime, local, owner, store, advance, expiryOf } =
      await storeFor('desktop-fixed');
    const put = await store.manageDesktopCredential?.(
      {
        userId: owner.userId,
        tenantId: owner.tenantId,
        permissions: [READ],
      },
      {
        id: randomUUID(),
        action: 'put',
        scopes: [READ],
        expiresInSeconds: 24 * 60 * 60,
      },
    );
    if (!put || put === 'slot_unavailable') throw new Error('slot not minted');
    expect(put.renewable).toBe(false);
    const expiry = await expiryOf(put.id);
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(put.token)).not.toBeNull();
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(put.token)).not.toBeNull();
    expect(await expiryOf(put.id)).toBe(expiry);
    expect(
      (await tokenRows(local.db)).find((row) => row.id === put.id)
        ?.last_used_at,
    ).toBeNull();
  });

  describe('the slide write re-checks the row itself (#4874)', () => {
    /**
     * Run `interfere` after verify has read and accepted the row but before
     * the slide UPDATE reaches the database.
     */
    async function raceSlide(
      label: string,
      interfere: (
        local: Awaited<ReturnType<typeof storeFor>>['local'],
        id: string,
        clock: Date,
      ) => Promise<void>,
    ) {
      const fixture = await storeFor(label);
      const { runtime, local, store, advance, clock, expiryOf } = fixture;
      const issued = await store.issue({ scopes: [READ] });
      advance(2 * HOUR);
      const original = local.db.query.bind(local.db);
      let raced = false;
      const spy = vi
        .spyOn(local.db, 'query')
        .mockImplementation(async (sql: string, ...params: unknown[]) => {
          if (!raced && /SET expires_at = \?, last_used_at/u.test(sql)) {
            raced = true;
            await interfere(local, issued.id, clock.now);
          }
          return original(sql, ...params);
        });
      try {
        await runtime.verifyLocalMcpToken(issued.token);
      } finally {
        spy.mockRestore();
      }
      expect(raced).toBe(true);
      const row = (await tokenRows(local.db)).find(
        (entry) => entry.id === issued.id,
      );
      return { fixture, issued, row, expiryOf };
    }

    it('does not slide a token revoked after verify read it', async () => {
      const expected = new Date(Date.parse(T0) + WINDOW).toISOString();
      const { fixture, issued, row } = await raceSlide(
        'race-revoked',
        async (local, id, at) => {
          await local.db.query(
            `UPDATE ${LOCAL_MCP_TOKEN_TABLE} SET revoked_at = ? WHERE id = ?`,
            at.toISOString(),
            id,
          );
        },
      );
      expect(row?.expires_at).toBe(expected);
      expect(row?.last_used_at).toBeNull();
      expect(
        await fixture.runtime.verifyLocalMcpToken(issued.token),
      ).toBeNull();
    });

    it('does not revive a token that expired after verify read it', async () => {
      let lapsed = '';
      const { fixture, issued, row } = await raceSlide(
        'race-expired',
        async (local, id, at) => {
          lapsed = new Date(at.getTime() - 1000).toISOString();
          await local.db.query(
            `UPDATE ${LOCAL_MCP_TOKEN_TABLE} SET expires_at = ? WHERE id = ?`,
            lapsed,
            id,
          );
        },
      );
      expect(row?.expires_at).toBe(lapsed);
      expect(row?.last_used_at).toBeNull();
      expect(
        await fixture.runtime.verifyLocalMcpToken(issued.token),
      ).toBeNull();
    });
  });

  it('never slides a fixed-lifetime token', async () => {
    const { runtime, store, advance, expiryOf } = await storeFor('fixed');
    const issued = await store.issue({
      scopes: [READ],
      expiresInSeconds: 24 * 60 * 60,
    });
    expect(issued.renewable).toBe(false);
    const expiry = await expiryOf(issued.id);
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(issued.token)).not.toBeNull();
    expect(await expiryOf(issued.id)).toBe(expiry);
    expect((await store.list())[0]).toMatchObject({
      renewable: false,
      lastUsedAt: null,
    });
    advance(24 * HOUR);
    expect(await runtime.verifyLocalMcpToken(issued.token)).toBeNull();
    await expect(
      store.issue({ scopes: [READ], expiresInSeconds: 59 }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
  });

  it('revokes a holder idempotently without touching other tokens', async () => {
    const { runtime, store } = await storeFor('revoke-holder');
    const mine = await store.issue({ scopes: [READ], holder: 'laptop' });
    const kept = await store.issue({ scopes: [READ], holder: 'phone' });
    const anonymous = await store.issue({ scopes: [READ] });
    expect(await store.revokeHolder('laptop')).toBe('revoked');
    expect(await store.revokeHolder('laptop')).toBe('none');
    expect(await store.revokeHolder('never-seen')).toBe('none');
    expect(await runtime.verifyLocalMcpToken(mine.token)).toBeNull();
    expect(await runtime.verifyLocalMcpToken(kept.token)).not.toBeNull();
    expect(await runtime.verifyLocalMcpToken(anonymous.token)).not.toBeNull();
    // The holder can be issued a fresh token afterwards.
    const again = await store.issue({ scopes: [READ], holder: 'laptop' });
    expect(await runtime.verifyLocalMcpToken(again.token)).not.toBeNull();
  });

  it('upgrades an old-schema table in place and treats old rows as fixed with no holder', async () => {
    const { runtime, local, store, advance, expiryOf } =
      await storeFor('upgrade');
    const old = await store.issue({ scopes: [READ] });
    const [row] = await tokenRows(local.db);
    // Rebuild the table as releases before #4874 shaped it, keeping the row.
    await local.db.query(`DROP TABLE ${LOCAL_MCP_TOKEN_TABLE}`);
    await local.db.query(
      `CREATE TABLE ${LOCAL_MCP_TOKEN_TABLE} (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        label TEXT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT NULL
      )`,
    );
    await local.db.query(
      `INSERT INTO ${LOCAL_MCP_TOKEN_TABLE}
       (id, token_hash, user_id, tenant_id, scopes, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      row.id,
      row.token_hash,
      row.user_id,
      row.tenant_id,
      row.scopes,
      row.created_at,
      row.expires_at,
    );
    // Startup runs this; running it again must change nothing.
    await ensureLocalMcpTokenTable(local.db);
    await ensureLocalMcpTokenTable(local.db);
    const columns = (
      (await local.db.query(`PRAGMA table_info(${LOCAL_MCP_TOKEN_TABLE})`))
        .rows as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining(['holder', 'sliding', 'last_used_at']),
    );
    const expiry = await expiryOf(old.id);
    advance(2 * HOUR);
    expect(await runtime.verifyLocalMcpToken(old.token)).not.toBeNull();
    expect(await expiryOf(old.id)).toBe(expiry); // legacy rows never slide
    expect((await store.list())[0]).toMatchObject({
      id: old.id,
      holder: null,
      renewable: false,
      lastUsedAt: null,
      status: 'active',
    });
    const rotated = await store.issue({ scopes: [READ], holder: 'laptop' });
    expect(await runtime.verifyLocalMcpToken(rotated.token)).not.toBeNull();
    expect(await runtime.verifyLocalMcpToken(old.token)).not.toBeNull();
  });

  it('does not verify a token under a different installation secret', async () => {
    const { local, owner, store, clock } = await storeFor('other-seed');
    const issued = await store.issue({ scopes: [READ], holder: 'laptop' });
    const reseeded = createLocalMcpTokenStore({
      db: local.db,
      now: () => clock.now,
      readSecret: async () => 'a-different-installation-seed',
      findOwner: async () => owner,
      fail: (code, message) => new LocalRuntimeError(code, message),
    });
    expect(await reseeded.verify(issued.token)).toBeNull();
    expect(await store.verify(issued.token)).not.toBeNull();
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

function desktopRequest(runtime: SmrtSvelteKitRuntime, sessionId: string) {
  const handle = createLocalMcpCredentialHandler(runtime);
  return (
    body: unknown,
    options: {
      url?: string;
      host?: string;
      origin?: string | null;
      peer?: string;
      fetchSite?: string;
      method?: string;
      mediaType?: string;
      raw?: string;
      cookie?: string;
    } = {},
  ) => {
    const url = new URL(
      options.url ?? 'http://127.0.0.1:4678/api/local/mcp-credentials',
    );
    const request = new Request(url, {
      method: options.method ?? 'POST',
      headers: {
        host: options.host ?? url.host,
        'content-type': options.mediaType ?? 'application/json',
        ...(options.origin === null
          ? {}
          : { origin: options.origin ?? url.origin }),
        ...(options.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}),
      },
      ...(options.method === 'GET'
        ? {}
        : { body: options.raw ?? JSON.stringify(body) }),
    });
    return handle({
      request,
      url,
      getClientAddress: () => options.peer ?? '::ffff:127.0.0.1',
      cookies: { get: () => options.cookie ?? sessionId } as Parameters<
        typeof handle
      >[0]['cookies'],
    });
  };
}

describe('desktop local MCP credential handler', () => {
  it('mints, rotates, expires and revokes a private owner slot without colliding with operator tokens', async () => {
    const clock = { now: new Date() };
    const { runtime, local, owner } = await ownedRuntime(
      'desktop-lifecycle',
      clock,
    );
    const store = local.mcpTokens;
    if (!store) throw new Error('token store missing');
    const manual = await store.issue({ scopes: [EXPORT] });
    const desktop = desktopRequest(runtime, owner.sessionId);
    // Even knowing the manual id cannot make its UUIDv4 row a desktop slot.
    const put = {
      action: 'put',
      id: manual.id,
      scopes: [READ],
      expiresInSeconds: 60,
    };
    const response = await desktop(put);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const first = await response.json();
    expect(first).toEqual({
      id: manual.id,
      token: expect.stringMatching(/^smrt_mcp_[A-Za-z0-9_-]{43}$/),
      scopes: [READ],
      expiresAt: new Date(clock.now.getTime() + 60_000).toISOString(),
    });
    expect(await runtime.verifyLocalMcpToken(first.token)).toMatchObject({
      id: owner.userId,
      tenantId: owner.tenantId,
      scopes: [READ],
    });
    const rotated = await (await desktop({ ...put, scopes: [EXPORT] })).json();
    expect(rotated.token).not.toBe(first.token);
    expect(await runtime.verifyLocalMcpToken(first.token)).toBeNull();
    expect(await runtime.verifyLocalMcpToken(rotated.token)).toMatchObject({
      scopes: [EXPORT],
    });
    const persisted = JSON.stringify(await tokenRows(local.db));
    expect(persisted).not.toContain(rotated.token);
    expect(await store.list()).toHaveLength(2);
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect(await runtime.verifyLocalMcpToken(rotated.token)).toBeNull();

    for (let retry = 0; retry < 2; retry += 1) {
      const response = await desktop({ action: 'revoke', id: put.id });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'revoked' });
    }
    expect((await desktop(put)).status).toBe(409);
    expect(await runtime.verifyLocalMcpToken(manual.token)).not.toBeNull();
    expect(await store.list()).toHaveLength(2);
  });

  it('denies hostile peers, origins, hosts, and callers and refuses malformed or excessive scopes and expiry', async () => {
    const { runtime, owner, local, revokePermission } =
      await ownedRuntime('desktop-trust');
    const desktop = desktopRequest(runtime, owner.sessionId);
    const put = {
      action: 'put',
      id: randomUUID(),
      scopes: [READ],
      expiresInSeconds: 60,
    };
    const users = await UserCollection.create({ db: local.db });
    const nonOwner = await users.create({
      email: 'visitor@example.test',
      status: UserStatus.ACTIVE,
    });
    const roles = await RoleCollection.create({ db: local.db });
    const viewer = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.VIEWER);
    const memberships = await MembershipCollection.create({ db: local.db });
    await memberships.create({
      tenantId: owner.tenantId,
      userId: nonOwner.id as string,
      roleId: viewer?.id as string,
      status: MembershipStatus.ACTIVE,
    });
    const sessions = await SessionCollection.create({ db: local.db });
    const visitorSession = await sessions.createSession({
      tenantId: owner.tenantId,
      userId: nonOwner.id as string,
      authMethod: 'password',
    });
    const tenants = await TenantCollection.create({ db: local.db });
    const anotherTenant = await tenants.create({
      name: 'Other',
      slug: 'other',
    });
    const wrongTenantSession = await sessions.createSession({
      tenantId: anotherTenant.id as string,
      userId: owner.userId,
      authMethod: 'password',
    });
    const cappedSession = await sessions.createSession({
      tenantId: owner.tenantId,
      userId: owner.userId,
      authMethod: 'password',
      data: { permissionCeiling: [EXPORT] },
    });
    const deviceSession = await sessions.createSession({
      tenantId: owner.tenantId,
      userId: owner.userId,
      authMethod: 'pin',
    });
    for (const options of [
      { peer: '192.0.2.1' },
      { url: 'https://attacker.example/api/local/mcp-credentials' },
      { host: 'attacker.example' },
      { origin: null },
      { origin: 'null' },
      { origin: 'http://127.0.0.1:4679' },
      { origin: 'http://localhost:4678' },
      { fetchSite: 'cross-site' },
      { cookie: '' },
      { cookie: 'forged-session' },
      { cookie: visitorSession.id as string },
      { cookie: wrongTenantSession.id as string },
      { cookie: deviceSession.id as string },
      { cookie: cappedSession.id as string },
    ]) {
      const response = await desktop(put, options);
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ code: 'forbidden' });
    }
    for (const input of [
      { ...put, id: 'bad-id' },
      { ...put, action: 'unknown' },
      { ...put, scopes: [] },
      { ...put, scopes: ['missing.scope'] },
      { ...put, scopes: [{ unexpected: 'object' }] },
      { ...put, expiresInSeconds: undefined },
      { ...put, expiresInSeconds: 59 },
      { ...put, expiresInSeconds: 365 * 86400 + 1 },
      { ...put, tenantId: owner.tenantId },
    ]) {
      expect((await desktop(input)).status).toBe(400);
    }
    expect((await desktop(put, { method: 'GET' })).status).toBe(405);
    expect((await desktop(put, { mediaType: 'text/plain' })).status).toBe(415);
    expect((await desktop(put, { raw: '{broken' })).status).toBe(400);
    expect((await desktop(put, { raw: ' '.repeat(13 * 1024) })).status).toBe(
      400,
    );
    expect(
      (
        await desktop(
          { action: 'revoke', id: put.id },
          { cookie: cappedSession.id as string },
        )
      ).status,
    ).toBe(403);
    expect(await tokenRows(local.db)).toEqual([]);

    const issued = await (await desktop(put)).json();
    expect(
      (await desktop(put, { cookie: cappedSession.id as string })).status,
    ).toBe(403);
    expect(await runtime.verifyLocalMcpToken(issued.token)).toMatchObject({
      scopes: [READ],
    });
    await revokePermission(READ);
    expect((await desktop(put)).status).toBe(400);
    expect(await runtime.verifyLocalMcpToken(issued.token)).toMatchObject({
      scopes: [],
    });

    const ownerRole = await roles.findSystemRoleBySlug(
      DEFAULT_ROLE_SLUGS.OWNER,
    );
    const otherMembership = await memberships.findByUserAndTenant(
      nonOwner.id as string,
      owner.tenantId,
    );
    if (!otherMembership || !ownerRole?.id)
      throw new Error('Missing owner fixture');
    otherMembership.roleId = ownerRole.id;
    await otherMembership.save();
    expect((await desktop({ ...put, scopes: [EXPORT] })).status).toBe(403);
    expect(await tokenRows(local.db)).toHaveLength(1);
  });

  it('preserves the previous credential on failed rotation and converges after lost or concurrent responses', async () => {
    const { runtime, owner, local } = await ownedRuntime('desktop-retry');
    const desktop = desktopRequest(runtime, owner.sessionId);
    const put = {
      action: 'put',
      id: randomUUID(),
      scopes: [READ],
      expiresInSeconds: 60,
    };
    const initial = await (await desktop(put)).json();
    const secret = initial.token;
    const driverSentinel = `smrt_mcp_${'S'.repeat(43)}`;
    // The driver exception includes sensitive text that must not escape the route.
    await local.db.query(`CREATE TEMP TRIGGER fail_desktop_rotation BEFORE UPDATE ON ${LOCAL_MCP_TOKEN_TABLE} BEGIN
      SELECT RAISE(ABORT, '${driverSentinel}'); END`);
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    try {
      const failure = await desktop(put);
      expect(failure.status).toBe(500);
      expect(await failure.json()).toEqual({
        code: 'credential_operation_failed',
      });
      const output = JSON.stringify([
        ...log.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
      ]);
      expect(output).not.toContain(driverSentinel);
      expect(output).not.toContain(secret);
      expect(process.argv.join(' ')).not.toContain(secret);
      expect(await runtime.verifyLocalMcpToken(secret)).not.toBeNull();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      await local.db.query('DROP TRIGGER fail_desktop_rotation');
    }
    // A response can be lost after commit. One more PUT replaces it in the
    // same slot, and concurrent writers still leave only one valid token.
    expect((await desktop(put)).status).toBe(200);
    const writes = await Promise.all([desktop(put), desktop(put)]);
    expect(writes.map((response) => response.status)).toEqual([200, 200]);
    const replies = await Promise.all(
      writes.map((response) => response.json()),
    );
    const principals = await Promise.all(
      replies.map((reply) => runtime.verifyLocalMcpToken(reply.token)),
    );
    expect(principals.filter(Boolean)).toHaveLength(1);
    expect(await runtime.verifyLocalMcpToken(secret)).toBeNull();
    expect(await tokenRows(local.db)).toHaveLength(1);
    const revoked = await Promise.all([
      desktop(put),
      desktop({ action: 'revoke', id: put.id }),
    ]);
    expect([200, 409]).toContain(revoked[0].status);
    expect(revoked[1].status).toBe(200);
    if (revoked[0].ok) {
      expect(
        await runtime.verifyLocalMcpToken((await revoked[0].json()).token),
      ).toBeNull();
    }
    expect((await desktop(put)).status).toBe(409);
    const unused = { ...put, id: randomUUID() };
    expect((await desktop({ action: 'revoke', id: unused.id })).status).toBe(
      200,
    );
    expect((await desktop(unused)).status).toBe(409);
    await expectDatabaseIntegrity(local.db);
  });
});
