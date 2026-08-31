import type {
  ExecuteAsPrincipalOptions,
  PrincipalRun,
} from '@happyvertical/smrt-agents';
import { PrincipalToolNotAllowedError } from '@happyvertical/smrt-agents';
import {
  type DataSurfaceBackgroundActionJob,
  InMemoryDataSurfaceActionStateStore,
} from '@happyvertical/smrt-agents/server';
import {
  createDataQueryFingerprint,
  getTestDatabase,
  normalizeDataQueryRequest,
} from '@happyvertical/smrt-core';
import type { DataQueryRequest } from '@happyvertical/smrt-types';
import { describe, expect, it, vi } from 'vitest';
import type { Content } from '../content.js';
import {
  buildContentQuerySchema,
  executeContentQuery,
} from '../content-query.js';
import { Mirror } from '../content-types.js';
import { Contents } from '../contents.js';
import { CONTENT_LIST_WORKFLOW_OPTIONS } from '../svelte/content-list-workflows.js';
import {
  CONTENT_LIST_WORKFLOWS,
  type ContentListActionCollection,
  type ContentListActionRequest,
  type ContentListWorkflowId,
  createContentListActionAdapter,
} from './content-list-actions.js';

type Row = {
  id: string;
  title: string;
  status: Content['status'];
  updated_at: string;
  tenantId: string;
};

const identity = {
  surfaceId: 'content-list',
  kind: 'table' as const,
};

function permissionDeniedError(): Error {
  const error = new Error('Permission denied.');
  error.name = 'OperationPermissionError';
  Object.assign(error, {
    decision: {
      allowed: false,
      permission: 'contents.update',
      reason: 'permission_denied',
    },
  });
  return error;
}

function matchesCondition(
  row: Row,
  condition: Record<string, unknown>,
): boolean {
  return Object.entries(condition).every(([rawKey, expected]) => {
    const key = rawKey.split(/\s+/)[0] as keyof Row;
    const actual = row[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    return actual === expected;
  });
}

function matchesWhere(
  row: Row,
  where?: Record<string, unknown> | Record<string, unknown>[][],
): boolean {
  if (!where) return true;
  if (!Array.isArray(where)) return matchesCondition(row, where);
  return where.some((branch) =>
    branch.every((condition) => matchesCondition(row, condition)),
  );
}

class MemoryContentCollection implements ContentListActionCollection {
  readonly contents = new Map<string, Content>();
  readonly saveCalls: string[] = [];
  failOnSave = new Set<string>();
  failAfterSave = new Set<string>();

  constructor(readonly rows: Row[]) {
    for (const row of rows) {
      const content = {
        id: row.id,
        title: row.title,
        status: row.status,
        category: '',
        get updated_at() {
          return row.updated_at;
        },
        resolveGovernance: async () => ({
          isGoverned: false,
          enforcePublishReadiness: false,
        }),
        runReviewAction: async (options?: {
          expectedUpdatedAt?: Date | string;
        }) => {
          await content.save({
            expectedUpdatedAt: options?.expectedUpdatedAt,
          });
          return {};
        },
        db: {
          transaction: async <T>(
            operation: (transaction: unknown) => Promise<T>,
          ) => {
            const snapshot = { ...row };
            try {
              return await operation(content.db);
            } catch (error) {
              for (const key of Object.keys(row)) {
                if (!(key in snapshot)) {
                  delete (row as unknown as Record<string, unknown>)[key];
                }
              }
              Object.assign(row, snapshot);
              throw error;
            }
          },
        },
        withDatabase: async <T>(
          _db: unknown,
          operation: (bound: typeof content) => Promise<T>,
        ) => operation(content),
        save: async (options?: { expectedUpdatedAt?: Date | string }) => {
          this.saveCalls.push(row.id);
          if (this.failOnSave.has(row.id))
            throw new Error('private persistence failure');
          if (
            options?.expectedUpdatedAt !== undefined &&
            String(options.expectedUpdatedAt) !== String(row.updated_at)
          ) {
            throw Object.assign(new Error('revision conflict'), {
              code: 'RUNTIME_REVISION_CONFLICT',
            });
          }
          row.status = content.status;
          row.category = content.category;
          row.updated_at = `${row.updated_at}-saved`;
          if (this.failAfterSave.has(row.id)) {
            throw new Error('forced publication snapshot failure');
          }
        },
      } as unknown as Content;
      this.contents.set(row.id, content);
    }
  }

  async list(options: {
    select?: readonly string[];
    where?: Record<string, unknown> | Record<string, unknown>[][];
    offset?: number;
    limit?: number;
    orderBy?: string | string[];
  }): Promise<Record<string, unknown>[]> {
    let rows = this.rows.filter((row) => matchesWhere(row, options.where));
    const terms = options.orderBy
      ? Array.isArray(options.orderBy)
        ? options.orderBy
        : [options.orderBy]
      : [];
    rows = [...rows].sort((left, right) => {
      for (const term of terms) {
        const [field, direction = 'ASC'] = term.split(/\s+/);
        const compared = String(left[field as keyof Row]).localeCompare(
          String(right[field as keyof Row]),
        );
        if (compared !== 0)
          return direction.toUpperCase() === 'DESC' ? -compared : compared;
      }
      return 0;
    });
    const sliced = rows.slice(
      options.offset ?? 0,
      (options.offset ?? 0) + (options.limit ?? rows.length),
    );
    return sliced.map((row) =>
      Object.fromEntries(
        (options.select ?? Object.keys(row)).map((field) => [
          field,
          row[field as keyof Row],
        ]),
      ),
    );
  }

  async count(options?: {
    where?: Record<string, unknown> | Record<string, unknown>[][];
  }): Promise<number> {
    return this.rows.filter((row) => matchesWhere(row, options?.where)).length;
  }

  async facets(): Promise<[]> {
    return [];
  }

  async get(filter: string | Record<string, unknown>): Promise<Content | null> {
    const id = typeof filter === 'string' ? filter : String(filter.id);
    return this.contents.get(id) ?? null;
  }
}

function rows(): Row[] {
  return [
    {
      id: 'a',
      title: 'Alpha',
      status: 'draft',
      updated_at: '2026-01-01T00:00:00.000Z',
      tenantId: 'tenant-a',
    },
    {
      id: 'b',
      title: 'Bravo',
      status: 'draft',
      updated_at: '2026-01-02T00:00:00.000Z',
      tenantId: 'tenant-a',
    },
    {
      id: 'c',
      title: 'Charlie',
      status: 'draft',
      updated_at: '2026-01-03T00:00:00.000Z',
      tenantId: 'tenant-a',
    },
  ];
}

function query(overrides: Partial<DataQueryRequest> = {}): DataQueryRequest {
  return {
    version: 1,
    requestId: 'content-list-query',
    mode: 'rows',
    projection: ['id', 'title', 'status', 'updated_at'],
    sort: [{ field: 'id', direction: 'asc' }],
    page: { kind: 'offset', offset: 0, limit: 1 },
    ...overrides,
  };
}

async function fingerprint(request: DataQueryRequest): Promise<string> {
  const schema = await buildContentQuerySchema();
  return createDataQueryFingerprint(
    normalizeDataQueryRequest(request, schema),
    schema,
  );
}

function actionRequest(
  phase: 'preview' | 'apply',
  actionId: ContentListWorkflowId,
  selection: ContentListActionRequest['selection'],
  target: ContentListActionRequest['target'],
  overrides: Partial<ContentListActionRequest> = {},
): ContentListActionRequest {
  return {
    version: 1,
    requestId: `${phase}-${actionId}`,
    identity,
    actionId,
    phase,
    selection,
    target,
    expectedRevision: 7,
    ...(phase === 'apply' ? { idempotencyKey: `apply-${actionId}` } : {}),
    ...overrides,
  };
}

function harness(
  options: {
    collection?: MemoryContentCollection;
    permissions?: string[];
    authorize?: (workflow: ContentListWorkflowId, run: PrincipalRun) => boolean;
    scope?: (run: PrincipalRun) => { tenantId: string } | undefined;
    backgroundQueue?: {
      enqueue(job: DataSurfaceBackgroundActionJob): Promise<{ jobId: string }>;
    };
    handlers?: Parameters<typeof createContentListActionAdapter>[0]['handlers'];
    assertOperation?: PrincipalRun['assertOperation'];
    revision?: Parameters<typeof createContentListActionAdapter>[0]['revision'];
    allowedTools?: string[];
    maxSelectionSize?: number;
    workflowStorage?: Parameters<
      typeof createContentListActionAdapter
    >[0]['workflowStorage'];
    resolveDeferredPrincipal?: Parameters<
      typeof createContentListActionAdapter
    >[0]['resolveDeferredPrincipal'];
  } = {},
) {
  const collection = options.collection ?? new MemoryContentCollection(rows());
  const allowedTools = options.allowedTools ?? [
    'content.workflow.move-to-trash',
    'content.workflow.mark-draft',
    'content.workflow.submit-review',
    'content.workflow.publish',
    'content.workflow.archive',
    'content.workflow.restore',
    'content.workflow.automated-review',
    'content.workflow.format-body',
    'content.workflow.categorize',
    'content.workflow.optimize',
  ];
  const run: PrincipalRun = {
    context: { tenantId: 'tenant-a' } as PrincipalRun['context'],
    permissions: options.permissions ?? ['contents:update'],
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error('tool denied');
    },
    assertOperation: vi.fn(options.assertOperation),
  };
  const runAsPrincipal = (async <T>(
    _principalOptions: ExecuteAsPrincipalOptions,
    callback: (principalRun: PrincipalRun) => Promise<T>,
  ): Promise<T> =>
    callback(
      run,
    )) as typeof import('@happyvertical/smrt-agents').executeAsPrincipal;
  const adapter = createContentListActionAdapter({
    workflowStorage: options.workflowStorage ?? { adapterType: 'sqlite' },
    state: new InMemoryDataSurfaceActionStateStore(),
    collection: async () => collection,
    revision: options.revision ?? (async () => 7),
    authorize: options.authorize,
    scope: options.scope,
    backgroundQueue: options.backgroundQueue,
    handlers: options.handlers,
    maxSelectionSize: options.maxSelectionSize,
    runAsPrincipal,
    resolveDeferredPrincipal:
      options.resolveDeferredPrincipal ??
      (async (reference) => ({
        db: 'test.db',
        principal: {
          runAsUserId: reference.runAsUserId,
          tenantId: reference.tenantId,
          actsAsProfileId: reference.actsAsProfileId,
          allowedTools,
        },
        onBehalfOfUserId: reference.onBehalfOfUserId,
      })),
  });
  const context = {
    principal: {
      db: 'test.db',
      principal: {
        runAsUserId: 'principal-a',
        tenantId: 'tenant-a',
        allowedTools,
      },
      audit: vi.fn(),
    },
  };
  return { adapter, collection, context, run };
}

describe('ContentList bulk workflow server adapter (#2453)', () => {
  it.each([
    { adapterType: 'json' as const },
    { adapterType: 'json' as const, writeStrategy: 'immediate' as const },
    { adapterType: 'duckdb' as const, writeStrategy: 'immediate' as const },
  ])('rejects non-transactional exported-file storage before setup: %j', (workflowStorage) => {
    let stateRead = false;
    expect(() =>
      createContentListActionAdapter({
        workflowStorage,
        get state() {
          stateRead = true;
          throw new Error('state must not be read');
        },
        collection: async () => new MemoryContentCollection(rows()),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'UNSUPPORTED_CONTENT_LIST_WORKFLOW_STORAGE',
      }),
    );
    expect(stateRead).toBe(false);
  });

  it.each([
    { adapterType: 'sqlite' as const },
    { adapterType: 'postgres' as const },
    { adapterType: 'duckdb' as const },
    { adapterType: 'json' as const, writeStrategy: 'manual' as const },
  ])('accepts transaction-safe workflow storage: %j', (workflowStorage) => {
    expect(() => harness({ workflowStorage })).not.toThrow();
  });

  it('applies a revision-guarded archive to native DuckDB UUID rows', async () => {
    const db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Content'],
      omitForeignKeyConstraints: true,
    });
    try {
      const contents = await Contents.create({ db });
      const created = await contents.create({
        id: '44444444-4444-4444-8444-444444444444',
        tenantId: '11111111-1111-4111-8111-111111111111',
        title: 'DuckDB content',
        status: 'draft',
      });
      const allowedTools = ['content.workflow.archive'];
      const run: PrincipalRun = {
        context: {
          tenantId: '11111111-1111-4111-8111-111111111111',
        } as PrincipalRun['context'],
        permissions: ['contents:update'],
        allowedTools,
        isToolAllowed: (tool) => allowedTools.includes(tool),
        assertToolAllowed(tool) {
          if (!allowedTools.includes(tool)) throw new Error('tool denied');
        },
        assertOperation: vi.fn(),
      };
      const runAsPrincipal = (async <T>(
        _principalOptions: ExecuteAsPrincipalOptions,
        callback: (principalRun: PrincipalRun) => Promise<T>,
      ): Promise<T> =>
        callback(
          run,
        )) as typeof import('@happyvertical/smrt-agents').executeAsPrincipal;
      const adapter = createContentListActionAdapter({
        workflowStorage: { adapterType: 'duckdb' },
        state: new InMemoryDataSurfaceActionStateStore(),
        collection: async () => contents,
        revision: async () => 7,
        runAsPrincipal,
      });
      const context = {
        principal: {
          db: 'test.db',
          principal: {
            runAsUserId: 'principal-a',
            tenantId: '11111111-1111-4111-8111-111111111111',
            allowedTools,
          },
          audit: vi.fn(),
        },
      };
      const selection = {
        scope: 'explicit-ids' as const,
        rowIds: [String(created.id)],
      };
      const target = { expectedCount: 1 };
      const projected = await executeContentQuery(
        contents,
        {
          version: 1,
          requestId: 'duckdb-content-query',
          mode: 'rows',
          projection: ['id', 'title', 'status', 'updated_at'],
          filter: {
            kind: 'condition',
            field: 'id',
            operator: 'in',
            value: [String(created.id)],
          },
          sort: [{ field: 'id', direction: 'asc' }],
          page: { kind: 'offset', offset: 0, limit: 1 },
        },
        {
          scope: {
            tenantId: '11111111-1111-4111-8111-111111111111',
          },
        },
      );
      expect(projected.rows[0]).toMatchObject({
        id: String(created.id),
        title: 'DuckDB content',
      });
      const hydratedBeforePreview = await contents.get(String(created.id));
      expect(hydratedBeforePreview?.status).toBe('draft');
      const preview = await adapter.preview(
        actionRequest('preview', 'archive', selection, target),
        context,
      );
      expect(preview).toMatchObject({ ok: true });

      const result = await adapter.apply(
        actionRequest('apply', 'archive', selection, target, {
          confirmationToken: preview.confirmationToken,
        }),
        context,
      );

      expect(result).toMatchObject({
        ok: true,
        details: { accepted: 1, failed: 0 },
      });
      const persisted = await contents.get(String(created.id));
      expect(typeof persisted?.id).toBe('string');
      expect(persisted?.status).toBe('archived');
    } finally {
      await db.close?.();
    }
  });

  it('canonicalizes native DuckDB STI-child UUIDs through the base collection', async () => {
    const db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Content', 'Mirror'],
      omitForeignKeyConstraints: true,
    });
    try {
      const feedSourceId = '55555555-5555-4555-8555-555555555555';
      const mirror = new Mirror({
        db,
        id: '66666666-6666-4666-8666-666666666666',
        title: 'DuckDB mirror',
        status: 'draft',
        feedSourceId,
      });
      await mirror.initialize();
      await mirror.save();
      const contents = await Contents.create({ db });
      const loaded = await contents.get(String(mirror.id));

      expect(loaded).toBeInstanceOf(Mirror);
      expect((loaded as Mirror).feedSourceId).toBe(feedSourceId);
      loaded.status = 'archived';
      await loaded.save();
      expect((await contents.get(String(mirror.id)))?.status).toBe('archived');
    } finally {
      await db.close?.();
    }
  });

  it('keeps browser and server workflow catalogs in parity', () => {
    expect(CONTENT_LIST_WORKFLOW_OPTIONS).toEqual(
      CONTENT_LIST_WORKFLOWS.map(({ id, label, execution, sensitivity }) => ({
        id,
        label,
        execution,
        sensitivity,
      })),
    );
  });

  it('rejects a forged surface subject and resolves revisions against trusted identity', async () => {
    const revision = vi.fn(async () => 7);
    const setup = harness({ revision });
    const forged = actionRequest(
      'preview',
      'categorize',
      { scope: 'explicit-ids', rowIds: ['a'] },
      { expectedCount: 1 },
      {
        identity: {
          ...identity,
          subject: { type: 'tenant', id: 'tenant-a' },
        },
        payload: { category: 'news' },
      },
    );

    await expect(
      setup.adapter.preview(forged, setup.context),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' });
    expect(revision).toHaveBeenCalledWith(setup.run, identity);
  });

  it('resolves all matching rows from the canonical frozen query, not the loaded page', async () => {
    const setup = harness();
    const targetQuery = query();
    const selection = {
      scope: 'all-matching' as const,
      queryFingerprint: await fingerprint(targetQuery),
      expectedCount: 3,
    };

    const preview = await setup.adapter.preview(
      actionRequest(
        'preview',
        'categorize',
        selection,
        { query: targetQuery, expectedCount: 3 },
        {
          payload: { category: 'news/local' },
        },
      ),
      setup.context,
    );

    expect(preview).toMatchObject({
      ok: true,
      details: {
        count: 3,
        accepted: 3,
        resolvedScope: 'all-matching',
        representativeLabels: ['Alpha', 'Bravo', 'Charlie'],
      },
    });
    expect(setup.collection.saveCalls).toEqual([]);
  });

  it('rejects forged query fingerprints and client/server count drift', async () => {
    const setup = harness();
    const targetQuery = query();
    const base = actionRequest(
      'preview',
      'categorize',
      { scope: 'all-matching', queryFingerprint: 'forged', expectedCount: 3 },
      { query: targetQuery, expectedCount: 3 },
      { payload: { category: 'news' } },
    );

    await expect(
      setup.adapter.preview(base, setup.context),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'stale_query_fingerprint',
    });

    const canonical = await fingerprint(targetQuery);
    await expect(
      setup.adapter.preview(
        {
          ...base,
          requestId: 'preview-count-drift',
          selection: {
            scope: 'all-matching',
            queryFingerprint: canonical,
            expectedCount: 2,
          },
          target: { query: targetQuery, expectedCount: 2 },
        },
        setup.context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'matching_count_drifted',
    });
  });

  it('rejects oversized explicit selections before querying the collection', async () => {
    const setup = harness({ maxSelectionSize: 2 });
    const list = vi.spyOn(setup.collection, 'list');
    const count = vi.spyOn(setup.collection, 'count');

    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'categorize',
          { scope: 'explicit-ids', rowIds: ['a', 'b', 'c'] },
          { expectedCount: 3 },
          { payload: { category: 'news' } },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'limit_exceeded' });
    expect(list).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('rejects a configured selection cap above the coherent query bound', () => {
    expect(() => harness({ maxSelectionSize: 1_001 })).toThrow(
      'ContentList maxSelectionSize must be an integer between 1 and 1000',
    );
  });

  it('reports an oversized all-matching selection as limit exceeded', async () => {
    const setup = harness({ maxSelectionSize: 2 });
    const targetQuery = query();

    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'categorize',
          {
            scope: 'all-matching',
            rowIds: [],
            queryFingerprint: await fingerprint(targetQuery),
            expectedCount: 3,
          } as never,
          { query: targetQuery, expectedCount: 3 },
          { payload: { category: 'news' } },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'limit_exceeded' });
  });

  it('rejects malformed requests and non-string restore statuses', async () => {
    const setup = harness();
    let deeplyNestedQuery: Record<string, unknown> = {};
    for (let depth = 0; depth < 18; depth += 1) {
      deeplyNestedQuery = { nested: deeplyNestedQuery };
    }

    await expect(
      setup.adapter.preview(null as never, setup.context),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_request' });
    await expect(
      setup.adapter.preview(
        {
          version: 1,
          requestId: 'missing-selection',
          identity,
          actionId: 'categorize',
          phase: 'preview',
          expectedRevision: 7,
          target: { expectedCount: 0 },
        } as never,
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_request' });
    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'restore',
          { scope: 'explicit-ids', rowIds: ['a'] },
          { expectedCount: 1 },
          { payload: { status: ['published'] } as never },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_payload' });
    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'format-body',
          { scope: 'explicit-ids', rowIds: ['a'] },
          { expectedCount: 1 },
          { payload: 'markdown' as never },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_payload' });
    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'automated-review',
          { scope: 'explicit-ids', rowIds: ['a'] },
          { expectedCount: 1 },
          { payload: { kind: 'unsupported' } },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_payload' });
    await expect(
      setup.adapter.apply(
        actionRequest(
          'apply',
          'categorize',
          { scope: 'explicit-ids', rowIds: ['a'] },
          { query: deeplyNestedQuery as never, expectedCount: 1 },
          { payload: { category: 'news' }, idempotencyKey: 'deep-query' },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_request' });
  });

  it('previews without writes, requires confirmation, and rejects row revision drift at apply', async () => {
    const setup = harness();
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a', 'b'] };
    const previewRequest = actionRequest(
      'preview',
      'categorize',
      selection,
      { expectedCount: 2 },
      { payload: { category: 'science' } },
    );
    const preview = await setup.adapter.preview(previewRequest, setup.context);

    expect(preview).toMatchObject({ ok: true, details: { accepted: 2 } });
    expect(setup.collection.saveCalls).toEqual([]);
    await expect(
      setup.adapter.apply(
        actionRequest(
          'apply',
          'categorize',
          selection,
          { expectedCount: 2 },
          { payload: { category: 'science' } },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_required' });

    setup.collection.rows[0].updated_at = '2026-07-01T00:00:00.000Z';
    await expect(
      setup.adapter.apply(
        actionRequest(
          'apply',
          'categorize',
          selection,
          { expectedCount: 2 },
          {
            payload: { category: 'science' },
            confirmationToken: preview.confirmationToken,
          },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_preview' });
    expect(setup.collection.saveCalls).toEqual([]);
  });

  it('uses the injected principal for authorization and trusted tenant scope', async () => {
    const collection = new MemoryContentCollection([
      ...rows().slice(0, 1),
      {
        id: 'foreign',
        title: 'Foreign',
        status: 'draft',
        updated_at: '2026-01-04T00:00:00.000Z',
        tenantId: 'tenant-b',
      },
    ]);
    const denied = harness({
      collection,
      permissions: [],
      authorize: (_workflow, run) =>
        run.permissions.includes('contents:update'),
      scope: (run) => ({
        tenantId: String((run.context as { tenantId: string }).tenantId),
      }),
    });
    const targetQuery = query();
    const canonical = await fingerprint(targetQuery);
    const selection = {
      scope: 'all-matching' as const,
      queryFingerprint: canonical,
      expectedCount: 1,
    };
    const request = actionRequest(
      'preview',
      'categorize',
      selection,
      { query: targetQuery, expectedCount: 1 },
      { payload: { category: 'local' } },
    );

    await expect(
      denied.adapter.preview(request, denied.context),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'denied',
    });

    const allowed = harness({
      collection,
      permissions: ['contents:update'],
      authorize: (_workflow, run) =>
        run.permissions.includes('contents:update'),
      scope: (run) => ({
        tenantId: String((run.context as { tenantId: string }).tenantId),
      }),
    });
    await expect(
      allowed.adapter.preview(
        { ...request, requestId: 'preview-allowed' },
        allowed.context,
      ),
    ).resolves.toMatchObject({
      ok: true,
      details: { count: 1, representativeLabels: ['Alpha'] },
    });
  });

  it('fails closed when automated review lacks reference-read permission', async () => {
    const setup = harness({
      permissions: ['contents:update'],
      assertOperation: async (collection, action) => {
        if (collection === 'contentreferences' && action === 'read') {
          throw permissionDeniedError();
        }
        return { allowed: true } as Awaited<
          ReturnType<PrincipalRun['assertOperation']>
        >;
      },
    });
    const request = actionRequest(
      'preview',
      'automated-review',
      { scope: 'explicit-ids', rowIds: ['a'] },
      { expectedCount: 1 },
    );

    await expect(
      setup.adapter.preview(request, setup.context),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'denied',
    });
    expect(setup.run.assertOperation).toHaveBeenNthCalledWith(
      1,
      'contents',
      'read',
    );
    expect(setup.run.assertOperation).toHaveBeenCalledWith(
      'contentreferences',
      'read',
    );
    expect(setup.collection.saveCalls).toEqual([]);
  });

  it.each([
    'contentassets',
    'assets',
  ])('fails closed when a publication snapshot lacks %s read permission', async (deniedCollection) => {
    const setup = harness({
      assertOperation: async (collection, action) => {
        if (collection === deniedCollection && action === 'read') {
          throw permissionDeniedError();
        }
        return { allowed: true } as Awaited<
          ReturnType<PrincipalRun['assertOperation']>
        >;
      },
    });

    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'publish',
          { scope: 'explicit-ids', rowIds: ['a'] },
          { expectedCount: 1 },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    expect(setup.run.assertOperation).toHaveBeenCalledWith(
      deniedCollection,
      'read',
    );
    expect(setup.collection.saveCalls).toEqual([]);
  });

  it('rechecks publish readiness and configured automated-review policies', async () => {
    const setup = harness();
    const content = await setup.collection.get('a');
    if (!content) throw new Error('expected content');
    const evaluateReviewProfile = vi.fn(async () => ({ ready: false }));
    Object.assign(content, {
      resolveGovernance: async () => ({
        isGoverned: true,
        enforcePublishReadiness: true,
        publicationProfileKey: 'publication',
        reviewPolicies: [{ key: 'facts', kind: 'facts' }],
      }),
      evaluateReviewProfile,
    });

    const publish = await setup.adapter.preview(
      actionRequest(
        'preview',
        'publish',
        { scope: 'explicit-ids', rowIds: ['a'] },
        { expectedCount: 1 },
      ),
      setup.context,
    );
    expect(publish).toMatchObject({
      ok: true,
      details: {
        accepted: 0,
        skipped: 1,
        outcomes: [
          {
            rowId: 'a',
            status: 'skipped',
            reason: 'publish_readiness_failed',
          },
        ],
      },
    });
    expect(evaluateReviewProfile).toHaveBeenCalledWith('publication');

    const unknownPolicy = await setup.adapter.preview(
      actionRequest(
        'preview',
        'automated-review',
        { scope: 'explicit-ids', rowIds: ['a'] },
        { expectedCount: 1 },
        { payload: { kind: 'custom', policyKey: 'unknown' } },
      ),
      setup.context,
    );
    expect(unknownPolicy).toMatchObject({
      ok: true,
      details: {
        accepted: 0,
        outcomes: [
          {
            rowId: 'a',
            status: 'skipped',
            reason: 'review_policy_unavailable',
          },
        ],
      },
    });
  });

  it('requires publication permissions only for restore-to-published', async () => {
    const setup = harness();
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a'] };
    const target = { expectedCount: 1 };

    await setup.adapter.preview(
      actionRequest('preview', 'restore', selection, target, {
        payload: { status: 'draft' },
      }),
      setup.context,
    );
    const draftOperations = vi
      .mocked(setup.run.assertOperation)
      .mock.calls.map(([collection, action]) => `${collection}:${action}`);
    expect(draftOperations).toEqual(['contents:read', 'contents:update']);

    vi.mocked(setup.run.assertOperation).mockClear();
    await setup.adapter.preview(
      actionRequest('preview', 'restore', selection, target, {
        payload: { status: 'published' },
      }),
      setup.context,
    );
    const publishedOperations = vi
      .mocked(setup.run.assertOperation)
      .mock.calls.map(([collection, action]) => `${collection}:${action}`);
    expect(publishedOperations).toContain('contentreferences:read');
    expect(publishedOperations).toContain('contentassets:read');
    expect(publishedOperations).toContain('assets:read');
    expect(publishedOperations).toContain('contentversions:create');
  });

  it('reports primary operation and tool authorization failures as denial', async () => {
    const primaryDenied = harness({
      assertOperation: async () => {
        throw permissionDeniedError();
      },
    });
    const request = actionRequest(
      'preview',
      'categorize',
      { scope: 'explicit-ids', rowIds: ['a'] },
      { expectedCount: 1 },
      { payload: { category: 'news' } },
    );

    await expect(
      primaryDenied.adapter.preview(request, primaryDenied.context),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });

    const toolDenied = harness({ allowedTools: [] });
    toolDenied.run.assertToolAllowed = (tool) => {
      throw new PrincipalToolNotAllowedError(tool);
    };
    await expect(
      toolDenied.adapter.preview(
        { ...request, requestId: 'preview-tool-denied' },
        toolDenied.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
  });

  it.each([
    {
      actionId: 'format-body' as const,
      payload: { format: 'markdown' },
    },
    {
      actionId: 'categorize' as const,
      payload: { category: 'news' },
    },
    {
      actionId: 'automated-review' as const,
      payload: {},
    },
  ])('requires publication operations before $actionId can touch published content', async ({
    actionId,
    payload,
  }) => {
    const collection = new MemoryContentCollection([
      { ...rows()[0], status: 'published' },
    ]);
    const setup = harness({
      collection,
      handlers: { formatBody: vi.fn() },
      assertOperation: async (target, action) => {
        if (target === 'contentversions' && action === 'create') {
          throw permissionDeniedError();
        }
        return { allowed: true } as Awaited<
          ReturnType<PrincipalRun['assertOperation']>
        >;
      },
    });

    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          actionId,
          { scope: 'explicit-ids', rowIds: ['a'] },
          { expectedCount: 1 },
          { payload },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    expect(setup.collection.saveCalls).toEqual([]);
  });

  it('surfaces permission catalog failures instead of misreporting them as denial', async () => {
    const setup = harness({
      assertOperation: async (collection) => {
        if (collection === 'facts') {
          const error = new Error('Unknown operation permission.');
          error.name = 'OperationPermissionError';
          Object.assign(error, {
            decision: {
              allowed: false,
              permission: null,
              reason: 'unknown_permission',
            },
          });
          throw error;
        }
        return { allowed: true } as Awaited<
          ReturnType<PrincipalRun['assertOperation']>
        >;
      },
    });

    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'automated-review',
          { scope: 'explicit-ids', rowIds: ['a'] },
          { expectedCount: 1 },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'execution_failed' });
  });

  it('reports accepted, skipped, and failed rows without leaking the failure', async () => {
    const collection = new MemoryContentCollection([
      ...rows().slice(0, 2),
      {
        id: 'deleted',
        title: 'Deleted',
        status: 'deleted',
        updated_at: '2026-01-04T00:00:00.000Z',
        tenantId: 'tenant-a',
      },
    ]);
    collection.failOnSave.add('b');
    const setup = harness({ collection });
    const selection = {
      scope: 'explicit-ids' as const,
      rowIds: ['a', 'b', 'deleted'],
    };
    const target = { expectedCount: 3 };
    const preview = await setup.adapter.preview(
      actionRequest('preview', 'categorize', selection, target, {
        payload: { category: 'news' },
      }),
      setup.context,
    );
    const result = await setup.adapter.apply(
      actionRequest('apply', 'categorize', selection, target, {
        payload: { category: 'news' },
        confirmationToken: preview.confirmationToken,
      }),
      setup.context,
    );

    expect(result).toMatchObject({
      ok: true,
      details: {
        accepted: 1,
        skipped: 1,
        failed: 1,
        outcomes: [
          { rowId: 'a', status: 'accepted' },
          { rowId: 'b', status: 'failed', reason: 'execution_failed' },
          { rowId: 'deleted', status: 'skipped', reason: 'deleted' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('private persistence failure');
  });

  it('rechecks each row revision immediately before mutation', async () => {
    const collection = new MemoryContentCollection(rows().slice(0, 1));
    const get = vi.spyOn(collection, 'get');
    const content = await collection.get('a');
    if (!content) throw new Error('expected content');
    const save = content.save.bind(content);
    content.save = async (options) => {
      collection.rows[0].updated_at = '2026-09-01T00:00:00.000Z';
      return save(options);
    };
    get.mockClear();
    const setup = harness({ collection });
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a'] };
    const target = { expectedCount: 1 };
    const preview = await setup.adapter.preview(
      actionRequest('preview', 'categorize', selection, target, {
        payload: { category: 'news' },
      }),
      setup.context,
    );

    const result = await setup.adapter.apply(
      actionRequest('apply', 'categorize', selection, target, {
        payload: { category: 'news' },
        confirmationToken: preview.confirmationToken,
      }),
      setup.context,
    );

    expect(result).toMatchObject({
      ok: true,
      details: {
        accepted: 0,
        failed: 1,
        outcomes: [
          { rowId: 'a', status: 'failed', reason: 'row_revision_drifted' },
        ],
      },
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(collection.saveCalls).toEqual(['a']);
  });

  it('uses an atomic revision guard for long-running handler mutations', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    const setup = harness({
      backgroundQueue: {
        enqueue: async (job) => {
          queued = job;
          return { jobId: 'format-cas-job' };
        },
      },
      handlers: {
        formatBody: vi.fn(async (content) => {
          expect('save' in content).toBe(false);
          expect('createVersion' in content).toBe(false);
          expect('addReference' in content).toBe(false);
          expect('addAsset' in content).toBe(false);
          expect('db' in content).toBe(false);
          content.title = 'formatted';
          setup.collection.rows[0].updated_at =
            '2026-01-01T00:00:00.000Z-concurrent';
        }),
      },
    });
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a'] };
    const target = { expectedCount: 1 };
    const preview = await setup.adapter.preview(
      actionRequest('preview', 'format-body', selection, target, {
        payload: { format: 'markdown' },
      }),
      setup.context,
    );

    const accepted = await setup.adapter.apply(
      actionRequest('apply', 'format-body', selection, target, {
        payload: { format: 'markdown' },
        confirmationToken: preview.confirmationToken,
        idempotencyKey: 'format-cas',
      }),
      setup.context,
    );
    expect(accepted).toMatchObject({
      ok: true,
      details: { background: true },
    });

    const result = await queued?.run();
    expect(result).toMatchObject({
      ok: true,
      details: {
        accepted: 0,
        failed: 1,
        outcomes: [
          { rowId: 'a', status: 'failed', reason: 'row_revision_drifted' },
        ],
      },
    });
    expect(setup.collection.rows[0].title).toBe('Alpha');
  });

  it.each([
    { actionId: 'publish' as const, initialStatus: 'draft' as const },
    { actionId: 'restore' as const, initialStatus: 'deleted' as const },
    { actionId: 'mark-draft' as const, initialStatus: 'archived' as const },
    { actionId: 'archive' as const, initialStatus: 'draft' as const },
    { actionId: 'move-to-trash' as const, initialStatus: 'draft' as const },
    { actionId: 'categorize' as const, initialStatus: 'draft' as const },
  ])('rolls back $actionId when post-save persistence fails', async ({
    actionId,
    initialStatus,
  }) => {
    const collection = new MemoryContentCollection([
      { ...rows()[0], status: initialStatus },
    ]);
    collection.failAfterSave.add('a');
    const setup = harness({ collection });
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a'] };
    const target = { expectedCount: 1 };
    const payload =
      actionId === 'restore'
        ? { status: 'published' }
        : actionId === 'categorize'
          ? { category: 'news' }
          : undefined;
    const preview = await setup.adapter.preview(
      actionRequest('preview', actionId, selection, target, { payload }),
      setup.context,
    );
    expect(preview).toMatchObject({ ok: true });

    const result = await setup.adapter.apply(
      actionRequest('apply', actionId, selection, target, {
        payload,
        confirmationToken: preview.confirmationToken,
      }),
      setup.context,
    );

    expect(result).toMatchObject({
      ok: true,
      details: {
        accepted: 0,
        failed: 1,
        outcomes: [
          { rowId: 'a', status: 'failed', reason: 'execution_failed' },
        ],
      },
    });
    expect(collection.rows[0].status).toBe(initialStatus);
    expect(collection.rows[0].category).toBeUndefined();
    expect(collection.rows[0].updated_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects repeated all-matching ids from one bounded snapshot query', async () => {
    const churnRows = Array.from({ length: 200 }, (_, index) => ({
      id: String(index).padStart(3, '0'),
      title: `Content ${index}`,
      status: 'draft' as const,
      updated_at: `2026-01-01T00:00:00.${String(index).padStart(3, '0')}Z`,
      tenantId: 'tenant-a',
    }));
    const collection = new MemoryContentCollection(churnRows);
    const list = collection.list.bind(collection);
    const listSpy = vi
      .spyOn(collection, 'list')
      .mockImplementation(async (options) => {
        const page = await list(options);
        return page.map((row, index) =>
          index === 199 ? { ...row, id: '198' } : row,
        );
      });
    const setup = harness({ collection, maxSelectionSize: 200 });
    const targetQuery = query({
      page: { kind: 'offset', offset: 0, limit: 1 },
    });
    const canonical = await fingerprint(targetQuery);

    await expect(
      setup.adapter.preview(
        actionRequest(
          'preview',
          'categorize',
          {
            scope: 'all-matching',
            queryFingerprint: canonical,
            expectedCount: 200,
          },
          { query: targetQuery, expectedCount: 200 },
          { payload: { category: 'news' } },
        ),
        setup.context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'matching_count_drifted',
    });
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves a configured all-matching limit above the default page cap', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: String(index).padStart(3, '0'),
      title: `Content ${index}`,
      status: 'draft' as const,
      type: 'document',
      updated_at: '2026-01-01T00:00:00.000Z',
    }));
    const collection = new MemoryContentCollection(rows);
    const listSpy = vi.spyOn(collection, 'list');
    const setup = harness({ collection, maxSelectionSize: 201 });
    const targetQuery = query({
      page: { kind: 'offset', offset: 0, limit: 1 },
    });
    const canonical = await fingerprint(targetQuery);

    const result = await setup.adapter.preview(
      actionRequest(
        'preview',
        'categorize',
        {
          scope: 'all-matching',
          queryFingerprint: canonical,
          expectedCount: 201,
        },
        { query: targetQuery, expectedCount: 201 },
        { payload: { category: 'news' } },
      ),
      setup.context,
    );

    expect(result.ok).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an automated review when content changes during AI work', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    let reviewWrites = 0;
    const setup = harness({
      backgroundQueue: {
        enqueue: async (job) => {
          queued = job;
          return { jobId: 'review-cas-job' };
        },
      },
    });
    const content = await setup.collection.get('a');
    if (!content) throw new Error('expected content');
    Object.assign(content, {
      resolveGovernance: async () => ({
        isGoverned: true,
        enforcePublishReadiness: false,
        reviewPolicies: [],
      }),
      runReviewAction: async (options: {
        expectedUpdatedAt?: Date | string;
      }) => {
        setup.collection.rows[0].updated_at =
          '2026-01-01T00:00:00.000Z-concurrent';
        await content.save({ expectedUpdatedAt: options.expectedUpdatedAt });
        reviewWrites += 1;
      },
    });
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a'] };
    const target = { expectedCount: 1 };
    const preview = await setup.adapter.preview(
      actionRequest('preview', 'automated-review', selection, target),
      setup.context,
    );
    await setup.adapter.apply(
      actionRequest('apply', 'automated-review', selection, target, {
        confirmationToken: preview.confirmationToken,
        idempotencyKey: 'review-cas',
      }),
      setup.context,
    );

    await expect(queued?.run()).resolves.toMatchObject({
      ok: true,
      details: {
        accepted: 0,
        failed: 1,
        outcomes: [
          { rowId: 'a', status: 'failed', reason: 'row_revision_drifted' },
        ],
      },
    });
    expect(reviewWrites).toBe(0);
  });

  it('binds the content target into idempotent retries', async () => {
    const setup = harness();
    const selection = { scope: 'current-page' as const };
    const firstQuery = query({
      filter: { kind: 'condition', field: 'id', operator: 'eq', value: 'a' },
    });
    const secondQuery = query({
      requestId: 'content-list-query-b',
      filter: { kind: 'condition', field: 'id', operator: 'eq', value: 'b' },
    });
    const firstTarget = { query: firstQuery, expectedCount: 1 };
    const secondTarget = { query: secondQuery, expectedCount: 1 };
    const firstPreview = await setup.adapter.preview(
      actionRequest('preview', 'categorize', selection, firstTarget, {
        payload: { category: 'news' },
      }),
      setup.context,
    );
    await setup.adapter.apply(
      actionRequest('apply', 'categorize', selection, firstTarget, {
        payload: { category: 'news' },
        confirmationToken: firstPreview.confirmationToken,
        idempotencyKey: 'same-key',
      }),
      setup.context,
    );
    const secondPreview = await setup.adapter.preview(
      actionRequest('preview', 'categorize', selection, secondTarget, {
        payload: { category: 'news' },
      }),
      setup.context,
    );

    await expect(
      setup.adapter.apply(
        actionRequest('apply', 'categorize', selection, secondTarget, {
          payload: { category: 'news' },
          confirmationToken: secondPreview.confirmationToken,
          idempotencyKey: 'same-key',
        }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'idempotency_conflict' });
  });

  it('queues long-running work once and replays the same accepted job for a duplicate apply', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    const enqueue = vi.fn(async (job: DataSurfaceBackgroundActionJob) => {
      queued = job;
      return { jobId: 'content-job-1' };
    });
    const formatBody = vi.fn();
    const setup = harness({
      backgroundQueue: { enqueue },
      handlers: { formatBody },
    });
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a', 'b'] };
    const target = { expectedCount: 2 };
    const preview = await setup.adapter.preview(
      actionRequest('preview', 'format-body', selection, target, {
        payload: { format: 'markdown' },
      }),
      setup.context,
    );
    const applyRequest = actionRequest(
      'apply',
      'format-body',
      selection,
      target,
      {
        payload: { format: 'markdown' },
        confirmationToken: preview.confirmationToken,
        idempotencyKey: 'format-once',
      },
    );

    const first = await setup.adapter.apply(applyRequest, setup.context);
    const duplicate = await setup.adapter.apply(applyRequest, setup.context);

    expect(first).toMatchObject({
      ok: true,
      details: { background: true, jobId: 'content-job-1', accepted: 2 },
    });
    expect(duplicate).toEqual(first);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(formatBody).not.toHaveBeenCalled();
    expect(queued?.rowIds).toEqual(['a', 'b']);

    const executed = await queued?.run();
    const replayed = await queued?.run();
    expect(executed).toMatchObject({
      ok: true,
      details: { accepted: 2, skipped: 0, failed: 0 },
    });
    expect(replayed).toEqual(executed);
    expect(formatBody).toHaveBeenCalledTimes(2);
  });

  it('returns a structured failure when a queued selection drifts', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    const collection = new MemoryContentCollection(rows().slice(0, 2));
    const setup = harness({
      collection,
      backgroundQueue: {
        enqueue: async (job) => {
          queued = job;
          return { jobId: 'content-job-drift' };
        },
      },
      handlers: { formatBody: vi.fn() },
    });
    const selection = { scope: 'explicit-ids' as const, rowIds: ['a', 'b'] };
    const target = { expectedCount: 2 };
    const preview = await setup.adapter.preview(
      actionRequest('preview', 'format-body', selection, target),
      setup.context,
    );
    await setup.adapter.apply(
      actionRequest('apply', 'format-body', selection, target, {
        confirmationToken: preview.confirmationToken,
        idempotencyKey: 'queued-drift',
      }),
      setup.context,
    );
    collection.rows.splice(1, 1);

    await expect(queued?.run()).resolves.toMatchObject({
      ok: false,
      reason: 'matching_count_drifted',
    });
  });
});
