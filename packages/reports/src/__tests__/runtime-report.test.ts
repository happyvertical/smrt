import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CompiledRuntimeReport,
  compileRuntimeReportSpec,
  describeRuntimeReportSource,
  type RuntimeReportCompileContext,
  runRuntimeReport,
} from '../runtime-compiler.js';
import {
  archiveRuntimeReport,
  getRuntimeReport,
  listRuntimeReports,
  RuntimeReport,
  runStoredRuntimeReport,
  saveRuntimeReport,
} from '../runtime-report.js';
import {
  parseRuntimeReportSpec,
  RuntimeReportError,
  runtimeReportSpecHash,
  serializeRuntimeReportSpec,
} from '../runtime-spec.js';

class RtInvoice extends SmrtObject {}
class RtGlobalNote extends SmrtObject {}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '33333333-3333-4333-8333-333333333333';

let db: DatabaseInterface;

function field(name: string, def: Record<string, unknown>): void {
  ObjectRegistry.registerFieldDecorator('RtInvoice', name, def as never);
}

function registerFixtures(): void {
  field('tenantId', {
    type: 'text',
    nullable: true,
    _meta: { __tenancy: { isTenantIdField: true, mode: 'optional' } },
  });
  field('customerId', { type: 'foreignKey', related: 'Customer' });
  field('status', { type: 'text' });
  field('totalAmount', { type: 'integer', format: 'money' });
  field('taxRate', { type: 'decimal' });
  field('isPaid', { type: 'boolean' });
  field('issuedAt', { type: 'datetime' });
  field('deletedAt', { type: 'datetime', nullable: true });
  field('internalNote', { type: 'text', sensitive: true });
  field('apiToken', { type: 'text', sensitivity: 'secret' });
  field('margin', { type: 'integer', readPermission: 'finance.margins' });
  field('payload', { type: 'json' });
  field('_hidden', { type: 'text' });
  field('draftFlag', { type: 'text', transient: true });
  ObjectRegistry.register(RtInvoice, {
    tableName: 'rt_invoices',
    tenantScoped: { mode: 'optional' },
  });

  ObjectRegistry.registerFieldDecorator('RtGlobalNote', 'body', {
    type: 'text',
  });
  ObjectRegistry.register(RtGlobalNote, { tableName: 'rt_global_notes' });
}

async function seed(): Promise<void> {
  await db.query(`
    CREATE TABLE rt_invoices (
      id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT,
      customer_id TEXT, status TEXT, total_amount INTEGER, tax_rate REAL,
      is_paid INTEGER, issued_at TEXT, deleted_at TEXT, internal_note TEXT,
      api_token TEXT, margin INTEGER, payload TEXT, _hidden TEXT,
      created_at TEXT, updated_at TEXT
    )
  `);
  await db.query(
    'CREATE TABLE rt_global_notes (id TEXT PRIMARY KEY, slug TEXT, context TEXT, body TEXT, created_at TEXT, updated_at TEXT)',
  );
  const rows: [
    string,
    string | null,
    string,
    string,
    number,
    number,
    number,
    string,
    string | null,
  ][] = [
    [
      'i1',
      TENANT_A,
      CUSTOMER_1,
      'paid',
      10000,
      5,
      1,
      '2026-01-10T00:00:00.000Z',
      null,
    ],
    [
      'i2',
      TENANT_A,
      CUSTOMER_1,
      'paid',
      25000,
      10,
      1,
      '2026-01-20T00:00:00.000Z',
      null,
    ],
    [
      'i3',
      TENANT_A,
      CUSTOMER_2,
      'open',
      5000,
      2,
      0,
      '2026-02-03T00:00:00.000Z',
      null,
    ],
    [
      'i4',
      TENANT_A,
      CUSTOMER_2,
      'paid',
      99999,
      99,
      1,
      '2026-02-04T00:00:00.000Z',
      '2026-02-05T00:00:00.000Z',
    ],
    [
      'i5',
      TENANT_B,
      CUSTOMER_1,
      'paid',
      7000000,
      1,
      1,
      '2026-01-15T00:00:00.000Z',
      null,
    ],
    [
      'i6',
      null,
      CUSTOMER_1,
      'open',
      42,
      0,
      0,
      '2026-01-01T00:00:00.000Z',
      null,
    ],
  ];
  for (const [
    id,
    tenant,
    customer,
    status,
    total,
    margin,
    paid,
    issued,
    deleted,
  ] of rows) {
    await db.query(
      `INSERT INTO rt_invoices (id, slug, context, tenant_id, customer_id, status, total_amount, tax_rate, is_paid, issued_at, deleted_at, internal_note, api_token, margin, created_at, updated_at)
       VALUES ($1, $1, '', $2, $3, $4, $5, 0.2, $6, $7, $8, 'SECRET-NOTE', 'TOKEN-123', $9, $7, $7)`,
      id,
      tenant,
      customer,
      status,
      total,
      paid,
      issued,
      deleted,
      margin,
    );
  }
}

const SOURCES = [
  {
    id: 'invoices',
    className: 'RtInvoice',
    label: 'Invoices',
    collection: 'RtInvoice',
  },
  { id: 'notes', className: 'RtGlobalNote', label: 'Notes' },
];

function context(
  overrides: Partial<RuntimeReportCompileContext> = {},
): RuntimeReportCompileContext {
  return {
    sources: SOURCES,
    permissions: [],
    tenantId: TENANT_A,
    ...overrides,
  };
}

function spec(overrides: Record<string, unknown> = {}) {
  return parseRuntimeReportSpec({
    title: 'Revenue by status',
    source: 'invoices',
    dimensions: [{ field: 'status' }],
    measures: [
      { fn: 'sum', field: 'totalAmount', as: 'revenue' },
      { fn: 'count', as: 'invoices' },
    ],
    ...overrides,
  });
}

async function run(
  overrides: Record<string, unknown> = {},
  ctx: RuntimeReportCompileContext = context(),
) {
  const compiled = await compileRuntimeReportSpec(spec(overrides), ctx);
  return { compiled, result: await runRuntimeReport(compiled, { db }) };
}

async function expectRejected(
  promise: Promise<unknown>,
  code: RuntimeReportError['code'],
  path?: string,
): Promise<RuntimeReportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeReportError);
    expect((error as RuntimeReportError).code).toBe(code);
    if (path) expect((error as RuntimeReportError).path).toBe(path);
    return error as RuntimeReportError;
  }
  throw new Error(`expected rejection with ${code}`);
}

/** `save()` wraps failures; the validation error rides on `cause`. */
async function expectSaveCause(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    expect(cause).toBeInstanceOf(RuntimeReportError);
    expect((cause as Error).message).toMatch(pattern);
    return;
  }
  throw new Error('expected save to be rejected');
}

beforeEach(async () => {
  registerFixtures();
  db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['RuntimeReport'],
  });
  await seed();
  enableTenancy();
});

afterEach(() => {
  disableTenancy();
});

describe('compileRuntimeReportSpec + runRuntimeReport', () => {
  it('aggregates through bound parameters and scopes to the tenant', async () => {
    const { compiled, result } = await run();
    expect(compiled.source).toMatchObject({
      id: 'invoices',
      table: 'rt_invoices',
    });
    expect(compiled.columns.map((c) => [c.id, c.role, c.type])).toEqual([
      ['status', 'dimension', 'string'],
      ['revenue', 'measure', 'integer'],
      ['invoices', 'measure', 'integer'],
    ]);
    // Tenant A only; the soft-deleted i4 is excluded; B and global excluded.
    expect(result.rows).toEqual([
      { status: 'open', revenue: 5000, invoices: 1 },
      { status: 'paid', revenue: 35000, invoices: 2 },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(2);
  });

  it('carries the source money format hint and keeps minor units integral', async () => {
    const { compiled, result } = await run();
    expect(compiled.columns.find((c) => c.id === 'revenue')?.format).toBe(
      'money',
    );
    for (const row of result.rows) {
      expect(Number.isSafeInteger(row.revenue)).toBe(true);
    }
  });

  it('supports filters, having, sort, buckets and limits', async () => {
    const { result } = await run({
      dimensions: [{ field: 'issuedAt', bucket: 'month' }],
      filters: [
        { field: 'status', op: 'eq', value: 'paid' },
        { field: 'totalAmount', op: 'gte', value: 1000 },
        { field: 'isPaid', op: 'eq', value: true },
        { field: 'issuedAt', op: 'gte', value: '2026-01-01' },
        { field: 'customerId', op: 'in', value: [CUSTOMER_1, CUSTOMER_2] },
      ],
      having: [{ measure: 'revenue', op: 'gt', value: 10 }],
      sort: [{ by: 'revenue', direction: 'desc' }],
      limit: 1,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].revenue).toBe(35000);
    expect(result.truncated).toBe(false);
  });

  it('reports truncation when more rows exist than the limit', async () => {
    const { result } = await run({
      dimensions: [{ field: 'id' }],
      measures: [{ fn: 'count', as: 'n' }],
      limit: 1,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('supports distinct counts, min/max and avg', async () => {
    const { result } = await run({
      dimensions: [],
      measures: [
        { fn: 'countDistinct', field: 'customerId', as: 'customers' },
        { fn: 'min', field: 'issuedAt', as: 'first_issued' },
        { fn: 'max', field: 'totalAmount', as: 'largest' },
        { fn: 'avg', field: 'totalAmount', as: 'average' },
      ],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].customers).toBe(2);
    expect(result.rows[0].largest).toBe(25000);
    expect(result.rows[0].average).toBeCloseTo(13333.33, 1);
    expect(typeof result.rows[0].first_issued).toBe('string');
  });

  describe('tenancy', () => {
    it('never reads another tenant', async () => {
      const a = await run({}, context({ tenantId: TENANT_A }));
      const b = await run({}, context({ tenantId: TENANT_B }));
      expect(a.result.rows.find((r) => r.status === 'paid')?.revenue).toBe(
        35000,
      );
      expect(b.result.rows).toEqual([
        { status: 'paid', revenue: 7000000, invoices: 1 },
      ]);
    });

    it('falls back to the ambient tenant context', async () => {
      const ctx = context({ tenantId: undefined });
      const inB = await withTenant({ tenantId: TENANT_B }, () => run({}, ctx));
      expect(inB.result.rows).toEqual([
        { status: 'paid', revenue: 7000000, invoices: 1 },
      ]);
    });

    it('fails closed to NULL-tenant rows when no tenant is in scope', async () => {
      const { result } = await run({}, context({ tenantId: null }));
      expect(result.rows).toEqual([
        { status: 'open', revenue: 42, invoices: 1 },
      ]);
    });

    it('cannot be widened through the spec', async () => {
      await expectRejected(
        compileRuntimeReportSpec(
          spec({
            filters: [{ field: 'tenantId', op: 'eq', value: TENANT_B }],
          }),
          context(),
        ),
        'unknown_field',
        'spec.filters[0].field',
      );
      await expectRejected(
        compileRuntimeReportSpec(
          spec({ dimensions: [{ field: 'tenantId' }] }),
          context(),
        ),
        'unknown_field',
      );
      // `tenant_id` (the column name) is not a registry field either.
      await expectRejected(
        compileRuntimeReportSpec(
          spec({ dimensions: [{ field: 'tenant_id' }] }),
          context(),
        ),
        'unknown_field',
      );
    });

    it('does not filter a source that has no tenant column', async () => {
      await db.query(
        "INSERT INTO rt_global_notes (id, slug, context, body) VALUES ('n1','n1','','x'), ('n2','n2','','x')",
      );
      const { result } = await run({
        source: 'notes',
        dimensions: [{ field: 'body' }],
        measures: [{ fn: 'count', as: 'n' }],
      });
      expect(result.rows).toEqual([{ body: 'x', n: 2 }]);
    });
  });

  describe('field policy and permissions', () => {
    const hidden = [
      'internalNote',
      'apiToken',
      'margin',
      'payload',
      'draftFlag',
      'doesNotExist',
    ];

    it.each(
      hidden,
    )('%s is un-nameable as a dimension, filter and measure', async (name) => {
      await expectRejected(
        compileRuntimeReportSpec(
          spec({ dimensions: [{ field: name }] }),
          context(),
        ),
        'unknown_field',
        'spec.dimensions[0].field',
      );
      await expectRejected(
        compileRuntimeReportSpec(
          spec({ filters: [{ field: name, op: 'isNotNull' }] }),
          context(),
        ),
        'unknown_field',
        'spec.filters[0].field',
      );
      await expectRejected(
        compileRuntimeReportSpec(
          spec({ measures: [{ fn: 'count', field: name, as: 'n' }] }),
          context(),
        ),
        'unknown_field',
        'spec.measures[0].field',
      );
    });

    it('internal and underscore-prefixed names are not even well-formed', async () => {
      for (const name of ['_hidden', '_meta_type', '__proto__']) {
        expect(() => spec({ dimensions: [{ field: name }] })).toThrow(
          RuntimeReportError,
        );
      }
    });

    it('answers hidden and absent fields identically (no existence oracle)', async () => {
      const messages = await Promise.all(
        ['internalNote', 'margin', 'doesNotExist'].map(async (name) => {
          const error = await expectRejected(
            compileRuntimeReportSpec(
              spec({ dimensions: [{ field: name }] }),
              context(),
            ),
            'unknown_field',
          );
          return error.message.replace(name, '<f>');
        }),
      );
      expect(new Set(messages).size).toBe(1);
    });

    it('admits a readPermission field only for a principal holding it', async () => {
      const permitted = spec({
        dimensions: [],
        measures: [{ fn: 'sum', field: 'margin', as: 'total_margin' }],
      });
      await expectRejected(
        compileRuntimeReportSpec(
          permitted,
          context({ permissions: ['other'] }),
        ),
        'unknown_field',
      );
      const compiled = await compileRuntimeReportSpec(
        permitted,
        context({ permissions: ['finance.margins'] }),
      );
      const result = await runRuntimeReport(compiled, { db });
      expect(result.rows[0].total_margin).toBe(5 + 10 + 2);
    });

    it('never returns sensitive values in results', async () => {
      const { result } = await run({
        dimensions: [{ field: 'id' }, { field: 'slug' }],
        measures: [{ fn: 'count', as: 'n' }],
      });
      expect(JSON.stringify(result)).not.toMatch(/SECRET-NOTE|TOKEN-123/);
    });

    it('rejects sources outside the server allow-list', async () => {
      for (const source of ['rt_invoices', 'RtInvoice', 'users', 'INVOICES']) {
        await expectRejected(
          compileRuntimeReportSpec(spec({ source }), context()),
          'unknown_source',
        );
      }
      await expectRejected(
        compileRuntimeReportSpec(spec(), context({ sources: [] })),
        'unknown_source',
      );
    });

    it('propagates a host source-authorization denial before reading fields', async () => {
      let sawFieldWork = false;
      const denied = new Error('denied by host');
      await expect(
        compileRuntimeReportSpec(
          spec({ dimensions: [{ field: 'nope' }] }),
          context({
            authorizeSource: () => {
              sawFieldWork = true;
              throw denied;
            },
          }),
        ),
      ).rejects.toBe(denied);
      expect(sawFieldWork).toBe(true);
    });
  });

  describe('describeRuntimeReportSource', () => {
    it('lists exactly the fields the compiler admits for the principal', async () => {
      const plain = await describeRuntimeReportSource(context(), 'invoices');
      const names = plain.fields.map((f) => f.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'status',
          'totalAmount',
          'issuedAt',
          'customerId',
        ]),
      );
      for (const hidden of [
        'internalNote',
        'apiToken',
        'margin',
        'payload',
        'tenantId',
        'draftFlag',
      ]) {
        expect(names).not.toContain(hidden);
      }
      expect(plain.fields.find((f) => f.name === 'totalAmount')).toMatchObject({
        type: 'integer',
        format: 'money',
        aggregates: expect.arrayContaining(['sum', 'avg']),
      });
      const withPermission = await describeRuntimeReportSource(
        context({ permissions: ['finance.margins'] }),
        'invoices',
      );
      expect(withPermission.fields.map((f) => f.name)).toContain('margin');
    });

    it('applies source authorization and the allow-list', async () => {
      await expectRejected(
        describeRuntimeReportSource(context(), 'users'),
        'unknown_source',
      );
      await expect(
        describeRuntimeReportSource(
          context({
            authorizeSource: () => {
              throw new Error('denied');
            },
          }),
          'invoices',
        ),
      ).rejects.toThrow('denied');
    });
  });

  describe('type and operator checks', () => {
    it.each([
      [
        'sum on text',
        { measures: [{ fn: 'sum', field: 'status', as: 'x' }] },
        'invalid_operation',
      ],
      [
        'avg on datetime',
        { measures: [{ fn: 'avg', field: 'issuedAt', as: 'x' }] },
        'invalid_operation',
      ],
      [
        'min on boolean',
        { measures: [{ fn: 'min', field: 'isPaid', as: 'x' }] },
        'invalid_operation',
      ],
      [
        'bucket on text',
        { dimensions: [{ field: 'status', bucket: 'day' }] },
        'invalid_operation',
      ],
      [
        'contains on integer',
        { filters: [{ field: 'totalAmount', op: 'contains', value: '1' }] },
        'invalid_operation',
      ],
      [
        'gt on boolean',
        { filters: [{ field: 'isPaid', op: 'gt', value: true }] },
        'invalid_operation',
      ],
      [
        'gt on id',
        { filters: [{ field: 'customerId', op: 'gt', value: CUSTOMER_1 }] },
        'invalid_operation',
      ],
      [
        'string for integer',
        { filters: [{ field: 'totalAmount', op: 'eq', value: '5' }] },
        'invalid_value',
      ],
      [
        'fraction for integer',
        { filters: [{ field: 'totalAmount', op: 'eq', value: 1.5 }] },
        'invalid_value',
      ],
      [
        'string for boolean',
        { filters: [{ field: 'isPaid', op: 'eq', value: 'true' }] },
        'invalid_value',
      ],
      [
        'bad date',
        { filters: [{ field: 'issuedAt', op: 'gte', value: 'yesterday' }] },
        'invalid_value',
      ],
      [
        'non-uuid id',
        { filters: [{ field: 'customerId', op: 'eq', value: "x' OR '1'='1" }] },
        'invalid_value',
      ],
      [
        'number for text',
        { filters: [{ field: 'status', op: 'eq', value: 7 }] },
        'invalid_value',
      ],
    ] as const)('%s', async (_name, overrides, code) => {
      await expectRejected(
        compileRuntimeReportSpec(spec(overrides as never), context()),
        code,
      );
    });
  });

  describe('injection-style negative cases', () => {
    const payloads = [
      "paid'; DROP TABLE rt_invoices; --",
      "' OR '1'='1",
      '" OR ""="',
      '%',
      '_',
      '\\',
      '1; SELECT * FROM users',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: injection payload
      '${process.exit(1)}',
      '{{7*7}}',
      "paid' UNION SELECT internal_note FROM rt_invoices --",
    ];

    it.each(
      payloads,
    )('filter value %j is a bound parameter, not SQL', async (payload) => {
      const compiled = await compileRuntimeReportSpec(
        spec({ filters: [{ field: 'status', op: 'eq', value: payload }] }),
        context(),
      );
      const result = await runRuntimeReport(compiled, { db });
      expect(result.rows).toEqual([]);
      const survivors = await db.query('SELECT COUNT(*) AS n FROM rt_invoices');
      expect(Number((survivors.rows[0] as { n: unknown }).n)).toBe(6);
    });

    it.each(
      payloads,
    )('contains/in values %j are bound and literal', async (payload) => {
      const contains = await runRuntimeReport(
        await compileRuntimeReportSpec(
          spec({
            filters: [{ field: 'status', op: 'contains', value: payload }],
          }),
          context(),
        ),
        { db },
      );
      expect(contains.rows).toEqual([]);
      const inList = await runRuntimeReport(
        await compileRuntimeReportSpec(
          spec({
            filters: [{ field: 'status', op: 'in', value: [payload, 'open'] }],
          }),
          context(),
        ),
        { db },
      );
      expect(inList.rows).toEqual([
        { status: 'open', revenue: 5000, invoices: 1 },
      ]);
    });

    it('a % in contains matches literally, not as a wildcard', async () => {
      const { result } = await run({
        filters: [{ field: 'status', op: 'contains', value: '%' }],
      });
      expect(result.rows).toEqual([]);
      const { result: literal } = await run({
        filters: [{ field: 'status', op: 'contains', value: 'pai' }],
      });
      expect(literal.rows).toHaveLength(1);
    });

    it('output aliases cannot shadow or probe source columns', async () => {
      // `internal_note`/`api_token` are real hidden columns. A same-named
      // alias must stay a plain output label, never resolve to the column.
      const { compiled, result } = await run({
        dimensions: [{ field: 'status', as: 'internal_note' }],
        measures: [{ fn: 'count', as: 'api_token' }],
      });
      expect(JSON.stringify(compiled.aggregate)).not.toContain(
        '"internal_note"',
      );
      expect(result.rows[0]).toEqual({ internal_note: 'open', api_token: 1 });
      expect(JSON.stringify(result)).not.toMatch(/SECRET-NOTE|TOKEN-123/);
    });

    it('the plan contains only registry-derived identifiers', async () => {
      const compiled = await compileRuntimeReportSpec(
        spec({
          filters: [{ field: 'status', op: 'eq', value: "x'; --" }],
          sort: [{ by: 'revenue', direction: 'desc' }],
        }),
        context(),
      );
      const identifier = /^(r_[a-z0-9_]+|[a-z_][a-z0-9_]*)$/;
      expect(compiled.aggregate.from).toBe('rt_invoices');
      for (const expr of compiled.aggregate.select) {
        expect(expr.as ?? '').toMatch(identifier);
        if ('column' in expr && expr.column)
          expect(expr.column).toMatch(identifier);
      }
      for (const key of (
        compiled.aggregate.where as Record<string, unknown>[][]
      )[0].flatMap((condition) => Object.keys(condition))) {
        expect(key.split(' ')[0]).toMatch(identifier);
      }
    });
  });
});

/** The confirmed-save path, as the application's confirmation host drives it. */
function saveConfirmed(
  options: Omit<Parameters<typeof saveRuntimeReport>[0], 'confirmedSpecHash'>,
): Promise<RuntimeReport> {
  return saveRuntimeReport({
    ...options,
    confirmedSpecHash: options.compiled.specHash,
  });
}

async function rowCount(): Promise<number> {
  const out = await db.query('SELECT COUNT(*) AS n FROM runtime_reports');
  return Number((out.rows[0] as { n: unknown }).n);
}

async function storedSpecHash(id: string): Promise<unknown> {
  const out = await db.query(
    'SELECT spec_hash FROM runtime_reports WHERE id = $1',
    id,
  );
  return (out.rows[0] as { spec_hash: unknown }).spec_hash;
}

describe('RuntimeReport storage', () => {
  async function compile(overrides: Record<string, unknown> = {}) {
    return compileRuntimeReportSpec(spec(overrides), context());
  }

  it('saves a compiled spec and lists/gets it within the tenant', async () => {
    const saved = await withTenant({ tenantId: TENANT_A }, async () =>
      saveConfirmed({
        db,
        compiled: await compile(),
        createdByUserId: USER,
      }),
    );
    expect(saved.id).toBeTruthy();
    expect(saved.tenantId).toBe(TENANT_A);
    expect(saved.status).toBe('active');

    const listA = await withTenant({ tenantId: TENANT_A }, () =>
      listRuntimeReports({ db }),
    );
    expect(listA.map((r) => r.id)).toEqual([saved.id]);
    expect(listA[0].getSpec().title).toBe('Revenue by status');

    const listB = await withTenant({ tenantId: TENANT_B }, () =>
      listRuntimeReports({ db }),
    );
    expect(listB).toEqual([]);
    const crossGet = await withTenant({ tenantId: TENANT_B }, () =>
      getRuntimeReport({ db, ref: saved.id as string }),
    );
    expect(crossGet).toBeNull();
  });

  it('requires a tenant to save', async () => {
    await expectRejected(
      saveConfirmed({
        db,
        compiled: await compileRuntimeReportSpec(
          spec(),
          context({ tenantId: null }),
        ),
        createdByUserId: USER,
        tenantId: null,
      }),
      'tenant_required',
    );
  });

  it('refuses tampered or inconsistent rows at save time', async () => {
    const saved = await withTenant({ tenantId: TENANT_A }, async () =>
      saveConfirmed({
        db,
        compiled: await compile(),
        createdByUserId: USER,
      }),
    );
    await withTenant({ tenantId: TENANT_A }, async () => {
      const row = (await getRuntimeReport({
        db,
        ref: saved.id as string,
      })) as RuntimeReport;
      row.spec = JSON.stringify({ ...JSON.parse(row.spec), where: '1=1' });
      await expectSaveCause(row.save(), /not a known key/);

      // A spec change on a stored row is a different report: it needs the
      // confirmed-save path, so the edit is refused and the row is unchanged.
      const row2 = (await getRuntimeReport({
        db,
        ref: saved.id as string,
      })) as RuntimeReport;
      row2.spec = row2.spec.replace('Revenue by status', 'Renamed');
      await expectSaveCause(row2.save(), /confirmed save/);
      expect(await storedSpecHash(saved.id as string)).toBe(saved.specHash);

      // Denormalized columns are re-derived from the spec, never trusted from
      // the writer, so setting them to something else changes nothing.
      const row3 = (await getRuntimeReport({
        db,
        ref: saved.id as string,
      })) as RuntimeReport;
      row3.title = 'Different title';
      row3.sourceId = 'users';
      await row3.save();
      expect(row3.title).toBe('Revenue by status');
      expect(row3.sourceId).toBe('invoices');
    });
  });

  describe('confirmed-save invariant (model layer)', () => {
    const body = () => {
      const normalized = spec();
      return {
        tenantId: TENANT_A,
        title: normalized.title,
        description: '',
        sourceId: normalized.source,
        spec: serializeRuntimeReportSpec(normalized),
        specHash: runtimeReportSpecHash(normalized),
        status: 'active' as const,
        createdByUserId: USER,
      };
    };

    it('refuses a directly constructed valid row and writes nothing', async () => {
      await withTenant({ tenantId: TENANT_A }, async () => {
        const report = new RuntimeReport({ db, _skipLoad: true, ...body() });
        await report.initialize();
        await expectSaveCause(report.save(), /confirmed save/);
      });
      expect(await rowCount()).toBe(0);
    });

    it('refuses collection create (the generated REST create path) and writes nothing', async () => {
      await withTenant({ tenantId: TENANT_A }, async () => {
        const collection = (await ObjectRegistry.getCollection(
          'RuntimeReport',
          {
            db,
          },
        )) as { create(values: Record<string, unknown>): Promise<unknown> };
        await expectSaveCause(collection.create(body()), /confirmed save/);
        // A JSON round trip of a legitimately saved row cannot carry the proof.
        const saved = await saveConfirmed({
          db,
          compiled: await compile(),
          createdByUserId: USER,
        });
        const cloned = JSON.parse(JSON.stringify(saved));
        delete cloned.id;
        delete cloned.slug;
        await expectSaveCause(collection.create(cloned), /confirmed save/);
      });
      expect(await rowCount()).toBe(1);
    });

    it('refuses an insert that reuses an existing id to overwrite its spec', async () => {
      const saved = await withTenant({ tenantId: TENANT_A }, async () =>
        saveConfirmed({
          db,
          compiled: await compile(),
          createdByUserId: USER,
        }),
      );
      await withTenant({ tenantId: TENANT_A }, async () => {
        const forged = new RuntimeReport({
          db,
          _skipLoad: true,
          ...body(),
          id: saved.id,
          spec: serializeRuntimeReportSpec(spec({ title: 'Forged' })),
        });
        await forged.initialize();
        await expectSaveCause(forged.save(), /confirmed save/);
      });
      expect(await rowCount()).toBe(1);
      expect(await storedSpecHash(saved.id as string)).toBe(saved.specHash);
    });

    it('refuses collection.update of the spec and of the author', async () => {
      const saved = await withTenant({ tenantId: TENANT_A }, async () =>
        saveConfirmed({
          db,
          compiled: await compile(),
          createdByUserId: USER,
        }),
      );
      await withTenant({ tenantId: TENANT_A }, async () => {
        const collection = (await ObjectRegistry.getCollection(
          'RuntimeReport',
          {
            db,
          },
        )) as {
          update(id: string, values: Record<string, unknown>): Promise<unknown>;
        };
        await expectSaveCause(
          collection.update(saved.id as string, {
            spec: serializeRuntimeReportSpec(spec({ title: 'Edited' })),
          }),
          /confirmed save/,
        );
        await expectSaveCause(
          collection.update(saved.id as string, {
            createdByUserId: 'someone-else',
          }),
          /confirmed save/,
        );
      });
      expect(await storedSpecHash(saved.id as string)).toBe(saved.specHash);
    });

    it('still allows archive and unarchive (status only) by an authorised writer', async () => {
      const saved = await withTenant({ tenantId: TENANT_A }, async () =>
        saveConfirmed({
          db,
          compiled: await compile(),
          createdByUserId: USER,
        }),
      );
      await withTenant({ tenantId: TENANT_A }, async () => {
        const archived = await archiveRuntimeReport({
          db,
          ref: saved.id as string,
        });
        expect(archived?.status).toBe('archived');
        const again = (await getRuntimeReport({
          db,
          ref: saved.id as string,
        })) as RuntimeReport;
        again.status = 'active';
        await again.save();
        expect(again.status).toBe('active');
      });
      expect(await storedSpecHash(saved.id as string)).toBe(saved.specHash);
    });

    it('refuses a confirmation for a different spec hash and writes nothing', async () => {
      const compiled = await compile();
      await expectRejected(
        withTenant({ tenantId: TENANT_A }, () =>
          saveRuntimeReport({
            db,
            compiled,
            createdByUserId: USER,
            confirmedSpecHash: 'f'.repeat(64),
          }),
        ),
        'confirmation_required',
      );
      expect(await rowCount()).toBe(0);
    });

    it('mints a proof per write: a later save of the same instance with a new spec is refused', async () => {
      const saved = await withTenant({ tenantId: TENANT_A }, async () =>
        saveConfirmed({
          db,
          compiled: await compile(),
          createdByUserId: USER,
        }),
      );
      saved.spec = serializeRuntimeReportSpec(spec({ title: 'Second' }));
      await withTenant({ tenantId: TENANT_A }, () =>
        expectSaveCause(saved.save(), /confirmed save/),
      );
    });
  });

  it('detects out-of-band edits to the stored spec on read', async () => {
    const saved = await withTenant({ tenantId: TENANT_A }, async () =>
      saveConfirmed({
        db,
        compiled: await compile(),
        createdByUserId: USER,
      }),
    );
    await db.query(
      'UPDATE runtime_reports SET spec = REPLACE(spec, $1, $2) WHERE id = $3',
      '"limit":100',
      '"limit":900',
      saved.id,
    );
    await withTenant({ tenantId: TENANT_A }, async () => {
      const report = (await getRuntimeReport({
        db,
        ref: saved.id as string,
      })) as RuntimeReport;
      expect(() => report.getSpec()).toThrow(/hash/);
      await expectRejected(
        runStoredRuntimeReport({ db, report, context: context() }),
        'invalid_spec',
      );
    });
  });

  it('refuses a plan whose spec does not match its hash', async () => {
    const compiled: CompiledRuntimeReport = {
      ...(await compile()),
      specHash: 'f'.repeat(64),
    };
    await expectRejected(
      withTenant({ tenantId: TENANT_A }, () =>
        saveConfirmed({ db, compiled, createdByUserId: USER }),
      ),
      'invalid_spec',
    );
  });

  it('re-validates against the live principal on every run', async () => {
    const saved = await withTenant({ tenantId: TENANT_A }, async () =>
      saveConfirmed({
        db,
        compiled: await compileRuntimeReportSpec(
          spec({
            dimensions: [],
            measures: [{ fn: 'sum', field: 'margin', as: 'total_margin' }],
          }),
          context({ permissions: ['finance.margins'] }),
        ),
        createdByUserId: USER,
      }),
    );
    await withTenant({ tenantId: TENANT_A }, async () => {
      const report = (await getRuntimeReport({
        db,
        ref: saved.id as string,
      })) as RuntimeReport;
      const allowed = await runStoredRuntimeReport({
        db,
        report,
        context: context({ permissions: ['finance.margins'] }),
      });
      expect(allowed.rows[0].total_margin).toBe(17);
      // Same stored report, viewer without the permission: refused.
      await expectRejected(
        runStoredRuntimeReport({ db, report, context: context() }),
        'unknown_field',
      );
      // Source no longer offered to this host: refused.
      await expectRejected(
        runStoredRuntimeReport({
          db,
          report,
          context: context({ sources: [], permissions: ['finance.margins'] }),
        }),
        'unknown_source',
      );
    });
  });

  it('archives and refuses to run archived reports', async () => {
    const saved = await withTenant({ tenantId: TENANT_A }, async () =>
      saveConfirmed({
        db,
        compiled: await compile(),
        createdByUserId: USER,
      }),
    );
    await withTenant({ tenantId: TENANT_A }, async () => {
      const archived = await archiveRuntimeReport({
        db,
        ref: saved.id as string,
      });
      expect(archived?.status).toBe('archived');
      expect(await listRuntimeReports({ db })).toEqual([]);
      expect(await listRuntimeReports({ db, status: 'archived' })).toHaveLength(
        1,
      );
      await expectRejected(
        runStoredRuntimeReport({
          db,
          report: archived as RuntimeReport,
          context: context(),
        }),
        'invalid_spec',
        'status',
      );
    });
  });
});
