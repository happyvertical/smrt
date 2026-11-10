/**
 * #4441: a declared join from a text column (a polymorphic work reference) to
 * the joined model's uuid `id` failed on PostgreSQL with `operator does not
 * exist: text = uuid`. The tables here are created by the real schema path
 * (`getTestDatabase` builds them from the registered fields), so `id` is a
 * native uuid where the dialect has one. Named `*.optional.test.ts` so the
 * package's `test:postgres` script runs it; PostgreSQL skips without a server.
 */
import {
  GlobalInterceptors,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReportDefinition, compileReportDefinition } from '../compiler.js';
import { refreshReport } from '../refresh.js';
import { SmrtReport } from '../report.js';

class TypedJoinWorkOrder extends SmrtObject {}
class TypedJoinSegment extends SmrtObject {}
class TypedJoinTextRefReport extends SmrtReport {}
class TypedJoinForeignKeyReport extends SmrtReport {}

const WORK_ORDERS = 'typed_join_work_orders';
const SEGMENTS = 'typed_join_segments';
const TEXT_REF_REPORT = 'typed_join_text_ref_reports';
const FOREIGN_KEY_REPORT = 'typed_join_foreign_key_reports';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const WO_GATE = 'aaaaaaaa-0000-4000-8000-000000000001';
const WO_GONE = 'aaaaaaaa-0000-4000-8000-000000000002';
const WO_THEIRS = 'aaaaaaaa-0000-4000-8000-000000000003';

const tenancy = {
  type: 'foreignKey',
  related: 'Tenant',
  nullable: true,
  _meta: {
    sqlType: 'UUID',
    __tenancy: { isTenantIdField: true, mode: 'optional' },
  },
};

function field(className: string, name: string, options: object) {
  ObjectRegistry.registerFieldDecorator(className, name, options as never);
}

function registerModels() {
  for (const name of [
    'TypedJoinWorkOrder',
    'TypedJoinSegment',
    'TypedJoinTextRefReport',
    'TypedJoinForeignKeyReport',
  ]) {
    field(name, 'tenantId', tenancy);
  }
  field('TypedJoinWorkOrder', 'title', { type: 'text' });
  field('TypedJoinWorkOrder', 'deletedAt', {
    type: 'datetime',
    nullable: true,
  });
  // A polymorphic reference: plain text, so `text` in the migrated schema.
  field('TypedJoinSegment', 'workRefId', { type: 'text', nullable: true });
  // A declared reference: a native uuid like the id it references. (A
  // crossPackageRef, so DuckDB is not asked for an ON UPDATE CASCADE key.)
  field('TypedJoinSegment', 'workOrderId', {
    type: 'crossPackageRef',
    related: 'TypedJoinWorkOrder',
    nullable: true,
  });
  field('TypedJoinSegment', 'hours', { type: 'decimal' });

  const report = (name: string, key: string) => {
    field(name, key, { type: 'text', __report: { kind: 'group' } });
    field(name, 'workTitle', {
      type: 'text',
      __report: { kind: 'group', sourceColumn: 'wo.title' },
    });
    field(name, 'hours', {
      type: 'decimal',
      __report: { kind: 'aggregate', fn: 'sum', column: 'hours' },
    });
  };
  report('TypedJoinTextRefReport', 'workRefId');
  report('TypedJoinForeignKeyReport', 'workOrderId');

  ObjectRegistry.register(TypedJoinWorkOrder, {
    tableName: WORK_ORDERS,
    tenantScoped: { mode: 'optional' },
  });
  ObjectRegistry.register(TypedJoinSegment, {
    tableName: SEGMENTS,
    tenantScoped: { mode: 'optional' },
  });
  ObjectRegistry.register(TypedJoinTextRefReport, {
    tableName: TEXT_REF_REPORT,
    tenantScoped: { mode: 'optional' },
    report: {
      source: 'TypedJoinSegment',
      joins: { wo: { source: 'TypedJoinWorkOrder', on: 'workRefId' } },
    },
  });
  ObjectRegistry.register(TypedJoinForeignKeyReport, {
    tableName: FOREIGN_KEY_REPORT,
    tenantScoped: { mode: 'optional' },
    report: {
      source: 'TypedJoinSegment',
      joins: { wo: { source: 'TypedJoinWorkOrder', on: 'workOrderId' } },
    },
  });
}

const keyCondition = (spec: ReturnType<typeof compileReportDefinition>) => {
  const on = spec.joins?.[0]?.on as { operands?: unknown[] } | undefined;
  return on?.operands;
};

for (const type of ['sqlite', 'duckdb', 'postgres'] as const) {
  const suite =
    type === 'postgres' && !isPostgresAvailable() ? describe.skip : describe;

  suite(`report joins across key types (${type}, #4441)`, () => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      ObjectRegistry.clear();
      GlobalInterceptors.clear();
      registerModels();
      db = await getTestDatabase({
        type,
        url: type === 'postgres' ? process.env.DATABASE_URL : ':memory:',
        classes: [
          'TypedJoinWorkOrder',
          'TypedJoinSegment',
          'TypedJoinTextRefReport',
          'TypedJoinForeignKeyReport',
        ],
      });

      const workOrder = (id: string, tenantId: string, title: string) => ({
        id,
        slug: id,
        context: '',
        tenant_id: tenantId,
        title,
        deleted_at: null as string | null,
      });
      await db.insert(WORK_ORDERS, workOrder(WO_GATE, TENANT_A, 'Gate'));
      await db.insert(WORK_ORDERS, {
        ...workOrder(WO_GONE, TENANT_A, 'Gone'),
        deleted_at: '2026-01-03T00:00:00.000Z',
      });
      // The same work order id is not reachable from another tenant's rows.
      await db.insert(WORK_ORDERS, workOrder(WO_THEIRS, TENANT_B, 'Theirs'));

      let n = 0;
      const segment = (
        workRefId: string | null,
        workOrderId: string | null,
        hours: number,
      ) => {
        n += 1;
        const id = `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
        return db.insert(SEGMENTS, {
          id,
          slug: id,
          context: '',
          tenant_id: TENANT_A,
          work_ref_id: workRefId,
          work_order_id: workOrderId,
          hours,
        });
      };
      await segment(WO_GATE, WO_GATE, 2);
      await segment(WO_GATE, WO_GATE, 3);
      // Not a uuid: a shop task, not a work order. Matches nothing.
      await segment('shop-cleanup', null, 1.5);
      await segment(WO_GONE, WO_GONE, 4);
      await segment(WO_THEIRS, null, 8);
      await segment(null, null, 0.5);
    }, 60_000);

    afterEach(async () => {
      try {
        if (type === 'postgres') {
          for (const table of [
            TEXT_REF_REPORT,
            FOREIGN_KEY_REPORT,
            SEGMENTS,
            WORK_ORDERS,
          ]) {
            await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
          }
        }
      } finally {
        await db?.close?.();
        disableTenancy();
        GlobalInterceptors.clear();
        ObjectRegistry.clear();
      }
    });

    const rows = async (table: string, key: string) =>
      (
        await db.query(
          `SELECT CAST(${key} AS TEXT) AS ref, work_title, hours FROM ${table}`,
        )
      ).rows
        .map((row) => [
          row.ref ?? null,
          row.work_title ?? null,
          Number(row.hours),
        ])
        .sort((a, b) => Number(b[2]) - Number(a[2]));

    it.runIf(type === 'postgres')(
      'migrates the reference as text and the joined id as uuid',
      async () => {
        const { rows: columns } = await db.query(
          `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_name IN ('${WORK_ORDERS}', '${SEGMENTS}')
           AND column_name IN ('id', 'work_ref_id', 'work_order_id')`,
        );
        const typeOf = (table: string, column: string) =>
          columns.find(
            (row) => row.table_name === table && row.column_name === column,
          )?.data_type;
        expect(typeOf(WORK_ORDERS, 'id')).toBe('uuid');
        expect(typeOf(SEGMENTS, 'work_ref_id')).toBe('text');
        expect(typeOf(SEGMENTS, 'work_order_id')).toBe('uuid');
      },
    );

    it('rebuilds a text reference joined to a uuid id; a non-uuid reference matches nothing', async () => {
      await refreshReport(TypedJoinTextRefReport, {
        db,
        tenantId: TENANT_A,
        lock: false,
        trackRuns: false,
        // An in-memory DuckDB url reads as SQLite, so say which it is.
        adapterType: type,
      });

      expect(await rows(TEXT_REF_REPORT, 'work_ref_id')).toEqual([
        // Another tenant's work order never matches.
        [WO_THEIRS, null, 8],
        [WO_GATE, 'Gate', 5],
        // A soft-deleted work order never matches.
        [WO_GONE, null, 4],
        ['shop-cleanup', null, 1.5],
        [null, null, 0.5],
      ]);
    });

    it('compares the text reference as text, and only where the dialect needs it', async () => {
      const definition = await buildReportDefinition(TypedJoinTextRefReport);
      expect(definition.joins?.[0]?.keyAsText).toBe(true);
      // tenant_id is a uuid on both sides, so it is compared as it is.
      expect(definition.joins?.[0]?.tenantColumns?.asText).toBeUndefined();

      const castKey = {
        op: 'eq',
        left: { op: 'asText', operand: { col: 'src.work_ref_id' } },
        right: { op: 'asText', operand: { col: 'wo.id' } },
      };
      const plainKey = {
        op: 'eq',
        left: { col: 'src.work_ref_id' },
        right: { col: 'wo.id' },
      };
      const tenant = {
        op: 'eq',
        left: { col: 'src.tenant_id' },
        right: { col: 'wo.tenant_id' },
      };
      const notDeleted = { op: 'isNull', operand: { col: 'wo.deleted_at' } };
      expect(keyCondition(compileReportDefinition(definition, type))).toEqual([
        type === 'sqlite' ? plainKey : castKey,
        tenant,
        notDeleted,
      ]);
    });

    it('leaves a same-typed (uuid = uuid) join uncast', async () => {
      const definition = await buildReportDefinition(TypedJoinForeignKeyReport);
      expect(definition.joins?.[0]?.keyAsText).toBeUndefined();
      expect(
        keyCondition(compileReportDefinition(definition, type))?.[0],
      ).toEqual({
        op: 'eq',
        left: { col: 'src.work_order_id' },
        right: { col: 'wo.id' },
      });

      await refreshReport(TypedJoinForeignKeyReport, {
        db,
        tenantId: TENANT_A,
        lock: false,
        trackRuns: false,
        // An in-memory DuckDB url reads as SQLite, so say which it is.
        adapterType: type,
      });
      // Titles and hours only: a uuid group key materialised into a report on
      // DuckDB is a separate matter from the join.
      expect(
        (await rows(FOREIGN_KEY_REPORT, 'work_order_id')).map((row) =>
          row.slice(1),
        ),
      ).toEqual([
        [null, 10],
        ['Gate', 5],
        [null, 4],
      ]);
    });
  });
}
