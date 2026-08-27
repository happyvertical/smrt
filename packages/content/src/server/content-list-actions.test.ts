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
  normalizeDataQueryRequest,
} from '@happyvertical/smrt-core';
import type { DataQueryRequest } from '@happyvertical/smrt-types';
import { describe, expect, it, vi } from 'vitest';
import type { Content } from '../content.js';
import { buildContentQuerySchema } from '../content-query.js';
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
    state: new InMemoryDataSurfaceActionStateStore(),
    collection: async () => collection,
    revision: options.revision ?? (async () => 7),
    authorize: options.authorize,
    scope: options.scope,
    backgroundQueue: options.backgroundQueue,
    handlers: options.handlers,
    maxSelectionSize: options.maxSelectionSize,
    runAsPrincipal,
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
    get.mockImplementation(async (filter) => {
      if (get.mock.calls.length === 3) {
        collection.rows[0].updated_at = '2026-09-01T00:00:00.000Z';
      }
      return (
        collection.contents.get(
          typeof filter === 'string' ? filter : String(filter.id),
        ) ?? null
      );
    });
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
    expect(collection.saveCalls).toEqual([]);
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
