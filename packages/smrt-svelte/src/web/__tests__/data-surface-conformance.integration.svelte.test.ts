/**
 * Application-level data-surface conformance gate (#2450).
 *
 * This fixture deliberately composes the shipped registry, browser/server
 * bridge, principal tools, action adapter, ContentList descriptor, and report
 * adapter. The database and generated REST handler are real; only the bridge
 * transport is an in-process test double.
 */

import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceDeadlineError,
  type DataSurfaceDefinition,
  type DataSurfaceExecutorResult,
  DataSurfaceQueryError,
  DataSurfaceRequestError,
  executeAsPrincipal,
} from '@happyvertical/smrt-agents';
import {
  createDataSurfaceActionAdapter,
  type DataSurfaceServerActionRequest,
  InMemoryDataSurfaceActionStateStore,
} from '@happyvertical/smrt-agents/server';
import {
  createDataSurfaceCommandBridge,
  type DataSurfaceBridgeMessage,
  type DataSurfaceBridgePeer,
} from '@happyvertical/smrt-chat/data-surface-bridge';
import {
  buildContentListSurfaceDescriptor,
  CONTENT_LIST_SCHEMA_VERSION,
  ContentList,
} from '@happyvertical/smrt-content/svelte';
import {
  APIGenerator,
  field,
  getTestDatabase,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  buildReportAdapterDescriptor,
  groupBy,
  queryReportMaterializedRows,
  report,
} from '@happyvertical/smrt-reports';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createDataSurfaceRegistry,
  createDataTableController,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
  DataTable,
} from '@happyvertical/smrt-ui/data';
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

@smrt({
  api: { include: ['list', 'get', 'update'] },
  tenantScoped: { mode: 'required' },
})
class SurfaceConformanceRecord extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';

  @field({ type: 'text' })
  name = '';

  @field({ type: 'text' })
  status = 'active';

  @field({ type: 'text', sensitive: true })
  secret = '';

  constructor(options: { tenantId?: string; name?: string } = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
  }
}

class SurfaceConformanceRecordCollection extends SmrtCollection<SurfaceConformanceRecord> {
  static readonly _itemClass = SurfaceConformanceRecord;
}

@smrt({ tenantScoped: { mode: 'required' } })
@report({ source: SurfaceConformanceRecord })
class SurfaceConformanceReport extends SmrtObject {
  @field({ type: 'text' })
  @groupBy('name')
  name = '';
}

const identity: DataSurfaceIdentity = {
  surfaceId: 'surface-conformance-records',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

const descriptor: DataSurfaceDescriptor = {
  version: 1,
  identity,
  schemaVersion: 1,
  label: 'Records',
  rowKey: 'id',
  columns: [
    {
      id: 'id',
      label: 'ID',
      capabilities: ['read', 'project'],
      role: 'row-key',
    },
    {
      id: 'name',
      label: 'Name',
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    },
    {
      id: 'status',
      label: 'Status',
      capabilities: ['read', 'filter', 'sort', 'project'],
    },
    { id: 'secret', label: 'Secret', sensitivity: 'secret', capabilities: [] },
  ],
  query: {
    modes: ['rows', 'count'],
    projectableColumnIds: ['id', 'name', 'status'],
    searchableColumnIds: ['name'],
    filterableColumnIds: ['name', 'status'],
    sortableColumnIds: ['name', 'status'],
  },
  controls: [
    { id: 'set-search', label: 'Search' },
    { id: 'toggle-sorting', label: 'Sort' },
    { id: 'set-page', label: 'Page' },
  ],
  actions: [
    {
      id: 'archive',
      label: 'Archive',
      sensitivity: 'sensitive',
      selectionScopes: ['explicit-ids'],
      requiresConfirmation: true,
    },
  ],
  limits: { maxQueryRows: 2, maxQueryBytes: 20_000, maxSelectionSize: 10 },
};

// A mounted table can only expose columns that its current principal may
// render. The server descriptor retains the secret field for redaction tests;
// the mounted descriptor proves the UI contract cannot accidentally render it.
const mountedDescriptor: DataSurfaceDescriptor = {
  ...descriptor,
  columns: descriptor.columns
    .filter((column) => column.id !== 'secret')
    .map(({ role: _role, ...column }) => column),
  query: {
    modes: descriptor.query.modes,
    projectableColumnIds: descriptor.query.projectableColumnIds,
  },
  controls: [
    ...descriptor.controls,
    { id: 'set-filters', label: 'Filter' },
    { id: 'set-column-order', label: 'Columns' },
    { id: 'set-column-visibility', label: 'Column visibility' },
    { id: 'set-selected-rows', label: 'Selection' },
  ],
};

function bridgeTransport() {
  const messages: DataSurfaceBridgeMessage[] = [];
  const listeners = new Set<
    (message: unknown, peer: DataSurfaceBridgePeer) => void
  >();
  const statuses = new Set<
    (state: 'connected' | 'disconnected' | 'reconnecting') => void
  >();
  return {
    messages,
    send: vi.fn((message: DataSurfaceBridgeMessage): void => {
      messages.push(message);
    }),
    subscribe(
      listener: (message: unknown, peer: DataSurfaceBridgePeer) => void,
    ) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStatus(
      listener: (state: 'connected' | 'disconnected' | 'reconnecting') => void,
    ) {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
    receive(message: unknown, peer: DataSurfaceBridgePeer) {
      for (const listener of listeners) listener(message, peer);
    },
    status(state: 'connected' | 'disconnected' | 'reconnecting') {
      for (const listener of statuses) listener(state);
    },
  };
}

function requiredTool(
  tools: ReturnType<typeof createDataSurfaceTools>,
  slug: string,
) {
  const tool = tools.find((candidate) => candidate.slug === slug);
  if (!tool) throw new Error(`Missing fixture tool: ${slug}`);
  return tool;
}

describe('data-surface human/agent parity and security (#2450)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let records: SurfaceConformanceRecordCollection;
  let firstId = '';
  let secondId = '';
  let hiddenId = '';
  let releasePermissions: (() => void) | undefined;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SurfaceConformanceRecord'],
    });
    enableTenancy();
    releasePermissions = registerPermissionDefinitions([
      { slug: 'records.read' },
      { slug: 'records.update' },
    ]);
    records = await SurfaceConformanceRecordCollection.create({ db });
    const first = await withTenant({ tenantId: 'tenant-a' }, () =>
      records.create({ tenantId: 'tenant-a', name: 'Ada' }),
    );
    const second = await withTenant({ tenantId: 'tenant-a' }, () =>
      records.create({ tenantId: 'tenant-a', name: 'Grace' }),
    );
    const hidden = await withTenant({ tenantId: 'tenant-b' }, () =>
      records.create({ tenantId: 'tenant-b', name: 'Hidden tenant' }),
    );
    firstId = String(first.id);
    secondId = String(second.id);
    hiddenId = String(hidden.id);
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      first.secret = 'sensitive-sentinel-tenant-a';
      second.secret = 'sensitive-sentinel-tenant-a-2';
      await first.save();
      await second.save();
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      hidden.secret = 'sensitive-sentinel-tenant-b';
      await hidden.save();
    });
  });

  afterAll(async () => {
    disableTenancy();
    releasePermissions?.();
    await db?.close?.();
  });

  function surface(
    options: { truncated?: boolean } = {},
  ): DataSurfaceDefinition {
    return {
      id: 'records',
      collection: 'records',
      schema: {
        version: 1,
        identityField: 'id',
        fields: [
          { id: 'id', type: 'string', projectable: true, sortable: true },
          {
            id: 'name',
            type: 'string',
            projectable: true,
            sortable: true,
            filterOperators: ['eq'],
          },
          {
            id: 'status',
            type: 'string',
            projectable: true,
            sortable: true,
            filterOperators: ['eq'],
          },
          {
            id: 'tenantId',
            type: 'string',
            projectable: true,
            sensitive: true,
          },
          { id: 'secret', type: 'string', projectable: true, sensitive: true },
        ],
        defaultPageLimit: 2,
        maxPageLimit: 2,
        maxResultBytes: 20_000,
        supports: { cursorPagination: true },
      },
      execute: async (_surface, request, context) => {
        const all = await records.list();
        const scoped = all
          .filter((row) => row.tenantId === context.principal.tenantId)
          .sort((left, right) => left.name.localeCompare(right.name));
        const cursorPage =
          request.page?.kind === 'cursor' ? request.page : undefined;
        const offset =
          request.page?.kind === 'offset'
            ? request.page.offset
            : cursorPage?.after
              ? scoped.findIndex((row) => row.id === cursorPage.after) + 1
              : 0;
        const limit = request.page ? request.page.limit : scoped.length;
        const rows = scoped.slice(offset, offset + limit).map((row) => {
          const projection = new Set(request.projection ?? []);
          return {
            id: row.id,
            ...(projection.has('name') ? { name: row.name } : {}),
            ...(projection.has('status') ? { status: row.status } : {}),
          };
        });
        return {
          rows,
          page: cursorPage
            ? {
                kind: 'cursor' as const,
                limit,
                hasMore: offset + rows.length < scoped.length,
                ...(offset + rows.length < scoped.length && rows.length > 0
                  ? { nextCursor: String(rows.at(-1)?.id) }
                  : {}),
              }
            : {
                kind: 'offset' as const,
                offset,
                limit,
                hasMore: offset + rows.length < scoped.length,
              },
          total: { kind: 'exact' as const, value: scoped.length },
          freshness: {
            state: 'fresh' as const,
            asOf: '2026-08-30T00:00:00.000Z',
          },
          warnings: [],
          truncated: options.truncated ?? false,
        };
      },
    };
  }

  function principalOptions(tenantId: string, allowedTools: string[]) {
    return {
      db,
      principal: {
        runAsUserId: 'surface-user',
        tenantId,
        allowedTools,
      },
      permissions: ['records.read', 'records.update'],
      postgresRls: false,
      audit: () => undefined,
    };
  }

  it('uses the real DB-backed principal query and REST auth boundary', async () => {
    const tools = createDataSurfaceTools({ surfaces: [surface()] });
    const discovered = await executeAsPrincipal(
      principalOptions('tenant-a', [
        DATA_DISCOVER_TOOL_SLUG,
        DATA_QUERY_TOOL_SLUG,
      ]),
      (run) =>
        requiredTool(tools, DATA_DISCOVER_TOOL_SLUG).execute({
          run,
          args: {},
          db,
        }),
    );
    expect(discovered).toMatchObject([
      { id: 'records', fields: expect.any(Array) },
    ]);
    const fields = (discovered as Array<{ fields: Array<{ id: string }> }>)[0]
      .fields;
    expect(fields.map((field) => field.id)).toEqual(['id', 'name', 'status']);

    const queried = await executeAsPrincipal(
      principalOptions('tenant-a', [DATA_QUERY_TOOL_SLUG]),
      (run) =>
        requiredTool(tools, DATA_QUERY_TOOL_SLUG).execute({
          run,
          args: {
            surfaceId: 'records',
            request: {
              version: 1,
              requestId: 'principal-page-1',
              mode: 'rows',
              projection: ['id', 'name', 'status'],
              page: { kind: 'offset', offset: 0, limit: 1 },
            },
          },
          db,
        }),
    );
    expect(queried).toMatchObject({
      rows: [{ id: firstId, name: 'Ada' }],
      total: { kind: 'exact', value: 2 },
      freshness: { state: 'fresh' },
    });
    expect(JSON.stringify(queried)).not.toContain('tenant-b');

    let cursorFailure: unknown;
    const cursorTools = createDataSurfaceTools({
      surfaces: [surface()],
      onFailure: (entry) => {
        cursorFailure = entry.error;
      },
    });
    const cursorQueried = await executeAsPrincipal(
      principalOptions('tenant-a', [DATA_QUERY_TOOL_SLUG]),
      (run) =>
        requiredTool(cursorTools, DATA_QUERY_TOOL_SLUG).execute({
          run,
          args: {
            surfaceId: 'records',
            request: {
              version: 1,
              requestId: 'principal-cursor-1',
              mode: 'rows',
              projection: ['id', 'name'],
              page: { kind: 'cursor', limit: 1 },
            },
          },
          db,
        }),
    );
    expect(cursorFailure).toBeUndefined();
    expect(cursorQueried).toMatchObject({
      rows: [{ id: firstId }],
      page: { kind: 'cursor', limit: 1, hasMore: true, nextCursor: firstId },
    });

    const bounded = createDataSurfaceTools({
      surfaces: [surface({ truncated: true })],
    });
    const boundedResult = await executeAsPrincipal(
      principalOptions('tenant-a', [DATA_QUERY_TOOL_SLUG]),
      (run) =>
        requiredTool(bounded, DATA_QUERY_TOOL_SLUG).execute({
          run,
          args: {
            surfaceId: 'records',
            request: {
              version: 1,
              requestId: 'principal-truncated',
              mode: 'rows',
              projection: ['id', 'name'],
              page: { kind: 'offset', offset: 0, limit: 1 },
            },
          },
          db,
        }),
    );
    expect(boundedResult).toMatchObject({ truncated: true, warnings: [] });

    // Sensitive fields are adversarially requested at the principal boundary;
    // visibleSchema rejects them before the executor can read or serialize a
    // sentinel value.
    await expect(
      executeAsPrincipal(
        principalOptions('tenant-a', [DATA_QUERY_TOOL_SLUG]),
        (run) =>
          requiredTool(tools, DATA_QUERY_TOOL_SLUG).execute({
            run,
            args: {
              surfaceId: 'records',
              request: {
                version: 1,
                requestId: 'principal-sensitive-probe',
                mode: 'rows',
                projection: ['id', 'secret'],
                page: { kind: 'offset', offset: 0, limit: 1 },
              },
            },
            db,
          }),
      ),
    ).rejects.toBeInstanceOf(DataSurfaceRequestError);

    // Exercise the result-byte gate with a deliberately oversized executor
    // payload. A safe projection alone would not prove this bound is active.
    const oversized = surface();
    oversized.schema = { ...oversized.schema, maxResultBytes: 120 };
    oversized.execute = async () => ({
      rows: [{ id: firstId, name: 'x'.repeat(500) }],
      total: { kind: 'exact' as const, value: 1 },
      page: { kind: 'offset' as const, offset: 0, limit: 1, hasMore: false },
      freshness: { state: 'fresh' as const },
      warnings: [],
      truncated: false,
    });
    await expect(
      executeAsPrincipal(
        principalOptions('tenant-a', [DATA_QUERY_TOOL_SLUG]),
        (run) => {
          const oversizedTools = createDataSurfaceTools({
            surfaces: [oversized],
          });
          return requiredTool(oversizedTools, DATA_QUERY_TOOL_SLUG).execute({
            run,
            args: {
              surfaceId: 'records',
              request: {
                version: 1,
                requestId: 'principal-byte-bound',
                mode: 'rows',
                projection: ['id', 'name'],
                page: { kind: 'offset', offset: 0, limit: 1 },
              },
            },
            db,
          });
        },
      ),
    ).rejects.toBeInstanceOf(DataSurfaceQueryError);

    // The executor must not be able to return more rows than the requested
    // bounded page, even when the caller asks for a valid limit.
    const overRows = surface();
    overRows.execute = async () => [
      { id: firstId, name: 'Ada' },
      { id: secondId, name: 'Grace' },
      { id: hiddenId, name: 'Hidden tenant' },
    ];
    await expect(
      executeAsPrincipal(
        principalOptions('tenant-a', [DATA_QUERY_TOOL_SLUG]),
        (run) => {
          const overRowsTools = createDataSurfaceTools({
            surfaces: [overRows],
          });
          return requiredTool(overRowsTools, DATA_QUERY_TOOL_SLUG).execute({
            run,
            args: {
              surfaceId: 'records',
              request: {
                version: 1,
                requestId: 'principal-row-bound',
                mode: 'rows',
                projection: ['id', 'name'],
                page: { kind: 'offset', offset: 0, limit: 2 },
              },
            },
            db,
          });
        },
      ),
    ).rejects.toBeInstanceOf(DataSurfaceQueryError);

    let aborted = false;
    const slow = surface({});
    slow.execute = async (_surface, _request, context) => {
      context.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      return new Promise<DataSurfaceExecutorResult>(() => undefined);
    };
    const slowTools = createDataSurfaceTools({
      surfaces: [slow],
      deadlineMs: 1,
    });
    await expect(
      executeAsPrincipal(
        principalOptions('tenant-a', [DATA_QUERY_TOOL_SLUG]),
        (run) =>
          requiredTool(slowTools, DATA_QUERY_TOOL_SLUG).execute({
            run,
            args: {
              surfaceId: 'records',
              request: {
                version: 1,
                requestId: 'principal-timeout',
                mode: 'rows',
                projection: ['id', 'name'],
                page: { kind: 'offset', offset: 0, limit: 1 },
              },
            },
            db,
          }),
      ),
    ).rejects.toBeInstanceOf(DataSurfaceDeadlineError);
    expect(aborted).toBe(true);

    // Model the production request boundary: authentication resolves a
    // trusted session first, then the server binds both the principal and its
    // tenant before entering the generated REST handler. The handler itself
    // still runs its configured auth middleware, so a request cannot swap
    // credentials after the session context has been selected.
    const fixtureSessions = new Map([
      ['Bearer fixture-user', { userId: 'surface-user', tenantId: 'tenant-a' }],
      [
        'Bearer fixture-user-b',
        { userId: 'surface-user-b', tenantId: 'tenant-b' },
      ],
    ]);
    const handleRestRequest = async (request: Request) => {
      const token = request.headers.get('authorization');
      if (!token) return new Response('auth required', { status: 401 });
      const session = fixtureSessions.get(token);
      if (!session) return new Response('forbidden', { status: 403 });

      const api = new APIGenerator(
        {
          basePath: '/api/v1',
          authMiddleware: () => async (authenticatedRequest) => {
            if (authenticatedRequest.headers.get('authorization') !== token) {
              return new Response('forbidden', { status: 403 });
            }
            return authenticatedRequest;
          },
        },
        {
          db,
          user: { id: session.userId },
          permissions: ['records.read', 'records.update'],
        },
      );
      api.registerCollection('surfaceconformancerecords', records);
      return withTenant({ tenantId: session.tenantId }, () =>
        api.generateHandler()(request),
      );
    };
    expect(
      (
        await handleRestRequest(
          new Request('http://fixture.local/api/v1/surfaceconformancerecords'),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleRestRequest(
          new Request('http://fixture.local/api/v1/surfaceconformancerecords', {
            headers: { authorization: 'Bearer other' },
          }),
        )
      ).status,
    ).toBe(403);
    const restResponse = await handleRestRequest(
      new Request('http://fixture.local/api/v1/surfaceconformancerecords', {
        headers: { authorization: 'Bearer fixture-user' },
      }),
    );
    expect(restResponse.status).toBe(200);
    const restBody = await restResponse.json();
    expect(JSON.stringify(restBody)).toContain(firstId);
    expect(JSON.stringify(restBody)).not.toContain(hiddenId);
    expect(JSON.stringify(restBody)).not.toContain('Hidden tenant');
    expect(JSON.stringify(restBody)).not.toContain('sensitive-sentinel');

    const otherTenantResponse = await handleRestRequest(
      new Request('http://fixture.local/api/v1/surfaceconformancerecords', {
        headers: { authorization: 'Bearer fixture-user-b' },
      }),
    );
    expect(otherTenantResponse.status).toBe(200);
    const otherTenantBody = await otherTenantResponse.json();
    expect(JSON.stringify(otherTenantBody)).toContain(hiddenId);
    expect(JSON.stringify(otherTenantBody)).not.toContain(firstId);
    expect(JSON.stringify(otherTenantBody)).not.toContain('Ada');
    expect(JSON.stringify(otherTenantBody)).not.toContain('sensitive-sentinel');
  });

  it('keeps human and browser command snapshots identical and rejects bridge abuse', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController({
      columnIds: ['id', 'name', 'status'],
    });
    const browserIdentity: DataSurfaceIdentity = {
      ...identity,
      surfaceId: 'surface-conformance-browser',
    };
    const browserController = createDataTableController({
      columnIds: ['id', 'name', 'status'],
    });
    const { container } = render(DataTable, {
      props: {
        data: [
          { id: firstId, name: 'Ada', status: 'active' },
          { id: secondId, name: 'Grace', status: 'active' },
        ],
        columns: [
          { id: 'id', label: 'ID', accessor: 'id' },
          {
            id: 'name',
            label: 'Name',
            accessor: 'name',
            sortable: true,
            filterable: true,
          },
          {
            id: 'status',
            label: 'Status',
            accessor: 'status',
            sortable: true,
            filterable: true,
          },
        ],
        rowKey: 'id',
        sortable: true,
        selectable: true,
        controller,
        caption: 'Records',
        dataSurface: { registry, descriptor: mountedDescriptor },
      },
    });
    render(DataTable, {
      props: {
        data: [
          { id: firstId, name: 'Ada', status: 'active' },
          { id: secondId, name: 'Grace', status: 'active' },
        ],
        columns: [
          { id: 'id', label: 'ID', accessor: 'id' },
          {
            id: 'name',
            label: 'Name',
            accessor: 'name',
            sortable: true,
            filterable: true,
          },
          {
            id: 'status',
            label: 'Status',
            accessor: 'status',
            sortable: true,
            filterable: true,
          },
        ],
        rowKey: 'id',
        sortable: true,
        selectable: true,
        controller: browserController,
        caption: 'Records browser mirror',
        dataSurface: {
          registry,
          descriptor: { ...mountedDescriptor, identity: browserIdentity },
        },
      },
    });
    await tick();
    await vi.waitFor(() => {
      expect(registry.inspect(identity)).toBeDefined();
      expect(registry.inspect(browserIdentity)).toBeDefined();
    });
    const sortButton = container.querySelector(
      'button[aria-label="Sort Name ascending"]',
    );
    if (!(sortButton instanceof HTMLElement)) {
      throw new Error('Mounted human table did not render its sort button');
    }
    await userEvent.click(sortButton);
    const sortedHuman = registry.inspect(identity);
    expect(sortedHuman?.state).toMatchObject({
      table: { state: { sorting: [{ columnId: 'name', direction: 'asc' }] } },
    });
    await expectNoA11yViolations(container);
    const browserSort = await registry.execute({
      version: 1,
      commandId: 'browser-sort',
      identity: browserIdentity,
      expectedRevision: registry.inspect(browserIdentity)?.revision ?? 0,
      controlId: 'toggle-sorting',
      payload: { columnId: 'name' },
    });
    expect(browserSort).toMatchObject({ ok: true });
    expect(controller.snapshot()).toEqual(browserController.snapshot());

    // Apply each remaining command once through the mounted human controller
    // and once through the mounted browser registry. Separate controllers make
    // this a real parity check rather than a second no-op against one state.
    controller.dispatch({
      type: 'setFilters',
      filters: [{ columnId: 'name', operator: 'equals', value: 'Ada' }],
    });
    const browserFilter = await registry.execute({
      version: 1,
      commandId: 'browser-filter',
      identity: browserIdentity,
      expectedRevision: registry.inspect(browserIdentity)?.revision ?? 0,
      controlId: 'set-filters',
      payload: {
        filters: [{ columnId: 'name', operator: 'equals', value: 'Ada' }],
      },
    });
    expect(browserFilter).toMatchObject({ ok: true });
    expect(controller.snapshot()).toEqual(browserController.snapshot());

    controller.dispatch({
      type: 'setColumnOrder',
      columnIds: ['status', 'name', 'id'],
    });
    const browserColumns = await registry.execute({
      version: 1,
      commandId: 'browser-columns',
      identity: browserIdentity,
      expectedRevision: registry.inspect(browserIdentity)?.revision ?? 0,
      controlId: 'set-column-order',
      payload: { columnIds: ['status', 'name', 'id'] },
    });
    expect(browserColumns).toMatchObject({ ok: true });
    expect(controller.snapshot()).toEqual(browserController.snapshot());

    controller.dispatch({ type: 'setPage', page: 2 });
    const browserPage = await registry.execute({
      version: 1,
      commandId: 'browser-page',
      identity: browserIdentity,
      expectedRevision: registry.inspect(browserIdentity)?.revision ?? 0,
      controlId: 'set-page',
      payload: { page: 2 },
    });
    expect(browserPage).toMatchObject({ ok: true });
    expect(controller.snapshot()).toEqual(browserController.snapshot());

    const visibleColumns = [
      { columnId: 'id', visible: false },
      { columnId: 'name', visible: true },
      { columnId: 'status', visible: true },
    ];
    controller.dispatch({
      type: 'setColumnVisibility',
      columns: visibleColumns,
    });
    const browserVisibility = await registry.execute({
      version: 1,
      commandId: 'browser-visibility',
      identity: browserIdentity,
      expectedRevision: registry.inspect(browserIdentity)?.revision ?? 0,
      controlId: 'set-column-visibility',
      payload: { columns: visibleColumns },
    });
    expect(browserVisibility).toMatchObject({ ok: true });
    expect(controller.snapshot()).toEqual(browserController.snapshot());

    controller.dispatch({
      type: 'toggleRowSelection',
      rowId: firstId,
    });
    const browserSelection = await registry.execute({
      version: 1,
      commandId: 'browser-selection',
      identity: browserIdentity,
      expectedRevision: registry.inspect(browserIdentity)?.revision ?? 0,
      controlId: 'set-selected-rows',
      payload: { rowIds: [firstId] },
    });
    expect(browserSelection).toMatchObject({ ok: true });
    expect(controller.snapshot()).toEqual(browserController.snapshot());
    expect(browserSelection.snapshot?.selection).toEqual({
      scope: 'explicit-ids',
      rowIds: [firstId],
    });

    const human = registry.inspect(identity);
    await expect(
      registry.execute({
        version: 1,
        commandId: 'stale-command',
        identity,
        expectedRevision: (human?.revision ?? 0) - 1,
        controlId: 'toggle-sorting',
        payload: { columnId: 'status' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_revision' });
    const replayCommand = {
      version: 1 as const,
      commandId: 'replay-command',
      identity,
      expectedRevision: human?.revision ?? 0,
      controlId: 'toggle-sorting',
      payload: { columnId: 'status' },
    };
    const replayed = await registry.execute(replayCommand);
    expect(replayed).toMatchObject({
      ok: true,
      revision: (human?.revision ?? 0) + 1,
    });
    await expect(registry.execute(replayCommand)).resolves.toEqual(replayed);
    await expect(
      registry.execute({
        ...replayCommand,
        payload: { columnId: 'name' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'idempotency_conflict' });
    await expect(
      registry.execute({
        ...replayCommand,
        commandId: 'absent-command',
        identity: { ...identity, surfaceId: 'surface-that-is-not-mounted' },
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' });

    const ackLink = bridgeTransport();
    ackLink.send.mockImplementation((message): void => {
      ackLink.messages.push(message);
      if (message.type !== 'data-surface.command') return;
      void registry
        .execute({
          version: 1,
          commandId: message.commandId,
          identity: message.identity,
          expectedRevision: message.expectedRevision,
          controlId: message.controlId,
          ...(message.payload === undefined
            ? {}
            : { payload: message.payload }),
        })
        .then((result) => {
          ackLink.receive(
            {
              type: 'data-surface.ack',
              version: 1,
              commandId: message.commandId,
              sessionId: message.sessionId,
              source: 'browser-1',
              expiresAt: message.expiresAt,
              identity: message.identity,
              expectedRevision: message.expectedRevision,
              ok: result.ok,
              ...(result.revision === undefined
                ? {}
                : { revision: result.revision }),
              ...(result.snapshot === undefined
                ? {}
                : { snapshot: result.snapshot }),
              ...(result.reason === undefined ? {} : { reason: result.reason }),
            },
            { sessionId: 'session-1', source: 'browser-1' },
          );
        });
    });
    const ackBridge = createDataSurfaceCommandBridge({
      transport: ackLink,
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: () => true,
      now: () => 1_000,
      ttlMs: 1_000,
      timeoutMs: 1_000,
    });
    const browserAck = await ackBridge.send({
      version: 1,
      commandId: 'browser-state-ack',
      identity,
      expectedRevision: replayed.revision ?? 0,
      controlId: 'set-page',
      payload: { page: 2 },
    });
    expect(browserAck).toMatchObject({
      ok: true,
      revision: expect.any(Number),
    });
    expect(browserAck.snapshot).toEqual(registry.inspect(identity));
    ackBridge.dispose();

    // ACKs are accepted only from the bound transport peer and only when
    // every correlation field still describes the pending command. Exercise
    // those checks through the transport, rather than calling bridge internals.
    const adversarialLink = bridgeTransport();
    let bridgeNow = 1_000;
    const adversarial = createDataSurfaceCommandBridge({
      transport: adversarialLink,
      sessionId: 'session-ack',
      source: 'server-ack',
      peerSource: 'browser-ack',
      authorize: () => true,
      now: () => bridgeNow,
      ttlMs: 1_000,
      timeoutMs: 1_000,
    });
    const adversarialPromise = adversarial.send({
      version: 1,
      commandId: 'adversarial-ack',
      identity,
      expectedRevision: replayed.revision ?? 0,
      controlId: 'set-page',
      payload: { page: 3 },
    });
    await vi.waitFor(() => expect(adversarialLink.messages).toHaveLength(1));
    const adversarialRequest = adversarialLink.messages[0];
    if (adversarialRequest?.type !== 'data-surface.command') {
      throw new Error('Expected a pending command request');
    }
    const adversarialAck = {
      type: 'data-surface.ack' as const,
      version: 1 as const,
      commandId: adversarialRequest.commandId,
      sessionId: adversarialRequest.sessionId,
      source: 'browser-ack',
      expiresAt: adversarialRequest.expiresAt,
      identity: adversarialRequest.identity,
      expectedRevision: adversarialRequest.expectedRevision,
      ok: false as const,
      reason: 'denied' as const,
    };
    // A wrong session or source is rejected at the transport boundary.
    adversarialLink.receive(adversarialAck, {
      sessionId: 'other-session',
      source: 'browser-ack',
    });
    adversarialLink.receive(adversarialAck, {
      sessionId: 'session-ack',
      source: 'other-browser',
    });
    // Correlated peers cannot smuggle a different source, identity, or
    // expected revision into the pending request.
    adversarialLink.receive(
      { ...adversarialAck, source: 'other-browser' },
      { sessionId: 'session-ack', source: 'browser-ack' },
    );
    adversarialLink.receive(
      {
        ...adversarialAck,
        identity: { ...identity, surfaceId: 'other-surface' },
      },
      { sessionId: 'session-ack', source: 'browser-ack' },
    );
    adversarialLink.receive(
      {
        ...adversarialAck,
        identity: {
          ...identity,
          subject: { type: 'tenant', id: 'tenant-b' },
        },
      },
      { sessionId: 'session-ack', source: 'browser-ack' },
    );
    adversarialLink.receive(
      {
        ...adversarialAck,
        expectedRevision: adversarialAck.expectedRevision + 1,
      },
      { sessionId: 'session-ack', source: 'browser-ack' },
    );
    // Even a fully correlated ACK is refused after its signed envelope TTL.
    bridgeNow = adversarialRequest.expiresAt + 1;
    adversarialLink.receive(adversarialAck, {
      sessionId: 'session-ack',
      source: 'browser-ack',
    });
    await expect(adversarialPromise).resolves.toMatchObject({
      ok: false,
      reason: 'expired',
    });
    // Replay and an ACK for an absent pending command are harmless no-ops.
    adversarialLink.receive(adversarialAck, {
      sessionId: 'session-ack',
      source: 'browser-ack',
    });
    adversarialLink.receive(
      { ...adversarialAck, commandId: 'never-pending' },
      { sessionId: 'session-ack', source: 'browser-ack' },
    );
    adversarial.dispose();

    const link = bridgeTransport();
    const authenticatedPrincipal = Object.freeze({
      sessionId: 'session-1',
      userId: 'surface-user',
      tenantId: 'tenant-a',
    });
    const browser = createDataSurfaceCommandBridge({
      transport: link,
      sessionId: authenticatedPrincipal.sessionId,
      source: 'server-1',
      peerSource: 'browser-1',
      // Authorization comes from the trusted authenticated session. The
      // command subject is only the requested target and cannot establish
      // authority by itself.
      authorize: async (command) =>
        authenticatedPrincipal.userId === 'surface-user' &&
        command.identity.subject?.type === 'tenant' &&
        command.identity.subject.id === authenticatedPrincipal.tenantId,
      now: () => 1_000,
      ttlMs: 1_000,
      timeoutMs: 100,
    });
    const commandPromise = browser.send({
      version: 1,
      commandId: 'sort-1',
      identity,
      expectedRevision: human?.revision ?? 0,
      controlId: 'toggle-sorting',
      payload: { columnId: 'status' },
    });
    await vi.waitFor(() => expect(link.messages).toHaveLength(1));
    const request = link.messages.at(-1);
    expect(request?.type).toBe('data-surface.command');
    const replayPromise = browser.send({
      version: 1,
      commandId: 'sort-1',
      identity,
      expectedRevision: human?.revision ?? 0,
      controlId: 'toggle-sorting',
      payload: { columnId: 'status' },
    });
    await expect(
      browser.send({
        version: 1,
        commandId: 'sort-1',
        identity,
        expectedRevision: human?.revision ?? 0,
        controlId: 'toggle-sorting',
        payload: { columnId: 'name' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'idempotency_conflict' });
    const messagesBeforeSpoof = link.messages.length;
    expect(
      await browser.send({
        version: 1,
        commandId: 'denied',
        identity: { ...identity, subject: { type: 'tenant', id: 'tenant-b' } },
        expectedRevision: human?.revision ?? 0,
        controlId: 'set-page',
        payload: { page: 2 },
      }),
    ).toMatchObject({ ok: false, reason: 'denied' });
    expect(link.messages).toHaveLength(messagesBeforeSpoof);
    link.status('disconnected');
    expect(await commandPromise).toMatchObject({
      ok: false,
      reason: 'disconnected',
    });
    await expect(replayPromise).resolves.toMatchObject({
      ok: false,
      reason: 'disconnected',
    });
    browser.dispose();

    const timeoutLink = bridgeTransport();
    const timeoutBridge = createDataSurfaceCommandBridge({
      transport: timeoutLink,
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: () => true,
      now: () => 1_000,
      ttlMs: 20,
      timeoutMs: 5,
    });
    await expect(
      timeoutBridge.send({
        version: 1,
        commandId: 'timeout-command',
        identity,
        expectedRevision: replayed.revision ?? 0,
        controlId: 'set-page',
        payload: { page: 2 },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    timeoutBridge.dispose();

    const malformed = createDataSurfaceCommandBridge({
      transport: bridgeTransport(),
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: () => true,
      ttlMs: 1_000,
      timeoutMs: 10,
    });
    expect(await malformed.send({ version: 1 } as never)).toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
    malformed.dispose();
  });

  it('requires a fresh opaque confirmation and rechecks tenant/eligibility on apply', async () => {
    let revision = 1;
    let authorizationAllowed = true;
    let eligibilityAllowed = true;
    let authoritativeSelection = {
      queryFingerprint: 'records-query-v1',
      rowIds: [firstId],
    };
    const applied: string[] = [];
    const state = new InMemoryDataSurfaceActionStateStore();
    const context = {
      principal: {
        db,
        principal: {
          runAsUserId: 'surface-user',
          tenantId: 'tenant-a',
          allowedTools: ['records.archive'],
        },
        onBehalfOfUserId: 'human-user',
        permissions: ['records.read', 'records.update'],
        postgresRls: false,
        audit: () => undefined,
      },
    };
    const adapter = createDataSurfaceActionAdapter({
      state,
      resolveSurface: async (run) => ({
        descriptor,
        revision,
        actions: {
          archive: {
            descriptor: descriptor.actions[0],
            inputSchema: null,
            validatePayload: () => ({ valid: true }),
            confirmation: 'required',
            execution: 'foreground',
            tool: 'records.archive',
            operation: {
              id: 'records:update',
              collection: 'records',
              action: 'update',
            },
            authorize: async (invocation) =>
              authorizationAllowed &&
              invocation.run.context.tenantId === 'tenant-a',
            eligible: async (_invocation, rowId) =>
              rowId === firstId && eligibilityAllowed
                ? { eligible: true }
                : { eligible: false, reason: 'no longer eligible' },
            apply: async (_invocation, rowId) => {
              const row = await records.get(String(rowId));
              if (!row) throw new Error('missing');
              row.status = 'archived';
              await row.save();
              applied.push(String(rowId));
              return undefined;
            },
          },
        },
      }),
      resolveSelection: async (invocation, _selection) => ({
        revision,
        queryFingerprint: authoritativeSelection.queryFingerprint,
        rowIds: authoritativeSelection.rowIds,
      }),
    });
    const base = {
      version: 1 as const,
      requestId: 'archive-preview',
      identity,
      actionId: 'archive',
      phase: 'preview' as const,
      selection: { scope: 'explicit-ids' as const, rowIds: [firstId] },
      expectedRevision: 1,
    } satisfies DataSurfaceServerActionRequest;
    expect(
      await adapter.apply(
        {
          ...base,
          phase: 'apply',
          requestId: 'without-preview',
          idempotencyKey: 'without-preview',
        },
        context,
      ),
    ).toMatchObject({ ok: false, reason: 'confirmation_required' });
    const preview = await adapter.preview(base, context);
    expect(preview).toMatchObject({
      ok: true,
      confirmationToken: expect.any(String),
    });
    const token = preview.confirmationToken as string;
    expect(token.length).toBeGreaterThan(20);
    expect(token).not.toContain('tenant-a');
    expect(token).not.toContain('archive');

    // The selected rows and their authoritative query can change without a
    // surface revision changing. Applying the old token must re-resolve that
    // selection and fail closed before the action callback is reached.
    const selectionDriftPreview = await adapter.preview(
      { ...base, requestId: 'selection-drift-preview' },
      context,
    );
    authoritativeSelection = {
      queryFingerprint: 'records-query-v2',
      rowIds: [secondId],
    };
    const selectionDrift = await adapter.apply(
      {
        ...base,
        phase: 'apply',
        requestId: 'selection-drift',
        idempotencyKey: 'selection-drift',
        confirmationToken: selectionDriftPreview.confirmationToken,
      },
      context,
    );
    expect(selectionDrift).toMatchObject({
      ok: false,
      reason: 'stale_preview',
    });
    expect(applied).toEqual([]);
    authoritativeSelection = {
      queryFingerprint: 'records-query-v1',
      rowIds: [firstId],
    };

    revision = 2;
    const stale = await adapter.apply(
      {
        ...base,
        phase: 'apply',
        requestId: 'stale',
        idempotencyKey: 'stale',
        confirmationToken: token,
      },
      context,
    );
    expect(stale).toMatchObject({ ok: false, reason: 'stale_preview' });
    revision = 1;
    const freshPreview = await adapter.preview(
      { ...base, requestId: 'fresh-preview' },
      context,
    );
    expect(freshPreview).toMatchObject({
      ok: true,
      confirmationToken: expect.any(String),
    });
    expect(freshPreview.confirmationToken).not.toBe(token);
    authorizationAllowed = false;
    const authorizationFlip = await adapter.apply(
      {
        ...base,
        phase: 'apply',
        requestId: 'authorization-flip',
        idempotencyKey: 'authorization-flip',
        confirmationToken: freshPreview.confirmationToken,
      },
      context,
    );
    expect(authorizationFlip).toMatchObject({ ok: false, reason: 'denied' });
    expect(applied).toEqual([]);

    authorizationAllowed = true;
    const eligibilityPreview = await adapter.preview(
      { ...base, requestId: 'eligibility-flip-preview' },
      context,
    );
    eligibilityAllowed = false;
    const eligibilityFlip = await adapter.apply(
      {
        ...base,
        phase: 'apply',
        requestId: 'eligibility-flip',
        idempotencyKey: 'eligibility-flip',
        confirmationToken: eligibilityPreview.confirmationToken,
      },
      context,
    );
    expect(eligibilityFlip).toMatchObject({
      ok: true,
      details: { accepted: 0, skipped: 1 },
    });
    expect(applied).toEqual([]);

    eligibilityAllowed = true;
    const crossTenantPreview = await adapter.preview(
      { ...base, requestId: 'cross-tenant-preview' },
      context,
    );
    const otherTenant = {
      ...context,
      principal: {
        ...context.principal,
        principal: { ...context.principal.principal, tenantId: 'tenant-b' },
      },
    };
    await expect(
      adapter.apply(
        {
          ...base,
          phase: 'apply',
          requestId: 'cross-tenant-apply',
          idempotencyKey: 'cross-tenant-apply',
          confirmationToken: crossTenantPreview.confirmationToken,
        },
        otherTenant,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_mismatch' });

    const otherPrincipal = {
      ...context,
      principal: {
        ...context.principal,
        principal: {
          ...context.principal.principal,
          runAsUserId: 'different-user',
        },
      },
    };
    await expect(
      adapter.apply(
        {
          ...base,
          phase: 'apply',
          requestId: 'cross-principal-apply',
          idempotencyKey: 'cross-principal-apply',
          confirmationToken: crossTenantPreview.confirmationToken,
        },
        otherPrincipal,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_mismatch' });

    const finalPreview = await adapter.preview(
      { ...base, requestId: 'final-preview' },
      context,
    );
    const applyRequest = {
      ...base,
      phase: 'apply' as const,
      requestId: 'archive-apply',
      idempotencyKey: 'archive-apply',
      confirmationToken: finalPreview.confirmationToken,
    };
    const appliedResult = await adapter.apply(applyRequest, context);
    expect(appliedResult).toMatchObject({ ok: true, details: { accepted: 1 } });
    expect(applied).toEqual([firstId]);
    expect(await adapter.apply(applyRequest, context)).toEqual(appliedResult);
    expect(applied).toHaveLength(1);
    await expect(
      adapter.apply(
        {
          ...applyRequest,
          requestId: 'confirmation-replay',
          idempotencyKey: 'confirmation-replay',
        },
        context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_replayed' });
    expect(
      await adapter.apply(
        {
          ...applyRequest,
          requestId: 'forged',
          idempotencyKey: 'forged',
          confirmationToken: 'forged-token',
        },
        context,
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_or_expired_confirmation' });
    const otherPreview = await adapter.preview(
      { ...base, requestId: 'other-tenant' },
      otherTenant,
    );
    expect(otherPreview).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('keeps ContentList and report adapters on the same stable identity/version contract', async () => {
    const contentDescriptor = buildContentListSurfaceDescriptor({
      surfaceId: 'content-list-conformance',
    });
    expect(contentDescriptor).toMatchObject({
      version: 1,
      schemaVersion: CONTENT_LIST_SCHEMA_VERSION,
      rowKey: 'id',
      identity: { kind: 'table' },
    });
    expect(
      contentDescriptor.columns.find((column) => column.id === 'description'),
    ).toBeUndefined();
    expect(
      contentDescriptor.actions.find((action) => action.id === 'delete'),
    ).toMatchObject({ requiresConfirmation: true });

    const report = await buildReportAdapterDescriptor(
      SurfaceConformanceReport,
      { tenantScope: 'current' },
    );
    expect(report).toMatchObject({
      version: 1,
      identityField: 'id',
      resourceId: expect.stringContaining('#current'),
      queryExecution: { modes: expect.arrayContaining(['silent']) },
    });
    expect(
      report.columns.find((column) => column.fieldName === 'secret'),
    ).toBeUndefined();

    // Execute the report adapter against a real tenant-scoped
    // SmrtReportCollection. This catches adapters that build a safe
    // descriptor but forget to carry the tenant boundary into row execution.
    const reportCollection = {
      // The fixture's real tenant-scoped collection owns the SQL and tenancy
      // interceptor. This adapter seam only maps its hydrated objects to the
      // report adapter's JSON row contract; it deliberately ignores the
      // adapter's already-validated select hint because the fixture schema is
      // generated without persisted column metadata.
      list: async (_options: Record<string, unknown>) =>
        (await records.list()).map((row) => ({
          id: String(row.id),
          name: row.name,
        })),
      count: async (_options?: Record<string, unknown>) =>
        (await records.list()).length,
    };
    const reportRows = await withTenant({ tenantId: 'tenant-a' }, () =>
      queryReportMaterializedRows(
        SurfaceConformanceReport,
        {
          version: 1,
          requestId: 'report-visible',
          mode: 'rows',
          projection: ['id', 'name'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        {
          db,
          collection: reportCollection,
          adapter: { tenantScope: 'current' },
          execution: 'visible',
        },
      ),
    );
    expect(reportRows).toMatchObject({
      execution: 'visible',
      rows: expect.arrayContaining([
        { id: firstId, name: 'Ada' },
        { id: secondId, name: 'Grace' },
      ]),
      total: { kind: 'exact', value: 2 },
    });
    expect(JSON.stringify(reportRows)).not.toContain(hiddenId);

    // Mount the shipped ContentList itself (compact mode owns the DataTable
    // surface) and drive its generated descriptor through the same registry
    // command path used by the standalone human table above.
    const contentRegistry = createDataSurfaceRegistry();
    const content = buildContentListSurfaceDescriptor({
      surfaceId: 'content-list-mounted',
    });
    const contentRows = [
      {
        id: 'content-a',
        title: 'Ada article',
        type: 'article',
        status: 'published',
      },
      {
        id: 'content-b',
        title: 'Grace article',
        type: 'article',
        status: 'draft',
      },
    ];
    const { container: contentContainer } = render(ContentList, {
      props: {
        defaultViewMode: 'compact',
        contents: contentRows,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        onAdd: vi.fn(),
        dataSurface: { registry: contentRegistry, descriptor: content },
      },
    });
    await tick();
    await vi.waitFor(() =>
      expect(contentRegistry.inspect(content.identity)).toBeDefined(),
    );
    const contentHuman = contentRegistry.inspect(content.identity);
    const contentBrowser = await contentRegistry.execute({
      version: 1,
      commandId: 'content-search',
      identity: content.identity,
      expectedRevision: contentHuman?.revision ?? 0,
      controlId: 'set-search',
      payload: { search: 'Ada' },
    });
    expect(contentBrowser).toMatchObject({ ok: true });
    expect(contentRegistry.inspect(content.identity)?.state).toMatchObject({
      table: { state: { search: 'Ada' } },
    });
    await expectNoA11yViolations(contentContainer);

    // The report presentation consumes the adapter's production table columns
    // while retaining the same stable row identity and mounted command state.
    const reportIdentity: DataSurfaceIdentity = {
      surfaceId: report.resourceId,
      kind: 'report',
      subject: { type: 'tenant', id: 'tenant-a' },
    };
    const reportSurface: DataSurfaceDescriptor = {
      version: 1,
      identity: reportIdentity,
      schemaVersion: report.schema.version,
      label: report.reportClassName,
      rowKey: report.identityField,
      columns: report.dataTable.columns.map((column) => ({
        id: column.id,
        label: column.label,
        capabilities: [
          'read' as const,
          ...(column.sortable ? (['sort'] as const) : []),
          ...(column.filterable ? (['filter'] as const) : []),
        ],
      })),
      query: {
        modes: ['rows', 'count'],
        projectableColumnIds: report.schema.fields
          .filter((field) => field.projectable)
          .map((field) => field.id),
        sortableColumnIds: report.schema.fields
          .filter((field) => field.sortable)
          .map((field) => field.id),
      },
      controls: [],
      actions: [],
      limits: { maxQueryRows: 50, maxQueryBytes: 20_000, maxSelectionSize: 10 },
    };
    const reportRegistry = createDataSurfaceRegistry();
    const { container: reportContainer } = render(DataTable, {
      props: {
        data: (reportRows.rows ?? []) as Array<Record<string, unknown>>,
        columns: report.dataTable.columns,
        rowKey: report.dataTable.rowKey,
        controller: createDataTableController({
          columnIds: report.dataTable.columns.map((column) => column.id),
        }),
        caption: 'Surface Conformance Report',
        dataSurface: { registry: reportRegistry, descriptor: reportSurface },
      },
    });
    await tick();
    await vi.waitFor(() =>
      expect(reportRegistry.inspect(reportIdentity)).toBeDefined(),
    );
    expect(reportRegistry.inspect(reportIdentity)?.descriptor.identity).toEqual(
      reportIdentity,
    );
    await expectNoA11yViolations(reportContainer);
  });
});
