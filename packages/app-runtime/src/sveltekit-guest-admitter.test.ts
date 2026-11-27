/**
 * The guest admitter's catalog probe and caching (#5196, slice G): every
 * unverified or unexpected catalog answer refuses guests.
 */

import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGuestAdmitter,
  type GuestCatalogPosture,
  probeGuestCatalog,
} from './sveltekit/guest.js';

const TABLES = [{ schemaName: 'public', tableName: 'products' }];

function fakeDb(
  answers: (sql: string, values: unknown[]) => unknown,
): DatabaseInterface {
  return {
    query: vi.fn(async (sql: string, ...values: unknown[]) =>
      answers(sql, values),
    ),
  } as unknown as DatabaseInterface;
}

const healthy = (sql: string): unknown =>
  sql.includes('pg_roles')
    ? { rows: [{ rolsuper: false, rolbypassrls: false }] }
    : {
        rows: [
          { row_security: true, force_row_security: true, policy_count: 2 },
        ],
      };

describe('probeGuestCatalog', () => {
  it('reads role attributes and the table posture, schema-qualified', async () => {
    const db = fakeDb(healthy);
    const result = await probeGuestCatalog(db, TABLES);
    expect(result).toEqual({
      rolePosture: { rolsuper: false, rolbypassrls: false },
      ceilingTables: [
        {
          table: 'public.products',
          rowSecurity: true,
          forceRowSecurity: true,
          policyCount: 2,
        },
      ],
      expectedCeilingTables: ['public.products'],
    });
    const calls = (db.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('current_user');
    expect(calls[1].slice(1)).toEqual(['public', 'products']);
  });

  it.each([
    [
      'no role row',
      (sql: string) => (sql.includes('pg_roles') ? { rows: [] } : healthy(sql)),
    ],
    [
      'role flag not a boolean',
      (sql: string) =>
        sql.includes('pg_roles')
          ? { rows: [{ rolsuper: 'f', rolbypassrls: false }] }
          : healthy(sql),
    ],
    [
      'role flag missing',
      (sql: string) =>
        sql.includes('pg_roles')
          ? { rows: [{ rolsuper: false }] }
          : healthy(sql),
    ],
    [
      'table not found',
      (sql: string) => (sql.includes('pg_roles') ? healthy(sql) : { rows: [] }),
    ],
    [
      'two relations match',
      (sql: string) =>
        sql.includes('pg_roles')
          ? healthy(sql)
          : {
              rows: [
                {
                  row_security: true,
                  force_row_security: true,
                  policy_count: 1,
                },
                {
                  row_security: true,
                  force_row_security: true,
                  policy_count: 1,
                },
              ],
            },
    ],
    [
      'row security flag not a boolean',
      (sql: string) =>
        sql.includes('pg_roles')
          ? healthy(sql)
          : {
              rows: [
                {
                  row_security: 't',
                  force_row_security: true,
                  policy_count: 1,
                },
              ],
            },
    ],
    [
      'policy count missing',
      (sql: string) =>
        sql.includes('pg_roles')
          ? healthy(sql)
          : { rows: [{ row_security: true, force_row_security: true }] },
    ],
  ])('is unverified (null) when %s', async (_name, answers) => {
    expect(await probeGuestCatalog(fakeDb(answers), TABLES)).toBeNull();
  });

  it('propagates a query failure for the admitter to refuse', async () => {
    const db = fakeDb(() => {
      throw new Error('boom');
    });
    await expect(probeGuestCatalog(db, TABLES)).rejects.toThrow('boom');
  });
});

describe('createGuestAdmitter caching', () => {
  beforeEach(() => enableTenancy());
  afterEach(() => {
    disableTenancy();
    vi.useRealTimers();
  });

  const posture: GuestCatalogPosture = {
    rolePosture: { rolsuper: false, rolbypassrls: false },
    ceilingTables: [
      {
        table: 'public.products',
        rowSecurity: true,
        forceRowSecurity: true,
        policyCount: 1,
      },
    ],
    expectedCeilingTables: ['public.products'],
  };

  function admitter(probe: () => Promise<GuestCatalogPosture | null>) {
    return createGuestAdmitter({
      rawConfig: () => ({ collections: ['products'] }),
      postgresRls: () => true,
      defaultSelector: true,
      baseDomain: () => 'base.test',
      baseClassOptions: () => ({}),
      baseDatabase: async () => ({}) as DatabaseInterface,
      ceilingTables: () => TABLES,
      probeCatalog: probe,
      resolver: async () => ({
        resolveGuestPermissions: async () => new Set(['products.read']),
      }),
    });
  }

  it('caches a verified posture for the process', async () => {
    const probe = vi.fn(async () => posture);
    const guests = admitter(probe);
    expect(await guests.admit('t1')).toEqual({
      tenantId: 't1',
      permissions: ['products.read'],
    });
    await guests.admit('t2');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure briefly, then retries', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async (): Promise<GuestCatalogPosture | null> => {
      if (probe.mock.calls.length === 1) throw new Error('catalog down');
      return posture;
    });
    const guests = admitter(probe);
    expect(await guests.admit('t1')).toBeNull();
    expect(await guests.admit('t1')).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11_000);
    expect(await guests.admit('t1')).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not cache an RLS-off verdict: the live gate is read every request', async () => {
    let rls = true;
    const guests = createGuestAdmitter({
      rawConfig: () => ({ collections: ['products'] }),
      postgresRls: () => rls,
      defaultSelector: true,
      baseDomain: () => 'base.test',
      baseClassOptions: () => ({}),
      baseDatabase: async () => ({}) as DatabaseInterface,
      ceilingTables: () => TABLES,
      probeCatalog: async () => posture,
      resolver: async () => ({
        resolveGuestPermissions: async () => new Set(['products.read']),
      }),
    });
    expect(await guests.admit('t1')).not.toBeNull();
    rls = false;
    expect(await guests.admit('t1')).toBeNull();
    expect(guests.mayAdmit('t1')).toBe(false);
  });

  it('no ceiling table means no guests', async () => {
    const guests = createGuestAdmitter({
      rawConfig: () => ({ collections: ['products'] }),
      postgresRls: () => true,
      defaultSelector: true,
      baseDomain: () => 'base.test',
      baseClassOptions: () => ({}),
      baseDatabase: async () => ({}) as DatabaseInterface,
      ceilingTables: () => [],
      probeCatalog: async () => posture,
      resolver: async () => ({
        resolveGuestPermissions: async () => new Set(['products.read']),
      }),
    });
    expect(await guests.admit('t1')).toBeNull();
  });
});
