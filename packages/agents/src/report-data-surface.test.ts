import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import {
  buildReportAdapterDescriptor,
  type ReportAdapterOptions,
} from '@happyvertical/smrt-reports';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATA_DISCOVER_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';
import {
  createReportDataSurfaceTools,
  REPORT_DRILLDOWN_TOOL_SLUG,
  REPORT_EXPORT_TOOL_SLUG,
  REPORT_QUERY_TOOL_SLUG,
  REPORT_REFRESH_TOOL_SLUG,
  ReportDataSurfaceVisibleError,
} from './report-data-surface.js';

class ReportToolsInvoice extends SmrtObject {}
class ReportToolsReport extends SmrtObject {}

async function currentReportId(
  adapter?: ReportAdapterOptions,
): Promise<string> {
  return (await buildReportAdapterDescriptor(ReportToolsReport, adapter))
    .resourceId;
}

function registerFixture(): void {
  ObjectRegistry.registerFromManifest(
    'ReportToolsInvoice',
    {
      className: 'ReportToolsInvoice',
      fields: { tenantId: { type: 'text' } },
      methods: {},
      decoratorConfig: { tableName: 'report_tools_invoices' },
      schema: {
        tableName: 'report_tools_invoices',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@happyvertical/smrt-agents',
  );
  ObjectRegistry.registerFromManifest(
    'ReportToolsReport',
    {
      className: 'ReportToolsReport',
      fields: {
        tenantId: {
          type: 'text',
          _meta: { __tenancy: { isTenantIdField: true } },
        },
        customerId: {
          type: 'text',
          _meta: {
            __report: { kind: 'group', sourceColumn: 'customerId' },
          },
        },
        revenue: {
          type: 'decimal',
          _meta: {
            __report: { kind: 'aggregate', fn: 'sum', column: 'totalAmount' },
          },
        },
        personalRevenue: {
          type: 'decimal',
          _meta: {
            sensitivity: 'personal',
            __report: {
              kind: 'aggregate',
              fn: 'sum',
              column: 'personalRevenue',
            },
          },
        },
        hiddenRevenue: {
          type: 'decimal',
          _meta: {
            sensitive: true,
            __report: {
              kind: 'aggregate',
              fn: 'sum',
              column: 'hiddenRevenue',
            },
          },
        },
        restrictedRevenue: {
          type: 'decimal',
          _meta: {
            readPermission: 'reports.read-restricted',
            __report: {
              kind: 'aggregate',
              fn: 'sum',
              column: 'restrictedRevenue',
            },
          },
        },
        refreshedAt: { type: 'datetime' },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'report_tools_reports',
        tenantScoped: { field: 'tenantId', mode: 'optional' },
        report: {
          source: 'ReportToolsInvoice',
          refresh: { mode: 'incremental', ttl: 60_000 },
        },
      },
      schema: {
        tableName: 'report_tools_reports',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@happyvertical/smrt-agents',
  );
}

function fakeRun(
  allowedTools: string[],
  tenantId = 'tenant-a',
  permissions = ['reports.read', 'reports.export'],
): PrincipalRun {
  return {
    context: {
      userId: 'report-user',
      tenantId,
      database: undefined,
      permissions,
      permissionSet: new Set(permissions),
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    } satisfies SessionPermissionRuntimeContext,
    permissions,
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    async assertOperation(collection, action) {
      if (collection !== 'reports' || action !== 'read') {
        throw new Error('rbac denied');
      }
      return {
        allowed: true,
        permission: 'reports.read',
        reason: 'permission_granted',
      };
    },
  };
}

type ReportRow = Record<string, unknown>;

function reportCollection(run: PrincipalRun): {
  list(options: Record<string, unknown>): Promise<ReportRow[]>;
  count(options?: Record<string, unknown>): Promise<number>;
} {
  const rows: ReportRow[] =
    run.context.tenantId === 'tenant-a'
      ? [
          {
            id: 'tenant-a-row',
            tenantId: 'tenant-a',
            customerId: 'customer-a',
            revenue: 10,
            personalRevenue: 2,
          },
        ]
      : [
          {
            id: 'tenant-b-row',
            tenantId: 'tenant-b',
            customerId: 'customer-b',
            revenue: 20,
            personalRevenue: 3,
          },
        ];
  return {
    async list(options) {
      const where = options.where;
      if (where && JSON.stringify(where).includes('tenant-a-row')) {
        return rows.filter((row) => row.id === 'tenant-a-row');
      }
      if (where && JSON.stringify(where).includes('tenant-b-row')) {
        return rows.filter((row) => row.id === 'tenant-b-row');
      }
      return rows;
    },
    async count() {
      return rows.length;
    },
  };
}

function toolSet(options: Parameters<typeof createReportDataSurfaceTools>[0]) {
  return new Map(
    createReportDataSurfaceTools(options).map((tool) => [tool.slug, tool]),
  );
}

function reportDefinition(overrides: Record<string, unknown> = {}) {
  return {
    report: ReportToolsReport,
    collection: 'reports',
    query: ({ run }: { run: PrincipalRun }) => ({
      collection: reportCollection(run),
    }),
    ...overrides,
  };
}

async function setupLifecycleDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [],
  });
  await db.query(`
    CREATE TABLE report_tools_reports (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      customer_id TEXT,
      revenue REAL,
      personal_revenue REAL,
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
  await db.insert('report_tools_reports', {
    id: 'tenant-a-row',
    tenant_id: 'tenant-a',
    customer_id: 'customer-a',
    revenue: 10,
    personal_revenue: 2,
    refreshed_at: '2026-08-24T00:00:00.000Z',
  });
  return db;
}

describe('principal-bound report data-surface tools', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerFixture();
    enableTenancy();
  });

  afterEach(() => {
    disableTenancy();
    ObjectRegistry.clear();
  });

  it('discovers report fields through generic tools while hiding sensitive and restricted fields', async () => {
    const tools = toolSet({ reports: [reportDefinition()] });
    const run = fakeRun([DATA_DISCOVER_TOOL_SLUG, DATA_QUERY_TOOL_SLUG]);

    const discovered = await tools.get(DATA_DISCOVER_TOOL_SLUG)?.execute({
      run,
      args: {},
      db: undefined,
    });
    expect(discovered).toEqual([
      expect.objectContaining({ id: expect.any(String) }),
    ]);
    const reportId = (discovered as Array<{ id: string }>)[0]?.id;
    const fields = (
      discovered as Array<{
        fields: Array<{
          id: string;
          metadata?: Record<string, unknown>;
        }>;
        metadata?: Record<string, unknown>;
      }>
    )[0]?.fields.map((field) => field.id);
    expect(fields).toContain('personal_revenue');
    expect(fields).not.toContain('hidden_revenue');
    expect(fields).not.toContain('restricted_revenue');
    const customer = (
      discovered as Array<{
        fields: Array<{
          id: string;
          metadata?: Record<string, unknown>;
        }>;
      }>
    )[0]?.fields.find((field) => field.id === 'customer_id');
    const revenue = (
      discovered as Array<{
        fields: Array<{
          id: string;
          metadata?: Record<string, unknown>;
        }>;
      }>
    )[0]?.fields.find((field) => field.id === 'revenue');
    expect(customer?.metadata).toMatchObject({
      kind: 'group',
      filterScope: 'where',
      capabilities: expect.arrayContaining(['filter']),
    });
    expect(revenue?.metadata).toMatchObject({
      kind: 'aggregate',
      filterScope: 'having',
      capabilities: expect.arrayContaining(['filter']),
    });
    expect(
      (discovered as Array<{ metadata?: Record<string, unknown> }>)[0]
        ?.metadata,
    ).toMatchObject({
      surfaceKind: 'report',
      freshnessSource: 'reportLifecycle',
      allowedActions: expect.arrayContaining(['query']),
    });

    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: reportId,
        request: {
          version: 1,
          requestId: 'generic-report-query',
          mode: 'rows',
          projection: ['id', 'customer_id'],
        },
      },
      db: undefined,
    });
    expect(result).toMatchObject({
      rows: [{ id: 'tenant-a-row' }],
    });
  });

  it('keeps silent queries local and background queries authority-free', async () => {
    const queued: unknown[] = [];
    const adapter = { tenantScope: 'tenant' as const };
    const tools = toolSet({
      reports: [
        reportDefinition({
          adapter,
          enqueueBackgroundQuery: async (task, context) => {
            queued.push({ task, context });
            return { taskId: 'report-job-1' };
          },
        }),
      ],
    });
    const run = fakeRun([REPORT_QUERY_TOOL_SLUG]);
    const reportId = await currentReportId(adapter);
    const request = {
      version: 1 as const,
      requestId: 'silent-report-query',
      mode: 'rows' as const,
      projection: ['id'],
    };
    const silent = await tools.get(REPORT_QUERY_TOOL_SLUG)?.execute({
      run,
      args: { reportId, request, execution: 'silent' },
      db: undefined,
    });
    expect(silent).toMatchObject({
      execution: 'silent',
      rows: [{ id: 'tenant-a-row' }],
    });

    const background = await tools.get(REPORT_QUERY_TOOL_SLUG)?.execute({
      run,
      args: { reportId, request, execution: 'background' },
      db: undefined,
    });
    expect(background).toMatchObject({
      execution: 'background',
      status: 'queued',
      taskId: 'report-job-1',
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      task: {
        execution: 'background',
        resourceId: reportId,
        inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
      },
      context: { run },
    });
    expect(JSON.stringify(queued[0]?.task)).not.toContain('tenant-a');
    expect(JSON.stringify(queued[0]?.task)).not.toContain('report-user');
  });

  it('does not advertise actions that the principal lacks permission to use', async () => {
    const tools = toolSet({
      reports: [
        reportDefinition({
          adapter: { refreshPermission: 'reports.refresh-sensitive' },
          refresh: {
            actionHost: () => ({ authorize: vi.fn(), audit: vi.fn() }),
          },
          export: {
            captureSnapshot: async () => ({ id: 'snapshot-a' }),
            actionHost: () => ({
              assertSnapshot: vi.fn(),
              authorize: vi.fn(),
              audit: vi.fn(),
            }),
          },
        }),
      ],
    });
    const run = fakeRun(
      [
        DATA_DISCOVER_TOOL_SLUG,
        REPORT_REFRESH_TOOL_SLUG,
        REPORT_EXPORT_TOOL_SLUG,
      ],
      'tenant-a',
      ['reports.read'],
    );

    const discovered = await tools.get(DATA_DISCOVER_TOOL_SLUG)?.execute({
      run,
      args: {},
      db: undefined,
    });
    const metadata = (
      discovered as Array<{ metadata?: Record<string, unknown> }>
    )[0]?.metadata;
    expect(metadata?.allowedActions).not.toContain('refresh');
    expect(metadata?.allowedActions).not.toContain('export');
    expect(metadata?.allowedActions).not.toContain('query');
    expect(metadata?.queryModes).toEqual([]);
    expect(metadata).not.toHaveProperty('refreshRequiredPermission');
  });

  it('discloses stale and lock-skipped lifecycle state through report queries', async () => {
    const db = await setupLifecycleDb();
    const tools = toolSet({ reports: [reportDefinition()] });
    const run = fakeRun([REPORT_QUERY_TOOL_SLUG]);
    const reportId = await currentReportId();
    const args = {
      reportId,
      execution: 'silent',
      request: {
        version: 1,
        requestId: 'report-lifecycle-read',
        mode: 'rows',
        projection: ['id'],
      },
    };
    try {
      const stale = await withTenant({ tenantId: 'tenant-a' }, () =>
        tools.get(REPORT_QUERY_TOOL_SLUG)?.execute({ run, args, db }),
      );
      expect(stale).toMatchObject({
        freshness: { state: 'stale' },
        reportLifecycle: { snapshot: { state: 'stale' } },
      });

      const descriptor = await buildReportAdapterDescriptor(ReportToolsReport);
      await db.insert('_smrt_report_runs', {
        id: 'lock-skipped-run',
        tenant_id: 'tenant-a',
        scope_key: 'tenant:tenant-a',
        report_class: descriptor.reportClassName,
        source_class: descriptor.sourceClassName,
        mode: 'incremental',
        trigger: 'manual',
        status: 'skipped',
        started_at: '2026-08-24T00:00:00.000Z',
        completed_at: '2026-08-24T00:00:01.000Z',
        row_count: 1,
        changed_group_count: 0,
        created_at: '2026-08-24T00:00:01.000Z',
      });
      const lockSkipped = await withTenant({ tenantId: 'tenant-a' }, () =>
        tools.get(REPORT_QUERY_TOOL_SLUG)?.execute({
          run,
          args: {
            ...args,
            request: { ...args.request, requestId: 'lock-skipped-read' },
          },
          db,
        }),
      );
      expect(lockSkipped).toMatchObject({
        freshness: { state: 'stale' },
        reportLifecycle: {
          snapshot: { state: 'lock-skipped', run: { status: 'skipped' } },
        },
      });
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('requires an exact successful browser acknowledgement and rejects stale acknowledgements', async () => {
    let command: Record<string, unknown> | undefined;
    const visible = {
      send: vi.fn(async (value: Record<string, unknown>) => {
        command = value;
        return {
          commandId: value.commandId,
          identity: value.identity,
          ok: true,
          revision: value.expectedRevision,
        };
      }),
    };
    const tools = toolSet({
      reports: [reportDefinition({ visible })],
    });
    const run = fakeRun([REPORT_QUERY_TOOL_SLUG]);
    const reportId = await currentReportId();
    const args = {
      reportId,
      request: {
        version: 1,
        requestId: 'visible-report-query',
        mode: 'rows',
        projection: ['id'],
      },
      execution: 'visible',
      expectedRevision: 7,
    };
    const result = await tools.get(REPORT_QUERY_TOOL_SLUG)?.execute({
      run,
      args,
      db: undefined,
    });
    expect(result).toMatchObject({ browser: { ok: true, revision: 7 } });
    expect(command).toMatchObject({ expectedRevision: 7 });

    visible.send = vi.fn(async (value: Record<string, unknown>) => ({
      commandId: value.commandId,
      identity: value.identity,
      ok: true,
      revision: 6,
    }));
    await expect(
      tools.get(REPORT_QUERY_TOOL_SLUG)?.execute({
        run,
        args: {
          ...args,
          request: { ...args.request, requestId: 'stale-visible' },
        },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(ReportDataSurfaceVisibleError);
  });

  it('only resolves drilldown from the current tenant materialized row', async () => {
    const tools = toolSet({ reports: [reportDefinition()] });
    const drilldown = tools.get(REPORT_DRILLDOWN_TOOL_SLUG);
    const tenantA = fakeRun([REPORT_DRILLDOWN_TOOL_SLUG], 'tenant-a');
    const tenantB = fakeRun([REPORT_DRILLDOWN_TOOL_SLUG], 'tenant-b');
    const reportId = await currentReportId();

    const handoff = await drilldown?.execute({
      run: tenantA,
      args: { reportId, rowId: 'tenant-a-row' },
      db: undefined,
    });
    expect(handoff).toMatchObject({
      resourceId: reportId,
      sourceClassName: expect.stringContaining('ReportToolsInvoice'),
      constraints: [
        expect.objectContaining({ id: 'customer_id', value: 'customer-a' }),
      ],
    });

    await expect(
      drilldown?.execute({
        run: tenantB,
        args: { reportId, rowId: 'tenant-a-row' },
        db: undefined,
      }),
    ).rejects.toThrow();
  });

  it('forwards the report-declared refresh permission to the live action host', async () => {
    const db = await setupLifecycleDb();
    const authorize = vi.fn();
    const audit = vi.fn();
    const adapter = { refreshPermission: 'reports.refresh-sensitive' };
    const tools = toolSet({
      reports: [
        reportDefinition({
          adapter,
          refresh: { actionHost: () => ({ authorize, audit }) },
        }),
      ],
    });
    const run = fakeRun([REPORT_REFRESH_TOOL_SLUG]);
    try {
      await expect(
        withTenant({ tenantId: 'tenant-a' }, async () =>
          tools.get(REPORT_REFRESH_TOOL_SLUG)?.execute({
            run,
            args: {
              reportId: await currentReportId(adapter),
              phase: 'preview',
              mode: 'invalid',
            },
            db,
          }),
        ),
      ).rejects.toThrow('Report refresh mode is invalid');
      expect(authorize).not.toHaveBeenCalled();
      await withTenant({ tenantId: 'tenant-a' }, async () =>
        tools.get(REPORT_REFRESH_TOOL_SLUG)?.execute({
          run,
          args: {
            reportId: await currentReportId(adapter),
            phase: 'preview',
          },
          db,
        }),
      );
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredPermission: 'reports.refresh-sensitive',
        }),
      );
      expect(audit).toHaveBeenCalledTimes(1);
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('requires snapshot/auth/audit and explicit confirmation for sensitive exports', async () => {
    const db = await setupLifecycleDb();
    const captured: unknown[] = [];
    const authorize = vi.fn();
    const audit = vi.fn();
    const assertSnapshot = vi.fn();
    const definition = reportDefinition({
      export: {
        captureSnapshot: async (context: unknown) => {
          captured.push(context);
          return { id: 'snapshot-a' };
        },
        actionHost: () => ({ assertSnapshot, authorize, audit }),
      },
    });
    const tools = toolSet({ reports: [definition] });
    const run = fakeRun([REPORT_EXPORT_TOOL_SLUG]);
    const reportId = await currentReportId();
    const args = {
      reportId,
      phase: 'apply',
      query: {
        version: 1,
        requestId: 'sensitive-export',
        mode: 'rows',
        projection: ['id', 'personal_revenue'],
      },
      format: 'csv',
    };
    try {
      await expect(
        withTenant({ tenantId: 'tenant-a' }, () =>
          tools.get(REPORT_EXPORT_TOOL_SLUG)?.execute({
            run,
            args,
            db,
          }),
        ),
      ).rejects.toThrow(
        'Sensitive report exports require explicit confirmation',
      );
      expect(captured).toHaveLength(1);
      expect(authorize).not.toHaveBeenCalled();
      expect(assertSnapshot).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();

      const applied = await withTenant({ tenantId: 'tenant-a' }, () =>
        tools.get(REPORT_EXPORT_TOOL_SLUG)?.execute({
          run,
          args: { ...args, confirmed: true },
          db,
        }),
      );
      expect(applied).toMatchObject({
        phase: 'apply',
        execution: 'stream',
        status: 'ready',
      });
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredPermission: 'reports.export',
          confirmationRequired: true,
        }),
      );
      expect(assertSnapshot).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(1);
    } finally {
      if (typeof db.close === 'function') await db.close();
    }
  });
});
