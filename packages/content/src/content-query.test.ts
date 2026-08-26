/**
 * Bounded, tenant-safe content query endpoint (#2452) over the canonical
 * data-query protocol (#2444).
 *
 * Real in-memory SQLite throughout, per `.claude/rules/testing.md` — the
 * database is the subject here (projection, paging, counts, facets, and the
 * collection's own field-policy refusals), so nothing about it is mocked.
 */

import {
  field,
  getTestDatabase,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type {
  DataQueryRequest,
  DataQuerySchema,
} from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentQuerySchema,
  buildDataQuerySchemaForClass,
  CONTENT_QUERY_MAX_PAGE_LIMIT,
  type ContentQueryCollection,
  DATA_QUERY_MAX_STRING_LENGTH,
  executeContentQuery,
  mergeContentQueryScope,
} from './content-query';
import { Contents } from './contents';
import { POST as queryRoute } from './routes/api/v1/contents/query/+server';

let routeContents: Contents | undefined;

vi.mock('$lib/server/smrt', () => ({
  getCollection: async () => {
    if (!routeContents) throw new Error('Test collection not initialized');
    return routeContents;
  },
}));

vi.mock('@sveltejs/kit', () => ({
  json: (data: unknown, init?: { status?: number }) =>
    new Response(JSON.stringify(data), {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  error: (status: number, body?: unknown) =>
    Object.assign(new Error(String(body ?? 'Error')), { status, body }),
}));

// A field-policy fixture: `Content` itself declares no sensitive or
// permission-gated field, so the exposure boundary needs a class that does.
// The name is unique to avoid AST-scanner collisions (issue #543).
@smrt({ idType: 'text' })
class ContentQueryProbe extends SmrtObject {
  label: string = '';

  @field({ type: 'text', sensitive: true })
  apiSecret: string = '';

  @field({ type: 'text', readPermission: 'content.probe.read' })
  internalNote: string = '';
}

class ContentQueryProbeCollection extends SmrtCollection<ContentQueryProbe> {
  static readonly _itemClass = ContentQueryProbe;
}

type PartialRequest = Partial<DataQueryRequest> & Record<string, unknown>;

function request(overrides: PartialRequest = {}): Record<string, unknown> {
  return {
    version: 1,
    requestId: 'test-request',
    mode: 'rows',
    ...overrides,
  };
}

async function seed(
  contents: Contents,
  entries: Array<Record<string, unknown>>,
): Promise<void> {
  for (const entry of entries) {
    const item = await contents.create(entry);
    await item.save();
  }
}

describe('content data-query schema (#2452)', () => {
  it('declares column-backed content fields with an id identity', async () => {
    const schema = await buildContentQuerySchema();
    const ids = schema.fields.map((entry) => entry.id);

    expect(schema.version).toBe(1);
    expect(schema.identityField).toBe('id');
    expect(ids).toEqual(
      expect.arrayContaining(['id', 'name', 'title', 'status']),
    );
    expect(schema.defaultSort).toEqual([
      { field: 'updated_at', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ]);
    expect(schema.maxPageLimit).toBe(CONTENT_QUERY_MAX_PAGE_LIMIT);
    expect(schema.supports).toEqual({
      cursorPagination: false,
      consistency: false,
      facets: true,
    });
  });

  it('never declares the tenant field, so no caller can name it', async () => {
    const schema = await buildContentQuerySchema();
    const ids = schema.fields.map((entry) => entry.id);

    expect(ids).not.toContain('tenantId');
    expect(ids).not.toContain('tenant_id');
  });

  it('excludes sensitive and readPermission-gated fields', async () => {
    const schema = await buildDataQuerySchemaForClass('ContentQueryProbe');
    const ids = schema.fields.map((entry) => entry.id);

    expect(ids).toContain('label');
    expect(ids).not.toContain('apiSecret');
    expect(ids).not.toContain('internalNote');
  });

  it('is memoized rather than rebuilt per request', async () => {
    const first = await buildContentQuerySchema();
    const second = await buildContentQuerySchema();

    expect(second).toBe(first);
  });

  it('keeps JSON fields unsortable, unfilterable, and unfacetable', async () => {
    const schema = await buildContentQuerySchema();
    const metadata = schema.fields.find((entry) => entry.id === 'metadata');

    expect(metadata).toMatchObject({
      type: 'json',
      projectable: true,
      sortable: false,
      facetable: false,
    });
    expect(metadata?.filterOperators).toBeUndefined();
  });
});

describe('mergeContentQueryScope', () => {
  it('returns undefined when there is neither scope nor filter', () => {
    expect(mergeContentQueryScope(undefined, undefined)).toBeUndefined();
  });

  it('ANDs every scope condition into every OR branch', () => {
    const merged = mergeContentQueryScope({ tenantId: null }, [
      [{ status: 'published' }],
      [{ status: 'review' }],
    ]);

    expect(merged).toEqual([
      [{ tenantId: null }, { status: 'published' }],
      [{ tenantId: null }, { status: 'review' }],
    ]);
  });

  it('rejects an unbounded OR branch', () => {
    expect(() =>
      mergeContentQueryScope(undefined, [[{ status: 'draft' }], []]),
    ).toThrow(/unbounded OR branch/);
  });

  it('refuses a scope condition that is not a plain object', () => {
    expect(() =>
      mergeContentQueryScope('status = published' as never, undefined),
    ).toThrow(/plain objects/);
  });
});

describe('executeContentQuery', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  const collectionOf = (value: unknown) => value as ContentQueryCollection;

  it('returns an empty, well-formed envelope for an empty collection', async () => {
    const result = await executeContentQuery(
      collectionOf(contents),
      request({ projection: ['title'] }),
    );

    expect(result.rows).toEqual([]);
    expect(result.total).toEqual({ kind: 'exact', value: 0 });
    expect(result.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: 50,
      hasMore: false,
    });
    expect(result.identityField).toBe('id');
    expect(result.queryFingerprint).toMatch(/^dq1_/);
    expect(result.freshness.state).toBe('fresh');
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('projects only the requested fields plus the identity field', async () => {
    await seed(contents, [{ name: 'alpha', title: 'Alpha', status: 'draft' }]);

    const result = await executeContentQuery(
      collectionOf(contents),
      request({ projection: ['title'] }),
    );

    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0]).sort()).toEqual(['id', 'title']);
    expect(result.rows[0].title).toBe('Alpha');
  });

  it('serializes datetime and JSON fields as JSON-safe values', async () => {
    await seed(contents, [
      {
        name: 'alpha',
        title: 'Alpha',
        publish_date: new Date('2026-01-02T03:04:05.000Z'),
        tags: ['news', 'local'],
        metadata: { section: 'front' },
      },
    ]);

    const result = await executeContentQuery(
      collectionOf(contents),
      request({ projection: ['publish_date', 'tags', 'metadata'] }),
    );

    expect(result.rows[0].publish_date).toBe('2026-01-02T03:04:05.000Z');
    expect(result.rows[0].tags).toEqual(['news', 'local']);
    expect(result.rows[0].metadata).toEqual({ section: 'front' });
  });

  it('counts without returning rows in count mode', async () => {
    await seed(contents, [
      { name: 'a', status: 'draft' },
      { name: 'b', status: 'published' },
      { name: 'c', status: 'published' },
    ]);

    const result = await executeContentQuery(
      collectionOf(contents),
      request({
        mode: 'count',
        filter: {
          kind: 'condition',
          field: 'status',
          operator: 'eq',
          value: 'published',
        },
      }),
    );

    expect(result.rows).toEqual([]);
    expect(result.page).toBeUndefined();
    expect(result.total).toEqual({ kind: 'exact', value: 2 });
  });

  it('returns bounded facets and reports conservative truncation', async () => {
    await seed(contents, [
      { name: 'a', status: 'draft' },
      { name: 'b', status: 'published' },
      { name: 'c', status: 'published' },
    ]);

    const full = await executeContentQuery(
      collectionOf(contents),
      request({ mode: 'facets', facets: [{ field: 'status', limit: 10 }] }),
    );
    expect(full.facets?.[0].field).toBe('status');
    expect(
      [...(full.facets?.[0].values ?? [])].sort((left, right) =>
        String(left.value).localeCompare(String(right.value)),
      ),
    ).toEqual([
      { value: 'draft', count: 1 },
      { value: 'published', count: 2 },
    ]);
    expect(full.facets?.[0].truncated).toBe(false);
    expect(full.total).toEqual({ kind: 'exact', value: 3 });

    const bounded = await executeContentQuery(
      collectionOf(contents),
      request({ mode: 'facets', facets: [{ field: 'status', limit: 1 }] }),
    );
    expect(bounded.facets?.[0].values).toHaveLength(1);
    expect(bounded.facets?.[0].truncated).toBe(true);
    expect(bounded.truncated).toBe(true);
  });

  it('clamps an oversized page limit to the schema maximum', async () => {
    const result = await executeContentQuery(
      collectionOf(contents),
      request({
        projection: ['title'],
        page: { kind: 'offset', offset: 0, limit: 5_000 },
      }),
    );

    expect(result.page).toMatchObject({ limit: CONTENT_QUERY_MAX_PAGE_LIMIT });
  });

  it('never declares the body field, which the envelope could not carry', async () => {
    const schema = await buildContentQuerySchema();

    expect(schema.fields.map((entry) => entry.id)).not.toContain('body');
    await expect(
      executeContentQuery(
        collectionOf(contents),
        request({ projection: ['body'] }),
      ),
    ).rejects.toThrow(/projection field is not allowed: body/);
  });

  it('shortens a value over the protocol scalar cap instead of failing', async () => {
    await seed(contents, [
      {
        name: 'long',
        description: 'd'.repeat(DATA_QUERY_MAX_STRING_LENGTH + 10),
      },
    ]);

    const result = await executeContentQuery(
      collectionOf(contents),
      request({ projection: ['description'] }),
    );

    expect(String(result.rows[0].description)).toHaveLength(
      DATA_QUERY_MAX_STRING_LENGTH,
    );
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/shortened over-long values/);
  });

  it('truncates a large result to the schema byte budget', async () => {
    const filler = 'x'.repeat(4_000);
    const rowCount = 100;
    await seed(
      contents,
      Array.from({ length: rowCount }, (_, index) => ({
        name: `bulk-${String(index).padStart(3, '0')}`,
        title: filler,
        description: filler,
        url: filler,
      })),
    );

    const result = await executeContentQuery(
      collectionOf(contents),
      request({
        projection: ['title', 'description', 'url'],
        sort: [{ field: 'name', direction: 'asc' }],
        page: { kind: 'offset', offset: 0, limit: rowCount },
      }),
    );

    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(rowCount);
    expect(result.page).toMatchObject({ hasMore: true });
    expect(result.warnings.join(' ')).toMatch(/maximum result bytes/);
    expect(result.total).toEqual({ kind: 'exact', value: rowCount });
  });

  it('pages deterministically across a tie-broken sort', async () => {
    await seed(contents, [
      { name: 'a', status: 'draft' },
      { name: 'b', status: 'draft' },
      { name: 'c', status: 'draft' },
      { name: 'd', status: 'published' },
      { name: 'e', status: 'published' },
    ]);
    const sort = [{ field: 'status', direction: 'asc' as const }];

    const everything = await executeContentQuery(
      collectionOf(contents),
      request({
        projection: ['name'],
        sort,
        page: { kind: 'offset', offset: 0, limit: 5 },
      }),
    );
    const paged: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = await executeContentQuery(
        collectionOf(contents),
        request({
          projection: ['name'],
          sort,
          page: { kind: 'offset', offset, limit: 2 },
        }),
      );
      paged.push(...page.rows.map((row) => String(row.name)));
      expect(page.page).toMatchObject({ offset, limit: 2 });
    }

    expect(paged).toEqual(everything.rows.map((row) => String(row.name)));
    expect(new Set(paged).size).toBe(paged.length);
  });

  it('documents that live offset paging is not a snapshot', async () => {
    // Offset paging reads the live table; `supports.consistency` is false and no
    // stability guarantee is offered ACROSS page reads. A row inserted between
    // two reads shifts the window, so a row already returned can reappear. What
    // IS guaranteed: ordering is deterministic within a read, and the total
    // reflects the state at that read.
    await seed(
      contents,
      ['c1', 'c2', 'c3', 'c4', 'c5'].map((name) => ({ name })),
    );
    const sort = [{ field: 'name', direction: 'asc' as const }];
    const page = (offset: number) =>
      executeContentQuery(
        collectionOf(contents),
        request({
          projection: ['name'],
          sort,
          page: { kind: 'offset', offset, limit: 2 },
        }),
      );

    const first = await page(0);
    expect(first.rows.map((row) => row.name)).toEqual(['c1', 'c2']);
    expect(first.total).toEqual({ kind: 'exact', value: 5 });

    await seed(contents, [{ name: 'c0' }]);

    const second = await page(2);
    expect(second.rows.map((row) => row.name)).toEqual(['c2', 'c3']);
    expect(second.total).toEqual({ kind: 'exact', value: 6 });
    // The documented consequence: 'c2' appears on both reads.
    expect(second.rows[0].name).toBe(first.rows[1].name);
  });

  it('applies an application scope that a caller filter cannot widen', async () => {
    await seed(contents, [
      { name: 'a', status: 'draft' },
      { name: 'b', status: 'published' },
      { name: 'c', status: 'published' },
    ]);

    const result = await executeContentQuery(
      collectionOf(contents),
      request({
        projection: ['name'],
        filter: {
          kind: 'any',
          filters: [
            {
              kind: 'condition',
              field: 'status',
              operator: 'eq',
              value: 'draft',
            },
            {
              kind: 'condition',
              field: 'status',
              operator: 'eq',
              value: 'published',
            },
          ],
        },
        page: { kind: 'offset', offset: 0, limit: 50 },
      }),
      { scope: { status: 'published' } },
    );

    expect(result.rows.map((row) => row.name).sort()).toEqual(['b', 'c']);
  });

  it('cannot be widened by a negated filter branch either', async () => {
    await seed(contents, [
      { name: 'a', status: 'draft' },
      { name: 'b', status: 'published' },
    ]);

    const result = await executeContentQuery(
      collectionOf(contents),
      request({
        projection: ['name'],
        filter: {
          kind: 'not',
          filter: {
            kind: 'condition',
            field: 'status',
            operator: 'eq',
            value: 'archived',
          },
        },
      }),
      { scope: { status: 'published' } },
    );

    expect(result.rows.map((row) => row.name)).toEqual(['b']);
  });
});

describe('executeContentQuery field policy', () => {
  let db: DatabaseInterface;
  let probes: ContentQueryProbeCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ContentQueryProbe'],
    });
    probes = await ContentQueryProbeCollection.create({ db });
    const probe = await probes.create({
      label: 'visible',
      apiSecret: 'super-secret',
      internalNote: 'internal',
    });
    await probe.save();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  /** A schema a buggy or malicious adapter might build: policy fields declared. */
  const forgedSchema: DataQuerySchema = {
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
        id: 'label',
        type: 'string',
        projectable: true,
        sortable: true,
        facetable: true,
        filterOperators: ['eq'],
      },
      {
        id: 'apiSecret',
        type: 'string',
        projectable: true,
        sortable: true,
        facetable: true,
        filterOperators: ['eq'],
      },
      {
        id: 'internalNote',
        type: 'string',
        projectable: true,
        sortable: true,
        facetable: true,
        filterOperators: ['eq'],
      },
    ],
    supports: { cursorPagination: false, consistency: false, facets: true },
  };

  it('layer 1: the schema rejects a projection of a policy field', async () => {
    const schema = await buildDataQuerySchemaForClass('ContentQueryProbe');

    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({ projection: ['apiSecret'] }),
        { schema },
      ),
    ).rejects.toThrow(/projection field is not allowed: apiSecret/);
    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({ projection: ['internalNote'] }),
        { schema },
      ),
    ).rejects.toThrow(/projection field is not allowed: internalNote/);
  });

  it('layer 1: the schema rejects sorting and filtering on a policy field', async () => {
    const schema = await buildDataQuerySchemaForClass('ContentQueryProbe');

    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({ sort: [{ field: 'apiSecret', direction: 'asc' }] }),
        { schema },
      ),
    ).rejects.toThrow(/sort field is not allowed: apiSecret/);
    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({
          filter: {
            kind: 'condition',
            field: 'internalNote',
            operator: 'eq',
            value: 'internal',
          },
        }),
        { schema },
      ),
    ).rejects.toThrow(/field is not declared: internalNote/);
  });

  it('layer 2: the collection still refuses a projection the schema wrongly allowed', async () => {
    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({ projection: ['apiSecret'] }),
        { schema: forgedSchema },
      ),
    ).rejects.toThrow(/sensitive/);

    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({ projection: ['internalNote'] }),
        { schema: forgedSchema },
      ),
    ).rejects.toThrow(/readPermission/);
  });

  it('layer 2: the collection still refuses a sort the schema wrongly allowed', async () => {
    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({
          projection: ['label'],
          sort: [{ field: 'apiSecret', direction: 'asc' }],
        }),
        { schema: forgedSchema },
      ),
    ).rejects.toThrow(/apiSecret/);
  });

  it('layer 2: the collection still refuses a filter the schema wrongly allowed', async () => {
    await expect(
      executeContentQuery(
        probes as unknown as ContentQueryCollection,
        request({
          projection: ['label'],
          filter: {
            kind: 'condition',
            field: 'apiSecret',
            operator: 'eq',
            value: 'super-secret',
          },
        }),
        { schema: forgedSchema },
      ),
    ).rejects.toThrow(/apiSecret/);
  });
});

describe('executeContentQuery tenant scoping', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
    // Tenancy must be on BEFORE seeding: the interceptor is what populates
    // `tenantId` on save, so rows created with it off are all global.
    enableTenancy();
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await contents.create({ name: 'tenant-1-content' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await contents.create({ name: 'tenant-2-content' })).save();
    });
    await withSystemContext(async () => {
      await (await contents.create({ name: 'global-content' })).save();
    });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  const names = (rows: Array<Record<string, unknown>>) =>
    rows.map((row) => String(row.name)).sort();

  it('fails closed to global rows when there is no tenant context', async () => {
    const result = await executeContentQuery(
      contents as unknown as ContentQueryCollection,
      request({ projection: ['name'] }),
    );

    expect(names(result.rows)).toEqual(['global-content']);
    expect(result.total).toEqual({ kind: 'exact', value: 1 });
  });

  it('scopes to the active tenant', async () => {
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      executeContentQuery(
        contents as unknown as ContentQueryCollection,
        request({ projection: ['name'] }),
      ),
    );

    expect(names(result.rows)).toEqual(['tenant-1-content']);
  });

  it('rejects a caller-supplied tenant filter instead of honoring it', async () => {
    for (const tenantField of ['tenantId', 'tenant_id']) {
      await expect(
        executeContentQuery(
          contents as unknown as ContentQueryCollection,
          request({
            projection: ['name'],
            filter: {
              kind: 'condition',
              field: tenantField,
              operator: 'eq',
              value: 'tenant-2',
            },
          }),
        ),
      ).rejects.toThrow(/is not declared/);
    }
  });

  it('cannot be widened past the tenant scope by any filter shape', async () => {
    const result = await withTenant({ tenantId: 'tenant-1' }, () =>
      executeContentQuery(
        contents as unknown as ContentQueryCollection,
        request({
          projection: ['name'],
          filter: {
            kind: 'any',
            filters: [
              {
                kind: 'condition',
                field: 'name',
                operator: 'eq',
                value: 'tenant-2-content',
              },
              {
                kind: 'condition',
                field: 'name',
                operator: 'eq',
                value: 'global-content',
              },
              {
                kind: 'not',
                filter: {
                  kind: 'condition',
                  field: 'name',
                  operator: 'eq',
                  value: 'nothing',
                },
              },
            ],
          },
        }),
      ),
    );

    expect(names(result.rows)).toEqual(['tenant-1-content']);
  });

  it('counts and facets are tenant-scoped too', async () => {
    const counted = await executeContentQuery(
      contents as unknown as ContentQueryCollection,
      request({ mode: 'count' }),
    );
    expect(counted.total).toEqual({ kind: 'exact', value: 1 });

    const faceted = await withTenant({ tenantId: 'tenant-2' }, () =>
      executeContentQuery(
        contents as unknown as ContentQueryCollection,
        request({ mode: 'facets', facets: [{ field: 'name', limit: 10 }] }),
      ),
    );
    expect(faceted.facets?.[0].values).toEqual([
      { value: 'tenant-2-content', count: 1 },
    ]);
  });
});

describe('Contents.queryAction', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('answers a request body with a normalized result envelope', async () => {
    await seed(contents, [{ name: 'a', title: 'A' }]);

    const result = await contents.queryAction(
      request({ projection: ['title'] }),
    );

    expect(result.version).toBe(1);
    expect(result.requestId).toBe('test-request');
    expect(result.rows).toEqual([{ id: expect.any(String), title: 'A' }]);
  });

  it('rejects a malformed request body with a typed 400-class error', async () => {
    await expect(contents.queryAction({ version: 2 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      contents.queryAction(request({ mode: 'sql' })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('POST /api/v1/contents/query (generated route)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    routeContents = await Contents.create({ db });
    await seed(routeContents, [{ name: 'a', title: 'A' }]);
  });

  afterEach(async () => {
    routeContents = undefined;
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  const call = (body: unknown) =>
    queryRoute({
      // The generated handler reads the raw body text, so the whole POST body
      // is the DataQueryRequest — no wrapper object.
      request: {
        url: new URL('http://localhost/api/v1/contents/query'),
        headers: new Headers(),
        text: async () => JSON.stringify(body),
      },
      locals: { smrtAuth: true },
    } as never) as Promise<Response>;

  it('returns { action, result } with the normalized envelope', async () => {
    const response = await call(request({ projection: ['title'] }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.action).toBe('queryAction');
    expect(payload.result).toMatchObject({
      version: 1,
      requestId: 'test-request',
      identityField: 'id',
      total: { kind: 'exact', value: 1 },
      truncated: false,
    });
    expect(payload.result.rows).toEqual([
      { id: expect.any(String), title: 'A' },
    ]);
    expect(payload.result.page).toMatchObject({
      kind: 'offset',
      hasMore: false,
    });
    expect(payload.result.queryFingerprint).toMatch(/^dq1_/);
  });

  it('answers a policy-rejected field with a typed 400 error body', async () => {
    const response = await call(request({ projection: ['tenantId'] }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatchObject({
      ok: false,
      status: 400,
      code: 'DATA_QUERY_PROJECTION_NOT_ALLOWED',
    });
  });
});
