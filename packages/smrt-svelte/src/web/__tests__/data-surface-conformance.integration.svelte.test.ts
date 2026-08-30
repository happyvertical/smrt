/**
 * Application-level data-surface conformance gate (#2450).
 *
 * This fixture deliberately composes the shipped registry, browser/server
 * bridge, principal tools, action adapter, ContentList descriptor, and report
 * adapter. The database and generated REST handler are real; only the bridge
 * transport is an in-process test double.
 */

import {
  APIGenerator,
  field,
  getTestDatabase,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  createDataSurfaceRegistry,
  createDataTableController,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
  DataTable,
} from '@happyvertical/smrt-ui/data';
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceDeadlineError,
  type DataSurfaceDefinition,
  type DataSurfaceExecutorResult,
} from '../../../../agents/src/data-surface.js';
import type { PrincipalRun } from '../../../../agents/src/execute-as-principal.js';
import {
  createDataSurfaceActionAdapter,
  type DataSurfaceServerActionRequest,
  InMemoryDataSurfaceActionStateStore,
} from '../../../../agents/src/server/data-surface-actions.js';
import {
  createDataSurfaceCommandBridge,
  type DataSurfaceBridgeMessage,
  type DataSurfaceBridgePeer,
} from '../../../../chat/src/data-surface-bridge.js';
import { buildContentListSurfaceDescriptor } from '../../../../content/src/svelte/content-list-controller.js';
import { buildReportAdapterDescriptor } from '../../../../reports/src/adapter.js';
import { groupBy, report } from '../../../../reports/src/decorators.js';

@smrt({ api: { include: ['list', 'get', 'update'] } })
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

@smrt()
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
};

function runFor(
  tenantId: string | null,
  allowedTools: string[],
  database?: unknown,
): PrincipalRun {
  const permissions = ['records.read', 'records.update'];
  return {
    context: {
      userId: 'surface-user',
      tenantId,
      database,
      permissions,
      permissionSet: new Set(permissions),
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    } as PrincipalRun['context'],
    permissions,
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error('tool denied');
    },
    async assertOperation(collection, action) {
      if (collection !== 'records' || !['read', 'update'].includes(action)) {
        throw new Error('operation denied');
      }
      return {
        allowed: true,
        permission: `records.${action}`,
        reason: 'permission_granted',
      };
    },
  };
}

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
    send: vi.fn((message: DataSurfaceBridgeMessage) => messages.push(message)),
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

describe('data-surface human/agent parity and security (#2450)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let records: SurfaceConformanceRecordCollection;
  let firstId = '';
  let secondId = '';

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SurfaceConformanceRecord'],
    });
    records = await SurfaceConformanceRecordCollection.create({ db });
    const first = await records.create({ tenantId: 'tenant-a', name: 'Ada' });
    const second = await records.create({
      tenantId: 'tenant-a',
      name: 'Grace',
    });
    await records.create({ tenantId: 'tenant-b', name: 'Hidden tenant' });
    firstId = first.id;
    secondId = second.id;
  });

  afterAll(async () => {
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

  it('uses the real DB-backed principal query and REST auth boundary', async () => {
    const tools = createDataSurfaceTools({ surfaces: [surface()] });
    const run = runFor(
      'tenant-a',
      [DATA_DISCOVER_TOOL_SLUG, DATA_QUERY_TOOL_SLUG],
      db,
    );
    const discovered = await tools
      .find((tool) => tool.slug === DATA_DISCOVER_TOOL_SLUG)
      ?.execute({ run, args: {}, db });
    expect(discovered).toMatchObject([
      { id: 'records', fields: expect.any(Array) },
    ]);
    const fields = (discovered as Array<{ fields: Array<{ id: string }> }>)[0]
      .fields;
    expect(fields.map((field) => field.id)).toEqual(['id', 'name', 'status']);

    const queried = await tools
      .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
      ?.execute({
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
      });
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
    const cursorQueried = await cursorTools
      .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
      ?.execute({
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
      });
    expect(cursorFailure).toBeUndefined();
    expect(cursorQueried).toMatchObject({
      rows: [{ id: firstId }],
      page: { kind: 'cursor', limit: 1, hasMore: true, nextCursor: firstId },
    });

    const bounded = createDataSurfaceTools({
      surfaces: [surface({ truncated: true })],
    });
    const boundedResult = await bounded
      .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
      ?.execute({
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
      });
    expect(boundedResult).toMatchObject({ truncated: true, warnings: [] });

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
      slowTools
        .find((tool) => tool.slug === DATA_QUERY_TOOL_SLUG)
        ?.execute({
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
    ).rejects.toBeInstanceOf(DataSurfaceDeadlineError);
    expect(aborted).toBe(true);

    const api = new APIGenerator(
      {
        basePath: '/api/v1',
        authMiddleware: () => async (request) => {
          const token = request.headers.get('authorization');
          if (!token) return new Response('auth required', { status: 401 });
          if (token !== 'Bearer fixture-user')
            return new Response('forbidden', { status: 403 });
          return request;
        },
      },
      { db },
    );
    api.registerCollection('surfaceconformancerecords', records);
    const handler = api.generateHandler();
    expect(
      (
        await handler(
          new Request('http://fixture.local/api/v1/surfaceconformancerecords'),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(
          new Request('http://fixture.local/api/v1/surfaceconformancerecords', {
            headers: { authorization: 'Bearer other' },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request('http://fixture.local/api/v1/surfaceconformancerecords', {
            headers: { authorization: 'Bearer fixture-user' },
          }),
        )
      ).status,
    ).toBe(200);
  });

  it('keeps human and browser command snapshots identical and rejects bridge abuse', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController({
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
          { id: 'name', label: 'Name', accessor: 'name', sortable: true },
          { id: 'status', label: 'Status', accessor: 'status', sortable: true },
        ],
        rowKey: 'id',
        sortable: true,
        controller,
        caption: 'Records',
        dataSurface: { registry, descriptor: mountedDescriptor },
      },
    });
    await tick();
    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );
    const human = registry.inspect(identity);
    expect(human?.state).toMatchObject({
      table: { state: { sorting: [{ columnId: 'name', direction: 'asc' }] } },
    });
    await expectNoA11yViolations(container);

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
    ackLink.send.mockImplementation((message) => {
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
        .then((result) =>
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
          ),
        );
    });
    const ackBridge = createDataSurfaceCommandBridge({
      transport: ackLink,
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: () => true,
      now: () => 1_000,
      ttlMs: 1_000,
      timeoutMs: 100,
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

    const link = bridgeTransport();
    const browser = createDataSurfaceCommandBridge({
      transport: link,
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: async (command) => command.identity.subject?.id === 'tenant-a',
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
    link.status('disconnected');
    expect(await commandPromise).toMatchObject({
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
    expect(
      await malformed.send({ ...({} as never), version: 1 }),
    ).toMatchObject({ ok: false, reason: 'invalid_request' });
    malformed.dispose();
  });

  it('requires a fresh opaque confirmation and rechecks tenant/eligibility on apply', async () => {
    let revision = 1;
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
      },
    };
    const runAsPrincipal = async <T>(
      options: { principal: { tenantId: string | null } },
      fn: (run: PrincipalRun) => Promise<T>,
    ) => fn(runFor(options.principal.tenantId, ['records.archive'], db));
    const adapter = createDataSurfaceActionAdapter({
      state,
      createToken: () => 'opaque-token',
      runAsPrincipal: runAsPrincipal as never,
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
              invocation.run.context.tenantId === 'tenant-a',
            eligible: async (_invocation, rowId) =>
              rowId === firstId
                ? { eligible: true }
                : { eligible: false, reason: 'missing' },
            apply: async (_invocation, rowId) => {
              const row = await records.get(String(rowId));
              if (!row) throw new Error('missing');
              row.status = 'archived';
              await row.save();
              applied.push(String(rowId));
            },
          },
        },
      }),
      resolveSelection: async (invocation, selection) => ({
        revision,
        queryFingerprint: 'records-query-v1',
        rowIds: selection.scope === 'explicit-ids' ? selection.rowIds : [],
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
      confirmationToken: 'opaque-token',
    });
    const token = preview.confirmationToken as string;
    expect(token).not.toContain('tenant-a');
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
      confirmationToken: 'opaque-token',
    });
    const applyRequest = {
      ...base,
      phase: 'apply' as const,
      requestId: 'archive-apply',
      idempotencyKey: 'archive-apply',
      confirmationToken: freshPreview.confirmationToken,
    };
    const appliedResult = await adapter.apply(applyRequest, context);
    expect(appliedResult).toMatchObject({ ok: true, details: { accepted: 1 } });
    expect(applied).toEqual([firstId]);
    expect(await adapter.apply(applyRequest, context)).toEqual(appliedResult);
    expect(applied).toHaveLength(1);
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
    const otherTenant = {
      ...context,
      principal: {
        ...context.principal,
        principal: { ...context.principal.principal, tenantId: 'tenant-b' },
      },
    };
    const otherPreview = await adapter.preview(
      { ...base, requestId: 'other-tenant' },
      otherTenant,
    );
    expect(otherPreview).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('keeps ContentList and report adapters on the same stable identity/version contract', async () => {
    const content = buildContentListSurfaceDescriptor({
      surfaceId: 'content-list-conformance',
    });
    expect(content).toMatchObject({
      version: 1,
      schemaVersion: 1,
      rowKey: 'id',
      identity: { kind: 'table' },
    });
    expect(
      content.columns.find((column) => column.id === 'description'),
    ).toBeUndefined();
    expect(
      content.actions.find((action) => action.id === 'delete'),
    ).toMatchObject({ requiresConfirmation: true });

    const report = await buildReportAdapterDescriptor(
      SurfaceConformanceReport,
      { tenantScope: 'tenant-a' },
    );
    expect(report).toMatchObject({
      version: 1,
      identityField: 'id',
      resourceId: expect.stringContaining('tenant-a'),
      queryExecution: { modes: expect.arrayContaining(['silent']) },
    });
    expect(
      report.columns.find((column) => column.fieldName === 'secret'),
    ).toBeUndefined();
  });
});
