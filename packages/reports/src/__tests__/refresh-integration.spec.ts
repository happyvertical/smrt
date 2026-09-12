import {
  GlobalInterceptors,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import {
  createHmacDurableJobPayloadSigner,
  createTaskRunner,
} from '@happyvertical/smrt-jobs';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshReport } from '../refresh.js';
import { SmrtReport } from '../report.js';
import {
  enqueueReportRefresh,
  ensureReportRefreshSchedules,
  ReportScheduleRunner,
  registerReportRefreshExecutionAuthorityHost,
  registerReportRefreshInterceptor,
  registerReportRefreshJobIntegritySigner,
  SmrtPrincipalReportRefreshTask,
  SmrtReportRefreshTask,
} from '../scheduler.js';

class IntegrationInvoice extends SmrtObject {}
class IntegrationRevenueReport extends SmrtReport {}
class IntegrationMonthlyRevenueReport extends SmrtReport {}
class IntegrationDefaultWatermarkReport extends SmrtReport {}
class IntegrationPaidRevenueReport extends SmrtReport {}

const SOURCE_TABLE = 'integration_invoices';
const REPORT_TABLE = 'integration_revenue_reports';
const MONTHLY_REPORT_TABLE = 'integration_monthly_revenue_reports';
const DEFAULT_WATERMARK_REPORT_TABLE = 'integration_default_watermark_reports';
const PAID_REPORT_TABLE = 'integration_paid_revenue_reports';
const JOB_SIGNER = createHmacDurableJobPayloadSigner({
  keyId: 'integration-reports-v1',
  key: 'test-only-integration-report-key',
});
let unregisterJobSigner: (() => void) | undefined;

beforeEach(() => {
  ObjectRegistry.clear();
  GlobalInterceptors.clear();
  registerJobsManifest();
  registerIntegrationClasses();
  ObjectRegistry.register(SmrtReportRefreshTask, {
    tableName: '_smrt_report_refresh_tasks',
  });
  ObjectRegistry.register(SmrtPrincipalReportRefreshTask, {
    tableName: '_smrt_principal_report_refresh_tasks',
  });
  unregisterJobSigner = registerReportRefreshJobIntegritySigner(JOB_SIGNER);
});

afterEach(() => {
  unregisterJobSigner?.();
  disableTenancy();
  GlobalInterceptors.clear();
  ObjectRegistry.clear();
});

function registerIntegrationClasses() {
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'tenantId', {
    type: 'foreignKey',
    related: 'Tenant',
    nullable: true,
    _meta: {
      sqlType: 'UUID',
      __tenancy: { isTenantIdField: true, mode: 'optional' },
    },
  });
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'customerId', {
    type: 'text',
  });
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'totalAmount', {
    type: 'decimal',
  });
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'status', {
    type: 'text',
  });
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'updatedAt', {
    type: 'datetime',
  });
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'issuedAt', {
    type: 'datetime',
  });
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'deletedAt', {
    type: 'datetime',
    nullable: true,
  });
  ObjectRegistry.register(IntegrationInvoice, {
    tableName: SOURCE_TABLE,
    tenantScoped: { mode: 'optional' },
  });

  ObjectRegistry.registerFieldDecorator(
    'IntegrationRevenueReport',
    'tenantId',
    {
      type: 'foreignKey',
      related: 'Tenant',
      nullable: true,
      _meta: {
        sqlType: 'UUID',
        __tenancy: { isTenantIdField: true, mode: 'optional' },
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationRevenueReport',
    'customerId',
    {
      type: 'text',
      __report: { kind: 'group', sourceColumn: 'customerId' },
    },
  );
  ObjectRegistry.registerFieldDecorator('IntegrationRevenueReport', 'revenue', {
    type: 'decimal',
    __report: {
      kind: 'aggregate',
      fn: 'sum',
      column: 'totalAmount',
    },
  });
  ObjectRegistry.registerFieldDecorator(
    'IntegrationRevenueReport',
    'avgTotal',
    {
      type: 'decimal',
      __report: {
        kind: 'aggregate',
        fn: 'avg',
        column: 'totalAmount',
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationRevenueReport',
    'invoiceCount',
    {
      type: 'integer',
      __report: { kind: 'aggregate', fn: 'count' },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationRevenueReport',
    'refreshedAt',
    { type: 'datetime' },
  );
  ObjectRegistry.register(IntegrationRevenueReport, {
    tableName: REPORT_TABLE,
    tenantScoped: { mode: 'optional' },
    conflictColumns: ['tenant_id', 'customer_id'],
    report: {
      source: 'IntegrationInvoice',
      refresh: {
        mode: 'incremental',
        onChange: ['IntegrationInvoice'],
        schedule: '* * * * *',
        tenantFanout: true,
        watermarkColumn: 'updatedAt',
        softDeleteColumn: 'deletedAt',
      },
    },
  });

  ObjectRegistry.registerFieldDecorator(
    'IntegrationMonthlyRevenueReport',
    'tenantId',
    {
      type: 'foreignKey',
      related: 'Tenant',
      nullable: true,
      _meta: {
        sqlType: 'UUID',
        __tenancy: { isTenantIdField: true, mode: 'optional' },
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationMonthlyRevenueReport',
    'issuedMonth',
    {
      type: 'datetime',
      __report: {
        kind: 'bucket',
        unit: 'month',
        sourceColumn: 'issuedAt',
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationMonthlyRevenueReport',
    'revenue',
    {
      type: 'decimal',
      __report: {
        kind: 'aggregate',
        fn: 'sum',
        column: 'totalAmount',
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationMonthlyRevenueReport',
    'refreshedAt',
    { type: 'datetime' },
  );
  ObjectRegistry.register(IntegrationMonthlyRevenueReport, {
    tableName: MONTHLY_REPORT_TABLE,
    tenantScoped: { mode: 'optional' },
    conflictColumns: ['tenant_id', 'issued_month'],
    report: {
      source: 'IntegrationInvoice',
      refresh: {
        mode: 'incremental',
        watermarkColumn: 'updatedAt',
        softDeleteColumn: 'deletedAt',
      },
    },
  });

  ObjectRegistry.registerFieldDecorator(
    'IntegrationDefaultWatermarkReport',
    'tenantId',
    {
      type: 'foreignKey',
      related: 'Tenant',
      nullable: true,
      _meta: {
        sqlType: 'UUID',
        __tenancy: { isTenantIdField: true, mode: 'optional' },
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationDefaultWatermarkReport',
    'customerId',
    {
      type: 'text',
      __report: { kind: 'group', sourceColumn: 'customerId' },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationDefaultWatermarkReport',
    'revenue',
    {
      type: 'decimal',
      __report: {
        kind: 'aggregate',
        fn: 'sum',
        column: 'totalAmount',
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationDefaultWatermarkReport',
    'refreshedAt',
    { type: 'datetime' },
  );
  ObjectRegistry.register(IntegrationDefaultWatermarkReport, {
    tableName: DEFAULT_WATERMARK_REPORT_TABLE,
    tenantScoped: { mode: 'optional' },
    conflictColumns: ['tenant_id', 'customer_id'],
    report: {
      source: 'IntegrationInvoice',
      refresh: {
        mode: 'incremental',
      },
    },
  });

  ObjectRegistry.registerFieldDecorator(
    'IntegrationPaidRevenueReport',
    'tenantId',
    {
      type: 'foreignKey',
      related: 'Tenant',
      nullable: true,
      _meta: {
        sqlType: 'UUID',
        __tenancy: { isTenantIdField: true, mode: 'optional' },
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationPaidRevenueReport',
    'customerId',
    {
      type: 'text',
      __report: { kind: 'group', sourceColumn: 'customerId' },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationPaidRevenueReport',
    'revenue',
    {
      type: 'decimal',
      __report: {
        kind: 'aggregate',
        fn: 'sum',
        column: 'totalAmount',
      },
    },
  );
  ObjectRegistry.registerFieldDecorator(
    'IntegrationPaidRevenueReport',
    'refreshedAt',
    { type: 'datetime' },
  );
  ObjectRegistry.register(IntegrationPaidRevenueReport, {
    tableName: PAID_REPORT_TABLE,
    tenantScoped: { mode: 'optional' },
    conflictColumns: ['tenant_id', 'customer_id'],
    report: {
      source: 'IntegrationInvoice',
      where: { status: 'paid' },
      refresh: {
        mode: 'incremental',
        watermarkColumn: 'updatedAt',
        softDeleteColumn: 'deletedAt',
      },
    },
  });
}

function registerJobsManifest() {
  for (const manifestUrl of [
    new URL('../../../jobs/dist/manifest.json', import.meta.url),
    new URL('../../../jobs/.smrt/manifest.json', import.meta.url),
  ]) {
    if (ObjectRegistry.registerPackageManifest(manifestUrl).loaded) return;
  }
}

async function setupDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [],
  });
  await db.query(`
    CREATE TABLE ${SOURCE_TABLE} (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      customer_id TEXT NOT NULL,
      total_amount REAL NOT NULL,
      status TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT,
      refreshed_at TEXT
    )
  `);
  await db.query(`
    CREATE TABLE ${REPORT_TABLE} (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      customer_id TEXT NOT NULL,
      revenue REAL,
      avg_total REAL,
      invoice_count INTEGER,
      refreshed_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(
    `CREATE UNIQUE INDEX ${REPORT_TABLE}_tenant_customer_idx ON ${REPORT_TABLE} (tenant_id, customer_id)`,
  );
  await db.query(`
    CREATE TABLE ${MONTHLY_REPORT_TABLE} (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      issued_month TEXT NOT NULL,
      revenue REAL,
      refreshed_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(
    `CREATE UNIQUE INDEX ${MONTHLY_REPORT_TABLE}_tenant_month_idx ON ${MONTHLY_REPORT_TABLE} (tenant_id, issued_month)`,
  );
  await db.query(`
    CREATE TABLE ${DEFAULT_WATERMARK_REPORT_TABLE} (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      customer_id TEXT NOT NULL,
      revenue REAL,
      refreshed_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(
    `CREATE UNIQUE INDEX ${DEFAULT_WATERMARK_REPORT_TABLE}_tenant_customer_idx ON ${DEFAULT_WATERMARK_REPORT_TABLE} (tenant_id, customer_id)`,
  );
  await db.query(`
    CREATE TABLE ${PAID_REPORT_TABLE} (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      customer_id TEXT NOT NULL,
      revenue REAL,
      refreshed_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(
    `CREATE UNIQUE INDEX ${PAID_REPORT_TABLE}_tenant_customer_idx ON ${PAID_REPORT_TABLE} (tenant_id, customer_id)`,
  );
  await createRuntimeTables(db);
  return db;
}

async function createRuntimeTables(db: DatabaseInterface): Promise<void> {
  await db.query(`
    CREATE TABLE _smrt_jobs (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      queue TEXT NOT NULL DEFAULT 'default',
      object_type TEXT NOT NULL,
      object_id TEXT,
      method TEXT NOT NULL,
      args TEXT,
      run_at TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      timeout INTEGER NOT NULL DEFAULT 300000,
      timeout_behavior TEXT NOT NULL DEFAULT 'fail',
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      result_pointer TEXT,
      retry_strategy TEXT,
      worker_id TEXT,
      worker_heartbeat TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  // SmrtJob is @TenantScoped, so its natural key leads with the tenant
  // column (smrt#2360) — the hand-built table must carry the same unique
  // index the framework schema emits or `save()`'s ON CONFLICT cannot bind.
  await db.query(
    'CREATE UNIQUE INDEX smrt_jobs_slug_context_idx ON _smrt_jobs (tenant_id, slug, context)',
  );
  await db.query(`
    CREATE TABLE _smrt_job_events (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tenant_id TEXT,
      job_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'log',
      level TEXT NOT NULL DEFAULT 'info', stage TEXT, progress INTEGER,
      message TEXT NOT NULL DEFAULT '', data TEXT
    )
  `);
  await db.query(
    'CREATE UNIQUE INDEX smrt_job_events_slug_context_idx ON _smrt_job_events (tenant_id, slug, context)',
  );
  await db.query(`
    CREATE TABLE _smrt_workers (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      worker_id TEXT NOT NULL, pid INTEGER, hostname TEXT, started_at TEXT,
      heartbeat_at TEXT, lease_expires_at TEXT, status TEXT NOT NULL DEFAULT 'running'
    )
  `);
  await db.query(
    'CREATE UNIQUE INDEX smrt_workers_worker_id_idx ON _smrt_workers (worker_id)',
  );
  await db.query(`
    CREATE TABLE _smrt_report_runs (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      scope_key TEXT NOT NULL,
      report_class TEXT NOT NULL,
      source_class TEXT NOT NULL,
      mode TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      row_count INTEGER,
      changed_group_count INTEGER,
      watermark_before TEXT,
      watermark_after TEXT,
      error TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(`
    CREATE TABLE _smrt_report_watermarks (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      scope_key TEXT NOT NULL,
      report_class TEXT NOT NULL,
      source_class TEXT NOT NULL,
      watermark_column TEXT NOT NULL,
      watermark_value TEXT,
      last_run_id TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(
    'CREATE UNIQUE INDEX report_watermarks_key ON _smrt_report_watermarks (report_class, scope_key, source_class, watermark_column)',
  );
  await db.query(`
    CREATE TABLE _smrt_report_locks (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      scope_key TEXT NOT NULL,
      report_class TEXT NOT NULL,
      owner_id TEXT,
      acquired_at TEXT,
      heartbeat_at TEXT,
      expires_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(
    'CREATE UNIQUE INDEX report_locks_key ON _smrt_report_locks (report_class, scope_key)',
  );
  await db.query(`
    CREATE TABLE _smrt_report_schedules (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      scope_key TEXT NOT NULL,
      report_class TEXT NOT NULL,
      cron TEXT NOT NULL,
      trigger TEXT NOT NULL,
      mode TEXT NOT NULL,
      enabled BOOLEAN,
      status TEXT,
      next_run TEXT,
      last_run TEXT,
      last_status TEXT,
      last_error TEXT,
      run_count INTEGER,
      success_count INTEGER,
      failure_count INTEGER,
      running_count INTEGER,
      max_concurrent INTEGER,
      queue TEXT,
      priority INTEGER,
      timeout INTEGER,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await db.query(
    'CREATE UNIQUE INDEX report_schedules_key ON _smrt_report_schedules (report_class, scope_key, cron, mode)',
  );
  await db.query(`
    CREATE TABLE _smrt_report_refresh_tasks (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      report_class TEXT,
      mode TEXT,
      trigger TEXT,
      args TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

async function insertInvoice(
  db: DatabaseInterface,
  row: {
    id: string;
    tenantId?: string | null;
    customerId: string;
    amount: number;
    status?: string;
    issuedAt?: string;
    updatedAt: string;
    deletedAt?: string | null;
  },
): Promise<void> {
  await db.insert(SOURCE_TABLE, {
    id: row.id,
    slug: row.id,
    context: '',
    tenant_id: row.tenantId ?? null,
    customer_id: row.customerId,
    total_amount: row.amount,
    status: row.status ?? 'paid',
    issued_at: row.issuedAt ?? row.updatedAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt ?? null,
    created_at: row.updatedAt,
  });
}

async function reportRows(db: DatabaseInterface) {
  const result = await db.query(
    `SELECT tenant_id, customer_id, revenue, avg_total, invoice_count FROM ${REPORT_TABLE} ORDER BY tenant_id, customer_id`,
  );
  return result.rows;
}

async function monthlyRows(db: DatabaseInterface) {
  const result = await db.query(
    `SELECT tenant_id, issued_month, revenue FROM ${MONTHLY_REPORT_TABLE} ORDER BY tenant_id, issued_month`,
  );
  return result.rows;
}

async function paidRows(db: DatabaseInterface) {
  const result = await db.query(
    `SELECT tenant_id, customer_id, revenue FROM ${PAID_REPORT_TABLE} ORDER BY tenant_id, customer_id`,
  );
  return result.rows;
}

describe('report refresh integration', () => {
  it('reauthorizes principal refreshes delivered by TaskRunner', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'manual-task-baseline',
      tenantId: 'tenant-a',
      customerId: 'customer-baseline',
      amount: 10,
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    await refreshReport(IntegrationRevenueReport, {
      db,
      mode: 'incremental',
      tenantId: 'tenant-a',
      adapterType: 'sqlite',
    });
    await insertInvoice(db, {
      id: 'manual-task-invoice',
      tenantId: 'tenant-a',
      customerId: 'customer-manual',
      amount: 42,
      updatedAt: '2026-03-02T00:00:00.000Z',
    });
    const authorize = vi.fn();
    const audit = vi.fn();
    const unregisterAuthority = registerReportRefreshExecutionAuthorityHost(
      'integration-authority',
      { authorize, audit },
    );
    const taskRunner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['reports'],
      retention: false,
    });
    try {
      const job = await enqueueReportRefresh({
        db,
        reportClass: 'IntegrationRevenueReport',
        trigger: 'manual',
        tenantId: 'tenant-a',
        adapterType: 'sqlite',
        maxAttempts: 1,
        integritySigner: JOB_SIGNER,
        executionAuthority: {
          version: 1,
          hostId: 'integration-authority',
          principal: {
            version: 1,
            actorUserId: 'user-a',
            tenantId: 'tenant-a',
          },
        },
      });
      const persisted = await db.query(
        'SELECT args FROM _smrt_jobs WHERE id = ?',
        job.id,
      );
      const injectedArgs = JSON.parse(String(persisted.rows[0]?.args));
      expect(injectedArgs).toMatchObject({
        reportClass: 'IntegrationRevenueReport',
        mode: 'incremental',
        trigger: 'manual',
        tenantId: 'tenant-a',
      });
      injectedArgs._agentConfig = {
        db: 'attacker-database',
        id: 'attacker-id',
        _skipLoad: true,
        args: {
          reportClass: 'AttackerReport',
          mode: 'rebuild',
          trigger: 'schedule',
          tenantId: 'tenant-b',
        },
        mode: 'rebuild',
        reportClass: 'AttackerReport',
        tenantId: 'tenant-b',
        trigger: 'schedule',
      };
      await db.update(
        '_smrt_jobs',
        { id: job.id },
        { args: JSON.stringify(injectedArgs) },
      );
      await taskRunner.initialize(db);
      const completion = new Promise<{ result?: unknown }>(
        (resolve, reject) => {
          taskRunner.once('job:completed', (_job, result) =>
            resolve(result as { result?: unknown }),
          );
          taskRunner.once('job:failed', (_job, error) => reject(error));
          taskRunner.once('runner:error', reject);
        },
      );
      await taskRunner.start();
      await expect(completion).resolves.toMatchObject({
        result: { tenantId: 'tenant-a', mode: 'incremental' },
      });
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-a',
          tenantId: 'tenant-a',
        }),
        expect.objectContaining({
          phase: 'execute',
          tenantId: 'tenant-a',
          mode: 'incremental',
          trigger: 'manual',
        }),
      );
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'allowed', tenantId: 'tenant-a' }),
      );
    } finally {
      await taskRunner.stop();
      unregisterAuthority();
      await db.close?.();
    }
  });

  it('keeps runner authority out of every persisted MCP argument position', async () => {
    const db = await setupDb();
    const authorize = vi.fn();
    const audit = vi.fn();
    const unregisterAuthority = registerReportRefreshExecutionAuthorityHost(
      'integration-authority',
      { authorize, audit },
    );
    try {
      const forgedContext = {
        job: {
          objectType: 'forged-principal-target',
          method: 'run',
          tenantId: 'tenant-a',
        },
      };
      const variants: Array<{ name: string; tail: unknown[] }> = [
        { name: 'missing', tail: [] },
        // JSON serialization represents an undefined array slot as null.
        { name: 'undefined/null', tail: [undefined] },
        { name: 'forged', tail: [forgedContext] },
        { name: 'forged with extra arguments', tail: [forgedContext, null] },
      ];
      const maintenanceType =
        ObjectRegistry.getClassByConstructor(SmrtReportRefreshTask)
          ?.qualifiedName ?? SmrtReportRefreshTask.name;

      for (const variant of variants) {
        const job = await enqueueReportRefresh({
          db,
          reportClass: 'IntegrationRevenueReport',
          mode: 'incremental',
          trigger: 'manual',
          tenantId: 'tenant-a',
          adapterType: 'sqlite',
          maxAttempts: 1,
          integritySigner: JOB_SIGNER,
          executionAuthority: {
            version: 1,
            hostId: 'integration-authority',
            principal: {
              version: 1,
              actorUserId: 'user-a',
              tenantId: 'tenant-a',
            },
          },
        });
        const persisted = await db.query(
          'SELECT args FROM _smrt_jobs WHERE id = ?',
          job.id,
        );
        const injectedArgs = JSON.parse(String(persisted.rows[0]?.args));
        const signedArgs = { ...injectedArgs };
        injectedArgs._mcpTask = {
          invocationArgs: [signedArgs, ...variant.tail],
        };
        await db.query(
          'UPDATE _smrt_jobs SET object_type = ?, args = ? WHERE id = ?',
          maintenanceType,
          JSON.stringify(injectedArgs),
          job.id,
        );
        const taskRunner = createTaskRunner({
          concurrency: 1,
          pollInterval: 10,
          queues: ['reports'],
          retention: false,
        });
        await taskRunner.initialize(db);
        const failure = new Promise<Error>((resolve, reject) => {
          taskRunner.once('job:failed', (_job, error) =>
            resolve(error as Error),
          );
          taskRunner.once('job:completed', () =>
            reject(new Error(`${variant.name} reroute should fail`)),
          );
          taskRunner.once('runner:error', reject);
        });
        await taskRunner.start();
        await expect(failure).resolves.toMatchObject({
          message: 'Invalid durable report refresh job target',
        });
        await taskRunner.stop();
      }
      expect(authorize).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    } finally {
      unregisterAuthority();
      await db.close?.();
    }
  });

  it('fails a revoked principal refresh delivered by TaskRunner before report reads', async () => {
    const db = await setupDb();
    const authorize = vi.fn(() => {
      throw new Error('membership revoked');
    });
    const audit = vi.fn();
    const unregisterAuthority = registerReportRefreshExecutionAuthorityHost(
      'integration-denied-authority',
      { authorize, audit },
    );
    const taskRunner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['reports'],
      retention: false,
    });
    try {
      await enqueueReportRefresh({
        db,
        reportClass: 'IntegrationRevenueReport',
        trigger: 'manual',
        tenantId: 'tenant-a',
        maxAttempts: 1,
        integritySigner: JOB_SIGNER,
        executionAuthority: {
          version: 1,
          hostId: 'integration-denied-authority',
          principal: {
            version: 1,
            actorUserId: 'user-a',
            tenantId: 'tenant-a',
          },
        },
      });
      await taskRunner.initialize(db);
      const failure = new Promise<Error>((resolve, reject) => {
        taskRunner.once('job:failed', (_job, error) => resolve(error as Error));
        taskRunner.once('runner:error', reject);
      });
      await taskRunner.start();
      expect((await failure).message).toContain(
        'Report refresh execution authority denied',
      );
      expect(authorize).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'denied',
          reason: 'current_authority_denied',
          tenantId: 'tenant-a',
        }),
      );
      await expect(reportRows(db)).resolves.toEqual([]);
    } finally {
      await taskRunner.stop();
      unregisterAuthority();
      await db.close?.();
    }
  });

  it('does not replace a global runner tenant with persisted task configuration', async () => {
    const db = await setupDb();
    const taskRunner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['reports'],
      retention: false,
    });
    try {
      const job = await enqueueReportRefresh({
        db,
        reportClass: 'IntegrationRevenueReport',
        trigger: 'manual',
        tenantId: 'tenant-a',
        maxAttempts: 1,
        integritySigner: JOB_SIGNER,
        executionAuthority: {
          version: 1,
          hostId: 'missing-host',
          principal: {
            version: 1,
            actorUserId: 'user-a',
            tenantId: 'tenant-a',
          },
        },
      });
      const persisted = await db.query(
        'SELECT args FROM _smrt_jobs WHERE id = ?',
        job.id,
      );
      const args = JSON.parse(String(persisted.rows[0]?.args));
      args._agentConfig = { tenantId: 'tenant-a' };
      await db.query(
        'UPDATE _smrt_jobs SET tenant_id = NULL, args = ? WHERE id = ?',
        JSON.stringify(args),
        job.id,
      );
      await taskRunner.initialize(db);
      const failure = new Promise<Error>((resolve, reject) => {
        taskRunner.once('job:failed', (_job, error) => resolve(error as Error));
        taskRunner.once('runner:error', reject);
      });
      await taskRunner.start();
      await expect(failure).resolves.toMatchObject({
        message: 'Invalid report refresh execution tenant',
      });
    } finally {
      await taskRunner.stop();
      await db.close?.();
    }
  });

  it('passes an explicit global runner scope to refresh instead of ambient tenancy', async () => {
    const db = await setupDb();
    const taskRunner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['reports'],
      retention: false,
    });
    try {
      await insertInvoice(db, {
        id: 'global-runner-a',
        tenantId: 'tenant-a',
        customerId: 'customer-a',
        amount: 10,
        updatedAt: '2026-03-01T00:00:00.000Z',
      });
      await insertInvoice(db, {
        id: 'global-runner-b',
        tenantId: 'tenant-b',
        customerId: 'customer-b',
        amount: 20,
        updatedAt: '2026-03-01T00:00:00.000Z',
      });
      await enqueueReportRefresh({
        db,
        reportClass: 'IntegrationRevenueReport',
        trigger: 'schedule',
        maxAttempts: 1,
        integritySigner: JOB_SIGNER,
      });
      await taskRunner.initialize(db);
      const completion = new Promise<{ result?: unknown }>(
        (resolve, reject) => {
          taskRunner.once('job:completed', (_job, result) =>
            resolve(result as { result?: unknown }),
          );
          taskRunner.once('job:failed', (_job, error) => reject(error));
          taskRunner.once('runner:error', reject);
        },
      );
      await withTenant({ tenantId: 'tenant-a' }, () => taskRunner.start());
      await expect(completion).resolves.toMatchObject({
        result: { tenantId: null },
      });
    } finally {
      await taskRunner.stop();
      await db.close?.();
    }
  });

  it('rejects an empty runner tenant without using persisted task configuration', async () => {
    const db = await setupDb();
    const taskRunner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['reports'],
      retention: false,
    });
    try {
      const job = await enqueueReportRefresh({
        db,
        reportClass: 'IntegrationRevenueReport',
        trigger: 'manual',
        tenantId: 'tenant-a',
        maxAttempts: 1,
        integritySigner: JOB_SIGNER,
        executionAuthority: {
          version: 1,
          hostId: 'missing-host',
          principal: {
            version: 1,
            actorUserId: 'user-a',
            tenantId: 'tenant-a',
          },
        },
      });
      const persisted = await db.query(
        'SELECT args FROM _smrt_jobs WHERE id = ?',
        job.id,
      );
      const args = JSON.parse(String(persisted.rows[0]?.args));
      args._agentConfig = { tenantId: 'tenant-a' };
      await db.query(
        'UPDATE _smrt_jobs SET tenant_id = ?, args = ? WHERE id = ?',
        '',
        JSON.stringify(args),
        job.id,
      );
      await taskRunner.initialize(db);
      const failure = new Promise<Error>((resolve, reject) => {
        taskRunner.once('job:failed', (_job, error) => resolve(error as Error));
        taskRunner.once('job:completed', () =>
          reject(new Error('empty-tenant job completed')),
        );
        taskRunner.once('runner:error', reject);
      });
      await taskRunner.start();
      await expect(failure).resolves.toMatchObject({
        message: 'Invalid report refresh execution tenant',
      });
    } finally {
      await taskRunner.stop();
      await db.close?.();
    }
  });

  it('recomputes affected groups incrementally, including avg and empty-group deletes', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'invoice-1',
      customerId: 'customer-a',
      amount: 10,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await insertInvoice(db, {
      id: 'invoice-2',
      customerId: 'customer-a',
      amount: 20,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    await refreshReport(IntegrationRevenueReport, { db, mode: 'incremental' });
    expect(await reportRows(db)).toMatchObject([
      {
        customer_id: 'customer-a',
        revenue: 30,
        avg_total: 15,
        invoice_count: 2,
      },
    ]);

    await db.update(
      SOURCE_TABLE,
      { id: 'invoice-2' },
      {
        total_amount: 30,
        updated_at: '2026-01-03T00:00:00.000Z',
      },
    );
    const updated = await refreshReport(IntegrationRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(updated.changedGroupCount).toBe(1);
    expect(await reportRows(db)).toMatchObject([
      {
        customer_id: 'customer-a',
        revenue: 40,
        avg_total: 20,
        invoice_count: 2,
      },
    ]);

    await db.update(
      SOURCE_TABLE,
      { id: 'invoice-2' },
      {
        deleted_at: '2026-01-04T00:00:00.000Z',
        updated_at: '2026-01-04T00:00:00.000Z',
      },
    );
    await refreshReport(IntegrationRevenueReport, { db, mode: 'incremental' });
    expect(await reportRows(db)).toMatchObject([
      {
        customer_id: 'customer-a',
        revenue: 10,
        avg_total: 10,
        invoice_count: 1,
      },
    ]);

    await db.update(
      SOURCE_TABLE,
      { id: 'invoice-1' },
      {
        deleted_at: '2026-01-05T00:00:00.000Z',
        updated_at: '2026-01-05T00:00:00.000Z',
      },
    );
    await refreshReport(IntegrationRevenueReport, { db, mode: 'incremental' });
    expect(await reportRows(db)).toEqual([]);
  });

  it('recomputes affected time-bucket groups incrementally', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'jan-invoice-1',
      customerId: 'customer-a',
      amount: 10,
      issuedAt: '2026-01-10T00:00:00.000Z',
      updatedAt: '2026-01-10T00:00:00.000Z',
    });

    await refreshReport(IntegrationMonthlyRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(await monthlyRows(db)).toMatchObject([
      {
        issued_month: '2026-01-01 00:00:00',
        revenue: 10,
      },
    ]);

    await insertInvoice(db, {
      id: 'jan-invoice-2',
      customerId: 'customer-b',
      amount: 25,
      issuedAt: '2026-01-20T00:00:00.000Z',
      updatedAt: '2026-01-20T00:00:00.000Z',
    });

    const updated = await refreshReport(IntegrationMonthlyRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(updated.changedGroupCount).toBe(1);
    expect(await monthlyRows(db)).toMatchObject([
      {
        issued_month: '2026-01-01 00:00:00',
        revenue: 35,
      },
    ]);
  });

  it('recomputes old materialized groups when source grouping keys change', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'regrouped-invoice',
      customerId: 'customer-a',
      amount: 40,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await refreshReport(IntegrationRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(await reportRows(db)).toMatchObject([
      {
        customer_id: 'customer-a',
        revenue: 40,
      },
    ]);

    await db.update(
      SOURCE_TABLE,
      { id: 'regrouped-invoice' },
      {
        customer_id: 'customer-b',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    );

    const updated = await refreshReport(IntegrationRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(updated.changedGroupCount).toBe(2);
    expect(await reportRows(db)).toMatchObject([
      {
        customer_id: 'customer-b',
        revenue: 40,
      },
    ]);
  });

  it('recomputes materialized groups for hard deletes with a change signal', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'hard-deleted-invoice',
      customerId: 'customer-a',
      amount: 40,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await refreshReport(IntegrationRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(await reportRows(db)).toMatchObject([
      {
        customer_id: 'customer-a',
        revenue: 40,
      },
    ]);

    await db.query(
      `DELETE FROM ${SOURCE_TABLE} WHERE id = ?`,
      'hard-deleted-invoice',
    );
    const updated = await refreshReport(IntegrationRevenueReport, {
      db,
      mode: 'incremental',
      changedRows: [{ id: 'hard-deleted-invoice' }],
    });

    expect(updated.changedGroupCount).toBe(1);
    expect(await reportRows(db)).toEqual([]);
  });

  it('recomputes groups when changed rows stop matching report filters', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'voided-invoice',
      customerId: 'customer-a',
      amount: 25,
      status: 'paid',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await refreshReport(IntegrationPaidRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(await paidRows(db)).toMatchObject([
      {
        customer_id: 'customer-a',
        revenue: 25,
      },
    ]);

    await db.update(
      SOURCE_TABLE,
      { id: 'voided-invoice' },
      {
        status: 'void',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    );

    const updated = await refreshReport(IntegrationPaidRevenueReport, {
      db,
      mode: 'incremental',
    });
    expect(updated.changedGroupCount).toBe(1);
    expect(await paidRows(db)).toEqual([]);
  });

  it('seeds default updatedAt watermarks during the first incremental rebuild', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'default-watermark-invoice',
      customerId: 'customer-a',
      amount: 15,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const seeded = await refreshReport(IntegrationDefaultWatermarkReport, {
      db,
      mode: 'incremental',
    });
    expect(seeded.mode).toBe('rebuild');

    const watermarks = await db.query(
      `SELECT watermark_column, watermark_value
        FROM _smrt_report_watermarks
        WHERE report_class LIKE ?
        ORDER BY watermark_column`,
      '%IntegrationDefaultWatermarkReport',
    );
    expect(watermarks.rows).toMatchObject([
      {
        watermark_column: 'updated_at',
        watermark_value: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const noOp = await refreshReport(IntegrationDefaultWatermarkReport, {
      db,
      mode: 'incremental',
    });
    expect(noOp.mode).toBe('incremental');
    expect(noOp.changedGroupCount).toBe(0);
  });

  it('does not require the locks table when locks are disabled', async () => {
    const db = await setupDb();
    await db.query('DROP TABLE _smrt_report_locks');
    await insertInvoice(db, {
      id: 'lockless-invoice',
      customerId: 'customer-a',
      amount: 10,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      refreshReport(IntegrationRevenueReport, {
        db,
        mode: 'incremental',
        lock: false,
      }),
    ).resolves.toMatchObject({
      rowCount: 1,
      mode: 'rebuild',
    });
  });

  it('requires watermarks for incremental refresh even without runs or locks', async () => {
    const db = await setupDb();
    await db.query('DROP TABLE _smrt_report_watermarks');

    await expect(
      refreshReport(IntegrationRevenueReport, {
        db,
        mode: 'incremental',
        lock: false,
        trackRuns: false,
      }),
    ).rejects.toThrow(
      "Report runtime table '_smrt_report_watermarks' does not exist",
    );
  });

  it('fans out tenant refreshes into one shared report table and tenant-scoped reads', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'tenant-a-invoice',
      tenantId: 'tenant-a',
      customerId: 'customer-a',
      amount: 10,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    await insertInvoice(db, {
      id: 'tenant-b-invoice',
      tenantId: 'tenant-b',
      customerId: 'customer-a',
      amount: 90,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });

    const result = await refreshReport(IntegrationRevenueReport, {
      db,
      mode: 'incremental',
      tenantIds: ['tenant-a', 'tenant-b'],
    });
    expect(result.tenantResults).toHaveLength(2);
    expect(await reportRows(db)).toMatchObject([
      { tenant_id: 'tenant-a', customer_id: 'customer-a', revenue: 10 },
      { tenant_id: 'tenant-b', customer_id: 'customer-a', revenue: 90 },
    ]);

    enableTenancy();
    const collection = await ObjectRegistry.getCollection<SmrtObject>(
      'IntegrationRevenueReport',
      { db },
    );
    const tenantARows = await withTenant({ tenantId: 'tenant-a' }, () =>
      collection.list(),
    );
    expect(tenantARows).toHaveLength(1);
    expect(tenantARows[0].toJSON()).toMatchObject({
      tenantId: 'tenant-a',
      revenue: 10,
    });
  });

  it('creates schedule jobs and onChange refresh jobs', async () => {
    const db = await setupDb();
    await ensureReportRefreshSchedules({
      db,
      reports: [IntegrationRevenueReport],
      tenantIds: ['tenant-a'],
    });
    await db.update(
      '_smrt_report_schedules',
      { tenant_id: 'tenant-a' },
      { next_run: '2026-01-01T00:00:00.000Z' },
    );

    const runner = new ReportScheduleRunner({
      pollInterval: 1000,
    });
    await runner.initialize(db);
    await runner.poll();

    let jobs = await db.query(
      "SELECT queue, object_type, method, tenant_id, args FROM _smrt_jobs WHERE queue = 'reports'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({
      method: 'run',
      tenant_id: 'tenant-a',
    });
    const scheduledArgs = JSON.parse(String(jobs.rows[0]?.args));
    expect(scheduledArgs.scheduleId).toBeTruthy();
    expect(scheduledArgs._scheduleId).toBe(scheduledArgs.scheduleId);

    const taskRunner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['reports'],
      retention: false,
    });
    await taskRunner.initialize(db);
    const completion = new Promise<{ result?: unknown }>((resolve, reject) => {
      taskRunner.once('job:completed', (_job, result) =>
        resolve(result as { result?: unknown }),
      );
      taskRunner.once('job:failed', (_job, error) => reject(error));
      taskRunner.once('runner:error', reject);
    });
    await taskRunner.start();
    try {
      await expect(completion).resolves.toMatchObject({
        result: { tenantId: 'tenant-a' },
      });
    } finally {
      await taskRunner.stop();
    }

    const unregister = registerReportRefreshInterceptor({
      db,
      reports: [IntegrationRevenueReport],
    });
    const invoice = new IntegrationInvoice({
      db,
      tenantId: 'tenant-b',
      customerId: 'customer-b',
    });
    (invoice as IntegrationInvoice & { tenantId: string }).tenantId =
      'tenant-b';
    (invoice as IntegrationInvoice & { updatedAt: Date }).updatedAt = new Date(
      '2026-09-12T12:34:56.789Z',
    );
    await GlobalInterceptors.executeAfterSave(invoice, {
      className: 'IntegrationInvoice',
      operation: 'save',
      timestamp: new Date(),
    });
    unregister();

    jobs = await db.query(
      "SELECT queue, object_type, method, tenant_id, args FROM _smrt_jobs WHERE queue = 'reports' ORDER BY created_at",
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows[1]).toMatchObject({
      method: 'run',
      tenant_id: 'tenant-b',
    });

    const changedArgs = JSON.parse(String(jobs.rows[1]?.args)) as {
      changedRows?: Array<{ updatedAt?: string }>;
    };
    expect(changedArgs.changedRows?.[0]?.updatedAt).toBe(
      '2026-09-12T12:34:56.789Z',
    );

    const changedTaskRunner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['reports'],
      retention: false,
    });
    await changedTaskRunner.initialize(db);
    const changedCompletion = new Promise<{ result?: unknown }>(
      (resolve, reject) => {
        changedTaskRunner.once('job:completed', (_job, result) =>
          resolve(result as { result?: unknown }),
        );
        changedTaskRunner.once('job:failed', (_job, error) => reject(error));
        changedTaskRunner.once('runner:error', reject);
      },
    );
    await changedTaskRunner.start();
    try {
      await expect(changedCompletion).resolves.toMatchObject({
        result: { tenantId: 'tenant-b' },
      });
    } finally {
      await changedTaskRunner.stop();
    }
  });

  it('runs the stateless refresh task used by queued jobs', async () => {
    const db = await setupDb();
    await insertInvoice(db, {
      id: 'task-invoice',
      tenantId: 'tenant-a',
      customerId: 'customer-task',
      amount: 55,
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    const task = new SmrtReportRefreshTask({ db });
    task.tenantId = 'tenant-a';
    await task.initialize();
    const unsignedArgs = {
      reportClass: 'IntegrationRevenueReport',
      mode: 'incremental',
      trigger: 'job',
      tenantId: 'tenant-a',
      adapterType: 'sqlite',
    } as const;
    const result = await task.run({
      ...unsignedArgs,
      integrity: JOB_SIGNER.sign(unsignedArgs),
    });

    expect(result).toMatchObject({
      rowCount: 1,
      tenantId: 'tenant-a',
    });
    expect(await reportRows(db)).toMatchObject([
      {
        tenant_id: 'tenant-a',
        customer_id: 'customer-task',
        revenue: 55,
      },
    ]);
  });
});
