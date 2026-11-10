import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { createHmacDurableJobPayloadSigner } from '@happyvertical/smrt-jobs';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { SmrtReport } from '../report.js';
import {
  ensureReportRefreshSchedules,
  ReportScheduleRunner,
  registerReportRefreshJobIntegritySigner,
  SmrtReportRefreshTask,
} from '../scheduler.js';

class ScheduleDialectSource extends SmrtObject {}
class ScheduleDialectReport extends SmrtReport {}
const SOURCE = 'schedule_dialect_sources';
const REPORT = 'schedule_dialect_reports';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function registerModels() {
  for (const name of ['ScheduleDialectSource', 'ScheduleDialectReport']) {
    ObjectRegistry.registerFieldDecorator(name, 'tenantId', {
      type: 'text',
      _meta: { __tenancy: { isTenantIdField: true, mode: 'optional' } },
    });
    ObjectRegistry.registerFieldDecorator(name, 'category', {
      type: 'text',
      ...(name === 'ScheduleDialectReport'
        ? { __report: { kind: 'group', sourceColumn: 'category' } }
        : {}),
    });
  }
  ObjectRegistry.registerFieldDecorator('ScheduleDialectSource', 'amount', {
    type: 'integer',
  });
  ObjectRegistry.registerFieldDecorator('ScheduleDialectReport', 'total', {
    type: 'integer',
    __report: { kind: 'aggregate', fn: 'sum', column: 'amount' },
  });
  ObjectRegistry.register(ScheduleDialectSource, {
    tableName: SOURCE,
    tenantScoped: { mode: 'optional' },
  });
  ObjectRegistry.register(ScheduleDialectReport, {
    tableName: REPORT,
    tenantScoped: { mode: 'optional' },
    report: {
      source: 'ScheduleDialectSource',
      refresh: {
        mode: 'rebuild',
        schedule: '* * * * *',
        tenantFanout: 'discover',
      },
    },
  });
}

for (const type of ['sqlite', 'duckdb', 'postgres'] as const) {
  const suite =
    type === 'postgres' && !isPostgresAvailable() ? describe.skip : describe;
  suite(`scheduled report tenant discovery (${type})`, () => {
    it('discovers new tenants and preserves the global slice and schedule history', async () => {
      registerModels();
      const db = await getTestDatabase({
        type,
        url: type === 'postgres' ? process.env.DATABASE_URL : ':memory:',
        classes: [
          'SmrtJob',
          'SmrtJobEvent',
          'SmrtReportSchedule',
          'SmrtReportRefreshTask',
          'SmrtReportRun',
          'SmrtReportWatermark',
          'SmrtReportLock',
        ],
      });
      const signer = createHmacDurableJobPayloadSigner({
        keyId: `scheduler-${type}`,
        key: 'test-only-report-scheduler-integrity-key',
      });
      const unregister = registerReportRefreshJobIntegritySigner(signer);
      const idType = type === 'sqlite' ? 'TEXT' : 'UUID';
      try {
        await db.query(
          `CREATE TABLE ${SOURCE} (id ${idType} PRIMARY KEY, tenant_id ${idType}, category TEXT, amount BIGINT)`,
        );
        await db.query(
          `CREATE TABLE ${REPORT} (id ${idType} PRIMARY KEY, slug TEXT, context TEXT, tenant_id ${idType}, category TEXT, total BIGINT, refreshed_at TEXT, created_at TEXT, updated_at TEXT)`,
        );
        await db.query(
          `CREATE UNIQUE INDEX schedule_dialect_group ON ${REPORT} (tenant_id, category)`,
        );
        await ensureReportRefreshSchedules({
          db,
          reports: [ScheduleDialectReport],
        });
        const first = (
          await db.query(
            'SELECT CAST(id AS TEXT) AS id FROM _smrt_report_schedules',
          )
        ).rows[0];
        await db.update(
          '_smrt_report_schedules',
          { id: first.id },
          {
            run_count: 4,
            running_count: 1,
            success_count: 3,
            failure_count: 1,
            last_error: 'previous failure',
            next_run: '2030-01-01T00:00:00.000Z',
          },
        );
        const before = (await db.query('SELECT * FROM _smrt_report_schedules'))
          .rows;
        await ensureReportRefreshSchedules({
          db,
          reports: [ScheduleDialectReport],
        });
        expect(
          (await db.query('SELECT * FROM _smrt_report_schedules')).rows,
        ).toEqual(before);
        // Exercise the native UUID boundary through the actual scheduler.
        await db.update(
          '_smrt_report_schedules',
          { id: first.id },
          {
            running_count: 0,
            next_run: '2020-01-01T00:00:00.000Z',
          },
        );
        const runner = new ReportScheduleRunner({ integritySigner: signer });
        await runner.initialize(db);
        await runner.poll();
        const jobs = (await db.query('SELECT args FROM _smrt_jobs')).rows;
        expect(jobs).toHaveLength(1);
        const scheduled =
          typeof jobs[0].args === 'string'
            ? JSON.parse(jobs[0].args)
            : jobs[0].args;
        expect(scheduled.scheduleId).toBe(first.id);
        await db.insert(REPORT, {
          id: crypto.randomUUID(),
          tenant_id: null,
          category: 'global',
          total: 99,
        });
        const task = new SmrtReportRefreshTask({ db });
        await task.initialize();
        const args = {
          reportClass: 'ScheduleDialectReport',
          mode: 'rebuild',
          trigger: 'schedule',
          tenantId: null,
          adapterType: type,
        } as const;
        const run = () => task.run({ ...args, integrity: signer.sign(args) });
        expect(await run()).toMatchObject({ rowCount: 0, tenantResults: [] });
        for (const amount of [10, 20]) {
          await db.insert(SOURCE, {
            id: crypto.randomUUID(),
            tenant_id: TENANT_A,
            category: 'a',
            amount,
          });
        }
        expect(await run()).toMatchObject({
          tenantResults: [{ tenantId: TENANT_A, rowCount: 1 }],
        });
        await db.insert(SOURCE, {
          id: crypto.randomUUID(),
          tenant_id: TENANT_B,
          category: 'b',
          amount: 40,
        });
        expect(await run()).toMatchObject({
          tenantResults: [{ tenantId: TENANT_A }, { tenantId: TENANT_B }],
        });
        const rows = (
          await db.query(
            `SELECT category, total FROM ${REPORT} ORDER BY category`,
          )
        ).rows;
        expect(rows.map((row) => [row.category, Number(row.total)])).toEqual([
          ['a', 30],
          ['b', 40],
          ['global', 99],
        ]);
        // A vanished source scope must still clear its materialized rows.
        await db.query(`DELETE FROM ${SOURCE} WHERE tenant_id = $1`, TENANT_A);
        expect(await run()).toMatchObject({
          tenantResults: [
            { tenantId: TENANT_A, rowCount: 0 },
            { tenantId: TENANT_B },
          ],
        });
        expect(
          (await db.query(`SELECT category FROM ${REPORT} ORDER BY category`))
            .rows,
        ).toEqual([{ category: 'b' }, { category: 'global' }]);
        await db.query(`DELETE FROM ${SOURCE}`);
        expect(await run()).toMatchObject({
          tenantResults: [{ tenantId: TENANT_B, rowCount: 0 }],
        });
        expect((await db.query(`SELECT category FROM ${REPORT}`)).rows).toEqual(
          [{ category: 'global' }],
        );
        expect(await run()).toMatchObject({ rowCount: 0, tenantResults: [] });
      } finally {
        unregister();
        await db.query(`DROP TABLE IF EXISTS ${REPORT}`);
        await db.query(`DROP TABLE IF EXISTS ${SOURCE}`);
        await db.close?.();
      }
    }, 60_000);
  });
}
