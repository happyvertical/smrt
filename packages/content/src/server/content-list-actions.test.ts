import type {
  ExecuteAsPrincipalOptions,
  PrincipalRun,
} from '@happyvertical/smrt-agents';
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
import {
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
  subject: { type: 'tenant', id: 'tenant-a' },
};

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
        resolveGovernance: async () => ({
          isGoverned: false,
          enforcePublishReadiness: false,
        }),
        save: async () => {
          this.saveCalls.push(row.id);
          if (this.failOnSave.has(row.id))
            throw new Error('private persistence failure');
          row.status = content.status;
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
  } = {},
) {
  const collection = options.collection ?? new MemoryContentCollection(rows());
  const allowedTools = [
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
    revision: async () => 7,
    authorize: options.authorize,
    scope: options.scope,
    backgroundQueue: options.backgroundQueue,
    handlers: options.handlers,
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

  it('fails closed when automated review lacks secondary collection permissions', async () => {
    const setup = harness({
      permissions: ['contents:update'],
      assertOperation: async (collection, action) => {
        if (collection === 'contentversions' && action === 'create') {
          throw new Error('operation denied');
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
      'contentversions',
      'create',
    );
    expect(setup.collection.saveCalls).toEqual([]);
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
});
