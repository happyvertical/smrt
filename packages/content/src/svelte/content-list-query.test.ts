/**
 * ContentList → server query translation and transport (#2452).
 *
 * The column → server-field map is asserted against the *real*
 * `buildContentQuerySchema()`, so renaming a `Content` field breaks a test
 * here rather than a production query.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DataTableViewState } from '@happyvertical/smrt-ui/data';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentQuerySchema,
  type ContentQueryCollection,
  executeContentQuery,
} from '../content-query';
import { Contents } from '../contents';
import {
  buildContentListColumns,
  CONTENT_LIST_COLUMN_IDS,
  CONTENT_LIST_VISIBLE_COLUMN_IDS,
} from './content-list-controller';
import {
  CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
  CONTENT_LIST_QUERY_FIELDS,
  CONTENT_LIST_QUERY_IDENTITY_FIELD,
  CONTENT_LIST_QUERY_PROJECTION,
  CONTENT_LIST_QUERY_SEARCH_FIELDS,
  type ContentListDataQueryRequest,
  ContentListQueryError,
  type ContentListQueryFilter,
  contentFromContentListQueryRow,
  contentListQueryErrorMessage,
  contentListQueryRequestKey,
  contentListQueryRowsToContents,
  contentListQueryTotalValue,
  contentListViewStateToDataQueryRequest,
  createContentListQueryTransport,
  escapeContentListQueryLikeValue,
  readContentListQueryNotices,
} from './content-list-query';
import { CONTENT_LIST_MAX_PAGE_SIZE } from './content-list-url-state';

function viewState(
  overrides: Partial<DataTableViewState> = {},
): Partial<DataTableViewState> {
  return { search: '', filters: [], sorting: [], page: 1, ...overrides };
}

function translate(overrides: Partial<DataTableViewState> = {}) {
  return contentListViewStateToDataQueryRequest(viewState(overrides), {
    createRequestId: () => 'fixed-request',
  });
}

function conditions(
  filter: ContentListQueryFilter | undefined,
): Array<Extract<ContentListQueryFilter, { kind: 'condition' }>> {
  if (!filter) return [];
  if (filter.kind === 'condition') return [filter];
  if (filter.kind === 'not') return conditions(filter.filter);
  return filter.filters.flatMap((child) => conditions(child));
}

describe('the column to server-field map (H1)', () => {
  it('names only fields the content query schema declares', async () => {
    const schema = await buildContentQuerySchema();
    const declared = new Map(schema.fields.map((field) => [field.id, field]));

    for (const columnId of CONTENT_LIST_COLUMN_IDS) {
      const mapped = CONTENT_LIST_QUERY_FIELDS[columnId];
      if (mapped === null) continue;
      const descriptor = declared.get(mapped.field);
      expect(
        descriptor,
        `column ${columnId} maps to undeclared server field ${mapped.field}`,
      ).toBeDefined();
      expect(descriptor?.type).toBe(mapped.type);
    }
  });

  it('declares every adapter column, so a new column cannot be forgotten', () => {
    for (const columnId of CONTENT_LIST_COLUMN_IDS) {
      expect(Object.hasOwn(CONTENT_LIST_QUERY_FIELDS, columnId)).toBe(true);
    }
  });

  it('bridges the `updated` / `updatedAt` / `updated_at` namespaces', () => {
    expect(CONTENT_LIST_QUERY_FIELDS.updated?.field).toBe('updated_at');
    expect(CONTENT_LIST_QUERY_FIELDS.publish?.field).toBe('publish_date');
  });

  it('leaves the derived `site` column without a server field', () => {
    expect(CONTENT_LIST_QUERY_FIELDS.site).toBeNull();
    // `site` is still a published, locally sortable column.
    expect(CONTENT_LIST_VISIBLE_COLUMN_IDS).toContain('site');
  });

  it('projects only fields the schema declares as projectable', async () => {
    const schema = await buildContentQuerySchema();
    const declared = new Map(schema.fields.map((field) => [field.id, field]));
    for (const field of CONTENT_LIST_QUERY_PROJECTION) {
      expect(
        declared.get(field),
        `undeclared projection field ${field}`,
      ).toBeDefined();
      expect(declared.get(field)?.projectable).toBe(true);
    }
    expect(CONTENT_LIST_QUERY_PROJECTION).toContain(
      CONTENT_LIST_QUERY_IDENTITY_FIELD,
    );
    // `body` is deliberately unqueryable — a document, not list data.
    expect(CONTENT_LIST_QUERY_PROJECTION).not.toContain('body');
  });

  it('searches exactly the columns the adapter marks searchable', async () => {
    const searchableColumns = buildContentListColumns()
      .filter((column) => column.searchable !== false)
      .map((column) => CONTENT_LIST_QUERY_FIELDS[column.id]?.field)
      .filter((field): field is string => Boolean(field));
    expect([...CONTENT_LIST_QUERY_SEARCH_FIELDS].sort()).toEqual(
      searchableColumns.sort(),
    );

    const schema = await buildContentQuerySchema();
    const declared = new Map(schema.fields.map((field) => [field.id, field]));
    for (const field of CONTENT_LIST_QUERY_SEARCH_FIELDS) {
      // `like` is string-only in the normalizer; a datetime search field would
      // fail the whole request.
      expect(declared.get(field)?.type).toBe('string');
      expect(declared.get(field)?.filterOperators).toContain('like');
    }
  });

  it('only emits operators the schema declares for that field type', async () => {
    const schema = await buildContentQuerySchema();
    const declared = new Map(schema.fields.map((field) => [field.id, field]));
    const cases: Array<[string, string, unknown]> = [
      ['status', 'equals', 'published'],
      ['title', 'contains', 'budget'],
      ['updated', 'gte', '2026-02-01T00:00:00.000Z'],
      ['type', 'in', ['article', 'mirror']],
      ['publish', 'lt', '2026-02-01T00:00:00.000Z'],
    ];
    for (const [columnId, operator, value] of cases) {
      const { request, dropped } = translate({
        filters: [
          { columnId, operator: operator as never, value: value as never },
        ],
      });
      expect(dropped, `${columnId}.${operator} was dropped`).toEqual([]);
      const emitted = conditions(request.filter);
      expect(emitted).toHaveLength(1);
      expect(
        declared.get(emitted[0].field)?.filterOperators,
        `${emitted[0].field} does not declare ${emitted[0].operator}`,
      ).toContain(emitted[0].operator);
    }
  });
});

describe('translating filters', () => {
  it('maps the toolbar filters onto server fields', () => {
    const { request, dropped } = translate({
      filters: [
        { columnId: 'type', operator: 'equals', value: 'article' },
        { columnId: 'status', operator: 'equals', value: 'published' },
      ],
    });
    expect(dropped).toEqual([]);
    expect(conditions(request.filter)).toEqual([
      { kind: 'condition', field: 'type', operator: 'eq', value: 'article' },
      {
        kind: 'condition',
        field: 'status',
        operator: 'eq',
        value: 'published',
      },
    ]);
  });

  it('drops a filter on the derived `site` column and says why', () => {
    const { request, dropped } = translate({
      filters: [{ columnId: 'site', operator: 'equals', value: 'example.com' }],
    });
    expect(request.filter).toBeUndefined();
    expect(dropped).toEqual([
      { scope: 'filter', reason: 'no-server-field', columnId: 'site' },
    ]);
  });

  it('drops `notContains`, the one operator with no server expression', () => {
    const { request, dropped } = translate({
      filters: [{ columnId: 'title', operator: 'notContains', value: 'x' }],
    });
    expect(request.filter).toBeUndefined();
    expect(dropped).toEqual([
      {
        scope: 'filter',
        reason: 'unsupported-operator',
        columnId: 'title',
        detail: 'notContains',
      },
    ]);
  });

  it('maps the null predicates onto a null-valued eq/ne', () => {
    const isNull = translate({
      filters: [{ columnId: 'author', operator: 'isNull' }],
    });
    expect(isNull.dropped).toEqual([]);
    expect(conditions(isNull.request.filter)[0]).toEqual({
      kind: 'condition',
      field: 'author',
      operator: 'eq',
      value: null,
    });

    const isNotNull = translate({
      filters: [{ columnId: 'publish', operator: 'isNotNull' }],
    });
    expect(isNotNull.dropped).toEqual([]);
    expect(conditions(isNotNull.request.filter)[0]).toEqual({
      kind: 'condition',
      field: 'publish_date',
      operator: 'ne',
      value: null,
    });
  });

  it('drops a `contains` on a datetime column, which the server refuses', () => {
    const { request, dropped } = translate({
      filters: [{ columnId: 'updated', operator: 'contains', value: '2026' }],
    });
    expect(request.filter).toBeUndefined();
    expect(dropped[0]).toMatchObject({
      reason: 'unsupported-operator',
      columnId: 'updated',
    });
  });

  it('normalizes a datetime filter to an RFC 3339 instant', () => {
    const { request, dropped } = translate({
      filters: [{ columnId: 'publish', operator: 'gte', value: '2026-02-01' }],
    });
    expect(dropped).toEqual([]);
    expect(conditions(request.filter)[0]).toEqual({
      kind: 'condition',
      field: 'publish_date',
      operator: 'gte',
      value: '2026-02-01T00:00:00.000Z',
    });
  });

  it('drops an unparseable datetime rather than failing the whole query', () => {
    const { request, dropped } = translate({
      filters: [{ columnId: 'updated', operator: 'gte', value: 'yesterday' }],
    });
    expect(request.filter).toBeUndefined();
    expect(dropped[0]).toMatchObject({
      reason: 'unsupported-value',
      columnId: 'updated',
    });
  });

  it('drops an unknown column', () => {
    const { dropped } = translate({
      filters: [{ columnId: 'nope', operator: 'equals', value: 'x' }],
    });
    expect(dropped).toEqual([
      { scope: 'filter', reason: 'unknown-column', columnId: 'nope' },
    ]);
  });

  it('maps `in` to a de-duplicated non-empty value list', () => {
    const { request } = translate({
      filters: [
        {
          columnId: 'status',
          operator: 'in',
          value: ['draft', 'published', 'draft'],
        },
      ],
    });
    expect(conditions(request.filter)[0]).toEqual({
      kind: 'condition',
      field: 'status',
      operator: 'in',
      value: ['draft', 'published'],
    });
  });

  it('drops an `in` whose values are all unusable', () => {
    const { request, dropped } = translate({
      filters: [{ columnId: 'status', operator: 'in', value: [] }],
    });
    expect(request.filter).toBeUndefined();
    expect(dropped[0]).toMatchObject({ reason: 'unsupported-value' });
  });

  it('ANDs search with the declarative filters', () => {
    const { request } = translate({
      search: 'budget',
      filters: [{ columnId: 'status', operator: 'equals', value: 'published' }],
    });
    expect(request.filter?.kind).toBe('all');
    expect(conditions(request.filter).map((entry) => entry.field)).toEqual([
      'title',
      'description',
      'author',
      'status',
    ]);
  });
});

describe('translating search (H4)', () => {
  it('becomes an `any` of wildcard `like` predicates', () => {
    const { request } = translate({ search: '  budget  ' });
    expect(request.filter).toEqual({
      kind: 'any',
      filters: [
        {
          kind: 'condition',
          field: 'title',
          operator: 'like',
          value: '%budget%',
        },
        {
          kind: 'condition',
          field: 'description',
          operator: 'like',
          value: '%budget%',
        },
        {
          kind: 'condition',
          field: 'author',
          operator: 'like',
          value: '%budget%',
        },
      ],
    });
  });

  it('escapes a `%` so it is matched literally, not as a wildcard', () => {
    const { request } = translate({ search: '50% off' });
    for (const condition of conditions(request.filter)) {
      expect(condition.value).toBe('%50\\% off%');
    }
  });

  it('escapes `_` and the escape character itself', () => {
    expect(escapeContentListQueryLikeValue('a_b')).toBe('a\\_b');
    expect(escapeContentListQueryLikeValue('a\\b')).toBe('a\\\\b');
    expect(escapeContentListQueryLikeValue('100%')).toBe('100\\%');
  });

  it('escapes the pattern operators too', () => {
    const { request } = translate({
      filters: [{ columnId: 'title', operator: 'startsWith', value: '%draft' }],
    });
    expect(conditions(request.filter)[0].value).toBe('\\%draft%');
  });

  it('omits the filter entirely for a blank search', () => {
    expect(translate({ search: '   ' }).request.filter).toBeUndefined();
  });
});

describe('translating sorting', () => {
  it('appends a deterministic id tie-break', () => {
    const { request } = translate({
      sorting: [{ columnId: 'title', direction: 'asc' }],
    });
    expect(request.sort).toEqual([
      { field: 'title', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('drops a sort on the derived `site` column', () => {
    const { request, dropped } = translate({
      sorting: [
        { columnId: 'site', direction: 'asc' },
        { columnId: 'updated', direction: 'desc' },
      ],
    });
    expect(request.sort).toEqual([
      { field: 'updated_at', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ]);
    expect(dropped).toContainEqual({
      scope: 'sorting',
      reason: 'no-server-field',
      columnId: 'site',
    });
  });

  it('omits `sort` when nothing is sortable, so the schema default applies', () => {
    const { request } = translate({
      sorting: [{ columnId: 'site', direction: 'asc' }],
    });
    expect(request.sort).toBeUndefined();
  });
});

describe('translating paging (H5)', () => {
  it('uses an offset page derived from page and page size', () => {
    const { request } = translate({ page: 3, pageSize: 25 });
    expect(request.page).toEqual({ kind: 'offset', offset: 50, limit: 25 });
  });

  it('falls back to the shared default page size when there is none', () => {
    const { request } = translate({ page: 1, pageSize: null });
    expect(request.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
    });
  });

  it('clamps a restored page size above the surface ceiling and reports it', () => {
    const { request, dropped } = translate({ page: 1, pageSize: 10_000 });
    expect(request.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: CONTENT_LIST_MAX_PAGE_SIZE,
    });
    expect(dropped).toContainEqual({
      scope: 'pageSize',
      reason: 'out-of-range',
      detail: '10000',
    });
  });

  it('clamps an offset beyond the protocol maximum', () => {
    const { request, dropped } = translate({ page: 10_000_000, pageSize: 50 });
    const page = request.page as { offset: number; limit: number };
    expect(page.offset).toBeLessThanOrEqual(1_000_000);
    expect(dropped).toContainEqual({
      scope: 'page',
      reason: 'out-of-range',
      detail: '10000000',
    });
  });
});

describe('request identity', () => {
  it('emits a request id and excludes it from the semantic key', () => {
    const first = contentListViewStateToDataQueryRequest(viewState());
    const second = contentListViewStateToDataQueryRequest(viewState());
    expect(first.request.requestId).not.toBe(second.request.requestId);
    expect(contentListQueryRequestKey(first.request)).toBe(
      contentListQueryRequestKey(second.request),
    );
  });

  it('changes the semantic key when the query changes', () => {
    const base = contentListQueryRequestKey(translate().request);
    const searched = contentListQueryRequestKey(
      translate({ search: 'budget' }).request,
    );
    expect(searched).not.toBe(base);
  });
});

describe('mapping result rows onto ContentData', () => {
  it('renames the server fields the client shape spells differently', () => {
    const content = contentFromContentListQueryRow({
      id: 'content-1',
      title: 'Budget',
      updated_at: '2026-02-01T10:00:00.000Z',
      created_at: '2026-01-01T10:00:00.000Z',
      publish_date: '2026-01-15T10:00:00.000Z',
    });
    expect(content).toEqual({
      id: 'content-1',
      title: 'Budget',
      updatedAt: '2026-02-01T10:00:00.000Z',
      createdAt: '2026-01-01T10:00:00.000Z',
      publish_date: '2026-01-15T10:00:00.000Z',
    });
  });

  it('omits null and unknown fields rather than inventing values', () => {
    const content = contentFromContentListQueryRow({
      id: 'content-1',
      author: null,
      tenantId: 'tenant-1',
    });
    expect(content).toEqual({ id: 'content-1' });
  });

  it('preserves server order across a page', () => {
    const contents = contentListQueryRowsToContents([
      { id: 'b' },
      { id: 'a' },
      { id: 'c' },
    ]);
    expect(contents.map((content) => content.id)).toEqual(['b', 'a', 'c']);
  });

  it('reads a total, and reports an unavailable one as undefined', () => {
    expect(contentListQueryTotalValue({ kind: 'exact', value: 42 })).toBe(42);
    expect(contentListQueryTotalValue({ kind: 'unavailable' })).toBeUndefined();
    expect(contentListQueryTotalValue(undefined)).toBeUndefined();
  });
});

describe('the fetch transport', () => {
  const request: ContentListDataQueryRequest = {
    version: 1,
    requestId: 'r1',
    mode: 'rows',
    page: { kind: 'offset', offset: 0, limit: 10 },
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('unwraps the generated { action, result } envelope', async () => {
    const result = { version: 1, requestId: 'r1', rows: [{ id: 'a' }] };
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ action: 'queryAction', result }),
    );
    const transport = createContentListQueryTransport({
      apiBaseUrl: '/api/v1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    await expect(transport.query(request)).resolves.toEqual(result);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/contents/query');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it('accepts a bare envelope from a host gateway', async () => {
    const transport = createContentListQueryTransport({
      fetch: (async () =>
        jsonResponse({ version: 1, requestId: 'r1', rows: [] })) as never,
    });
    await expect(transport.query(request)).resolves.toMatchObject({
      version: 1,
    });
  });

  it('throws a coded error for the refusal envelope', async () => {
    const transport = createContentListQueryTransport({
      fetch: (async () =>
        jsonResponse(
          {
            error: {
              ok: false,
              status: 400,
              code: 'DATA_QUERY_FILTER_NOT_ALLOWED',
              message: 'Content query filter field is not declared: secret',
            },
          },
          400,
        )) as never,
    });
    await expect(transport.query(request)).rejects.toMatchObject({
      name: 'ContentListQueryError',
      code: 'DATA_QUERY_FILTER_NOT_ALLOWED',
      status: 400,
      message: 'Content query filter field is not declared: secret',
    });
  });

  it('does not swallow an HTTP failure without an envelope', async () => {
    const transport = createContentListQueryTransport({
      fetch: (async () =>
        new Response('<html>gateway</html>', { status: 502 })) as never,
    });
    await expect(transport.query(request)).rejects.toMatchObject({
      code: 'CONTENT_QUERY_HTTP_ERROR',
      status: 502,
    });
  });

  it('does not swallow a 200 with a non-JSON body', async () => {
    const transport = createContentListQueryTransport({
      fetch: (async () => new Response('not json', { status: 200 })) as never,
    });
    await expect(transport.query(request)).rejects.toMatchObject({
      code: 'CONTENT_QUERY_INVALID_RESPONSE',
    });
  });

  it('forwards the abort signal and propagates the abort untouched', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    });
    const transport = createContentListQueryTransport({
      fetch: fetchImpl as never,
    });
    controller.abort();
    await expect(
      transport.query(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves caller headers per request', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ action: 'queryAction', result: { rows: [] } }),
    );
    const transport = createContentListQueryTransport({
      fetch: fetchImpl as never,
      headers: () => ({ 'x-tenant': 'acme' }),
    });
    await transport.query(request);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('x-tenant')).toBe('acme');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('refuses to build where there is no fetch at all', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => createContentListQueryTransport()).toThrow(TypeError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('error messages', () => {
  it('appends the server code to a coded failure', () => {
    expect(
      contentListQueryErrorMessage(
        new ContentListQueryError('Refused', {
          code: 'DATA_QUERY_UNSUPPORTED',
        }),
      ),
    ).toBe('Refused (DATA_QUERY_UNSUPPORTED)');
  });

  it('passes a plain error through and reports no error as null', () => {
    expect(contentListQueryErrorMessage(new Error('boom'))).toBe('boom');
    expect(contentListQueryErrorMessage(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review batch #2452: caps, null predicates, and the completeness flags
// ---------------------------------------------------------------------------

describe('translating the null predicates end to end', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
    for (const entry of [
      {
        name: 'with-author',
        title: 'With author',
        author: 'Ada Lovelace',
        publish_date: new Date('2026-02-01T00:00:00.000Z'),
      },
      { name: 'no-author', title: 'No author', author: null },
    ]) {
      const item = await contents.create(entry);
      await item.save();
    }
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  const run = (state: Partial<DataTableViewState>) =>
    executeContentQuery(
      contents as unknown as ContentQueryCollection,
      contentListViewStateToDataQueryRequest(viewState(state), {
        createRequestId: () => 'null-predicate-request',
        projection: ['id', 'title', 'author'],
      }).request,
    );

  it('resolves `isNull` to IS NULL through the collection', async () => {
    const result = await run({
      filters: [{ columnId: 'author', operator: 'isNull' }],
    });
    expect(result.rows.map((row) => row.title)).toEqual(['No author']);
  });

  it('resolves `isNotNull` to IS NOT NULL, not a NULL comparison', async () => {
    const result = await run({
      filters: [{ columnId: 'author', operator: 'isNotNull' }],
    });
    expect(result.rows.map((row) => row.title)).toEqual(['With author']);
  });

  it('works for a datetime column too', async () => {
    const missing = await run({
      filters: [{ columnId: 'publish', operator: 'isNull' }],
    });
    expect(missing.rows.map((row) => row.title)).toEqual(['No author']);

    const present = await run({
      filters: [{ columnId: 'publish', operator: 'isNotNull' }],
    });
    expect(present.rows.map((row) => row.title)).toEqual(['With author']);
  });
});

describe('client-side caps mirroring the server limits', () => {
  it('caps an `in` list at the protocol maximum and reports it', () => {
    const values = Array.from({ length: 150 }, (_, index) => `v${index}`);
    const { request, dropped } = translate({
      filters: [{ columnId: 'status', operator: 'in', value: values }],
    });
    const condition = conditions(request.filter)[0];
    expect((condition.value as string[]).length).toBe(100);
    expect(dropped).toContainEqual({
      scope: 'filter',
      reason: 'out-of-range',
      columnId: 'status',
      detail: '150',
    });
  });

  it('caps the total filter-node count so the request is never refused', () => {
    const filters = Array.from({ length: 60 }, () => ({
      columnId: 'title' as const,
      operator: 'equals' as const,
      value: 'x',
    }));
    const { request, dropped } = translate({ search: 'budget', filters });

    // search = `any` + 3 conditions = 4 nodes, plus the outer `all` = 5.
    expect(conditions(request.filter).length).toBe(3 + 45);
    expect(
      dropped.filter((drop) => drop.reason === 'out-of-range'),
    ).toHaveLength(15);
  });

  it('trims an over-long search so it stays inside the scalar cap', () => {
    const { request, dropped } = translate({ search: 'a'.repeat(5_000) });
    for (const condition of conditions(request.filter)) {
      expect((condition.value as string).length).toBeLessThanOrEqual(4_096);
    }
    expect(dropped).toContainEqual({
      scope: 'search',
      reason: 'out-of-range',
      detail: '5000',
    });
  });

  it('accounts for escaping when trimming, so escaped output still fits', () => {
    const { request } = translate({ search: '%'.repeat(5_000) });
    for (const condition of conditions(request.filter)) {
      expect((condition.value as string).length).toBeLessThanOrEqual(4_096);
    }
  });

  it('trims an over-long filter value', () => {
    const { request, dropped } = translate({
      filters: [
        { columnId: 'status', operator: 'equals', value: 'b'.repeat(9_000) },
      ],
    });
    expect((conditions(request.filter)[0].value as string).length).toBe(4_096);
    expect(dropped).toContainEqual({
      scope: 'filter',
      reason: 'out-of-range',
      columnId: 'status',
      detail: 'equals',
    });
  });
});

describe('an unpaginated view state in server mode', () => {
  it('coerces null to the default page size and reports it', () => {
    const { request, dropped } = contentListViewStateToDataQueryRequest(
      viewState({ pageSize: null }),
      { createRequestId: () => 'fixed', defaultPageSize: 25 },
    );
    expect(request.page).toEqual({ kind: 'offset', offset: 0, limit: 25 });
    expect(dropped).toContainEqual({
      scope: 'pageSize',
      reason: 'unpaginated-unsupported',
    });
  });

  it('reports nothing when the state simply carries no page size', () => {
    const { dropped } = contentListViewStateToDataQueryRequest(
      { search: '', filters: [], sorting: [], page: 1 },
      { createRequestId: () => 'fixed' },
    );
    expect(dropped).toEqual([]);
  });
});

describe('reading the completeness flags off a result', () => {
  it('reads truncated and warnings', () => {
    expect(
      readContentListQueryNotices({
        truncated: true,
        warnings: ['Content query result was truncated', 42],
      }),
    ).toEqual({
      truncated: true,
      warnings: ['Content query result was truncated'],
    });
  });

  it('defaults defensively for a non-envelope value', () => {
    expect(readContentListQueryNotices(null)).toEqual({
      truncated: false,
      warnings: [],
    });
    expect(readContentListQueryNotices('nope')).toEqual({
      truncated: false,
      warnings: [],
    });
  });
});
