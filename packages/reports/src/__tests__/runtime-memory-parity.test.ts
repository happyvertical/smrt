/**
 * Parity of the in-memory runner with the SQL path (#4100).
 *
 * Every spec in the matrix runs twice over the same rows: compiled against
 * the ObjectRegistry and executed as SQL on in-memory SQLite
 * (`compileRuntimeReportSpec` + `runRuntimeReport`), and evaluated by
 * `runRuntimeReportInMemory` over the equivalent row objects. The results
 * must be identical, `specHash` included (server hash vs Web Crypto digest).
 *
 * One dialect difference is normalized, not hidden: SQLite returns time
 * buckets as `YYYY-MM-DD HH:MM:SS` TEXT, while PostgreSQL/DuckDB (and the
 * in-memory runner) return them as ISO-8601 instants. `iso()` converts the
 * SQLite text before comparing; every other cell is compared verbatim.
 */

import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  compileRuntimeReportSpec,
  type RuntimeReportResult,
  type RuntimeReportSourceDefinition,
  runRuntimeReport,
} from '../runtime-compiler.js';
import {
  describeRuntimeReportMemorySource,
  type RuntimeReportMemorySource,
  runRuntimeReportInMemory,
} from '../runtime-memory.js';
import { parseRuntimeReportSpec, RuntimeReportError } from '../runtime-spec.js';

class PmInvoice extends SmrtObject {}

const NOW = new Date('2026-10-16T12:00:00.000Z');
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Row {
  id: string;
  customerId: string | null;
  status: string | null;
  memo: string | null;
  totalAmount: number | null;
  taxRate: number | null;
  isPaid: boolean | null;
  issuedAt: string | null;
  deletedAt: string | null;
}

/**
 * Edge cases on purpose: NULLs in every typed column, a soft-deleted row,
 * mixed-case text for `contains`, binary-exact decimals, a Sunday/Monday pair
 * for weeks, and timestamps on minute/hour boundaries.
 */
const ROWS: Row[] = [
  {
    id: 'i01',
    customerId: C1,
    status: 'paid',
    memo: 'Brake pads',
    totalAmount: 10000,
    taxRate: 0.5,
    isPaid: true,
    issuedAt: '2026-09-01T08:15:00.000Z',
    deletedAt: null,
  },
  {
    id: 'i02',
    customerId: C1,
    status: 'paid',
    memo: 'brake fluid',
    totalAmount: 25000,
    taxRate: 0.25,
    isPaid: true,
    issuedAt: '2026-09-06T23:59:00.000Z',
    deletedAt: null,
  },
  {
    id: 'i03',
    customerId: C2,
    status: 'open',
    memo: 'Oil change',
    totalAmount: 5000,
    taxRate: 1.5,
    isPaid: false,
    issuedAt: '2026-09-07T00:00:00.000Z',
    deletedAt: null,
  },
  {
    id: 'i04',
    customerId: C2,
    status: 'void',
    memo: null,
    totalAmount: 99999,
    taxRate: 2.75,
    isPaid: false,
    issuedAt: '2026-09-15T10:30:00.000Z',
    deletedAt: '2026-09-16T00:00:00.000Z',
  },
  {
    id: 'i05',
    customerId: C1,
    status: null,
    memo: 'Tyres',
    totalAmount: 42000,
    taxRate: null,
    isPaid: null,
    issuedAt: '2026-08-31T23:59:59.000Z',
    deletedAt: null,
  },
  {
    id: 'i06',
    customerId: null,
    status: 'open',
    memo: 'Wiper BLADES',
    totalAmount: null,
    taxRate: 0.75,
    isPaid: false,
    issuedAt: '2026-10-02T14:00:00.000Z',
    deletedAt: null,
  },
  {
    id: 'i07',
    customerId: C2,
    status: 'paid',
    memo: 'Inspection',
    totalAmount: 7500,
    taxRate: 0.5,
    isPaid: true,
    issuedAt: '2026-07-14T09:00:00.000Z',
    deletedAt: null,
  },
  {
    id: 'i08',
    customerId: C1,
    status: 'paid',
    memo: 'Alignment',
    totalAmount: 13333,
    taxRate: 1.25,
    isPaid: true,
    issuedAt: null,
    deletedAt: null,
  },
  {
    id: 'i09',
    customerId: C2,
    status: 'open',
    memo: 'brake pads',
    totalAmount: 3,
    taxRate: 0.125,
    isPaid: false,
    issuedAt: '2025-12-31T23:00:00.000Z',
    deletedAt: null,
  },
];

const SQL_SOURCES: RuntimeReportSourceDefinition[] = [
  { id: 'invoices', className: 'PmInvoice', label: 'Invoices' },
];

const MEMORY_SOURCES: RuntimeReportMemorySource[] = [
  {
    id: 'invoices',
    label: 'Invoices',
    schema: [
      { name: 'id', type: 'string' },
      { name: 'slug', type: 'string' },
      { name: 'context', type: 'string' },
      { name: 'createdAt', type: 'datetime' },
      { name: 'updatedAt', type: 'datetime' },
      { name: 'customerId', type: 'id' },
      { name: 'status', type: 'string' },
      { name: 'memo', type: 'string' },
      { name: 'totalAmount', type: 'integer', format: 'money' },
      { name: 'taxRate', type: 'decimal' },
      { name: 'isPaid', type: 'boolean' },
      { name: 'issuedAt', type: 'datetime' },
      { name: 'deletedAt', type: 'datetime' },
    ],
  },
];

let db: DatabaseInterface;

function registerFixture(): void {
  const field = (name: string, def: Record<string, unknown>) =>
    ObjectRegistry.registerFieldDecorator('PmInvoice', name, def as never);
  field('customerId', { type: 'foreignKey', related: 'Customer' });
  field('status', { type: 'text' });
  field('memo', { type: 'text' });
  // As `@field({ ui: { format: 'money' } })` registers it (`_meta.ui.format`).
  field('totalAmount', { type: 'integer', ui: { format: 'money' } });
  field('taxRate', { type: 'decimal' });
  field('isPaid', { type: 'boolean' });
  field('issuedAt', { type: 'datetime' });
  field('deletedAt', { type: 'datetime', nullable: true });
  ObjectRegistry.register(PmInvoice, { tableName: 'pm_invoices' });
}

async function seed(): Promise<void> {
  // Exact column types matter here (INTEGER money, REAL decimals, ISO TEXT).
  await db.query('DROP TABLE IF EXISTS pm_invoices');
  await db.query(`
    CREATE TABLE pm_invoices (
      id TEXT PRIMARY KEY, slug TEXT, context TEXT, customer_id TEXT,
      status TEXT, memo TEXT, total_amount INTEGER, tax_rate REAL,
      is_paid INTEGER, issued_at TEXT, deleted_at TEXT,
      created_at TEXT, updated_at TEXT
    )
  `);
  for (const row of ROWS) {
    await db.query(
      `INSERT INTO pm_invoices (id, slug, context, customer_id, status, memo, total_amount, tax_rate, is_paid, issued_at, deleted_at, created_at, updated_at)
       VALUES ($1, $1, '', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      row.id,
      row.customerId,
      row.status,
      row.memo,
      row.totalAmount,
      row.taxRate,
      row.isPaid === null ? null : row.isPaid ? 1 : 0,
      row.issuedAt,
      row.deletedAt,
      '2026-01-01T00:00:00.000Z',
    );
  }
}

/** Rows as the browser holds them: camelCase, typed, plus base fields. */
const MEMORY_ROWS = ROWS.map((row) => ({
  ...row,
  slug: row.id,
  context: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}));

/** SQLite bucket TEXT (`YYYY-MM-DD HH:MM:SS`) as an ISO-8601 instant. */
function iso(result: RuntimeReportResult): RuntimeReportResult {
  const buckets = result.columns.filter((column) => column.bucket);
  return {
    ...result,
    rows: result.rows.map((row) => {
      const out = { ...row };
      for (const column of buckets) {
        const value = out[column.id];
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /.test(value)) {
          out[column.id] = `${value.replace(' ', 'T')}.000Z`;
        }
      }
      return out;
    }),
  };
}

async function viaSql(input: unknown): Promise<RuntimeReportResult> {
  const spec = parseRuntimeReportSpec(input);
  const compiled = await compileRuntimeReportSpec(spec, {
    sources: SQL_SOURCES,
    tenantId: null,
  });
  return iso(await runRuntimeReport(compiled, { db, now: () => NOW }));
}

async function viaMemory(input: unknown): Promise<RuntimeReportResult> {
  return runRuntimeReportInMemory(parseRuntimeReportSpec(input), MEMORY_ROWS, {
    sources: MEMORY_SOURCES,
    now: () => NOW,
  });
}

beforeEach(async () => {
  registerFixture();
  db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  await seed();
});

const base = { title: 'Parity', source: 'invoices' };

/** [name, spec] — each must give identical results on both paths. */
const MATRIX: [string, Record<string, unknown>][] = [
  ['row count, no grouping', { measures: [{ fn: 'count' }] }],
  [
    'every measure over one field, no grouping',
    {
      measures: [
        { fn: 'count', field: 'totalAmount', as: 'n' },
        { fn: 'countDistinct', field: 'customerId', as: 'customers' },
        { fn: 'sum', field: 'totalAmount', as: 'total' },
        { fn: 'avg', field: 'totalAmount', as: 'mean' },
        { fn: 'min', field: 'totalAmount', as: 'low' },
        { fn: 'max', field: 'totalAmount', as: 'high' },
      ],
    },
  ],
  [
    'decimal sum and average',
    {
      dimensions: [{ field: 'status' }],
      measures: [
        { fn: 'sum', field: 'taxRate', as: 'tax' },
        { fn: 'avg', field: 'taxRate', as: 'mean_tax' },
      ],
    },
  ],
  [
    'group by text with a NULL group, default order',
    {
      dimensions: [{ field: 'status' }],
      measures: [{ fn: 'count' }, { fn: 'sum', field: 'totalAmount' }],
    },
  ],
  [
    'group by id with distinct count',
    {
      dimensions: [{ field: 'customerId' }],
      measures: [{ fn: 'countDistinct', field: 'status', as: 'statuses' }],
    },
  ],
  [
    'group by boolean',
    {
      dimensions: [{ field: 'isPaid' }],
      measures: [{ fn: 'sum', field: 'totalAmount', as: 'total' }],
    },
  ],
  [
    'two dimensions with explicit sort',
    {
      dimensions: [{ field: 'status' }, { field: 'isPaid' }],
      measures: [{ fn: 'count' }],
      sort: [
        { by: 'status', direction: 'desc' },
        { by: 'is_paid', direction: 'asc' },
      ],
    },
  ],
  ...(['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'].map(
    (bucket) =>
      [
        `${bucket} bucket`,
        {
          dimensions: [{ field: 'issuedAt', bucket }],
          measures: [{ fn: 'count' }, { fn: 'sum', field: 'totalAmount' }],
        },
      ] as [string, Record<string, unknown>],
  ) as [string, Record<string, unknown>][]),
  [
    'previous calendar month (sales last month)',
    {
      measures: [
        { fn: 'count', as: 'invoices' },
        { fn: 'sum', field: 'totalAmount', as: 'total' },
      ],
      filters: [
        { field: 'issuedAt', op: 'gte', value: '2026-09-01' },
        { field: 'issuedAt', op: 'lt', value: '2026-10-01' },
      ],
    },
  ],
  [
    'datetime dimension without a bucket, min/max datetime',
    {
      dimensions: [{ field: 'status' }],
      measures: [
        { fn: 'min', field: 'issuedAt', as: 'first' },
        { fn: 'max', field: 'issuedAt', as: 'last' },
      ],
    },
  ],
  [
    'eq / ne exclude NULLs',
    {
      dimensions: [{ field: 'status' }],
      measures: [{ fn: 'count' }],
      filters: [{ field: 'status', op: 'ne', value: 'paid' }],
    },
  ],
  [
    'numeric comparisons',
    {
      measures: [{ fn: 'count' }],
      filters: [
        { field: 'totalAmount', op: 'gt', value: 5000 },
        { field: 'totalAmount', op: 'lte', value: 42000 },
      ],
    },
  ],
  [
    'in / notIn (NULL never matches notIn)',
    {
      dimensions: [{ field: 'status' }],
      measures: [{ fn: 'count' }],
      filters: [{ field: 'status', op: 'notIn', value: ['void'] }],
    },
  ],
  [
    'in on decimals',
    {
      measures: [{ fn: 'count' }],
      filters: [{ field: 'taxRate', op: 'in', value: [0.5, 1.5] }],
    },
  ],
  [
    'contains is case-sensitive',
    {
      dimensions: [{ field: 'memo' }],
      measures: [{ fn: 'count' }],
      filters: [{ field: 'memo', op: 'contains', value: 'brake' }],
    },
  ],
  [
    'isNull / isNotNull',
    {
      dimensions: [{ field: 'customerId' }],
      measures: [{ fn: 'count' }],
      filters: [
        { field: 'issuedAt', op: 'isNotNull' },
        { field: 'taxRate', op: 'isNotNull' },
      ],
    },
  ],
  [
    'boolean eq',
    {
      measures: [{ fn: 'sum', field: 'totalAmount', as: 'paid_total' }],
      filters: [{ field: 'isPaid', op: 'eq', value: true }],
    },
  ],
  [
    'id eq is case-insensitive on input',
    {
      measures: [{ fn: 'count' }],
      filters: [{ field: 'customerId', op: 'eq', value: C2.toUpperCase() }],
    },
  ],
  [
    'datetime eq',
    {
      measures: [{ fn: 'count' }],
      filters: [
        { field: 'issuedAt', op: 'eq', value: '2026-09-07T00:00:00.000Z' },
      ],
    },
  ],
  [
    'having, sort by measure desc, limit truncation',
    {
      dimensions: [{ field: 'customerId' }],
      measures: [{ fn: 'sum', field: 'totalAmount', as: 'total' }],
      having: [{ measure: 'total', op: 'gt', value: 100 }],
      sort: [{ by: 'total', direction: 'desc' }],
      limit: 1,
    },
  ],
  [
    'having excludes NULL measures',
    {
      dimensions: [{ field: 'status' }],
      measures: [{ fn: 'sum', field: 'taxRate', as: 'tax' }],
      having: [{ measure: 'tax', op: 'gte', value: 0 }],
    },
  ],
  [
    'no rows, grouped: empty result',
    {
      dimensions: [{ field: 'status' }],
      measures: [{ fn: 'count' }],
      filters: [{ field: 'status', op: 'eq', value: 'refunded' }],
    },
  ],
  [
    'no rows, ungrouped: one row of count 0 and NULL sum',
    {
      measures: [{ fn: 'count' }, { fn: 'sum', field: 'totalAmount' }],
      filters: [{ field: 'status', op: 'eq', value: 'refunded' }],
    },
  ],
  [
    'chart hint and description travel through',
    {
      description: 'Monthly revenue',
      dimensions: [{ field: 'issuedAt', bucket: 'month' }],
      measures: [{ fn: 'sum', field: 'totalAmount', as: 'revenue' }],
      chart: { type: 'bar', x: 'issued_at_month', y: ['revenue'] },
    },
  ],
];

describe('runRuntimeReportInMemory parity with the SQL runner (#4100)', () => {
  it.each(MATRIX)('%s', async (_name, spec) => {
    const input = { ...base, ...spec };
    const sql = await viaSql(input);
    const memory = await viaMemory(input);
    expect(memory).toEqual(sql);
  });

  it('totals last month on both paths (the planner assistant case)', async () => {
    const input = {
      ...base,
      measures: [
        { fn: 'count', as: 'invoices' },
        { fn: 'sum', field: 'totalAmount', as: 'total' },
      ],
      filters: [
        { field: 'issuedAt', op: 'gte', value: '2026-09-01' },
        { field: 'issuedAt', op: 'lt', value: '2026-10-01' },
      ],
    };
    // i01 + i02 + i03; i04 is soft-deleted and i05 is 1s before September.
    const expected = [{ invoices: 3, total: 40000 }];
    expect((await viaSql(input)).rows).toEqual(expected);
    expect((await viaMemory(input)).rows).toEqual(expected);
  });

  it('reads Date objects in rows like ISO strings', async () => {
    const input = parseRuntimeReportSpec({
      ...base,
      dimensions: [{ field: 'issuedAt', bucket: 'week' }],
      measures: [{ fn: 'max', field: 'issuedAt', as: 'last' }],
    });
    const dated = MEMORY_ROWS.map((row) => ({
      ...row,
      issuedAt: row.issuedAt === null ? null : new Date(row.issuedAt),
    }));
    const options = { sources: MEMORY_SOURCES, now: () => NOW };
    expect(await runRuntimeReportInMemory(input, dated, options)).toEqual(
      await runRuntimeReportInMemory(input, MEMORY_ROWS, options),
    );
  });

  it('honours the soft-delete column on both paths', async () => {
    const input = { ...base, measures: [{ fn: 'count' }] };
    expect((await viaMemory(input)).rows).toEqual([{ row_count: 8 }]);
    expect((await viaSql(input)).rows).toEqual([{ row_count: 8 }]);
  });

  it('applies the host row ceiling the same way', async () => {
    const input = {
      ...base,
      dimensions: [{ field: 'status' }],
      measures: [{ fn: 'count' }],
    };
    const spec = parseRuntimeReportSpec(input);
    const compiled = await compileRuntimeReportSpec(spec, {
      sources: SQL_SOURCES,
      tenantId: null,
    });
    const sql = await runRuntimeReport(compiled, {
      db,
      maxRows: 2,
      now: () => NOW,
    });
    const memory = await runRuntimeReportInMemory(spec, MEMORY_ROWS, {
      sources: MEMORY_SOURCES,
      maxRows: 2,
      now: () => NOW,
    });
    expect(memory).toEqual(sql);
    expect(memory.truncated).toBe(true);
  });

  /** [name, spec, code, path] — both paths reject identically. */
  const REJECTIONS: [string, Record<string, unknown>, string, string][] = [
    [
      'unknown source',
      { source: 'orders', measures: [{ fn: 'count' }] },
      'unknown_source',
      'spec.source',
    ],
    [
      'unknown field',
      { dimensions: [{ field: 'nope' }], measures: [{ fn: 'count' }] },
      'unknown_field',
      'spec.dimensions[0].field',
    ],
    [
      'sum on text',
      { measures: [{ fn: 'sum', field: 'status' }] },
      'invalid_operation',
      'spec.measures[0].fn',
    ],
    [
      'min on boolean',
      { measures: [{ fn: 'min', field: 'isPaid' }] },
      'invalid_operation',
      'spec.measures[0].fn',
    ],
    [
      'bucket on text',
      {
        dimensions: [{ field: 'status', bucket: 'month' }],
        measures: [{ fn: 'count' }],
      },
      'invalid_operation',
      'spec.dimensions[0].bucket',
    ],
    [
      'contains on integer',
      {
        measures: [{ fn: 'count' }],
        filters: [{ field: 'totalAmount', op: 'contains', value: '1' }],
      },
      'invalid_operation',
      'spec.filters[0].op',
    ],
    [
      'uncoercible value',
      {
        measures: [{ fn: 'count' }],
        filters: [{ field: 'issuedAt', op: 'gte', value: 'last month' }],
      },
      'invalid_value',
      'spec.filters[0].value',
    ],
    [
      'non-UUID id value',
      {
        measures: [{ fn: 'count' }],
        filters: [{ field: 'customerId', op: 'eq', value: 'c1' }],
      },
      'invalid_value',
      'spec.filters[0].value',
    ],
  ];

  async function rejection(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeReportError);
      const { code, path } = error as RuntimeReportError;
      return { code, path };
    }
    throw new Error('expected a rejection');
  }

  it.each(
    REJECTIONS,
  )('rejects %s identically', async (_name, spec, code, path) => {
    const input = { ...base, ...spec };
    const expected = { code, path };
    expect(await rejection(viaSql(input))).toEqual(expected);
    expect(await rejection(viaMemory(input))).toEqual(expected);
  });

  it('applies fields / excludeFields with the server semantics', async () => {
    const narrow = (policy: {
      fields?: string[];
      excludeFields?: string[];
    }): {
      sql: RuntimeReportSourceDefinition[];
      memory: RuntimeReportMemorySource[];
    } => ({
      sql: [{ ...SQL_SOURCES[0], ...policy }],
      memory: [{ ...MEMORY_SOURCES[0], ...policy }],
    });
    const run = async (
      sources: ReturnType<typeof narrow>,
      input: Record<string, unknown>,
    ) => {
      const spec = parseRuntimeReportSpec({ ...base, ...input });
      return Promise.all([
        rejection(
          compileRuntimeReportSpec(spec, {
            sources: sources.sql,
            tenantId: null,
          }),
        ),
        rejection(
          runRuntimeReportInMemory(spec, MEMORY_ROWS, {
            sources: sources.memory,
          }),
        ),
      ]);
    };

    const memoHidden = { measures: [{ fn: 'count', field: 'memo' }] };
    for (const policy of [
      { fields: ['status', 'totalAmount'] },
      { excludeFields: ['memo'] },
      { fields: ['memo', 'status'], excludeFields: ['memo'] },
    ]) {
      const [sql, memory] = await run(narrow(policy), memoHidden);
      expect(sql).toEqual({
        code: 'unknown_field',
        path: 'spec.measures[0].field',
      });
      expect(memory).toEqual(sql);
    }

    const [sql, memory] = await run(narrow({ excludeFields: ['memoo'] }), {
      measures: [{ fn: 'count' }],
    });
    expect(sql).toEqual({
      code: 'unsupported_source',
      path: 'source.excludeFields',
    });
    expect(memory).toEqual(sql);
  });

  it('describes an in-memory source like describeRuntimeReportSource', async () => {
    const { describeRuntimeReportSource } = await import(
      '../runtime-compiler.js'
    );
    const sql = await describeRuntimeReportSource(
      { sources: SQL_SOURCES, tenantId: null },
      'invoices',
    );
    const memory = describeRuntimeReportMemorySource(
      MEMORY_SOURCES,
      'invoices',
    );
    const byName = <T extends { name: string }>(fields: T[]) =>
      [...fields].sort((a, b) => a.name.localeCompare(b.name));
    expect(memory.id).toBe(sql.id);
    expect(memory.label).toBe(sql.label);
    expect(byName(memory.fields)).toEqual(byName(sql.fields));
  });
});
