/**
 * ContentList → server query translation and transport (#2452).
 *
 * The column → server-field map is asserted against the *real*
 * `buildContentQuerySchema()`, so renaming a `Content` field breaks a test
 * here rather than a production query.
 */

import {
  getTestDatabase,
  MAX_DATA_QUERY_FILTERS,
  MAX_DATA_QUERY_IN_VALUES,
  MAX_DATA_QUERY_OFFSET,
  MAX_DATA_QUERY_REQUEST_BYTES,
  normalizeDataQueryRequest,
} from '@happyvertical/smrt-core';
import type {
  DataTableFilter,
  DataTableViewState,
} from '@happyvertical/smrt-ui/data';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentQuerySchema,
  type ContentQueryCollection,
  executeContentQuery,
  MAX_CONTENT_QUERY_OR_BRANCHES,
} from '../content-query';
import { Contents } from '../contents';
import {
  buildContentListColumns,
  CONTENT_LIST_COLUMN_IDS,
  CONTENT_LIST_VISIBLE_COLUMN_IDS,
  createContentListController,
  selectContentListRows,
  toContentListRows,
} from './content-list-controller';
import {
  CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
  CONTENT_LIST_QUERY_DEFAULT_SORT,
  CONTENT_LIST_QUERY_FIELDS,
  CONTENT_LIST_QUERY_IDENTITY_FIELD,
  CONTENT_LIST_QUERY_MAX_FIELD_ID_LENGTH,
  CONTENT_LIST_QUERY_MAX_FILTER_NODES,
  CONTENT_LIST_QUERY_MAX_IN_VALUES,
  CONTENT_LIST_QUERY_MAX_OFFSET,
  CONTENT_LIST_QUERY_MAX_OR_BRANCHES,
  CONTENT_LIST_QUERY_MAX_PROJECTION_FIELDS,
  CONTENT_LIST_QUERY_MAX_REQUEST_BYTES,
  CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH,
  CONTENT_LIST_QUERY_MAX_VALUE_LENGTH,
  CONTENT_LIST_QUERY_PROJECTABLE_FIELDS,
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
  resolveContentListMaxPageSize,
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

  it('emits the schema default explicitly when nothing is sortable', () => {
    // Explicit rather than omitted: the normalizer injects `defaultSort` when
    // the key is absent and then measures the NORMALIZED request against the
    // byte limit, so omitting it makes the client under-measure by 84 bytes.
    const { request } = translate({
      sorting: [{ columnId: 'site', direction: 'asc' }],
    });
    expect(request.sort).toEqual([...CONTENT_LIST_QUERY_DEFAULT_SORT]);
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

// ---------------------------------------------------------------------------
// Review batch 2 (#2452)
// ---------------------------------------------------------------------------

describe('bounding a value in the unit the server measures (finding 1)', () => {
  /** Exactly what `dataQueryScalar` tests: UTF-16 code units. */
  const serverLength = (value: string) => value.length;

  it('counts an astral character as TWO, the way core does', () => {
    // 4093 ASCII + one emoji: 4094 code points, 4095 UTF-16 units. Adding the
    // two wildcards lands on 4097 server-side unless the emoji costs two.
    const { request } = translate({ search: `${'x'.repeat(4093)}😀` });
    for (const condition of conditions(request.filter)) {
      expect(serverLength(condition.value as string)).toBeLessThanOrEqual(
        4_096,
      );
    }
  });

  it('bounds a value that is entirely astral characters', () => {
    const { request, dropped } = translate({ search: '😀'.repeat(4_094) });
    for (const condition of conditions(request.filter)) {
      expect(serverLength(condition.value as string)).toBeLessThanOrEqual(
        4_096,
      );
    }
    expect(dropped).toContainEqual(
      expect.objectContaining({ scope: 'search', reason: 'out-of-range' }),
    );
  });

  it('never splits a surrogate pair', () => {
    const { request } = translate({ search: '😀'.repeat(4_094) });
    const value = conditions(request.filter)[0].value as string;
    // A lone surrogate would survive a round trip through JSON as U+FFFD.
    expect(JSON.parse(JSON.stringify(value))).toBe(value);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(value)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)).toBe(false);
  });

  it('still lands exactly on the cap for pure ASCII and metacharacters', () => {
    const ascii = translate({ search: 'a'.repeat(9_000) });
    expect(
      serverLength(conditions(ascii.request.filter)[0].value as string),
    ).toBe(4_096);
    const meta = translate({ search: '%'.repeat(9_000) });
    expect(
      serverLength(conditions(meta.request.filter)[0].value as string),
    ).toBe(4_096);
  });

  it('agrees with the scalar bounder on an astral filter value', () => {
    const { request } = translate({
      filters: [
        { columnId: 'status', operator: 'equals', value: '😀'.repeat(9_000) },
      ],
    });
    expect(
      serverLength(conditions(request.filter)[0].value as string),
    ).toBeLessThanOrEqual(4_096);
  });
});

describe('one resolved page-size ceiling (findings 3, 4, 5)', () => {
  it('takes the narrowest configured limit, never the loosest', () => {
    expect(resolveContentListMaxPageSize(200, 25)).toBe(25);
    expect(resolveContentListMaxPageSize(25, 200)).toBe(25);
    expect(resolveContentListMaxPageSize(undefined, 25)).toBe(25);
    expect(resolveContentListMaxPageSize(25, undefined)).toBe(25);
  });

  it('can never exceed the schema limit, whatever a host asks for', () => {
    expect(resolveContentListMaxPageSize(10_000, 5_000)).toBe(
      CONTENT_LIST_MAX_PAGE_SIZE,
    );
    expect(resolveContentListMaxPageSize()).toBe(CONTENT_LIST_MAX_PAGE_SIZE);
  });

  it('ignores nonsense candidates rather than collapsing to them', () => {
    expect(resolveContentListMaxPageSize(0, Number.NaN, -5)).toBe(
      CONTENT_LIST_MAX_PAGE_SIZE,
    );
  });

  it('clamps a default page size above the ceiling', () => {
    const { request } = contentListViewStateToDataQueryRequest(viewState(), {
      createRequestId: () => 'fixed',
      defaultPageSize: 201,
    });
    expect(request.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: CONTENT_LIST_MAX_PAGE_SIZE,
    });
  });
});

describe('the effective page when an offset is capped (finding 7)', () => {
  it('reports the page the request actually reads', () => {
    const { request, effectivePage } = contentListViewStateToDataQueryRequest(
      viewState({ page: 10_000, pageSize: 200 }),
      { createRequestId: () => 'fixed' },
    );
    const page = request.page as { offset: number; limit: number };
    expect(page.offset).toBeLessThanOrEqual(1_000_000);
    expect(effectivePage).toBe(page.offset / page.limit + 1);
    expect(effectivePage).toBeLessThan(10_000);
  });

  it('reports the requested page unchanged when nothing was capped', () => {
    const { effectivePage } = contentListViewStateToDataQueryRequest(
      viewState({ page: 3, pageSize: 25 }),
      { createRequestId: () => 'fixed' },
    );
    expect(effectivePage).toBe(3);
  });
});

describe('validity rules beyond the numeric caps (Shape B sweep)', () => {
  it('drops a date outside the RFC 3339 four-digit year range', () => {
    // `new Date('+275760-09-13')` parses and `toISOString()` round-trips, but
    // the server's instant pattern refuses the expanded-year form.
    const { request, dropped } = translate({
      filters: [
        { columnId: 'updated', operator: 'gte', value: '+275760-09-13' },
      ],
    });
    expect(request.filter).toBeUndefined();
    expect(dropped[0]).toMatchObject({
      reason: 'unsupported-value',
      columnId: 'updated',
    });
  });

  it('drops a negative-year date for the same reason', () => {
    const { dropped } = translate({
      filters: [
        { columnId: 'publish', operator: 'lt', value: '-000001-01-01' },
      ],
    });
    expect(dropped[0]).toMatchObject({ reason: 'unsupported-value' });
  });

  it('keeps the whole request inside the request byte budget', () => {
    // 100 values of 4096 characters is inside every per-value cap and five
    // times the request limit.
    const values = Array.from({ length: 100 }, (_, index) =>
      `${index}`.padEnd(4_000, 'v'),
    );
    const { request, dropped } = translate({
      filters: [
        { columnId: 'status', operator: 'in', value: values },
        { columnId: 'author', operator: 'in', value: values },
        { columnId: 'title', operator: 'in', value: values },
      ],
    });
    expect(
      new TextEncoder().encode(JSON.stringify(request)).byteLength,
    ).toBeLessThanOrEqual(CONTENT_LIST_QUERY_MAX_REQUEST_BYTES);
    expect(
      dropped.some(
        (drop) =>
          drop.reason === 'out-of-range' &&
          drop.detail === String(CONTENT_LIST_QUERY_MAX_REQUEST_BYTES),
      ),
    ).toBe(true);
  });

  it('bounds a caller-supplied request id to the normalizer rule', () => {
    const long = contentListViewStateToDataQueryRequest(viewState(), {
      createRequestId: () => 'r'.repeat(500),
    });
    expect(long.request.requestId.length).toBe(128);

    const empty = contentListViewStateToDataQueryRequest(viewState(), {
      createRequestId: () => '',
    });
    expect(empty.request.requestId.length).toBeGreaterThan(0);
    expect(empty.request.requestId.length).toBeLessThanOrEqual(128);
  });

  it('drops a projection field the schema does not declare projectable', async () => {
    const schema = await buildContentQuerySchema();
    const projectable = new Set(
      schema.fields.filter((field) => field.projectable).map((f) => f.id),
    );

    const { request, dropped } = contentListViewStateToDataQueryRequest(
      viewState(),
      {
        createRequestId: () => 'fixed',
        // A typo, a withheld document field, and the tenant field the schema
        // never declares — each a 400 for the whole list if it were sent.
        projection: ['titel', 'body', 'tenantId', 'title'],
      },
    );

    expect(request.projection).toEqual(['id', 'title']);
    for (const field of request.projection ?? []) {
      expect(projectable.has(field)).toBe(true);
    }
    expect(
      dropped.filter((drop) => drop.reason === 'unsupported-value'),
    ).toHaveLength(3);
  });

  it('drops a projection entry that is not a usable field id', () => {
    const { request, dropped } = contentListViewStateToDataQueryRequest(
      viewState(),
      {
        createRequestId: () => 'fixed',
        projection: ['', 'x'.repeat(300), 'title'],
      },
    );
    expect(request.projection).toEqual(['id', 'title']);
    expect(
      dropped.filter((drop) => drop.reason === 'unsupported-value'),
    ).toHaveLength(2);
  });

  it('de-duplicates and always projects the identity field', () => {
    const deduped = contentListViewStateToDataQueryRequest(viewState(), {
      createRequestId: () => 'fixed',
      projection: ['title', 'title'],
    });
    expect(deduped.request.projection).toEqual(['id', 'title']);
  });

  it('caps the projection count at the normalizer limit', async () => {
    const schema = await buildContentQuerySchema();
    const projectable = schema.fields
      .filter((field) => field.projectable)
      .map((field) => field.id);
    // Every declared field, so the cap is exercised with REAL ids only.
    const { request } = contentListViewStateToDataQueryRequest(viewState(), {
      createRequestId: () => 'fixed',
      projection: projectable,
    });
    expect(request.projection?.length).toBe(
      Math.min(projectable.length, CONTENT_LIST_QUERY_MAX_PROJECTION_FIELDS),
    );
  });
});

describe('the bounded request survives the real normalizer', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
    const item = await contents.create({ name: 'a', title: 'A' });
    await item.save();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  const execute = (state: Partial<DataTableViewState>) =>
    executeContentQuery(
      contents as unknown as ContentQueryCollection,
      contentListViewStateToDataQueryRequest(viewState(state), {
        createRequestId: () => 'bounded-request',
        projection: ['id', 'title'],
      }).request,
    );

  it('accepts a search of 4093 characters plus one emoji', async () => {
    // Reproduces the reported 400: this is 4095 UTF-16 units before wildcards.
    await expect(
      execute({ search: `${'x'.repeat(4093)}😀` }),
    ).resolves.toBeDefined();
  });

  it('accepts an all-astral search', async () => {
    await expect(
      execute({ search: '😀'.repeat(4_094) }),
    ).resolves.toBeDefined();
  });

  it('accepts a filter list far past every per-value cap', async () => {
    const values = Array.from({ length: 400 }, (_, index) =>
      `${index}`.padEnd(5_000, 'v'),
    );
    await expect(
      execute({
        search: '😀'.repeat(3_000),
        filters: [
          { columnId: 'status', operator: 'in', value: values },
          { columnId: 'author', operator: 'in', value: values },
        ],
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Review batch 3: every mirrored constant is self-enforcing (#2452 finding 5)
// ---------------------------------------------------------------------------

/**
 * The client mirrors numbers that live in the schema and in
 * `@happyvertical/smrt-core`. A hand-copied number that silently drifts is the
 * defect class this whole issue has been chasing: lowering the server's page
 * limit while the client keeps seeding and paging by the old one strands rows
 * with every existing test still green.
 *
 * Each assertion below binds one mirrored constant to its source. Where core
 * exports the constant, the assertion is direct; where it does not, the
 * assertion is against core's observable BEHAVIOUR (the largest value it
 * accepts, and the smallest it refuses) rather than being skipped.
 */
describe('mirrored constants are pinned to their source', () => {
  const schemaFor = () => buildContentQuerySchema();

  it('CONTENT_LIST_MAX_PAGE_SIZE === schema.maxPageLimit', async () => {
    expect(CONTENT_LIST_MAX_PAGE_SIZE).toBe((await schemaFor()).maxPageLimit);
  });

  it('CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE === schema.defaultPageLimit', async () => {
    expect(CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE).toBe(
      (await schemaFor()).defaultPageLimit,
    );
  });

  it('CONTENT_LIST_QUERY_IDENTITY_FIELD === schema.identityField', async () => {
    expect(CONTENT_LIST_QUERY_IDENTITY_FIELD).toBe(
      (await schemaFor()).identityField,
    );
  });

  it('CONTENT_LIST_QUERY_DEFAULT_SORT === schema.defaultSort', async () => {
    expect([...CONTENT_LIST_QUERY_DEFAULT_SORT]).toEqual(
      (await schemaFor()).defaultSort,
    );
  });

  it('CONTENT_LIST_QUERY_PROJECTABLE_FIELDS === the schema projectable ids', async () => {
    const schema = await schemaFor();
    expect([...CONTENT_LIST_QUERY_PROJECTABLE_FIELDS].sort()).toEqual(
      schema.fields
        .filter((field) => field.projectable)
        .map((field) => field.id)
        .sort(),
    );
  });

  it('the offset, filter, in-value and request-byte caps === core', () => {
    expect(CONTENT_LIST_QUERY_MAX_OFFSET).toBe(MAX_DATA_QUERY_OFFSET);
    expect(CONTENT_LIST_QUERY_MAX_FILTER_NODES).toBe(MAX_DATA_QUERY_FILTERS);
    expect(CONTENT_LIST_QUERY_MAX_PROJECTION_FIELDS).toBe(
      MAX_DATA_QUERY_FILTERS,
    );
    expect(CONTENT_LIST_QUERY_MAX_IN_VALUES).toBe(MAX_DATA_QUERY_IN_VALUES);
    expect(CONTENT_LIST_QUERY_MAX_REQUEST_BYTES).toBe(
      MAX_DATA_QUERY_REQUEST_BYTES,
    );
  });

  // The remaining limits are literals inside core with no export, so they are
  // pinned to what core actually accepts and refuses.
  describe('constants core does not export, pinned to its behaviour', () => {
    let schema: Awaited<ReturnType<typeof buildContentQuerySchema>>;

    beforeEach(async () => {
      schema = await buildContentQuerySchema();
    });

    const withFilterValue = (value: string) => ({
      version: 1 as const,
      requestId: 'pin',
      mode: 'rows' as const,
      filter: {
        kind: 'condition' as const,
        field: 'title',
        operator: 'eq' as const,
        value,
      },
    });

    it('CONTENT_LIST_QUERY_MAX_VALUE_LENGTH is the largest scalar core takes', () => {
      const atCap = 'a'.repeat(CONTENT_LIST_QUERY_MAX_VALUE_LENGTH);
      expect(() =>
        normalizeDataQueryRequest(withFilterValue(atCap), schema),
      ).not.toThrow();
      expect(() =>
        normalizeDataQueryRequest(withFilterValue(`${atCap}a`), schema),
      ).toThrow();
    });

    it('CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH is the largest id core takes', () => {
      const request = (length: number) => ({
        version: 1 as const,
        requestId: 'r'.repeat(length),
        mode: 'count' as const,
      });
      expect(() =>
        normalizeDataQueryRequest(
          request(CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH),
          schema,
        ),
      ).not.toThrow();
      expect(() =>
        normalizeDataQueryRequest(
          request(CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH + 1),
          schema,
        ),
      ).toThrow();
    });

    it('CONTENT_LIST_QUERY_MAX_FIELD_ID_LENGTH is the largest field id core takes', () => {
      // A field id at the cap is refused for being undeclared, not for its
      // length; one over the cap is refused for its length. The two error
      // messages distinguish the rules.
      const project = (length: number) => ({
        version: 1 as const,
        requestId: 'pin',
        mode: 'rows' as const,
        projection: ['f'.repeat(length)],
      });
      expect(() =>
        normalizeDataQueryRequest(
          project(CONTENT_LIST_QUERY_MAX_FIELD_ID_LENGTH),
          schema,
        ),
      ).toThrow(/projection field is not allowed/);
      expect(() =>
        normalizeDataQueryRequest(
          project(CONTENT_LIST_QUERY_MAX_FIELD_ID_LENGTH + 1),
          schema,
        ),
      ).toThrow(/must be a non-empty string up to/);
    });

    it('the client byte bound is never smaller than core\u2019s, with or without a sort', () => {
      // The default view carries no sorting at all: the case where the
      // normalizer used to inject 84 bytes the client had not counted.
      for (const state of [
        viewState(),
        viewState({ sorting: [{ columnId: 'title', direction: 'asc' }] }),
        viewState({ search: 'budget', page: 4, pageSize: 25 }),
      ]) {
        const { request } = contentListViewStateToDataQueryRequest(state, {
          createRequestId: () => 'byte-parity',
        });
        const clientBytes = new TextEncoder().encode(
          JSON.stringify(request),
        ).byteLength;
        const normalizedBytes = new TextEncoder().encode(
          JSON.stringify(normalizeDataQueryRequest(request, schema)),
        ).byteLength;
        expect(normalizedBytes).toBeLessThanOrEqual(clientBytes);
      }
    });

    it('the request byte bound is measured the way core measures it', () => {
      // The whole point of finding 3: core measures the NORMALIZED request.
      // A translator-shaped request at the client cap must survive core.
      const values = Array.from({ length: 100 }, (_, index) =>
        `${index}`.padEnd(4_000, 'v'),
      );
      const { request } = contentListViewStateToDataQueryRequest(
        viewState({
          filters: [
            { columnId: 'status', operator: 'in', value: values },
            { columnId: 'author', operator: 'in', value: values },
            { columnId: 'title', operator: 'in', value: values },
          ],
        }),
        { createRequestId: () => 'byte-bound' },
      );
      const clientBytes = new TextEncoder().encode(
        JSON.stringify(request),
      ).byteLength;
      expect(clientBytes).toBeLessThanOrEqual(
        CONTENT_LIST_QUERY_MAX_REQUEST_BYTES,
      );
      // The invariant finding 3 was about: core measures the NORMALIZED
      // request, so the client's measurement is only meaningful if it can
      // never come out SMALLER. Omitting `sort` breaks this by exactly the 84
      // bytes core injects, which is why the translator always emits it.
      const normalized = normalizeDataQueryRequest(request, schema);
      const normalizedBytes = new TextEncoder().encode(
        JSON.stringify(normalized),
      ).byteLength;
      expect(normalizedBytes).toBeLessThanOrEqual(clientBytes);
      expect(normalizedBytes).toBeLessThanOrEqual(MAX_DATA_QUERY_REQUEST_BYTES);
    });
  });
});

// ---------------------------------------------------------------------------
// Review batch 4: NULL semantics agree between local and server mode (#2452)
// ---------------------------------------------------------------------------

/**
 * The same shared link must return the same rows whether the host passed a
 * `query` or not. The local evaluator flattens an absent value to empty text,
 * so `notEquals`/`notIn` INCLUDE a row with no value; SQL's `<>` is UNKNOWN for
 * NULL and would exclude it. The executor therefore unions `IS NULL` into both,
 * exactly as it already did for `in`.
 */
describe('null-valued rows through both filter paths', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  const rows = [
    { name: 'with-author', title: 'With author', author: 'Ada Lovelace' },
    { name: 'other-author', title: 'Other author', author: 'Grace Hopper' },
    { name: 'no-author', title: 'No author', author: null },
  ];

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
    for (const entry of rows) {
      const item = await contents.create(entry);
      await item.save();
    }
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  /** What the server-backed list renders. */
  const serverTitles = async (filter: DataTableFilter) => {
    const result = await executeContentQuery(
      contents as unknown as ContentQueryCollection,
      contentListViewStateToDataQueryRequest(viewState({ filters: [filter] }), {
        createRequestId: () => 'null-semantics',
        projection: ['id', 'title', 'author'],
      }).request,
    );
    return result.rows.map((row) => String(row.title)).sort();
  };

  /** What the local list renders for the same view state. */
  const localTitles = (filter: DataTableFilter) =>
    selectContentListRows(
      toContentListRows(
        rows.map((entry) => ({
          id: entry.name,
          title: entry.title,
          author: entry.author,
        })),
      ),
      {
        ...createContentListController().getState(),
        filters: [filter],
      },
    )
      .map((row) => row.title)
      .sort();

  const bothAgree = async (filter: DataTableFilter) => {
    const [server, local] = [await serverTitles(filter), localTitles(filter)];
    expect(server).toEqual(local);
    return server;
  };

  it('includes the authorless row for `notEquals`, in both modes', async () => {
    const titles = await bothAgree({
      columnId: 'author',
      operator: 'notEquals',
      value: 'Ada Lovelace',
    });
    expect(titles).toEqual(['No author', 'Other author']);
  });

  it('includes the authorless row for `notIn`, in both modes', async () => {
    const titles = await bothAgree({
      columnId: 'author',
      operator: 'notIn',
      value: ['Ada Lovelace', 'Grace Hopper'],
    });
    expect(titles).toEqual(['No author']);
  });

  it('keeps `equals` and `in` excluding it, in both modes', async () => {
    expect(
      await bothAgree({
        columnId: 'author',
        operator: 'equals',
        value: 'Ada Lovelace',
      }),
    ).toEqual(['With author']);
    expect(
      await bothAgree({
        columnId: 'author',
        operator: 'in',
        value: ['Ada Lovelace'],
      }),
    ).toEqual(['With author']);
  });

  it('keeps `contains` excluding it, in both modes', async () => {
    expect(
      await bothAgree({
        columnId: 'author',
        operator: 'contains',
        value: 'Lovelace',
      }),
    ).toEqual(['With author']);
  });

  it('still resolves isNull / isNotNull, which must NOT gain the union', async () => {
    expect(
      await serverTitles({ columnId: 'author', operator: 'isNull' }),
    ).toEqual(['No author']);
    expect(
      await serverTitles({ columnId: 'author', operator: 'isNotNull' }),
    ).toEqual(['Other author', 'With author']);
  });

  it('partitions the rows: a predicate and its negation, no overlap or gap', async () => {
    const all = ['No author', 'Other author', 'With author'];
    const pairs: Array<[DataTableFilter, DataTableFilter]> = [
      [
        { columnId: 'author', operator: 'equals', value: 'Ada Lovelace' },
        { columnId: 'author', operator: 'notEquals', value: 'Ada Lovelace' },
      ],
      [
        { columnId: 'author', operator: 'in', value: ['Ada Lovelace'] },
        { columnId: 'author', operator: 'notIn', value: ['Ada Lovelace'] },
      ],
      [
        { columnId: 'author', operator: 'isNull' },
        { columnId: 'author', operator: 'isNotNull' },
      ],
    ];
    for (const [predicate, negation] of pairs) {
      const [yes, no] = [await bothAgree(predicate), await bothAgree(negation)];
      expect(yes.filter((title) => no.includes(title))).toEqual([]);
      expect([...yes, ...no].sort()).toEqual(all);
    }
  });

  it('excludes the authorless row from every ordered comparison', async () => {
    // An absent value takes part in no ordered comparison, matching SQL. The
    // local evaluator used to read it as empty text, which sorts below
    // everything, so `lt` matched it and the two modes disagreed.
    expect(
      await bothAgree({ columnId: 'author', operator: 'lt', value: 'Zzz' }),
    ).toEqual(['Other author', 'With author']);
    expect(
      await bothAgree({ columnId: 'author', operator: 'lte', value: 'Zzz' }),
    ).toEqual(['Other author', 'With author']);
    await bothAgree({ columnId: 'author', operator: 'gt', value: 'Ada' });
    await bothAgree({ columnId: 'author', operator: 'gte', value: 'Ada' });
  });

  it('agrees for a blank comparand, the case that used to be unalignable', async () => {
    // `?author.lt=` and `?author.gte=` both compare against the empty string,
    // where an "absent reads as empty" model and SQL give opposite answers.
    for (const operator of ['lt', 'lte', 'gt', 'gte'] as const) {
      await bothAgree({ columnId: 'author', operator, value: '' });
    }
  });

  it('agrees on isNull / isNotNull, which the flattened row used to miss', async () => {
    expect(await bothAgree({ columnId: 'author', operator: 'isNull' })).toEqual(
      ['No author'],
    );
    expect(
      await bothAgree({ columnId: 'author', operator: 'isNotNull' }),
    ).toEqual(['Other author', 'With author']);
  });

  it('never matches a display fallback label, in either mode', async () => {
    // `toContentListRows` renders `content` for an untyped row and `Untitled
    // content` for one with no title. Both are presentation: a filter on the
    // literal label matched every such row locally and none server-side.
    expect(
      await bothAgree({
        columnId: 'type',
        operator: 'equals',
        value: 'content',
      }),
    ).toEqual([]);
    expect(
      await bothAgree({
        columnId: 'title',
        operator: 'equals',
        value: 'Untitled content',
      }),
    ).toEqual([]);
    expect(
      await bothAgree({
        columnId: 'title',
        operator: 'contains',
        value: 'Untitled',
      }),
    ).toEqual([]);
  });

  it('treats a column that stores empty text as present, in both modes', async () => {
    // `title` defaults to `''` rather than NULL, so an ordered comparison must
    // still include it — the null-awareness is about absence, not emptiness.
    expect(
      await bothAgree({ columnId: 'title', operator: 'gte', value: 'A' }),
    ).toEqual(['No author', 'Other author', 'With author']);
  });
});

describe('the OR-branch budget that the null union makes reachable', () => {
  it('mirrors the executor ceiling', () => {
    expect(CONTENT_LIST_QUERY_MAX_OR_BRANCHES).toBe(
      MAX_CONTENT_QUERY_OR_BRANCHES,
    );
  });

  it('drops filters before the executor would refuse the request', () => {
    // Each null-safe `notEquals` doubles the DNF; an `all` of them multiplies.
    const filters = Array.from({ length: 12 }, (_, index) => ({
      columnId: 'author' as const,
      operator: 'notEquals' as const,
      value: `person-${index}`,
    }));
    const { request, dropped } = translate({ filters });

    // 2^7 = 128 is exactly the ceiling; 2^8 would be refused.
    expect(conditions(request.filter).length).toBe(7);
    expect(
      dropped.some(
        (drop) =>
          drop.reason === 'out-of-range' &&
          drop.detail === String(CONTENT_LIST_QUERY_MAX_OR_BRANCHES),
      ),
    ).toBe(true);
  });

  it('accounts for search, which is itself three branches', () => {
    const filters = Array.from({ length: 12 }, (_, index) => ({
      columnId: 'author' as const,
      operator: 'notEquals' as const,
      value: `person-${index}`,
    }));
    const { request } = translate({ search: 'budget', filters });
    // 3 search branches leave room for 5 doublings (3 * 2^5 = 96 <= 128).
    const notEquals = conditions(request.filter).filter(
      (entry) => entry.operator === 'ne',
    );
    // 3 * 2^5 = 96 fits; 3 * 2^6 = 192 does not.
    expect(notEquals.length).toBe(5);
  });
});

describe('the branch counter mirrors the executor exactly', () => {
  /** Runs a filter through the real executor and reports whether it survived. */
  const executorAccepts = async (
    contents: Contents,
    filter: unknown,
  ): Promise<boolean> => {
    try {
      await executeContentQuery(contents as unknown as ContentQueryCollection, {
        version: 1,
        requestId: 'branch-parity',
        mode: 'rows',
        projection: ['id'],
        filter,
        page: { kind: 'offset', offset: 0, limit: 1 },
      });
      return true;
    } catch {
      return false;
    }
  };

  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
    const item = await contents.create({ name: 'a', title: 'A' });
    await item.save();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  it('sheds exactly at the boundary the executor refuses', async () => {
    const build = (count: number) =>
      translate({
        filters: Array.from({ length: count }, (_, index) => ({
          columnId: 'author' as const,
          operator: 'notEquals' as const,
          value: `person-${index}`,
        })),
      }).request.filter;

    // What the translator emits is always accepted …
    expect(await executorAccepts(contents, build(12))).toBe(true);
    // … and one more doubling than it allows itself is not.
    expect(
      await executorAccepts(contents, {
        kind: 'all',
        filters: Array.from({ length: 8 }, (_, index) => ({
          kind: 'condition',
          field: 'author',
          operator: 'ne',
          value: `person-${index}`,
        })),
      }),
    ).toBe(false);
    // Exactly one fewer is accepted, so the mirror is not merely conservative.
    expect(
      await executorAccepts(contents, {
        kind: 'all',
        filters: Array.from({ length: 7 }, (_, index) => ({
          kind: 'condition',
          field: 'author',
          operator: 'ne',
          value: `person-${index}`,
        })),
      }),
    ).toBe(true);
  });

  it('a listed null costs one branch, not two, in both layers', async () => {
    // `notIn [x, null]` is a single AND group server-side, so eight of them fit
    // where eight null-safe ones would not.
    const filters = Array.from({ length: 8 }, (_, index) => ({
      kind: 'condition' as const,
      field: 'author',
      operator: 'notIn' as const,
      value: [`person-${index}`, null],
    }));
    expect(await executorAccepts(contents, { kind: 'all', filters })).toBe(
      true,
    );
  });
});

describe('the branch counter tracks the negated ordered comparison', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
    const item = await contents.create({ name: 'a', title: 'A' });
    await item.save();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  const accepts = async (filter: unknown): Promise<boolean> => {
    try {
      await executeContentQuery(contents as unknown as ContentQueryCollection, {
        version: 1,
        requestId: 'negated-branch-parity',
        mode: 'rows',
        projection: ['id'],
        filter,
        page: { kind: 'offset', offset: 0, limit: 1 },
      });
      return true;
    } catch {
      return false;
    }
  };

  const negatedComparisons = (count: number) => ({
    kind: 'all' as const,
    filters: Array.from({ length: count }, (_, index) => ({
      kind: 'not' as const,
      filter: {
        kind: 'condition' as const,
        field: 'author',
        operator: 'gt' as const,
        value: `person-${index}`,
      },
    })),
  });

  it('costs two branches, exactly like the executor', async () => {
    // A negated ordered comparison unions IS NULL, so seven fit and eight do
    // not — the same boundary as `ne`. If the mirror still counted one, it
    // would let fifteen through and the executor would refuse the request.
    expect(await accepts(negatedComparisons(7))).toBe(true);
    expect(await accepts(negatedComparisons(8))).toBe(false);
  });

  it('costs one branch when it is NOT negated', async () => {
    const plain = (count: number) => ({
      kind: 'all' as const,
      filters: Array.from({ length: count }, (_, index) => ({
        kind: 'condition' as const,
        field: 'author',
        operator: 'gt' as const,
        value: `person-${index}`,
      })),
    });
    expect(await accepts(plain(20))).toBe(true);
  });
});

describe('display fallback labels are never compared', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  /**
   * One row with a real title and type, one with neither.
   *
   * The collection backfills a blank `title` from `name` on save, so the server
   * row reads `bare`; the local fixture keeps the empty title, which is exactly
   * the shape that triggers the `Untitled content` label. The local side is the
   * one under test here — the server side is the control that says what the
   * label must NOT match.
   */
  const fixtures = [
    { name: 'typed', title: 'Council budget', type: 'article' },
    { name: 'bare', title: '', type: null },
  ];

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({ db });
    for (const entry of fixtures) {
      const item = await contents.create(entry);
      await item.save();
    }
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  const localRows = () =>
    toContentListRows(
      fixtures.map((entry) => ({
        id: entry.name,
        title: entry.title,
        type: entry.type,
      })),
    );

  const localNames = (state: Partial<DataTableViewState>) =>
    selectContentListRows(localRows(), {
      ...createContentListController().getState(),
      ...state,
    })
      .map((row) => String(row.content.id))
      .sort();

  const serverNames = async (state: Partial<DataTableViewState>) => {
    const result = await executeContentQuery(
      contents as unknown as ContentQueryCollection,
      contentListViewStateToDataQueryRequest(viewState(state), {
        createRequestId: () => 'fallback-label',
        projection: ['id', 'name', 'title', 'type'],
      }).request,
    );
    return result.rows.map((row) => String(row.name)).sort();
  };

  const bothAgree = async (state: Partial<DataTableViewState>) => {
    const [server, local] = [await serverNames(state), localNames(state)];
    expect(server).toEqual(local);
    return server;
  };

  it('renders the labels, so this is genuinely about presentation', () => {
    const [, bare] = localRows();
    expect(bare.typeLabel).toBe('Content');
    expect(bare.type).toBe('content');
    expect(bare.title).toBe('Untitled content');
  });

  it('does not match `type equals content` on an untyped row', async () => {
    expect(
      await bothAgree({
        filters: [{ columnId: 'type', operator: 'equals', value: 'content' }],
      }),
    ).toEqual([]);
  });

  it('does not match `title equals Untitled content` on an untitled row', async () => {
    expect(
      await bothAgree({
        filters: [
          {
            columnId: 'title',
            operator: 'equals',
            value: 'Untitled content',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('does not find an untitled row by searching for `untitled`', async () => {
    expect(await bothAgree({ search: 'untitled' })).toEqual([]);
  });

  it('still matches the real values, and still finds them by search', async () => {
    expect(
      await bothAgree({
        filters: [{ columnId: 'type', operator: 'equals', value: 'article' }],
      }),
    ).toEqual(['typed']);
    expect(await bothAgree({ search: 'budget' })).toEqual(['typed']);
  });

  it('keeps `isNull` as the way to ask for an absent value', async () => {
    // The recovery path for an operator who actually wanted the untyped rows.
    expect(
      await bothAgree({
        filters: [{ columnId: 'type', operator: 'isNull' }],
      }),
    ).toEqual(['bare']);
  });
});
