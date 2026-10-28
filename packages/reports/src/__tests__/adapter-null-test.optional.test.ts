/**
 * Null tests on materialized report reads (#4448). A nullable report column
 * declares `isNull`/`isNotNull`; a NOT NULL one does not. The SQLite lane
 * always runs; the PostgreSQL lane runs under the package's `test:postgres`
 * script (`DATABASE_URL`), which is why the file is `*.optional.test.ts`.
 */
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import type { DataQueryFilter } from '@happyvertical/smrt-types';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildReportAdapterDescriptor,
  queryReportMaterializedRows,
} from '../adapter.js';
import { reportDefinitionFingerprint } from '../views.js';

class NullTestShiftReport extends SmrtObject {}

const TABLE = 'null_test_shift_reports';

function registerFixture(): void {
  ObjectRegistry.registerFromManifest(
    'NullTestShiftSource',
    {
      className: 'NullTestShiftSource',
      fields: {},
      methods: {},
      decoratorConfig: { tableName: 'null_test_shift_sources' },
      schema: {
        tableName: 'null_test_shift_sources',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
  ObjectRegistry.registerFromManifest(
    'NullTestShiftReport',
    {
      className: 'NullTestShiftReport',
      fields: {
        employee: {
          type: 'text',
          _meta: { __report: { kind: 'group', sourceColumn: 'employee' } },
        },
        status: {
          type: 'text',
          _meta: { __report: { kind: 'group', sourceColumn: 'status' } },
        },
        lastEndedAt: {
          type: 'datetime',
          _meta: {
            __report: { kind: 'aggregate', fn: 'max', column: 'endedAt' },
          },
        },
        openShifts: {
          type: 'integer',
          _meta: { __report: { kind: 'aggregate', fn: 'count' } },
        },
      },
      methods: {},
      decoratorConfig: {
        tableName: TABLE,
        report: { source: 'NullTestShiftSource', refresh: { manual: true } },
      },
      schema: {
        tableName: TABLE,
        ddl: '',
        columns: {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          slug: { type: 'TEXT' },
          employee: { type: 'TEXT', notNull: true },
          status: { type: 'TEXT' },
          last_ended_at: { type: 'TIMESTAMP' },
          open_shifts: { type: 'INTEGER', notNull: true },
        },
        indexes: [],
        version: 'test',
      },
    } as never,
    '@test/reports',
  );
}

// PostgreSQL ids are native UUIDs.
const ROWS = [
  { employee: 'Ada', status: 'active', last_ended_at: null },
  {
    employee: 'Bo',
    status: 'active',
    last_ended_at: '2026-10-01T17:00:00.000Z',
  },
  { employee: 'Cy', status: 'break', last_ended_at: null },
  { employee: 'Di', status: null, last_ended_at: null },
];

function lane(type: 'sqlite' | 'postgres') {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    ObjectRegistry.clear();
    registerFixture();
    db = await getTestDatabase({
      type,
      url: type === 'postgres' ? process.env.DATABASE_URL : ':memory:',
      classes: ['NullTestShiftReport'],
    });
    for (const row of ROWS) {
      const id = crypto.randomUUID();
      await db.insert(TABLE, { ...row, id, slug: id, open_shifts: 1 });
    }
  });

  afterAll(async () => {
    if (type === 'postgres') await db?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await db?.close?.();
    ObjectRegistry.clear();
  });

  async function employees(filter: DataQueryFilter): Promise<string[]> {
    const result = await queryReportMaterializedRows(
      NullTestShiftReport,
      {
        version: 1,
        requestId: 'null-test',
        mode: 'rows',
        projection: ['id', 'employee'],
        filter,
        sort: [{ field: 'employee', direction: 'asc' }],
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      { db },
    );
    expect(result.total).toEqual({ kind: 'exact', value: result.rows.length });
    return result.rows.map((row) => String(row.employee));
  }

  it('declares null tests only on nullable report columns', async () => {
    const descriptor = await buildReportAdapterDescriptor(NullTestShiftReport);
    const byId = new Map(
      descriptor.schema.fields.map((field) => [field.id, field]),
    );
    for (const id of ['status', 'last_ended_at']) {
      expect(byId.get(id)?.filterOperators, id).toEqual(
        expect.arrayContaining(['isNull', 'isNotNull']),
      );
    }
    for (const id of ['id', 'employee', 'open_shifts']) {
      expect(byId.get(id)?.filterOperators, id).not.toContain('isNull');
    }
  });

  it('leaves the null tests out of the definition fingerprint', async () => {
    const descriptor = await buildReportAdapterDescriptor(NullTestShiftReport);
    const strip = (operators?: string[]) =>
      operators?.filter((operator) => !operator.startsWith('is'));
    const withoutNullTests = {
      ...descriptor,
      columns: descriptor.columns.map((column) => ({
        ...column,
        filterOperators: strip(column.filterOperators),
      })),
      schema: {
        ...descriptor.schema,
        fields: descriptor.schema.fields.map((field) => ({
          ...field,
          filterOperators: strip(field.filterOperators),
        })),
      },
    } as typeof descriptor;
    expect(reportDefinitionFingerprint(descriptor)).toBe(
      reportDefinitionFingerprint(withoutNullTests),
    );
  });

  it('filters materialized rows with isNull, isNotNull, and their negations', async () => {
    expect(
      await employees({
        kind: 'condition',
        field: 'last_ended_at',
        operator: 'isNull',
      }),
    ).toEqual(['Ada', 'Cy', 'Di']);
    expect(
      await employees({
        kind: 'condition',
        field: 'last_ended_at',
        operator: 'isNotNull',
      }),
    ).toEqual(['Bo']);
    expect(
      await employees({
        kind: 'not',
        filter: { kind: 'condition', field: 'status', operator: 'isNotNull' },
      }),
    ).toEqual(['Di']);
  });

  it('combines a status in with an isNull inside all', async () => {
    expect(
      await employees({
        kind: 'all',
        filters: [
          {
            kind: 'condition',
            field: 'status',
            operator: 'in',
            value: ['active', 'break'],
          },
          { kind: 'condition', field: 'last_ended_at', operator: 'isNull' },
        ],
      }),
    ).toEqual(['Ada', 'Cy']);
  });

  it('keeps the report ne as a plain SQL inequality that excludes nulls', async () => {
    // Unlike the collection surfaces, report `ne` is `<>`: a row with no
    // status is UNKNOWN, so Di is not returned. Use isNull to include it.
    expect(
      await employees({
        kind: 'condition',
        field: 'status',
        operator: 'ne',
        value: 'active',
      }),
    ).toEqual(['Cy']);
  });
}

describe('report null tests (#4448, SQLite)', () => lane('sqlite'));

(isPostgresAvailable() ? describe.sequential : describe.skip)(
  'report null tests (#4448, PostgreSQL)',
  () => lane('postgres'),
);
