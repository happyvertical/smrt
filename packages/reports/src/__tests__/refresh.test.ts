import {
  ObjectRegistry,
  type SmrtCollection,
  SmrtObject,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshReport, reportRowIdentity } from '../refresh.js';
import type { ReportDefinition } from '../types.js';

class RefreshInvoice extends SmrtObject {}
class RefreshRevenueReport extends SmrtObject {}

function makeDb(): DatabaseInterface {
  const db = {
    url: ':memory:',
    client: {},
    type: 'sqlite',
    insert: vi.fn(async () => ({ operation: 'insert', affected: 0 })),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    getOrInsert: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    table: vi.fn(),
    tableExists: vi.fn(
      async (table: string) => table === 'refresh_revenue_reports',
    ),
    many: vi.fn(),
    single: vi.fn(),
    pluck: vi.fn(),
    execute: vi.fn(),
    oo: vi.fn(),
    oO: vi.fn(),
    ox: vi.fn(),
    xx: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('DELETE FROM')) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            customer_id: 'cust_1',
            issued_month: '2026-01-01 00:00:00',
            revenue: 125,
          },
        ],
        rowCount: 1,
      };
    }),
    transaction: vi.fn(
      async <T>(callback: (tx: DatabaseInterface) => Promise<T>) =>
        callback(db as unknown as DatabaseInterface),
    ),
  };

  return db as unknown as DatabaseInterface;
}

function registerRefreshClasses() {
  ObjectRegistry.registerFromManifest(
    'RefreshInvoice',
    {
      className: 'RefreshInvoice',
      fields: {
        customerId: { type: 'text' },
        issuedAt: { type: 'datetime' },
        totalAmount: { type: 'decimal' },
      },
      methods: {},
      decoratorConfig: { tableName: 'refresh_invoices' },
    },
    '@test/reports',
  );

  ObjectRegistry.registerFromManifest(
    'RefreshRevenueReport',
    {
      className: 'RefreshRevenueReport',
      fields: {
        customerId: {
          type: 'text',
          _meta: { __report: { kind: 'group', sourceColumn: 'customerId' } },
        },
        issuedMonth: {
          type: 'datetime',
          _meta: {
            __report: {
              kind: 'bucket',
              unit: 'month',
              sourceColumn: 'issuedAt',
            },
          },
        },
        revenue: {
          type: 'decimal',
          _meta: {
            __report: {
              kind: 'aggregate',
              fn: 'sum',
              column: 'totalAmount',
            },
          },
        },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'refresh_revenue_reports',
        report: { source: 'RefreshInvoice' },
      },
    },
    '@test/reports',
  );
}

describe('report refresh', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerRefreshClasses();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('rebuilds a materialized report table from aggregate results', async () => {
    const db = makeDb();

    const result = await refreshReport(RefreshRevenueReport, {
      db,
      lock: false,
      trackRuns: false,
    });

    expect(result.rowCount).toBe(1);
    expect(result.mode).toBe('rebuild');
    expect(db.query).toHaveBeenCalledWith(
      "SELECT customer_id AS customer_id, strftime('%Y-%m-01 00:00:00', issued_at) AS issued_month, SUM(total_amount) AS revenue FROM refresh_invoices GROUP BY customer_id, strftime('%Y-%m-01 00:00:00', issued_at)",
    );
    expect(db.query).toHaveBeenCalledWith(
      'DELETE FROM refresh_revenue_reports',
    );
    expect(db.insert).toHaveBeenCalledWith(
      'refresh_revenue_reports',
      expect.arrayContaining([
        expect.objectContaining({
          customer_id: 'cust_1',
          issued_month: '2026-01-01 00:00:00',
          revenue: 125,
          slug: expect.any(String),
          refreshed_at: expect.any(String),
        }),
      ]),
    );
  });

  it('uses stable IDs from grouping columns', () => {
    const definition: ReportDefinition = {
      reportClassName: 'RefreshRevenueReport',
      sourceClassName: 'RefreshInvoice',
      sourceTable: 'refresh_invoices',
      fields: [
        {
          fieldName: 'customerId',
          columnName: 'customer_id',
          report: { kind: 'group', sourceColumn: 'customerId' },
        },
      ],
    };
    const row = { customer_id: 'cust_1', revenue: 125 };

    expect(reportRowIdentity(row, definition)).toBe(
      reportRowIdentity(row, definition),
    );
  });

  it('rejects incremental mode when source preconditions are missing', async () => {
    await expect(
      refreshReport(RefreshRevenueReport, {
        db: makeDb(),
        mode: 'incremental',
        lock: false,
        trackRuns: false,
      }),
    ).rejects.toThrow(/requires source .*(watermark|soft-delete) column/i);
  });
});
