import {
  GlobalInterceptors,
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
import { refreshReport } from '../refresh.js';
import { SmrtReport } from '../report.js';
import {
  ensureReportRefreshSchedules,
  ReportScheduleRunner,
  registerReportRefreshInterceptor,
  SmrtReportRefreshTask,
} from '../scheduler.js';

class IntegrationInvoice extends SmrtObject {}
class IntegrationRevenueReport extends SmrtReport {}

const SOURCE_TABLE = 'integration_invoices';
const REPORT_TABLE = 'integration_revenue_reports';

beforeEach(() => {
  ObjectRegistry.clear();
  GlobalInterceptors.clear();
  registerJobsManifest();
  registerIntegrationClasses();
});

afterEach(() => {
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
  ObjectRegistry.registerFieldDecorator('IntegrationInvoice', 'updatedAt', {
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
  await db.query(
    'CREATE UNIQUE INDEX smrt_jobs_slug_context_idx ON _smrt_jobs (slug, context)',
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

describe('report refresh integration', () => {
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

    const runner = new ReportScheduleRunner({ pollInterval: 1000 });
    await runner.initialize(db);
    await runner.poll();

    let jobs = await db.query(
      "SELECT queue, object_type, method, tenant_id FROM _smrt_jobs WHERE queue = 'reports'",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({
      method: 'run',
      tenant_id: 'tenant-a',
    });

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
    await GlobalInterceptors.executeAfterSave(invoice, {
      className: 'IntegrationInvoice',
      operation: 'save',
      timestamp: new Date(),
    });
    unregister();

    jobs = await db.query(
      "SELECT queue, object_type, method, tenant_id FROM _smrt_jobs WHERE queue = 'reports' ORDER BY created_at",
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows[1]).toMatchObject({
      method: 'run',
      tenant_id: 'tenant-b',
    });
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
    await task.initialize();
    const result = await task.run({
      reportClass: 'IntegrationRevenueReport',
      mode: 'incremental',
      trigger: 'job',
      tenantId: 'tenant-a',
      adapterType: 'sqlite',
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
