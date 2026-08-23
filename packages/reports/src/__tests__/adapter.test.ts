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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReportAdapterDescriptor,
  buildReportDrilldownQuery,
  queryReportMaterializedRows,
  reportMaterializedRowKey,
  splitReportFilterScopes,
} from '../adapter.js';
import { reportRowIdentity } from '../refresh.js';

class AdapterInvoice extends SmrtObject {}
class AdapterReport extends SmrtObject {}
class ManualRefreshReport extends SmrtObject {}
class UnscopedTenantMarkedReport extends SmrtObject {}

function registerFixture() {
  ObjectRegistry.registerFromManifest(
    'AdapterInvoice',
    {
      className: 'AdapterInvoice',
      fields: { tenantId: { type: 'text' } },
      methods: {},
      decoratorConfig: { tableName: 'adapter_invoices' },
      schema: {
        tableName: 'adapter_invoices',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
  ObjectRegistry.registerFromManifest(
    'AdapterReport',
    {
      className: 'AdapterReport',
      fields: {
        tenantId: {
          type: 'text',
          _meta: { __tenancy: { isTenantIdField: true } },
        },
        customerId: {
          type: 'text',
          description: 'Customer',
          _meta: {
            __report: { kind: 'group', sourceColumn: 'customerId' },
            format: 'text',
            sensitivity: 'personal',
            capabilities: ['read', 'project', 'filter', 'sort', 'group'],
          },
        },
        issuedMonth: {
          type: 'datetime',
          _meta: {
            __report: {
              kind: 'bucket',
              unit: 'month',
              sourceColumn: 'issuedAt',
            },
          },
        },
        revenue: {
          type: 'decimal',
          _meta: {
            __report: { kind: 'aggregate', fn: 'sum', column: 'totalAmount' },
          },
        },
        secretTotal: {
          type: 'decimal',
          _meta: {
            sensitive: true,
            __report: { kind: 'aggregate', fn: 'sum', column: 'secretTotal' },
          },
        },
        restrictedTotal: {
          type: 'decimal',
          _meta: {
            readPermission: 'reports:read-restricted',
            __report: {
              kind: 'aggregate',
              fn: 'sum',
              column: 'restrictedTotal',
            },
          },
        },
        transientTotal: {
          type: 'decimal',
          transient: true,
          _meta: {
            transient: true,
            __report: {
              kind: 'aggregate',
              fn: 'sum',
              column: 'transientTotal',
            },
          },
        },
        relatedTotal: {
          type: 'oneToMany',
          _meta: {
            __report: { kind: 'aggregate', fn: 'sum', column: 'relatedTotal' },
          },
        },
        refreshedAt: { type: 'datetime' },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'adapter_reports',
        tenantScoped: { field: 'tenantId', mode: 'optional' },
        report: {
          source: 'AdapterInvoice',
          refresh: {
            mode: 'incremental',
            ttl: 30_000,
            onChange: ['AdapterInvoice'],
          },
        },
      },
      schema: {
        tableName: 'adapter_reports',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
}

function registerRefreshAndTenancyDescriptorFixtures() {
  ObjectRegistry.registerFromManifest(
    'ManualRefreshReport',
    {
      className: 'ManualRefreshReport',
      fields: {
        revenue: {
          type: 'decimal',
          _meta: {
            __report: { kind: 'aggregate', fn: 'sum', column: 'totalAmount' },
          },
        },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'manual_refresh_reports',
        report: {
          source: 'AdapterInvoice',
          refresh: {
            manual: true,
            mode: 'incremental',
            ttl: 30_000,
            schedule: '0 * * * *',
            onChange: ['AdapterInvoice'],
          },
        },
      },
      schema: {
        tableName: 'manual_refresh_reports',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
  ObjectRegistry.registerFromManifest(
    'UnscopedTenantMarkedReport',
    {
      className: 'UnscopedTenantMarkedReport',
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
      },
      methods: {},
      decoratorConfig: {
        tableName: 'unscoped_tenant_marked_reports',
        report: { source: 'AdapterInvoice' },
      },
      schema: {
        tableName: 'unscoped_tenant_marked_reports',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
}

function registerRuntimeTenantFixture() {
  // Exercise the manifest-hydrated deployment path used by the default
  // collection resolver. Registering an unqualified test constructor here
  // would leave its fields on a different registry entry than the qualified
  // adapter descriptor resolves.
  registerFixture();
}

describe('report adapter', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerFixture();
    registerRefreshAndTenancyDescriptorFixtures();
  });

  afterEach(() => ObjectRegistry.clear());

  it('builds deterministic schema and report column descriptors', async () => {
    const first = await buildReportAdapterDescriptor(AdapterReport);
    const second = await buildReportAdapterDescriptor(AdapterReport);

    expect(
      JSON.stringify({
        columns: first.columns,
        schema: first.schema,
        dataTable: first.dataTable,
        refresh: first.refresh,
      }),
    ).toBe(
      JSON.stringify({
        columns: second.columns,
        schema: second.schema,
        dataTable: second.dataTable,
        refresh: second.refresh,
      }),
    );
    expect(first.identityField).toBe('id');
    expect(first.schema.identityField).toBe('id');
    expect(first.queryExecution).toEqual({
      modes: ['visible', 'background', 'silent'],
      visible: { delivery: 'result' },
      background: { delivery: 'queued', requiresHost: true },
      silent: { delivery: 'result', mutatesVisibleSurface: false },
    });
    expect(first.schema.fields[0].id).toBe('customer_id');
    expect(first.columns.map((column) => column.id)).toEqual([
      'customer_id',
      'id',
      'issued_month',
      'revenue',
    ]);
    expect(
      first.columns.find((column) => column.id === 'customer_id'),
    ).toMatchObject({
      kind: 'group',
      type: 'string',
      format: 'text',
      sensitivity: 'personal',
    });
    expect(first.tenantScoped).toBe(true);
    expect(first.tenantField).toBe('tenant_id');
    expect(first.refresh).toMatchObject({
      mode: 'incremental',
      mayRefreshOnRead: true,
      ttlMs: 30_000,
      action: {
        id: 'refresh',
        scope: 'surface',
        phases: ['preview', 'apply'],
        requiresPermission: true,
        requiredPermission: 'reports.refresh',
        auditRequired: true,
      },
    });
    expect(first.columns.some((column) => column.id === 'secret_total')).toBe(
      false,
    );
    expect(
      first.columns.some((column) => column.id === 'restricted_total'),
    ).toBe(false);
    expect(
      first.columns.some((column) => column.id === 'transient_total'),
    ).toBe(false);
    expect(first.columns.some((column) => column.id === 'related_total')).toBe(
      false,
    );
    expect(first.refresh.triggers).toEqual(['manual', 'change', 'ttl', 'job']);
    expect(first.dataTable).toMatchObject({
      rowKey: 'id',
      manualPagination: true,
      manualSorting: true,
      enableFiltering: true,
      enableSearch: false,
    });
    expect(first.dataTable.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'customer_id',
          searchable: false,
          filterable: true,
        }),
        expect.objectContaining({
          id: 'revenue',
          searchable: false,
          filterable: true,
        }),
      ]),
    );
    expect(
      first.schema.fields.find((field) => field.id === 'customer_id'),
    ).toMatchObject({
      filterOperators: expect.arrayContaining(['eq', 'in', 'like']),
      sortable: true,
      facetable: true,
    });
    expect(
      first.schema.fields.find((field) => field.id === 'revenue'),
    ).toMatchObject({ sortable: true, facetable: false });
    expect(first.schema.supports?.facets).toBe(true);
    expect(
      first.columns.find((column) => column.id === 'customer_id'),
    ).toMatchObject({
      filterScope: 'where',
      sortable: true,
      facetable: true,
      capabilities: ['project', 'read', 'filter', 'sort', 'facet', 'group'],
    });
    expect(
      first.columns.find((column) => column.id === 'revenue'),
    ).toMatchObject({
      filterScope: 'having',
      sortable: true,
      facetable: false,
      capabilities: ['project', 'read', 'filter', 'sort', 'aggregate'],
    });
    expect(() => JSON.stringify(first)).not.toThrow();
  });

  it('projects report metadata into neutral grouped-header and format hints', async () => {
    const descriptor = await buildReportAdapterDescriptor(AdapterReport);

    expect(
      descriptor.dataTable.columns.find(
        (column) => column.id === 'customer_id',
      ),
    ).toMatchObject({
      headerPath: [
        { id: 'dimensions', label: 'Dimensions' },
        { id: 'groups', label: 'Groups' },
      ],
      valueFormat: 'text',
      align: 'left',
      responsive: { priority: 100, keepVisible: true },
    });
    expect(
      descriptor.dataTable.columns.find(
        (column) => column.id === 'issued_month',
      ),
    ).toMatchObject({
      headerPath: [
        { id: 'dimensions', label: 'Dimensions' },
        { id: 'time', label: 'Time' },
      ],
      valueFormat: 'date',
      align: 'left',
    });
    expect(
      descriptor.dataTable.columns.find((column) => column.id === 'revenue'),
    ).toMatchObject({
      headerPath: [
        { id: 'measures', label: 'Measures' },
        { id: 'aggregate:sum', label: 'Sum' },
      ],
      valueFormat: 'number',
      align: 'right',
      responsive: { priority: 20 },
    });
  });

  it('does not treat prototype property names as configured value formats', async () => {
    ObjectRegistry.registerFieldDecorator('AdapterReport', 'revenue', {
      format: '__proto__',
    });

    const descriptor = await buildReportAdapterDescriptor(AdapterReport);

    expect(
      descriptor.dataTable.columns.find((column) => column.id === 'revenue'),
    ).toMatchObject({ valueFormat: 'number' });
  });

  it('allows consumer presentation overrides while keeping structural rows non-data', async () => {
    const descriptor = await buildReportAdapterDescriptor(AdapterReport, {
      dataTable: {
        columns: {
          revenue: {
            label: 'Recognized revenue',
            headerPath: [
              { id: 'financial', label: 'Financials' },
              { id: 'recognized', label: 'Recognized' },
            ],
            valueFormat: 'money',
            responsive: { priority: 90, keepVisible: true },
          },
        },
        structuralRows: [
          {
            id: 'all-customers',
            kind: 'summary',
            label: 'All customers',
            values: { revenue: 900_000.25 },
            labelColumnId: 'customer_id',
          },
        ],
      },
    });

    expect(
      descriptor.dataTable.columns.find((column) => column.id === 'revenue'),
    ).toMatchObject({
      label: 'Recognized revenue',
      headerPath: [
        { id: 'financial', label: 'Financials' },
        { id: 'recognized', label: 'Recognized' },
      ],
      valueFormat: 'money',
      responsive: { priority: 90, keepVisible: true },
    });
    expect(descriptor.dataTable.structuralRows).toEqual([
      {
        id: 'all-customers',
        kind: 'summary',
        label: 'All customers',
        values: { revenue: 900_000.25 },
        labelColumnId: 'customer_id',
        selection: 'excluded',
        actions: 'excluded',
      },
    ]);
  });

  it('makes structural row values safe for JSON transport', async () => {
    const descriptor = await buildReportAdapterDescriptor(AdapterReport, {
      dataTable: {
        structuralRows: [
          {
            id: 'all-customers',
            kind: 'summary',
            label: 'All customers',
            values: {
              customer_id: new Date('2026-08-23T00:00:00.000Z'),
              revenue: 42n,
            },
          },
        ],
      },
    });

    expect(descriptor.dataTable.structuralRows[0]?.values).toEqual({
      customer_id: '2026-08-23T00:00:00.000Z',
      revenue: 42,
    });
    expect(() => JSON.stringify(descriptor)).not.toThrow();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          structuralRows: [
            {
              id: 'circular',
              kind: 'summary',
              label: 'Circular',
              values: { revenue: circular },
            },
          ],
        },
      }),
    ).rejects.toThrow(/circular references/);
  });

  it('rejects malformed grouped headers and duplicate structural rows', async () => {
    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          columns: {
            revenue: { headerPath: [{ id: '', label: 'Financials' }] },
          },
        },
      }),
    ).rejects.toThrow(/headerPath entries/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          structuralRows: [
            { id: 'total', kind: 'summary', label: 'Total' },
            { id: 'total', kind: 'footer', label: 'Total' },
          ],
        },
      }),
    ).rejects.toThrow(/must be unique/);
  });

  it('rejects invalid JavaScript presentation enum values at the adapter boundary', async () => {
    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          columns: {
            revenue: { valueFormat: 'scientific' as never },
          },
        },
      }),
    ).rejects.toThrow(/valueFormat.*not supported/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          structuralRows: [
            { id: 'total', kind: 'data' as never, label: 'Total' },
          ],
        },
      }),
    ).rejects.toThrow(/kind is not supported/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          columns: { revenue: { role: '' as never } },
        },
      }),
    ).rejects.toThrow(/role.*not supported/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          columns: {
            revenue: {
              align: 'center' as never,
              responsive: { keepVisible: 'yes' as never },
            },
          },
        },
      }),
    ).rejects.toThrow(/align.*not supported/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          columns: { revenue: { label: 12 as never } },
        },
      }),
    ).rejects.toThrow(/label.*must not be empty/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          columns: {
            revenue: { responsive: { keepVisible: 'yes' as never } },
          },
        },
      }),
    ).rejects.toThrow(/keepVisible.*boolean/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          structuralRows: [
            {
              id: 'total',
              kind: 'summary',
              label: 'Total',
              labelColumnId: 'missing_column',
            },
          ],
        },
      }),
    ).rejects.toThrow(/labelColumnId.*adapter column/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          structuralRows: [
            {
              id: 'total',
              kind: 'summary',
              label: 'Total',
              labelColumnId: '' as never,
            },
          ],
        },
      }),
    ).rejects.toThrow(/labelColumnId.*adapter column/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          structuralRows: [
            {
              id: 'total',
              kind: 'summary',
              label: 'Total',
              values: null as never,
            },
          ],
        },
      }),
    ).rejects.toThrow(/values must be an object/);

    await expect(
      buildReportAdapterDescriptor(AdapterReport, {
        dataTable: {
          structuralRows: [
            {
              id: 'total',
              kind: 'summary',
              label: 'Total',
              values: { unknown_column: 1 },
            },
          ],
        },
      }),
    ).rejects.toThrow(/values must use adapter column ids/);
  });

  it('does not describe a tenant-like field as a tenant boundary without registration', async () => {
    const descriptor = await buildReportAdapterDescriptor(
      UnscopedTenantMarkedReport,
    );

    expect(descriptor.tenantScoped).toBe(false);
    expect(descriptor.tenantField).toBeUndefined();
  });

  it('suppresses automatic refresh triggers for manual reports', async () => {
    const descriptor = await buildReportAdapterDescriptor(ManualRefreshReport);

    expect(descriptor.refresh).toMatchObject({ mayRefreshOnRead: false });
    expect(descriptor.refresh.triggers).toEqual(['manual']);
  });

  it('requires a materialized identity and preserves reportRowIdentity', async () => {
    const descriptor = await buildReportAdapterDescriptor(AdapterReport);
    expect(reportMaterializedRowKey({ id: 'materialized-row' })).toBe(
      'materialized-row',
    );
    expect(() => reportMaterializedRowKey({})).toThrow(
      /require a non-empty string id/,
    );

    const definition = {
      reportClassName: 'AdapterReport',
      sourceClassName: 'AdapterInvoice',
      sourceTable: 'adapter_invoices',
      fields: [
        {
          fieldName: 'customerId',
          columnName: 'customer_id',
          report: { kind: 'group' as const, sourceColumn: 'customerId' },
        },
      ],
    };
    expect(reportRowIdentity({ customer_id: 'customer-1' }, definition)).toBe(
      reportRowIdentity({ customer_id: 'customer-1' }, definition),
    );
    expect(descriptor.schema.identityField).toBe('id');
  });

  it('builds a principal-and-tenant-bound drilldown handoff from declared groups', async () => {
    const descriptor = await buildReportAdapterDescriptor(AdapterReport);
    expect(descriptor.drilldown).toEqual({
      id: 'drilldown',
      sourceClassName: 'AdapterInvoice',
      fields: [
        {
          id: 'customer_id',
          sourceColumn: 'customer_id',
          kind: 'group',
        },
        {
          id: 'issued_month',
          sourceColumn: 'issued_at',
          kind: 'bucket',
          bucket: 'month',
        },
      ],
      inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
    });

    await expect(
      buildReportDrilldownQuery(AdapterReport, {
        customer_id: 'customer-1',
        issued_month: new Date('2026-08-01T00:00:00.000Z'),
      }),
    ).resolves.toEqual({
      version: 1,
      resourceId: '@happyvertical/smrt-reports:AdapterReport#current',
      reportClassName: '@happyvertical/smrt-reports:AdapterReport',
      sourceClassName: 'AdapterInvoice',
      constraints: [
        {
          id: 'customer_id',
          sourceColumn: 'customer_id',
          kind: 'group',
          value: 'customer-1',
        },
        {
          id: 'issued_month',
          sourceColumn: 'issued_at',
          kind: 'bucket',
          bucket: 'month',
          value: '2026-08-01T00:00:00.000Z',
        },
      ],
      inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
    });

    await expect(buildReportDrilldownQuery(AdapterReport, {})).rejects.toThrow(
      /missing grouping field: customer_id/,
    );
  });

  it('projects and pages materialized rows through the canonical result envelope', async () => {
    let listOptions: Record<string, unknown> | undefined;
    const collection = {
      async list(options: Record<string, unknown>) {
        listOptions = options;
        return [{ id: 'row-2', customerId: 'customer-2' }];
      },
      async count() {
        return 2;
      },
    };
    const result = await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-1',
        mode: 'rows',
        projection: ['customer_id'],
        page: { kind: 'offset', offset: 1, limit: 1 },
      },
      { collection },
    );
    expect(listOptions).toMatchObject({
      select: ['customerId', 'id'],
      offset: 1,
      limit: 1,
      orderBy: 'id ASC',
    });
    expect(result.rows).toEqual([{ customer_id: 'customer-2', id: 'row-2' }]);
    expect(result.page).toEqual({
      kind: 'offset',
      offset: 1,
      limit: 1,
      hasMore: false,
    });
    expect(result.total).toEqual({ kind: 'exact', value: 2 });
    expect(result.freshness).toEqual({ state: 'unknown' });
    expect(result.execution).toBe('visible');
  });

  it('executes silent reads without a visible-surface side effect', async () => {
    const result = await queryReportMaterializedRows(
      AdapterReport,
      { version: 1, requestId: 'request-silent', mode: 'rows' },
      {
        execution: 'silent',
        collection: {
          async list() {
            return [{ id: 'row-silent' }];
          },
          async count() {
            return 1;
          },
        },
      },
    );

    expect(result.execution).toBe('silent');
    expect(result.rows).toEqual([{ id: 'row-silent' }]);
  });

  it('delegates background queries to a host without reading or serializing authority', async () => {
    const list = vi.fn(async () => [{ id: 'must-not-read' }]);
    const enqueueBackgroundQuery = vi.fn(async (task: unknown) => {
      expect(task).toMatchObject({
        version: 1,
        execution: 'background',
        resourceId: '@test/reports:AdapterReport#current',
        reportClassName: '@test/reports:AdapterReport',
        request: {
          version: 1,
          requestId: 'request-background',
          mode: 'rows',
          projection: ['customer_id', 'id'],
        },
        inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
      });
      expect(task).not.toHaveProperty('tenantId');
      expect(task).not.toHaveProperty('principalId');
      return { taskId: 'job-report-query-1' };
    });

    const result = await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-background',
        mode: 'rows',
        projection: ['customer_id'],
      },
      {
        execution: 'background',
        collection: { list, count: async () => 1 },
        enqueueBackgroundQuery,
      },
    );

    expect(list).not.toHaveBeenCalled();
    expect(enqueueBackgroundQuery).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      version: 1,
      execution: 'background',
      status: 'queued',
      taskId: 'job-report-query-1',
    });
    expect(result).not.toHaveProperty('rows');
  });

  it('rejects bigint values that cannot be represented safely in JSON', async () => {
    const collection = {
      async list() {
        return [
          {
            id: 'row-bigint',
            revenue: 9_007_199_254_740_993n,
          },
        ];
      },
      async count() {
        return 1;
      },
    };

    await expect(
      queryReportMaterializedRows(
        AdapterReport,
        {
          version: 1,
          requestId: 'request-bigint-precision',
          mode: 'rows',
          projection: ['revenue'],
        },
        { collection },
      ),
    ).rejects.toThrow(/safely representable/);
  });

  it('honors the bounded identity sort declared in its canonical schema', async () => {
    let listOptions: Record<string, unknown> | undefined;
    const collection = {
      async list(options: Record<string, unknown>) {
        listOptions = options;
        return [{ id: 'row-2' }];
      },
      async count() {
        return 1;
      },
    };

    await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-descending-id',
        mode: 'rows',
        sort: [{ field: 'id', direction: 'desc' }],
      },
      { collection },
    );

    expect(listOptions).toMatchObject({ orderBy: 'id DESC' });
  });

  it('calculates totals after the read lifecycle has refreshed materialized rows', async () => {
    const calls: string[] = [];
    let refreshed = false;
    const collection = {
      async list() {
        calls.push('list');
        refreshed = true;
        return [{ id: 'row-after-refresh' }];
      },
      async count() {
        calls.push('count');
        return refreshed ? 2 : 1;
      },
    };

    const result = await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-refresh-consistent-total',
        mode: 'rows',
        page: { kind: 'offset', offset: 0, limit: 1 },
      },
      { collection },
    );

    expect(calls).toEqual(['list', 'count']);
    expect(result.total).toEqual({ kind: 'exact', value: 2 });
    expect(result.page).toMatchObject({ hasMore: true });
  });

  it('runs the read lifecycle before a count-only materialized query', async () => {
    const calls: string[] = [];
    let refreshed = false;
    const collection = {
      async list() {
        calls.push('list');
        refreshed = true;
        return [];
      },
      async count() {
        calls.push('count');
        return refreshed ? 2 : 1;
      },
    };

    const result = await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-count-refresh-consistent-total',
        mode: 'count',
      },
      { collection },
    );

    expect(calls).toEqual(['list', 'count']);
    expect(result.rows).toEqual([]);
    expect(result.total).toEqual({ kind: 'exact', value: 2 });
  });

  it('maps declared dimension and measure filters into a bounded materialized predicate', async () => {
    let listOptions: Record<string, unknown> | undefined;
    let countOptions: Record<string, unknown> | undefined;
    const collection = {
      async list(options: Record<string, unknown>) {
        listOptions = options;
        return [{ id: 'row-2', customerId: 'customer-1', revenue: 25 }];
      },
      async count(options?: Record<string, unknown>) {
        countOptions = options;
        return 1;
      },
    };
    const filter = {
      kind: 'all' as const,
      filters: [
        {
          kind: 'condition' as const,
          field: 'customer_id',
          operator: 'eq' as const,
          value: 'customer-1',
        },
        {
          kind: 'condition' as const,
          field: 'revenue',
          operator: 'gte' as const,
          value: 10,
        },
      ],
    };
    const descriptor = await buildReportAdapterDescriptor(AdapterReport);
    expect(splitReportFilterScopes(descriptor, filter)).toEqual({
      where: filter.filters[0],
      having: filter.filters[1],
    });
    expect(
      splitReportFilterScopes(descriptor, {
        kind: 'all',
        filters: [
          filter.filters[0],
          { kind: 'all', filters: [filter.filters[0]] },
          filter.filters[1],
        ],
      }),
    ).toEqual({
      where: { kind: 'all', filters: [filter.filters[0], filter.filters[0]] },
      having: filter.filters[1],
    });

    const result = await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-filter-and-sort',
        mode: 'rows',
        projection: ['customer_id', 'revenue'],
        filter,
        sort: [{ field: 'revenue', direction: 'desc' }],
      },
      { collection },
    );

    expect(listOptions).toMatchObject({
      select: ['customerId', 'id', 'revenue'],
      orderBy: ['revenue DESC', 'id ASC'],
      where: [[{ customerId: 'customer-1' }, { 'revenue >=': 10 }]],
    });
    expect(countOptions).toEqual({
      where: [[{ customerId: 'customer-1' }, { 'revenue >=': 10 }]],
    });
    expect(result.rows).toEqual([
      { customer_id: 'customer-1', id: 'row-2', revenue: 25 },
    ]);
  });

  it('keeps OR and null-bucket report filters parameterized and branch-bounded', async () => {
    let listOptions: Record<string, unknown> | undefined;
    const collection = {
      async list(options: Record<string, unknown>) {
        listOptions = options;
        return [{ id: 'row-2', customerId: null }];
      },
      async count() {
        return 1;
      },
    };

    await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-null-or-filter',
        mode: 'rows',
        projection: ['customer_id'],
        filter: {
          kind: 'any',
          filters: [
            {
              kind: 'condition',
              field: 'customer_id',
              operator: 'eq',
              value: null,
            },
            {
              kind: 'condition',
              field: 'customer_id',
              operator: 'in',
              value: ['customer-1', 'customer-2'],
            },
          ],
        },
      },
      { collection },
    );

    expect(listOptions).toMatchObject({
      where: [
        [{ customerId: null }],
        [{ 'customerId in': ['customer-1', 'customer-2'] }],
      ],
    });
  });

  it('returns database-backed dimension facets under the same report filter', async () => {
    let facetOptions: Record<string, unknown> | undefined;
    const collection = {
      async list() {
        return [];
      },
      async count() {
        return 4;
      },
      async facets(options: Record<string, unknown>) {
        facetOptions = options;
        return [
          {
            field: 'customerId',
            values: [
              { value: 'customer-1', count: 3 },
              { value: null, count: 1 },
            ],
          },
        ];
      },
    };

    const result = await queryReportMaterializedRows(
      AdapterReport,
      {
        version: 1,
        requestId: 'request-dimension-facet',
        mode: 'facets',
        filter: {
          kind: 'condition',
          field: 'revenue',
          operator: 'gte',
          value: 10,
        },
        facets: [{ field: 'customer_id', limit: 2 }],
      },
      { collection },
    );

    expect(facetOptions).toEqual({
      fields: [{ field: 'customerId', limit: 2 }],
      where: [[{ 'revenue >=': 10 }]],
    });
    expect(result.rows).toEqual([]);
    expect(result.total).toEqual({ kind: 'exact', value: 4 });
    expect(result.facets).toEqual([
      {
        field: 'customer_id',
        values: [
          { value: 'customer-1', count: 3 },
          { value: null, count: 1 },
        ],
        truncated: true,
      },
    ]);
  });

  it('rejects a mixed WHERE/HAVING OR expression before it can be miscompiled', async () => {
    const descriptor = await buildReportAdapterDescriptor(AdapterReport);
    expect(() =>
      splitReportFilterScopes(descriptor, {
        kind: 'any',
        filters: [
          {
            kind: 'condition',
            field: 'customer_id',
            operator: 'eq',
            value: 'customer-1',
          },
          {
            kind: 'condition',
            field: 'revenue',
            operator: 'gte',
            value: 10,
          },
        ],
      }),
    ).toThrow(/WHERE and HAVING filters cannot be mixed/);
  });

  it('resolves the default collection through ObjectRegistry for tenant-bound reads', async () => {
    const collection = {
      async list() {
        return [{ id: 'row-1', customerId: 'customer-1' }];
      },
      async count() {
        return 1;
      },
    };
    const resolve = vi
      .spyOn(ObjectRegistry, 'getCollection')
      .mockResolvedValue(collection as never);
    try {
      await queryReportMaterializedRows(AdapterReport, {
        version: 1,
        requestId: 'request-default-collection',
        mode: 'count',
      });
      expect(resolve).toHaveBeenCalledWith(
        expect.stringMatching(/AdapterReport$/),
        { db: undefined },
      );
    } finally {
      resolve.mockRestore();
    }
  });

  it('reads only the active tenant through the default materialized collection', async () => {
    ObjectRegistry.clear();
    registerRuntimeTenantFixture();
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: ['AdapterReport'],
    });
    try {
      await db.insert('adapter_reports', {
        id: 'tenant-a-row',
        slug: 'tenant-a-row',
        tenant_id: 'tenant-a',
        customer_id: 'customer-a',
        revenue: 10,
      });
      await db.insert('adapter_reports', {
        id: 'tenant-b-row',
        slug: 'tenant-b-row',
        tenant_id: 'tenant-b',
        customer_id: 'customer-b',
        revenue: 90,
      });
      enableTenancy();

      const result = await withTenant({ tenantId: 'tenant-a' }, () =>
        queryReportMaterializedRows(
          AdapterReport,
          {
            version: 1,
            requestId: 'request-tenant-a',
            mode: 'rows',
          },
          { db },
        ),
      );

      expect(result.rows).toEqual([{ id: 'tenant-a-row' }]);
      expect(result.total).toEqual({ kind: 'exact', value: 1 });
    } finally {
      disableTenancy();
      if (typeof db.close === 'function') await db.close();
    }
  });

  it('applies the active tenant to every OR branch of a report query', async () => {
    ObjectRegistry.clear();
    registerRuntimeTenantFixture();
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: ['AdapterReport'],
    });
    try {
      await db.insert('adapter_reports', {
        id: 'tenant-a-customer-a',
        slug: 'tenant-a-customer-a',
        tenant_id: 'tenant-a',
        customer_id: 'customer-a',
        revenue: 10,
      });
      await db.insert('adapter_reports', {
        id: 'tenant-b-customer-b',
        slug: 'tenant-b-customer-b',
        tenant_id: 'tenant-b',
        customer_id: 'customer-b',
        revenue: 90,
      });
      enableTenancy();

      const result = await withTenant({ tenantId: 'tenant-a' }, () =>
        queryReportMaterializedRows(
          AdapterReport,
          {
            version: 1,
            requestId: 'request-tenant-or-filter',
            mode: 'rows',
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
                  field: 'customer_id',
                  operator: 'eq',
                  value: 'customer-b',
                },
              ],
            },
          },
          { db },
        ),
      );

      expect(result.rows).toEqual([{ id: 'tenant-a-customer-a' }]);
      expect(result.total).toEqual({ kind: 'exact', value: 1 });
    } finally {
      disableTenancy();
      if (typeof db.close === 'function') await db.close();
    }
  });
});
