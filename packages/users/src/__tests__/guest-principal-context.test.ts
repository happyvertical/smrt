/**
 * The guest door of withPrincipalPermissionContext (#5196, slice G).
 *
 * A recorded PostgreSQL-shaped connection proves the settings lifecycle: the
 * guest publishes all six settings transaction-locally with no user, no
 * bypass and no system context, and a signed-in request that follows on the
 * same connection overwrites every one of them. The real-PostgreSQL proof
 * (pooled connection, FORCE RLS, non-superuser role) is the on-demand
 * workflow's guest RLS suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionResolver } from '../services/PermissionResolver.js';
import { withPrincipalPermissionContext } from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';

type Call = { sql: string; value: string };

/** One "pooled connection": every transaction it opens appends to `log`. */
function pooledConnection() {
  const log: Call[][] = [];
  const baseDb = {
    url: 'postgres://base-db',
    query: vi.fn().mockResolvedValue(undefined),
    beginTransaction: vi.fn(async () => {
      const calls: Call[] = [];
      log.push(calls);
      return {
        url: 'postgres://transaction-db',
        commit: vi.fn().mockResolvedValue(undefined),
        isActive: vi.fn().mockReturnValue(true),
        rollback: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(async (sql: string, value: string) => {
          calls.push({ sql, value });
        }),
      };
    }),
  };
  vi.spyOn(SessionService, 'create').mockResolvedValue({
    getDatabase: () => baseDb,
  } as unknown as SessionService);
  return { baseDb, log };
}

const settingNames = [
  'smrt.tenant_id',
  'smrt.user_id',
  'smrt.session_id',
  'smrt.permissions',
  'smrt.super_admin_bypass',
  'smrt.system_context',
];

const pg = { type: 'postgres' as const, url: 'postgres://base-db' };

describe('guest principal door (#5196)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes all six settings transaction-locally with no user, bypass or system context', async () => {
    const { log } = pooledConnection();
    const resolve = vi.spyOn(PermissionResolver, 'create');
    const seen = await withPrincipalPermissionContext(
      {
        db: pg,
        callerKind: 'guest',
        userId: null,
        tenantId: 'tenant-a',
        permissions: ['products.read'],
        postgresRls: true,
        enterTenantContext: false,
      },
      async (context) => context,
    );
    expect(seen).toMatchObject({
      callerKind: 'guest',
      userId: null,
      user: null,
      session: null,
      sessionId: null,
      tenantId: 'tenant-a',
      permissions: ['products.read'],
      postgresRls: true,
      superAdminBypass: false,
      systemContext: false,
    });
    // Never resolved per user.
    expect(resolve).not.toHaveBeenCalled();
    expect(log).toHaveLength(1);
    expect(log[0].map((call) => call.value)).toEqual([
      'tenant-a',
      '',
      '',
      JSON.stringify(['products.read']),
      'false',
      'false',
    ]);
    for (const [index, call] of log[0].entries()) {
      expect(call.sql).toBe(
        `SELECT set_config('${settingNames[index]}', $1, true)`,
      );
    }
  });

  it('a signed-in request on the same connection overwrites every guest setting', async () => {
    const { log } = pooledConnection();
    await withPrincipalPermissionContext(
      {
        db: pg,
        callerKind: 'guest',
        userId: null,
        tenantId: 'tenant-a',
        permissions: ['products.read'],
        postgresRls: true,
      },
      async () => undefined,
    );
    await withPrincipalPermissionContext(
      {
        db: pg,
        userId: 'user-1',
        tenantId: 'tenant-b',
        permissions: ['orders.read'],
        postgresRls: true,
      },
      async () => undefined,
    );
    expect(log).toHaveLength(2);
    // Each request runs in its own transaction and sets all six names, all
    // transaction-local (`true`): nothing the guest set survives its commit.
    for (const calls of log) {
      expect(
        calls.map((call) => call.sql.match(/'(smrt\.[a-z_]+)'/)?.[1]),
      ).toEqual(settingNames);
      expect(calls.every((call) => call.sql.endsWith(', $1, true)'))).toBe(
        true,
      );
    }
    expect(log[1].map((call) => call.value)).toEqual([
      'tenant-b',
      'user-1',
      '',
      JSON.stringify(['orders.read']),
      'false',
      'false',
    ]);
  });

  it('without active row-level security the guest carries no tenant and no permission', async () => {
    // A non-PostgreSQL database never opens the RLS transaction.
    vi.spyOn(SessionService, 'create').mockResolvedValue({
      getDatabase: () => ({ url: 'file:app.db', query: vi.fn() }),
    } as unknown as SessionService);
    const seen = await withPrincipalPermissionContext(
      {
        db: { type: 'sqlite', url: ':memory:' },
        callerKind: 'guest',
        userId: null,
        tenantId: 'tenant-a',
        permissions: ['products.read'],
        postgresRls: true,
      },
      async (context) => context,
    );
    expect(seen.callerKind).toBe('guest');
    expect(seen.postgresRls).toBe(false);
    expect(seen.tenantId).toBeNull();
    expect(seen.permissions).toEqual([]);
    expect(seen.permissionSet.size).toBe(0);
  });

  it('with RLS switched off the guest carries nothing either', async () => {
    const { log } = pooledConnection();
    const seen = await withPrincipalPermissionContext(
      {
        db: pg,
        callerKind: 'guest',
        userId: null,
        tenantId: 'tenant-a',
        permissions: ['products.read'],
        postgresRls: false,
      },
      async (context) => context,
    );
    expect(seen.tenantId).toBeNull();
    expect(seen.permissions).toEqual([]);
    expect(log).toHaveLength(0);
  });

  it.each([
    ['a user id', { userId: 'user-1' }],
    ['no tenant', { tenantId: '' }],
    ['a non-list permission set', { permissions: 'products.read' }],
    ['a non-string slug', { permissions: [1] }],
    ['an unknown caller kind', { callerKind: 'robot' }],
  ])('refuses a malformed guest: %s', async (_name, override) => {
    pooledConnection();
    await expect(
      withPrincipalPermissionContext(
        {
          db: pg,
          callerKind: 'guest',
          userId: null,
          tenantId: 'tenant-a',
          permissions: ['products.read'],
          postgresRls: true,
          ...override,
        } as never,
        async () => undefined,
      ),
    ).rejects.toThrow();
  });
});
