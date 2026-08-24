import { createDataQueryFingerprint } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import type { ReportAdapterDescriptor } from '../adapter.js';
import {
  applyReportExport,
  createReportExportPageRequest,
  createReportExportRequest,
  createReportExportSnapshot,
  migrateReportSavedView,
  normalizeReportSavedView,
  previewReportExport,
  ReportSurfaceValidationError,
  restoreReportSavedView,
  validateReportExportArtifact,
  validateReportExportExecution,
  verifyReportExportSnapshot,
} from '../views.js';

const AS_OF = '2026-08-23T22:00:00.000Z';
const REFRESHED_AT = '2026-08-23T21:59:00.000Z';

function descriptor(): ReportAdapterDescriptor {
  return {
    version: 1,
    resourceId: '@test/reports:RevenueReport#current',
    reportClassName: '@test/reports:RevenueReport',
    sourceClassName: '@test/reports:Invoice',
    tenantScoped: true,
    tenantField: 'tenant_id',
    identityField: 'id',
    columns: [
      {
        id: 'id',
        fieldName: 'id',
        label: 'ID',
        kind: 'identity',
        filterScope: 'where',
        type: 'string',
        projectable: true,
        sortable: true,
        facetable: false,
        filterOperators: ['eq'],
        capabilities: ['read', 'project', 'filter', 'sort'],
      },
      {
        id: 'customer_id',
        fieldName: 'customerId',
        label: 'Customer',
        kind: 'group',
        filterScope: 'where',
        type: 'string',
        projectable: true,
        sortable: true,
        facetable: true,
        filterOperators: ['eq'],
        capabilities: ['read', 'project', 'filter', 'sort', 'facet', 'group'],
      },
      {
        id: 'revenue',
        fieldName: 'revenue',
        label: 'Revenue',
        kind: 'aggregate',
        filterScope: 'having',
        type: 'number',
        projectable: true,
        sortable: true,
        facetable: false,
        filterOperators: ['gte'],
        capabilities: ['read', 'project', 'filter', 'sort', 'aggregate'],
        sensitivity: 'personal',
      },
    ],
    schema: {
      version: 1,
      identityField: 'id',
      fields: [
        {
          id: 'id',
          type: 'string',
          projectable: true,
          sortable: true,
          facetable: false,
          filterOperators: ['eq'],
        },
        {
          id: 'customer_id',
          type: 'string',
          projectable: true,
          sortable: true,
          facetable: true,
          filterOperators: ['eq'],
        },
        {
          id: 'revenue',
          type: 'number',
          projectable: true,
          sortable: true,
          facetable: false,
          filterOperators: ['gte'],
        },
      ],
      defaultSort: [{ field: 'id', direction: 'asc' }],
      supports: { cursorPagination: false, consistency: false, facets: true },
    },
    queryExecution: {
      modes: ['visible', 'background', 'silent'],
      visible: { delivery: 'result' },
      background: { delivery: 'queued', requiresHost: true },
      silent: { delivery: 'result', mutatesVisibleSurface: false },
    },
    dataTable: {
      rowKey: 'id',
      manualPagination: true,
      manualSorting: true,
      enableFiltering: true,
      enableSearch: false,
      columns: [],
      structuralRows: [],
    },
    drilldown: {
      id: 'drilldown',
      sourceClassName: '@test/reports:Invoice',
      fields: [],
      inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
    },
    refresh: {
      mode: 'incremental',
      mayRefreshOnRead: true,
      triggers: ['manual'],
      action: {
        id: 'refresh',
        label: 'Refresh report',
        scope: 'surface',
        phases: ['preview', 'apply'],
        requiresPermission: true,
        requiredPermission: 'reports.refresh',
        auditRequired: true,
      },
    },
  };
}

function query() {
  return {
    version: 1,
    requestId: 'report-view',
    mode: 'rows',
    projection: ['id', 'customer_id', 'revenue'],
    filter: {
      kind: 'condition',
      field: 'customer_id',
      operator: 'eq',
      value: 'customer-a',
    },
    sort: [{ field: 'revenue', direction: 'desc' }],
    page: { kind: 'offset', offset: 0, limit: 50 },
  } as const;
}

function sourceResult(report: ReportAdapterDescriptor, rowCount = 1_500) {
  const request = query();
  return {
    queryFingerprint: createDataQueryFingerprint(request, report.schema),
    identityField: 'id',
    total: { kind: 'exact' as const, value: rowCount },
    freshness: { state: 'stale' as const, asOf: AS_OF },
    truncated: false,
    reportLifecycle: {
      read: 'stale' as const,
      snapshot: {
        version: 1 as const,
        state: 'stale' as const,
        asOf: AS_OF,
        refreshedAt: REFRESHED_AT,
        hasUsableRows: true,
        mode: 'incremental' as const,
        lock: { held: false },
      },
    },
  };
}

describe('report saved views and exports', () => {
  it('normalizes saved views through the current descriptor policy', () => {
    const report = descriptor();
    const legacy = {
      version: 0,
      id: 'view-1',
      title: 'Customers by revenue',
      query: query(),
      columns: [
        { id: 'customer_id', width: 240, pinned: 'start' },
        { id: 'revenue', width: 120 },
      ],
      grouping: { fields: ['customer_id'], expanded: true },
      display: { density: 'compact', showTotals: true },
    };
    expect(migrateReportSavedView(legacy)).toMatchObject({ version: 1 });
    const saved = normalizeReportSavedView(report, legacy);

    expect(saved).toMatchObject({
      version: 1,
      resourceId: report.resourceId,
      reportClassName: report.reportClassName,
      columns: [
        { id: 'customer_id', width: 240, pinned: 'start' },
        { id: 'revenue', width: 120 },
      ],
      grouping: { fields: ['customer_id'], expanded: true },
    });
    expect(saved.query.requestId).toBe('report-view');

    expect(() =>
      normalizeReportSavedView(report, {
        id: 'forbidden',
        title: 'Forbidden',
        query: query(),
        columns: [{ id: 'secret_total' }],
      }),
    ).toThrow(/current report policy/);

    expect(() =>
      restoreReportSavedView(
        { ...report, sourceClassName: '@test/reports:ChangedInvoice' },
        saved,
      ),
    ).toThrow(/definition has changed/);
    expect(() => migrateReportSavedView({ ...legacy, version: 2 })).toThrow(
      /version is unsupported/,
    );
    expect(() =>
      normalizeReportSavedView(report, {
        ...legacy,
        query: {
          ...query(),
          filter: {
            kind: 'any',
            filters: [
              {
                kind: 'condition',
                field: 'customer_id',
                operator: 'eq',
                value: 'customer-a',
              },
              {
                kind: 'condition',
                field: 'revenue',
                operator: 'gte',
                value: 100,
              },
            ],
          },
        },
      }),
    ).toThrow(/WHERE and HAVING filters cannot be mixed/);
  });

  it('freezes the exact normalized query and materialization metadata for export', () => {
    const report = descriptor();
    const snapshot = createReportExportSnapshot(
      report,
      query(),
      sourceResult(report),
      { id: 'snapshot-1' },
    );

    expect(snapshot).toMatchObject({
      resourceId: report.resourceId,
      reportClassName: report.reportClassName,
      projection: ['customer_id', 'id', 'revenue'],
      sort: [
        { field: 'revenue', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      freshness: { state: 'stale', asOf: AS_OF },
      snapshot: {
        asOf: AS_OF,
        refreshedAt: REFRESHED_AT,
        stale: true,
      },
      total: { kind: 'exact', value: 1_500 },
      inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
    });

    expect(() =>
      createReportExportSnapshot(
        report,
        query(),
        {
          ...sourceResult(report),
          queryFingerprint: 'dq1_wrong',
        },
        { id: 'snapshot-1' },
      ),
    ).toThrow(/query fingerprint/);
    expect(() =>
      createReportExportSnapshot(
        report,
        query(),
        { ...sourceResult(report), truncated: true },
        { id: 'snapshot-1' },
      ),
    ).toThrow(/truncated/);
    const offsetAsOf = '2026-08-23T22:00:00.000+00:00';
    const offsetResult = sourceResult(report);
    const offsetSnapshot = createReportExportSnapshot(
      report,
      query(),
      {
        ...offsetResult,
        freshness: { state: 'stale', asOf: offsetAsOf },
        reportLifecycle: {
          ...offsetResult.reportLifecycle,
          snapshot: {
            ...offsetResult.reportLifecycle.snapshot,
            asOf: AS_OF,
          },
        },
      },
      { id: 'snapshot-offset' },
    );
    expect(offsetSnapshot.snapshot.asOf).toBe(AS_OF);
    const revalidatedOffsetSnapshot = verifyReportExportSnapshot(report, {
      ...offsetSnapshot,
      freshness: { state: 'stale', asOf: offsetAsOf },
      snapshot: {
        ...offsetSnapshot.snapshot,
        asOf: offsetAsOf,
        refreshedAt: '2026-08-23T21:59:00.000+00:00',
      },
    });
    expect(revalidatedOffsetSnapshot).toMatchObject({
      freshness: { asOf: AS_OF },
      snapshot: { asOf: AS_OF, refreshedAt: REFRESHED_AT },
    });
    expect(() =>
      verifyReportExportSnapshot(report, {
        ...snapshot,
        unexpected: true,
      } as unknown as typeof snapshot),
    ).toThrow(ReportSurfaceValidationError);
    expect(() =>
      verifyReportExportSnapshot(report, {
        ...snapshot,
        freshness: { ...snapshot.freshness, unexpected: true },
      } as unknown as typeof snapshot),
    ).toThrow(ReportSurfaceValidationError);
    expect(() =>
      verifyReportExportSnapshot(report, {
        ...snapshot,
        snapshot: { ...snapshot.snapshot, unexpected: true },
      } as unknown as typeof snapshot),
    ).toThrow(ReportSurfaceValidationError);
    expect(
      createReportExportRequest(report, revalidatedOffsetSnapshot, {
        format: 'csv',
      }).read.asOf,
    ).toBe(AS_OF);
  });

  it('uses one audited, confirmation-aware operation and queues large exports', async () => {
    const report = descriptor();
    const snapshot = createReportExportSnapshot(
      report,
      query(),
      sourceResult(report),
      { id: 'snapshot-2' },
    );
    const request = createReportExportRequest(report, snapshot, {
      format: 'csv',
      limits: {
        maxRows: 1_000,
        maxBytes: 10_000,
        deadlineMs: 5_000,
        foregroundRowLimit: 10,
      },
    });
    const completeRequest = createReportExportRequest(report, snapshot, {
      format: 'csv',
      limits: {
        maxRows: 2_000,
        maxBytes: 10_000,
        deadlineMs: 5_000,
        foregroundRowLimit: 10,
      },
    });
    expect(
      createReportExportPageRequest(report, completeRequest, 0),
    ).toMatchObject({
      projection: ['customer_id', 'id', 'revenue'],
      page: { kind: 'offset', offset: 0, limit: 1_000 },
    });
    expect(
      createReportExportPageRequest(report, completeRequest, 1_000),
    ).toMatchObject({
      page: { kind: 'offset', offset: 1_000, limit: 500 },
    });
    expect(() =>
      createReportExportPageRequest(report, completeRequest, 1_500),
    ).toThrow(/outside the bounded export/);
    expect(
      createReportExportRequest(report, snapshot, {
        format: 'csv',
        limits: { maxRows: 100 },
      }),
    ).toMatchObject({
      limits: { maxRows: 100, foregroundRowLimit: 100 },
    });
    const authorize = vi.fn();
    const audit = vi.fn();
    const assertSnapshot = vi.fn();
    const enqueue = vi.fn(async () => ({ taskId: 'export-task-1' }));
    const host = { assertSnapshot, authorize, audit, enqueue };

    const preview = await previewReportExport(report, request, host);
    expect(preview.action).toMatchObject({
      phase: 'preview',
      requiredPermission: 'reports.export',
      confirmationRequired: true,
      execution: 'background',
    });
    await expect(
      previewReportExport(
        report,
        {
          ...request,
          action: { ...request.action, confirmationRequired: false },
        },
        host,
      ),
    ).rejects.toThrow(/does not match current policy/);
    await expect(
      previewReportExport(
        report,
        {
          ...request,
          read: { ...request.read, snapshotId: 'different-snapshot' },
        },
        host,
      ),
    ).rejects.toThrow(/does not match current policy/);
    await expect(applyReportExport(report, request, host)).rejects.toThrow(
      /explicit confirmation/,
    );

    const applied = await applyReportExport(report, request, host, {
      confirmed: true,
    });
    expect(applied).toMatchObject({
      phase: 'apply',
      execution: 'background',
      status: 'queued',
      taskId: 'export-task-1',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: 'background',
        inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
        request: expect.objectContaining({
          rowCount: 1_000,
          read: {
            snapshotId: 'snapshot-2',
            queryFingerprint: snapshot.queryFingerprint,
            asOf: AS_OF,
            page: { kind: 'offset', offset: 0, limit: 1_000 },
          },
        }),
      }),
    );
    await expect(
      validateReportExportExecution(report, request, host),
    ).resolves.toMatchObject({ read: { snapshotId: 'snapshot-2' } });
    expect(assertSnapshot).toHaveBeenCalledWith({
      bindingId: 'snapshot-2',
      resourceId: report.resourceId,
      reportClassName: report.reportClassName,
      definitionFingerprint: snapshot.definitionFingerprint,
      queryFingerprint: snapshot.queryFingerprint,
      asOf: AS_OF,
    });
    await expect(
      validateReportExportExecution(report, request, {
        ...host,
        assertSnapshot: () => {
          throw new Error('materialization snapshot is no longer available');
        },
      }),
    ).rejects.toThrow(/snapshot is no longer available/);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(assertSnapshot).toHaveBeenCalledTimes(3);
    expect(request).toMatchObject({ rowCount: 1_000, truncated: true });
  });

  it('fails expired artifacts and definition drift before a serving host can expose them', () => {
    const report = descriptor();
    const snapshot = createReportExportSnapshot(
      report,
      query(),
      sourceResult(report, 2),
      { id: 'snapshot-3' },
    );
    const request = createReportExportRequest(report, snapshot, {
      format: 'json',
      limits: {
        maxRows: 100,
        maxBytes: 10_000,
        deadlineMs: 5_000,
        foregroundRowLimit: 10,
      },
    });
    const artifact = {
      id: 'artifact-1',
      request,
      progress: {
        state: 'completed' as const,
        rowCount: 2,
        byteCount: 100,
        truncated: false,
      },
      expiresAt: '2026-08-23T23:00:00.000Z',
    };

    expect(
      validateReportExportArtifact(
        report,
        artifact,
        new Date('2026-08-23T22:30:00.000Z'),
      ),
    ).toMatchObject({ id: 'artifact-1' });
    expect(() =>
      validateReportExportArtifact(
        report,
        artifact,
        new Date('2026-08-23T23:00:00.000Z'),
      ),
    ).toThrow(/expired/);
    expect(() =>
      validateReportExportArtifact(
        { ...report, sourceClassName: '@test/reports:ChangedInvoice' },
        artifact,
      ),
    ).toThrow(/definition has changed/);
    expect(() =>
      validateReportExportArtifact(
        report,
        {
          ...artifact,
          progress: null,
        } as unknown as typeof artifact,
        new Date('2026-08-23T22:30:00.000Z'),
      ),
    ).toThrow(/progress must be a plain object/);
    expect(() =>
      validateReportExportArtifact(
        report,
        {
          ...artifact,
          progress: { ...artifact.progress, rowCount: 3 },
        },
        new Date('2026-08-23T22:30:00.000Z'),
      ),
    ).toThrow(/rowCount cannot exceed 2/);
    expect(() =>
      validateReportExportArtifact(
        report,
        {
          ...artifact,
          progress: { ...artifact.progress, rowCount: 1 },
        },
        new Date('2026-08-23T22:30:00.000Z'),
      ),
    ).toThrow(/must contain the requested row count/);
    expect(() =>
      validateReportExportArtifact(
        report,
        {
          ...artifact,
          progress: { ...artifact.progress, truncated: true },
        },
        new Date('2026-08-23T22:30:00.000Z'),
      ),
    ).toThrow(/must match the requested truncation state/);
    expect(() =>
      validateReportExportArtifact(
        report,
        { ...artifact, unexpected: true } as unknown as typeof artifact,
        new Date('2026-08-23T22:30:00.000Z'),
      ),
    ).toThrow(ReportSurfaceValidationError);
    expect(() =>
      validateReportExportArtifact(
        report,
        {
          ...artifact,
          progress: { ...artifact.progress, unexpected: true },
        } as unknown as typeof artifact,
        new Date('2026-08-23T22:30:00.000Z'),
      ),
    ).toThrow(ReportSurfaceValidationError);
  });
});
