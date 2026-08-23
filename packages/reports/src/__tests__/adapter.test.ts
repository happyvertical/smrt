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
  queryReportMaterializedRows,
  reportMaterializedRowKey,
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
  ObjectRegistry.registerFieldDecorator('AdapterInvoice', 'tenantId', {
    type: 'text',
    _meta: { __tenancy: { isTenantIdField: true } },
  });
  ObjectRegistry.register(AdapterInvoice, { tableName: 'adapter_invoices' });

  ObjectRegistry.registerFieldDecorator('AdapterReport', 'tenantId', {
    type: 'text',
    _meta: { __tenancy: { isTenantIdField: true } },
  });
  ObjectRegistry.registerFieldDecorator('AdapterReport', 'customerId', {
    type: 'text',
    __report: { kind: 'group', sourceColumn: 'customerId' },
  });
  ObjectRegistry.registerFieldDecorator('AdapterReport', 'revenue', {
    type: 'decimal',
    __report: { kind: 'aggregate', fn: 'sum', column: 'totalAmount' },
  });
  ObjectRegistry.register(AdapterReport, {
    tableName: 'adapter_reports',
    tenantScoped: { field: 'tenantId', mode: 'optional' },
    report: { source: 'AdapterInvoice' },
  });
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
      enableFiltering: false,
      enableSearch: false,
    });
    expect(
      first.dataTable.columns.every(
        (column) => column.searchable === false && column.filterable === false,
      ),
    ).toBe(true);
    expect(
      first.schema.fields.every((field) => field.filterOperators === undefined),
    ).toBe(true);
    expect(
      first.schema.fields.filter((field) => field.id === 'id')[0]?.sortable,
    ).toBe(true);
    expect(
      first.schema.fields
        .filter((field) => field.id !== 'id')
        .every(
          (field) => field.sortable === false && field.facetable === false,
        ),
    ).toBe(true);
    expect(first.schema.supports?.facets).toBe(false);
    expect(
      first.columns
        .filter((column) => column.kind !== 'identity')
        .every(
          (column) =>
            column.sortable === false &&
            column.facetable === false &&
            column.capabilities.join(',') === 'project,read',
        ),
    ).toBe(true);
    expect(
      first.columns.find((column) => column.id === 'id')?.capabilities,
    ).toEqual(['project', 'read', 'sort']);
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

  it('rejects caller filters until report-specific semantics exist', async () => {
    const collection = {
      async list() {
        return [];
      },
      async count() {
        return 0;
      },
    };
    await expect(
      queryReportMaterializedRows(
        AdapterReport,
        {
          version: 1,
          requestId: 'request-2',
          mode: 'rows',
          filter: {
            kind: 'condition',
            field: 'customer_id',
            operator: 'eq',
            value: 'customer-1',
          },
        },
        { collection },
      ),
    ).rejects.toThrow(/not allowed|do not support filter or sort/);
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
});
