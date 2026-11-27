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
    : sql.includes('guest_insert_policy')
      ? {
          rows: [
            {
              row_security: true,
              force_row_security: true,
              guest_insert_policy: true,
            },
          ],
        }
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
      auditTable: {
        table: 'public.audit_logs',
        rowSecurity: true,
        forceRowSecurity: true,
        guestInsertPolicy: true,
      },
    });
    const calls = (db.query as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('current_user');
    expect(calls[1].slice(1)).toEqual(['public', 'products']);
    // The audit probe names the shared policy, never a literal of its own.
    expect(calls[2].slice(1, 3)).toEqual(['public', 'audit_logs']);
    expect(calls[2][3]).toMatch(/^smrt_audit_logs_guest_insert_/);
    expect(calls[2][0]).toContain("polcmd = 'a'");
  });

  it('leaves the audit posture unverified when the table is absent or loose', async () => {
    const noTable = (sql: string) =>
      sql.includes('guest_insert_policy') ? { rows: [] } : healthy(sql);
    expect(
      (await probeGuestCatalog(fakeDb(noTable), TABLES))?.auditTable,
    ).toBeNull();
    const loose = (sql: string) =>
      sql.includes('guest_insert_policy')
        ? { rows: [{ row_security: true, force_row_security: true }] }
        : healthy(sql);
    expect(
      (await probeGuestCatalog(fakeDb(loose), TABLES))?.auditTable,
    ).toBeNull();
    expect(
      (await probeGuestCatalog(fakeDb(healthy), TABLES, { audit: false }))
        ?.auditTable,
    ).toBeNull();
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
    auditTable: {
      table: 'public.audit_logs',
      rowSecurity: true,
      forceRowSecurity: true,
      guestInsertPolicy: true,
    },
  };

  const createConfig = {
    collections: ['products', 'messages'],
    createCollections: ['messages'],
    createFields: { messages: { allowedFields: ['name'] } },
  };

  function admitter(
    probe: () => Promise<GuestCatalogPosture | null>,
    rawConfig: unknown = { collections: ['products'] },
  ) {
    return createGuestAdmitter({
      rawConfig: () => rawConfig,
      auditWriter: () => async () => undefined,
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
    expect(await guests.admit('t1')).toMatchObject({
      tenantId: 't1',
      permissions: ['products.read'],
    });
    await guests.admit('t2');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('shares ONE guest runtime (and its limiters) across admissions', async () => {
    const guests = admitter(async () => posture);
    const a = await guests.admit('t1');
    const b = await guests.admit('t2');
    expect(a?.runtime).toBeDefined();
    expect(b?.runtime).toBe(a?.runtime);
  });

  it('refuses guest creates unless the audit table is forced with the guest policy', async () => {
    const loose = (
      patch: Partial<NonNullable<GuestCatalogPosture['auditTable']>>,
    ) =>
      admitter(
        async () => ({
          ...posture,
          auditTable: { ...posture.auditTable!, ...patch },
        }),
        createConfig,
      );
    expect(
      await admitter(async () => posture, createConfig).admit('t1'),
    ).not.toBeNull();
    expect(await loose({ rowSecurity: false }).admit('t1')).toBeNull();
    expect(await loose({ forceRowSecurity: false }).admit('t1')).toBeNull();
    expect(await loose({ guestInsertPolicy: false }).admit('t1')).toBeNull();
    expect(
      await admitter(
        async () => ({ ...posture, auditTable: null }),
        createConfig,
      ).admit('t1'),
    ).toBeNull();
  });

  it('does not require the audit table of a read-only guest config', async () => {
    const guests = admitter(async () => ({ ...posture, auditTable: null }));
    expect(await guests.admit('t1')).not.toBeNull();
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
