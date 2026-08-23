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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReportAdapterDescriptor,
  queryReportMaterializedRows,
} from '../adapter.js';
import { buildReportDefinition } from '../compiler.js';
import {
  applyReportRefresh,
  getReportLifecycle,
  previewReportRefresh,
  reportRefreshOutcome,
} from '../lifecycle.js';

class LifecycleInvoice extends SmrtObject {}
class LifecycleReport extends SmrtObject {}
class GlobalLifecycleReport extends SmrtObject {}

const NOW = new Date('2026-08-23T16:30:00.000Z');

function registerFixture() {
  ObjectRegistry.registerFromManifest(
    'LifecycleInvoice',
    {
      className: 'LifecycleInvoice',
      fields: { tenantId: { type: 'text' } },
      methods: {},
      decoratorConfig: { tableName: 'lifecycle_invoices' },
      schema: {
        tableName: 'lifecycle_invoices',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
  ObjectRegistry.registerFromManifest(
    'LifecycleReport',
    {
      className: 'LifecycleReport',
      fields: {
        tenantId: {
          type: 'text',
          _meta: { __tenancy: { isTenantIdField: true } },
        },
        revenue: {
          type: 'decimal',
          _meta: {
            __report: { kind: 'aggregate', fn: 'sum', column: 'totalAmount' },
          },
        },
        refreshedAt: { type: 'datetime' },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'lifecycle_reports',
        tenantScoped: { field: 'tenantId', mode: 'optional' },
        report: {
          source: 'LifecycleInvoice',
          refresh: { mode: 'incremental', ttl: 60_000 },
        },
      },
      schema: {
        tableName: 'lifecycle_reports',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
  ObjectRegistry.registerFromManifest(
    'GlobalLifecycleReport',
    {
      className: 'GlobalLifecycleReport',
      fields: {
        revenue: {
          type: 'decimal',
          _meta: {
            __report: { kind: 'aggregate', fn: 'sum', column: 'totalAmount' },
          },
        },
        refreshedAt: { type: 'datetime' },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'global_lifecycle_reports',
        report: {
          source: 'LifecycleInvoice',
          refresh: { mode: 'incremental', ttl: 60_000 },
        },
      },
      schema: {
        tableName: 'global_lifecycle_reports',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
}

function registerJobsManifest() {
  for (const manifestUrl of [
    new URL('../../../jobs/dist/manifest.json', import.meta.url),
    new URL('../../../jobs/.smrt/manifest.json', import.meta.url),
  ]) {
    if (ObjectRegistry.registerPackageManifest(manifestUrl).loaded) return;
  }
}

async function lifecycleClassName(): Promise<string> {
  await buildReportDefinition(LifecycleReport);
  const registered =
    ObjectRegistry.getClassByConstructor(LifecycleReport) ??
    ObjectRegistry.getClass(LifecycleReport.name);
  return registered?.qualifiedName ?? registered?.name ?? LifecycleReport.name;
}

async function setupDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [],
  });
  await db.query(`
    CREATE TABLE lifecycle_reports (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      revenue REAL,
      refreshed_at TEXT
    )
  `);
  await db.query(`
    CREATE TABLE _smrt_report_runs (
      id TEXT PRIMARY KEY,
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
      created_at TEXT
    )
  `);
  await db.query(`
    CREATE TABLE _smrt_report_locks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      scope_key TEXT NOT NULL,
      report_class TEXT NOT NULL,
      owner_id TEXT,
      expires_at TEXT
    )
  `);
  await db.query(`
    CREATE TABLE _smrt_jobs (
      id TEXT PRIMARY KEY,
      slug TEXT,
      context TEXT,
      tenant_id TEXT,
      queue TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT,
      method TEXT NOT NULL,
      args TEXT,
      run_at TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      timeout INTEGER NOT NULL,
      timeout_behavior TEXT NOT NULL,
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
    'CREATE UNIQUE INDEX lifecycle_jobs_slug_context_idx ON _smrt_jobs (tenant_id, slug, context)',
  );
  return db;
}

async function insertRun(
  db: DatabaseInterface,
  values: Partial<Record<string, string | number>> & { id: string },
) {
  await db.insert('_smrt_report_runs', {
    tenant_id: 'tenant-a',
    scope_key: 'tenant:tenant-a',
    report_class: await lifecycleClassName(),
    source_class: 'LifecycleInvoice',
    mode: 'incremental',
    trigger: 'manual',
    status: 'success',
    started_at: '2026-08-23T16:28:00.000Z',
    completed_at: '2026-08-23T16:29:00.000Z',
    row_count: 2,
    changed_group_count: 1,
    created_at: '2026-08-23T16:29:00.000Z',
    ...values,
  });
}

describe('report lifecycle', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerFixture();
    registerJobsManifest();
    enableTenancy();
  });

  afterEach(() => {
    disableTenancy();
    ObjectRegistry.clear();
  });

  it('returns only the ambient tenant lifecycle and redacts lock/error internals', async () => {
    const db = await setupDb();
    try {
      await db.insert('lifecycle_reports', {
        id: 'tenant-a-row',
        tenant_id: 'tenant-a',
        revenue: 12,
        refreshed_at: '2026-08-23T16:29:30.000Z',
      });
      await insertRun(db, { id: 'run-a' });
      await db.insert('_smrt_report_locks', {
        id: 'lock-a',
        tenant_id: 'tenant-a',
        scope_key: 'tenant:tenant-a',
        report_class: await lifecycleClassName(),
        expires_at: '2026-08-23T16:31:00.000Z',
        owner_id: 'private-worker-id',
      });
      await insertRun(db, {
        id: 'run-b',
        tenant_id: 'tenant-b',
        scope_key: 'tenant:tenant-b',
        status: 'failed',
        completed_at: '2026-08-23T16:29:45.000Z',
      });

      const tenantA = await withTenant({ tenantId: 'tenant-a' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );
      const tenantB = await withTenant({ tenantId: 'tenant-b' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );

      expect(tenantA).toMatchObject({
        state: 'refreshing',
        hasUsableRows: true,
        mode: 'incremental',
        run: { id: 'run-a', status: 'success', rowCount: 2 },
        lock: { held: true, expiresAt: '2026-08-23T16:31:00.000Z' },
      });
      expect(JSON.stringify(tenantA)).not.toContain('private-worker-id');
      expect(tenantB).toMatchObject({
        state: 'failed',
        hasUsableRows: false,
        run: { id: 'run-b', status: 'failed', mayRetry: true },
        failure: { code: 'refresh_failed', retryable: true },
      });
      expect(JSON.stringify(tenantB)).not.toContain('tenant-a');
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('distinguishes stale, lock-skipped, and failed lifecycle states', async () => {
    const db = await setupDb();
    try {
      const stale = await withTenant({ tenantId: 'tenant-a' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );
      expect(stale).toMatchObject({ state: 'stale', hasUsableRows: false });

      await insertRun(db, { id: 'skipped-run', status: 'skipped' });
      await db.insert('_smrt_report_locks', {
        id: 'lock-for-skipped-run',
        tenant_id: 'tenant-a',
        scope_key: 'tenant:tenant-a',
        report_class: await lifecycleClassName(),
        owner_id: 'worker',
        expires_at: '2026-08-23T16:31:00.000Z',
      });
      const skipped = await withTenant({ tenantId: 'tenant-a' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );
      expect(skipped).toMatchObject({
        state: 'lock-skipped',
        run: { status: 'skipped', mayRetry: false },
      });

      await insertRun(db, {
        id: 'failed-run',
        status: 'failed',
        started_at: '2026-08-23T16:29:30.000Z',
      });
      const retryingFailed = await withTenant({ tenantId: 'tenant-a' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );
      expect(retryingFailed).toMatchObject({
        state: 'refreshing',
        run: { id: 'failed-run', status: 'failed' },
        lock: { held: true },
      });

      await db.delete('_smrt_report_locks', {
        id: 'lock-for-skipped-run',
      });
      const failed = await withTenant({ tenantId: 'tenant-a' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );
      expect(failed).toMatchObject({
        state: 'failed',
        run: { id: 'failed-run', mayRetry: true },
        failure: { code: 'refresh_failed', retryable: true },
      });
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('uses the newest successful lifecycle signal', async () => {
    const db = await setupDb();
    try {
      await db.insert('lifecycle_reports', {
        id: 'tenant-a-row',
        tenant_id: 'tenant-a',
        revenue: 12,
        refreshed_at: '2026-08-23T16:00:00.000Z',
      });
      await insertRun(db, {
        id: 'successful-noop-run',
        completed_at: '2026-08-23T16:29:30.000Z',
      });

      const completedNoop = await withTenant({ tenantId: 'tenant-a' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );
      expect(completedNoop).toMatchObject({
        state: 'current',
        asOf: '2026-08-23T16:29:30.000Z',
        refreshedAt: '2026-08-23T16:00:00.000Z',
      });
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('does not retain abandoned running work as refreshing', async () => {
    const db = await setupDb();
    try {
      await db.insert('lifecycle_reports', {
        id: 'tenant-a-row',
        tenant_id: 'tenant-a',
        revenue: 12,
        refreshed_at: '2026-08-23T16:29:30.000Z',
      });
      await insertRun(db, {
        id: 'abandoned-running-run',
        status: 'running',
        started_at: '2026-08-23T16:10:00.000Z',
        completed_at: null,
      });

      const abandoned = await withTenant({ tenantId: 'tenant-a' }, () =>
        getReportLifecycle(LifecycleReport, { db, now: NOW }),
      );
      expect(abandoned).toMatchObject({
        state: 'stale',
        asOf: '2026-08-23T16:29:30.000Z',
        run: { id: 'abandoned-running-run', status: 'running' },
        lock: { held: false },
      });
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('maps an explicit lifecycle read into the canonical query freshness', async () => {
    const db = await setupDb();
    try {
      await db.insert('lifecycle_reports', {
        id: 'tenant-a-row',
        tenant_id: 'tenant-a',
        revenue: 12,
        refreshed_at: '2026-08-23T16:29:30.000Z',
      });
      await insertRun(db, { id: 'run-a' });
      const result = await withTenant({ tenantId: 'tenant-a' }, () =>
        queryReportMaterializedRows(
          LifecycleReport,
          { version: 1, requestId: 'lifecycle-read', mode: 'rows' },
          {
            db,
            lifecycle: { now: NOW },
            collection: {
              async list() {
                return [{ id: 'tenant-a-row' }];
              },
              async count() {
                return 1;
              },
            },
          },
        ),
      );

      expect(result.freshness).toEqual({
        state: 'fresh',
        asOf: '2026-08-23T16:29:30.000Z',
      });
      expect(result.reportLifecycle).toMatchObject({
        read: 'current',
        snapshot: { state: 'current', hasUsableRows: true },
      });
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('discloses when a collection read turns a stale materialization current', async () => {
    const db = await setupDb();
    try {
      const result = await withTenant({ tenantId: 'tenant-a' }, () =>
        queryReportMaterializedRows(
          LifecycleReport,
          { version: 1, requestId: 'lifecycle-read-refresh', mode: 'rows' },
          {
            db,
            lifecycle: { now: NOW },
            collection: {
              async list() {
                await db.insert('lifecycle_reports', {
                  id: 'tenant-a-refreshed-row',
                  tenant_id: 'tenant-a',
                  revenue: 12,
                  refreshed_at: '2026-08-23T16:29:30.000Z',
                });
                await insertRun(db, { id: 'refresh-triggered-run' });
                return [{ id: 'tenant-a-refreshed-row' }];
              },
              async count() {
                return 1;
              },
            },
          },
        ),
      );

      expect(result.freshness).toEqual({
        state: 'fresh',
        asOf: '2026-08-23T16:29:30.000Z',
      });
      expect(result.reportLifecycle).toMatchObject({
        read: 'refresh-triggered',
        snapshot: { state: 'current', hasUsableRows: true },
      });
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('requires host authorization and audit before previewing or queueing refreshes', async () => {
    const db = await setupDb();
    const authorize = vi.fn();
    const audit = vi.fn();
    const host = { authorize, audit };
    try {
      const descriptor = await buildReportAdapterDescriptor(LifecycleReport, {
        refreshPermission: 'reports.rebuild',
      });
      const preview = await withTenant({ tenantId: 'tenant-a' }, () =>
        previewReportRefresh(LifecycleReport, {
          db,
          host,
          refreshAction: descriptor.refresh.action,
        }),
      );
      const applied = await withTenant({ tenantId: 'tenant-a' }, () =>
        applyReportRefresh(LifecycleReport, {
          db,
          host,
          priority: 90,
          refreshAction: descriptor.refresh.action,
        }),
      );

      expect(preview).toMatchObject({
        phase: 'preview',
        execution: 'background',
        action: {
          phase: 'preview',
          reportClassName: expect.stringMatching(/LifecycleReport$/),
          tenantScope: 'ambient',
          requiredPermission: 'reports.rebuild',
        },
      });
      expect(applied).toMatchObject({
        phase: 'apply',
        job: { status: 'pending', attempts: 0, maxAttempts: 3 },
      });
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(audit).toHaveBeenCalledTimes(2);
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ requiredPermission: 'reports.rebuild' }),
      );
      const jobs = await db.query(
        'SELECT tenant_id, queue, method, priority FROM _smrt_jobs',
      );
      expect(jobs.rows).toEqual([
        {
          tenant_id: 'tenant-a',
          queue: 'reports',
          method: 'run',
          priority: 90,
        },
      ]);
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('queues global reports outside an ambient tenant scope', async () => {
    const db = await setupDb();
    const host = { authorize: vi.fn(), audit: vi.fn() };
    try {
      await withTenant({ tenantId: 'tenant-a' }, () =>
        applyReportRefresh(GlobalLifecycleReport, { db, host }),
      );

      const jobs = await db.query('SELECT tenant_id, args FROM _smrt_jobs');
      expect(jobs.rows).toEqual([expect.objectContaining({ tenant_id: null })]);
      expect(JSON.parse(String(jobs.rows[0]?.args))).toMatchObject({
        tenantId: null,
      });
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('returns fanout outcomes without tenant identifiers', () => {
    const outcome = reportRefreshOutcome({
      rowCount: 3,
      changedGroupCount: 2,
      refreshedAt: NOW,
      mode: 'incremental',
      tenantResults: [
        {
          rowCount: 2,
          refreshedAt: NOW,
          mode: 'incremental',
          tenantId: 'tenant-a',
        },
        {
          rowCount: 1,
          refreshedAt: NOW,
          mode: 'incremental',
          tenantId: 'tenant-b',
          skipped: true,
        },
      ],
    });

    expect(outcome).toEqual({
      state: 'partial',
      rowCount: 3,
      changedGroupCount: 2,
      completedScopes: 1,
      lockSkippedScopes: 1,
      mode: 'incremental',
      refreshedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(outcome)).not.toContain('tenant-');
  });
});
