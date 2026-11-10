import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import {
  createHmacDurableJobPayloadSigner,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import { expect } from 'vitest';
import { SmrtReport } from '../src/report.js';
import {
  ensureReportRefreshSchedules,
  ReportScheduleRunner,
} from '../src/scheduler.js';

class RetryAssociationSource extends SmrtObject {}
class RetryAssociationReport extends SmrtReport {}
const sourceTable = 'retry_association_sources';
const reportTable = 'retry_association_reports';
function registerModels() {
  ObjectRegistry.registerFieldDecorator('RetryAssociationSource', 'amount', {
    type: 'integer',
  });
  ObjectRegistry.registerFieldDecorator('RetryAssociationSource', 'category', {
    type: 'text',
  });
  ObjectRegistry.registerFieldDecorator('RetryAssociationReport', 'category', {
    type: 'text',
    __report: { kind: 'group', sourceColumn: 'category' },
  });
  ObjectRegistry.registerFieldDecorator('RetryAssociationReport', 'total', {
    type: 'integer',
    __report: { kind: 'aggregate', fn: 'sum', column: 'amount' },
  });
  ObjectRegistry.register(RetryAssociationSource, { tableName: sourceTable });
  ObjectRegistry.register(RetryAssociationReport, {
    tableName: reportTable,
    report: {
      source: 'RetryAssociationSource',
      refresh: { mode: 'rebuild', schedule: '* * * * *' },
    },
  });
}

export const reportAgentTableCases = [
  'absent',
  'unrelated-id',
  'same-id-wrong-target',
] as const;
export async function proveReportScheduleRetry(
  type: 'sqlite' | 'duckdb' | 'postgres',
  agentTable: (typeof reportAgentTableCases)[number],
  url?: string,
): Promise<void> {
  registerModels();
  const db = await getTestDatabase({
    type,
    url: url ?? ':memory:',
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
  const runner = new ReportScheduleRunner({
    integritySigner: createHmacDurableJobPayloadSigner({
      keyId: 'reports-retry-test',
      key: 'synthetic-report-retry-test-integrity-key',
    }),
  });
  let primaryFailure: { cause: unknown } | undefined;
  const cleanupFailures: unknown[] = [];
  try {
    const idType = type === 'sqlite' ? 'TEXT' : 'UUID';
    await db.query(
      `CREATE TABLE ${sourceTable} (id ${idType} PRIMARY KEY, category TEXT, amount BIGINT)`,
    );
    await db.query(
      `CREATE TABLE ${reportTable} (id ${idType} PRIMARY KEY, slug TEXT, context TEXT, category TEXT,total BIGINT,refreshed_at TEXT,created_at TEXT,updated_at TEXT)`,
    );
    await ensureReportRefreshSchedules({
      db,
      reports: [RetryAssociationReport],
    });
    const schedule = (
      await db.query(
        'SELECT CAST(id AS TEXT) AS id FROM _smrt_report_schedules',
      )
    ).rows[0];
    expect(schedule.id).toBeTruthy();
    await db.update(
      '_smrt_report_schedules',
      { id: schedule.id },
      { next_run: '2020-01-01T00:00:00.000Z' },
    );
    await runner.initialize(db);
    await runner.poll();
    const jobs = await SmrtJobCollection.create({ db });
    const [job] = await jobs.list({ limit: 10 });
    expect(job).toBeDefined();
    expect(job.args._scheduleId).toBe(schedule.id);
    expect(job.args.scheduleId).toBe(schedule.id);
    expect(job.args).not.toHaveProperty('_scheduledFor');
    const originalArgs = JSON.stringify(job.args),
      originalType = job.objectType;
    expect(await db.tableExists('_smrt_agent_schedules')).toBe(false);
    if (agentTable !== 'absent') {
      await db.query(
        `CREATE TABLE _smrt_agent_schedules (id ${idType} PRIMARY KEY,tenant_id ${idType},agent_type TEXT,agent_id TEXT,method TEXT,running_count INTEGER,max_concurrent INTEGER)`,
      );
      await db.insert('_smrt_agent_schedules', {
        id:
          agentTable === 'unrelated-id'
            ? '88888888-8888-4888-8888-888888888888'
            : schedule.id,
        tenant_id: null,
        agent_type: 'UnrelatedAgent',
        agent_id: null,
        method: 'run',
        running_count: 7,
        max_concurrent: 1,
      });
    }
    await job.cancel();
    await job.retry();
    const loaded = await jobs.get({ id: job.id }, { cache: false });
    expect(loaded?.status).toBe('pending');
    expect(loaded?.objectType).toBe(originalType);
    expect(JSON.stringify(loaded?.args)).toBe(originalArgs);
    // A missing-table probe must never leave a PostgreSQL caller transaction aborted.
    await job.cancel();
    if (!db.transaction)
      throw new Error('Report retry fixture requires transactions');
    await db.transaction(async (tx) => {
      await job.retry({ transaction: tx });
      expect((await tx.query('SELECT 1 AS probe')).rows[0].probe).toBe(1);
    });
    const retried = await jobs.get({ id: job.id }, { cache: false });
    expect(retried?.status).toBe('pending');
    expect(JSON.stringify(retried?.args)).toBe(originalArgs);
    await job.cancel();
    await expect(
      db.transaction(async (tx) => {
        await job.retry({ transaction: tx });
        expect((await tx.query('SELECT 1 AS probe')).rows[0].probe).toBe(1);
        throw new Error('caller report retry rollback');
      }),
    ).rejects.toThrow('caller report retry rollback');
    const rolledBack = await jobs.get({ id: job.id }, { cache: false });
    expect(rolledBack?.status).toBe('cancelled');
    expect(JSON.stringify(rolledBack?.args)).toBe(originalArgs);
    await rolledBack?.retry();

    if (agentTable !== 'absent')
      expect(
        (await db.query('SELECT running_count FROM _smrt_agent_schedules'))
          .rows[0].running_count,
      ).toBe(7);
  } catch (error) {
    primaryFailure = { cause: error };
  } finally {
    try {
      await runner.stop();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await db.close?.();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      primaryFailure
        ? [primaryFailure.cause, ...cleanupFailures]
        : cleanupFailures,
      'Report retry fixture cleanup failed',
      { cause: primaryFailure?.cause },
    );
  if (primaryFailure) throw primaryFailure.cause;
}
