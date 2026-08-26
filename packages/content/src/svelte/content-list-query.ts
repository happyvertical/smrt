/**
 * Server-backed ContentList queries (#2452).
 *
 * This module is the seam between the ContentList adapter's *view state* and
 * the canonical bounded data-query protocol (#2444) that
 * `POST /api/v1/contents/query` speaks. It owns three things:
 *
 * 1. {@link contentListViewStateToDataQueryRequest} — the translator. It turns
 *    search, declarative filters, sorting, and paging into a
 *    `DataQueryRequest`, dropping (never throwing on) anything the protocol
 *    cannot express and reporting what it dropped.
 * 2. {@link createContentListQueryTransport} — a `fetch` transport for that
 *    route, which unwraps the generated `{ action, result }` envelope and turns
 *    the `{ error: { … } }` envelope into a thrown, coded error.
 * 3. {@link ContentListQueryBinding} — the structural seam a caller binds a
 *    remote query through.
 *
 * ## Three id namespaces
 *
 * A content list value crosses three vocabularies, and they do not agree:
 *
 * | Namespace | Example | Owner |
 * |---|---|---|
 * | adapter column id | `updated` | `content-list-controller.ts` |
 * | `ContentData` client field | `updatedAt` | `mock-smrt-client.ts` |
 * | server data-query field id | `updated_at` | the registered `Content` model |
 *
 * {@link CONTENT_LIST_QUERY_FIELDS} is the single explicit column → server
 * field map, and `content-list-query.test.ts` asserts it against the field ids
 * and declared operators of the real `buildContentQuerySchema()`. A model
 * rename therefore breaks a test rather than production.
 *
 * A column with no server field is not queryable server-side and is dropped
 * from the request: `site` is derived in the browser from `url`/`source`, so
 * there is nothing for the server to filter or sort on.
 *
 * ## Deliberate structural mirror
 *
 * The request/result types here mirror `@happyvertical/smrt-types` (and
 * `@happyvertical/smrt-web`'s browser copy) structurally rather than by import.
 * `@happyvertical/smrt-content` must not pull the browser data runtime into its
 * Svelte barrel: that runtime is code-split precisely so it never loads on
 * public content pages, and a barrel-level import would defeat that. The mirror
 * is exact, so a `RemoteQueryBinding` from
 * `@happyvertical/smrt-svelte/web` satisfies {@link ContentListQueryBinding}
 * without a cast.
 *
 * ## Documented limits
 *
 * - **Offset paging only.** The content query schema declares
 *   `supports.cursorPagination: false`.
 * - **`body` is not queryable.** It is a document, not list data.
 * - **`metadata` path filtering is unavailable.** JSON columns have no portable
 *   predicate, so the schema declares no filter operators for them.
 * - **No ETag/version slot.** The canonical envelope carries a
 *   `queryFingerprint` plus `freshness.asOf` instead.
 * - **Filters compare exactly.** Local mode compares case-insensitively; the
 *   server compares the stored value. Content stores lowercase `type`,
 *   `status`, and `state` tokens, which is why the adapter normalizes filter
 *   values to lowercase before they get here.
 */

import type {
  DataTableFilter,
  DataTableFilterOperator,
  DataTableSortRule,
  DataTableViewState,
} from '@happyvertical/smrt-ui/data';
import type { ContentData } from '../mock-smrt-client.js';
import type { ContentListColumnId } from './content-list-controller.js';
import {
  CONTENT_LIST_MAX_PAGE_SIZE,
  type ContentListStateDropScope,
} from './content-list-url-state.js';

// ---------------------------------------------------------------------------
// Structural mirror of the canonical bounded query envelope (#2444)
// ---------------------------------------------------------------------------

export type ContentListQueryScalar = string | number | boolean | null;

export type ContentListQueryFilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'like';

export type ContentListQueryFilter =
  | {
      kind: 'condition';
      field: string;
      operator: ContentListQueryFilterOperator;
      value: ContentListQueryScalar | ContentListQueryScalar[];
    }
  | { kind: 'all' | 'any'; filters: ContentListQueryFilter[] }
  | { kind: 'not'; filter: ContentListQueryFilter };

export interface ContentListDataQueryRequest {
  version: 1;
  requestId: string;
  mode: 'rows' | 'count' | 'facets';
  projection?: string[];
  filter?: ContentListQueryFilter;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  page?:
    | { kind: 'offset'; offset: number; limit: number }
    | { kind: 'cursor'; after?: string; limit: number };
  consistency?: { mode: 'eventual' | 'snapshot'; asOf?: string };
  facets?: Array<{ field: string; limit: number }>;
}

export type ContentListQueryTotal =
  | { kind: 'exact' | 'estimated'; value: number; asOf?: string }
  | { kind: 'unavailable'; reason?: string };

export interface ContentListDataQueryResult {
  version: 1;
  requestId: string;
  queryFingerprint: string;
  identityField: string;
  rows: Array<Record<string, unknown>>;
  page?:
    | { kind: 'offset'; limit: number; offset: number; hasMore: boolean }
    | { kind: 'cursor'; limit: number; nextCursor?: string; hasMore: boolean };
  total: ContentListQueryTotal;
  freshness: { state: 'fresh' | 'stale' | 'unknown'; asOf?: string };
  warnings: string[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Column → server field map (namespace bridge)
// ---------------------------------------------------------------------------

/** The declared type of a server field, mirroring `DataQueryFieldDescriptor`. */
export type ContentListQueryFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'json';

export interface ContentListQueryField {
  /** Server data-query field id (an SMRT field name). */
  field: string;
  type: ContentListQueryFieldType;
}

/**
 * The single explicit adapter-column → server-field map.
 *
 * `null` means the column has no server field at all and is therefore neither
 * filterable nor sortable server-side. Only `site` is in that state: it is
 * derived from `url`/`source` in the browser, so the server has nothing to
 * order or compare.
 */
export const CONTENT_LIST_QUERY_FIELDS: Readonly<
  Record<ContentListColumnId, ContentListQueryField | null>
> = Object.freeze({
  type: { field: 'type', type: 'string' },
  title: { field: 'title', type: 'string' },
  author: { field: 'author', type: 'string' },
  status: { field: 'status', type: 'string' },
  state: { field: 'state', type: 'string' },
  publish: { field: 'publish_date', type: 'datetime' },
  // The hazard: `updated` (column) → `updatedAt` (ContentData) → `updated_at`.
  updated: { field: 'updated_at', type: 'datetime' },
  site: null,
  description: { field: 'description', type: 'string' },
});

/** Row identity, matching `CONTENT_QUERY_IDENTITY_FIELD`. */
export const CONTENT_LIST_QUERY_IDENTITY_FIELD = 'id';

/**
 * The server fields the list actually renders. Kept deliberately narrow: the
 * envelope has a byte budget, and a projection is the cheapest place to keep a
 * page inside it.
 */
export const CONTENT_LIST_QUERY_PROJECTION: readonly string[] = Object.freeze([
  CONTENT_LIST_QUERY_IDENTITY_FIELD,
  'type',
  'title',
  'description',
  'author',
  'status',
  'state',
  'publish_date',
  'updated_at',
  'created_at',
  'url',
  'source',
  'fileKey',
  'thumbnailAssetId',
]);

/**
 * Fields free-text search reaches, mirroring the adapter's searchable columns
 * (`title`, `author`, and the hidden search-only `description`).
 */
export const CONTENT_LIST_QUERY_SEARCH_FIELDS: readonly string[] =
  Object.freeze(['title', 'description', 'author']);

/**
 * Page size used when the view state carries none. Matches the server's
 * `CONTENT_QUERY_DEFAULT_PAGE_LIMIT`, so a client default and a server default
 * never disagree about how many rows a page holds.
 */
export const CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE = 50;

/** Mirrors `MAX_DATA_QUERY_OFFSET`; a larger offset is refused outright. */
export const CONTENT_LIST_QUERY_MAX_OFFSET = 1_000_000;

/**
 * Operators the server declares per field type, mirroring `filterOperatorsFor`
 * in `content-query.ts`. Sending an operator outside this set fails the *whole*
 * request with a 400, so the translator drops it here instead.
 */
const SERVER_OPERATORS: Record<
  ContentListQueryFieldType,
  readonly ContentListQueryFilterOperator[]
> = {
  string: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'like'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn'],
  datetime: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn'],
  boolean: ['eq', 'ne', 'in', 'notIn'],
  json: [],
};

/**
 * How a `DataTable` operator is expressed over the wire.
 *
 * `pattern` marks the three operators that become a `like` with wildcards the
 * client adds itself — the server does not add them.
 *
 * Three DataTable operators have no sound server expression and are dropped:
 *
 * - `notContains` would be `not(like)`, and the executor refuses to negate a
 *   `like` (`DATA_QUERY_UNSUPPORTED`) — sending it would fail the whole query.
 * - `isNull` / `isNotNull` have no null-aware operator: `ne null` is never true
 *   in SQL, so it would silently return an empty list rather than "has a value".
 */
const OPERATOR_MAP: Partial<
  Record<
    DataTableFilterOperator,
    {
      operator: ContentListQueryFilterOperator;
      pattern?: 'contains' | 'prefix' | 'suffix';
    }
  >
> = {
  equals: { operator: 'eq' },
  notEquals: { operator: 'ne' },
  contains: { operator: 'like', pattern: 'contains' },
  startsWith: { operator: 'like', pattern: 'prefix' },
  endsWith: { operator: 'like', pattern: 'suffix' },
  in: { operator: 'in' },
  notIn: { operator: 'notIn' },
  gt: { operator: 'gt' },
  gte: { operator: 'gte' },
  lt: { operator: 'lt' },
  lte: { operator: 'lte' },
};

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

/**
 * Why one part of a view state could not be expressed as a server query.
 *
 * A superset of `ContentListStateDropReason` so one notice can list restore
 * drops and translation drops together.
 */
export type ContentListQueryDropReason =
  /** The column carries no server field (only `site` today). */
  | 'no-server-field'
  /** The column id is not published by the adapter at all. */
  | 'unknown-column'
  /** The operator has no sound server expression. */
  | 'unsupported-operator'
  /** The value cannot be expressed for the server field's declared type. */
  | 'unsupported-value'
  /** The value was clamped to stay inside a protocol or policy bound. */
  | 'out-of-range';

/** One discarded piece of a translated query, reported rather than thrown. */
export interface ContentListQueryDrop {
  scope: ContentListStateDropScope;
  reason: ContentListQueryDropReason;
  columnId?: string;
  detail?: string;
}

export interface ContentListQueryTranslation {
  request: ContentListDataQueryRequest;
  /** Everything the translator refused, for reporting to the operator. */
  dropped: ContentListQueryDrop[];
}

export interface ContentListQueryRequestOptions {
  /** Overrides the projected server fields. */
  projection?: readonly string[];
  /** Page size used when the view state has none. */
  defaultPageSize?: number;
  /** Ceiling on a requested page size. Defaults to `CONTENT_LIST_MAX_PAGE_SIZE`. */
  maxPageSize?: number;
  /** Injectable id factory, for deterministic tests. */
  createRequestId?: () => string;
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

function defaultRequestId(): string {
  try {
    const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } })
      .crypto;
    if (typeof cryptoRef?.randomUUID === 'function') {
      return `content-list-${cryptoRef.randomUUID()}`;
    }
  } catch {
    // Fall through to the non-cryptographic id below.
  }
  return `content-list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Escapes the SQL `LIKE` metacharacters in a user-supplied value.
 *
 * Search and the three pattern operators build their own wildcards, so a `%` or
 * `_` the operator typed must be matched literally. The escape character is a
 * backslash, which PostgreSQL and DuckDB honour by default for `LIKE`.
 *
 * KNOWN GAP: SQLite has no default `LIKE` escape character and the collection
 * query builder emits no `ESCAPE` clause, so on SQLite an escaped `%` matches
 * the two literal characters rather than a literal `%`. That fails closed (an
 * empty result) instead of open (every row), which is the safer of the two; a
 * portable fix needs an `ESCAPE` clause at the collection/SQL boundary.
 */
export function escapeContentListQueryLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function likeValue(
  value: string,
  pattern: 'contains' | 'prefix' | 'suffix',
): string {
  const escaped = escapeContentListQueryLikeValue(value);
  if (pattern === 'prefix') return `${escaped}%`;
  if (pattern === 'suffix') return `%${escaped}`;
  return `%${escaped}%`;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Coerces one filter value for a server field.
 *
 * A `datetime` field only accepts an RFC 3339 instant — the request normalizer
 * rejects anything else and fails the entire query — so an unparseable date is
 * dropped here rather than sent.
 */
function coerceValue(
  field: ContentListQueryField,
  raw: unknown,
): ContentListQueryScalar | undefined {
  const text = scalarText(raw);
  if (text === null) return undefined;
  if (field.type === 'datetime') {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (field.type === 'number') {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (field.type === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return undefined;
  }
  return text;
}

function resolveColumn(
  columnId: string,
): ContentListQueryField | null | undefined {
  if (!Object.hasOwn(CONTENT_LIST_QUERY_FIELDS, columnId)) return undefined;
  return CONTENT_LIST_QUERY_FIELDS[columnId as ContentListColumnId];
}

function translateFilter(
  filter: DataTableFilter,
  dropped: ContentListQueryDrop[],
): ContentListQueryFilter | null {
  const columnId = filter.columnId;
  const field = resolveColumn(columnId);
  if (field === undefined) {
    dropped.push({ scope: 'filter', reason: 'unknown-column', columnId });
    return null;
  }
  if (field === null) {
    dropped.push({ scope: 'filter', reason: 'no-server-field', columnId });
    return null;
  }
  const mapping = OPERATOR_MAP[filter.operator];
  if (!mapping) {
    dropped.push({
      scope: 'filter',
      reason: 'unsupported-operator',
      columnId,
      detail: filter.operator,
    });
    return null;
  }
  if (!SERVER_OPERATORS[field.type].includes(mapping.operator)) {
    dropped.push({
      scope: 'filter',
      reason: 'unsupported-operator',
      columnId,
      detail: filter.operator,
    });
    return null;
  }

  if (mapping.operator === 'in' || mapping.operator === 'notIn') {
    const entries = Array.isArray(filter.value) ? filter.value : [];
    const values: ContentListQueryScalar[] = [];
    for (const entry of entries) {
      const coerced = coerceValue(field, entry);
      if (coerced !== undefined && !values.includes(coerced)) {
        values.push(coerced);
      }
    }
    if (values.length === 0) {
      dropped.push({
        scope: 'filter',
        reason: 'unsupported-value',
        columnId,
        detail: filter.operator,
      });
      return null;
    }
    return {
      kind: 'condition',
      field: field.field,
      operator: mapping.operator,
      value: values,
    };
  }

  if (mapping.pattern) {
    const text = scalarText(filter.value);
    if (text === null) {
      dropped.push({
        scope: 'filter',
        reason: 'unsupported-value',
        columnId,
        detail: filter.operator,
      });
      return null;
    }
    return {
      kind: 'condition',
      field: field.field,
      operator: 'like',
      value: likeValue(text, mapping.pattern),
    };
  }

  const value = coerceValue(field, filter.value);
  if (value === undefined) {
    dropped.push({
      scope: 'filter',
      reason: 'unsupported-value',
      columnId,
      detail: filter.operator,
    });
    return null;
  }
  return {
    kind: 'condition',
    field: field.field,
    operator: mapping.operator,
    value,
  };
}

/**
 * Free-text search as an `any` of `like` predicates.
 *
 * The protocol has no search primitive — only `filter` — so search is modelled
 * explicitly, over exactly the fields the adapter marks searchable, with the
 * wildcards added (and the operator's own metacharacters escaped) here.
 */
function translateSearch(
  search: string,
  searchFields: readonly string[],
): ContentListQueryFilter | null {
  const trimmed = search.trim();
  if (!trimmed || searchFields.length === 0) return null;
  const value = likeValue(trimmed, 'contains');
  const filters: ContentListQueryFilter[] = searchFields.map((field) => ({
    kind: 'condition',
    field,
    operator: 'like',
    value,
  }));
  return filters.length === 1 ? filters[0] : { kind: 'any', filters };
}

function translateSorting(
  sorting: readonly DataTableSortRule[],
  dropped: ContentListQueryDrop[],
): Array<{ field: string; direction: 'asc' | 'desc' }> {
  const terms: Array<{ field: string; direction: 'asc' | 'desc' }> = [];
  const seen = new Set<string>();
  for (const rule of sorting) {
    const field = resolveColumn(rule.columnId);
    if (field === undefined) {
      dropped.push({
        scope: 'sorting',
        reason: 'unknown-column',
        columnId: rule.columnId,
      });
      continue;
    }
    if (field === null) {
      dropped.push({
        scope: 'sorting',
        reason: 'no-server-field',
        columnId: rule.columnId,
      });
      continue;
    }
    if (seen.has(field.field)) continue;
    seen.add(field.field);
    terms.push({ field: field.field, direction: rule.direction });
  }
  if (terms.length === 0) return terms;
  // A paged read must be totally ordered or two pages can repeat or skip a row.
  if (!seen.has(CONTENT_LIST_QUERY_IDENTITY_FIELD)) {
    terms.push({ field: CONTENT_LIST_QUERY_IDENTITY_FIELD, direction: 'asc' });
  }
  return terms;
}

/**
 * Translates a content-list view state into a bounded `DataQueryRequest`.
 *
 * Everything unmappable is dropped and reported rather than thrown: a stale
 * saved view or a crafted link must still produce a valid query, minus the
 * parts the server cannot express.
 *
 * Selection and expansion are never translated — they address rendered rows,
 * not a query.
 */
export function contentListViewStateToDataQueryRequest(
  state: Partial<DataTableViewState>,
  options: ContentListQueryRequestOptions = {},
): ContentListQueryTranslation {
  const dropped: ContentListQueryDrop[] = [];
  const projection = [...(options.projection ?? CONTENT_LIST_QUERY_PROJECTION)];
  const maxPageSize = options.maxPageSize ?? CONTENT_LIST_MAX_PAGE_SIZE;
  const requestedSize =
    state.pageSize ??
    options.defaultPageSize ??
    CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE;
  let limit = Math.max(1, Math.floor(requestedSize));
  if (limit > maxPageSize) {
    // A restored link or saved view must never turn into a larger row budget
    // than the surface publishes.
    dropped.push({
      scope: 'pageSize',
      reason: 'out-of-range',
      detail: String(requestedSize),
    });
    limit = maxPageSize;
  }

  const page = Math.max(1, Math.floor(state.page ?? 1));
  let offset = (page - 1) * limit;
  if (offset > CONTENT_LIST_QUERY_MAX_OFFSET) {
    dropped.push({
      scope: 'page',
      reason: 'out-of-range',
      detail: String(page),
    });
    offset = Math.floor(CONTENT_LIST_QUERY_MAX_OFFSET / limit) * limit;
  }

  const branches: ContentListQueryFilter[] = [];
  const search = translateSearch(
    state.search ?? '',
    CONTENT_LIST_QUERY_SEARCH_FIELDS,
  );
  if (search) branches.push(search);
  for (const filter of state.filters ?? []) {
    const translated = translateFilter(filter, dropped);
    if (translated) branches.push(translated);
  }

  const sort = translateSorting(state.sorting ?? [], dropped);
  const request: ContentListDataQueryRequest = {
    version: 1,
    requestId: (options.createRequestId ?? defaultRequestId)(),
    mode: 'rows',
    projection,
    ...(branches.length === 0
      ? {}
      : {
          filter:
            branches.length === 1
              ? branches[0]
              : { kind: 'all', filters: branches },
        }),
    ...(sort.length === 0 ? {} : { sort }),
    page: { kind: 'offset', offset, limit },
  };
  return { request, dropped };
}

/**
 * A stable identity for the *semantics* of a request.
 *
 * `requestId` is correlation metadata, not query identity, so it is excluded:
 * a component can compare two translations to decide whether the query actually
 * changed rather than re-fetching on every state transition.
 */
export function contentListQueryRequestKey(
  request: ContentListDataQueryRequest,
): string {
  const { requestId: _requestId, ...semantic } = request;
  return JSON.stringify(semantic);
}

// ---------------------------------------------------------------------------
// Result rows → ContentData
// ---------------------------------------------------------------------------

/**
 * Server field id → `ContentData` key. The second namespace bridge: a result
 * row is keyed by server field ids, and the presentations read `ContentData`.
 */
const ROW_FIELD_TO_CONTENT_KEY: Readonly<Record<string, keyof ContentData>> =
  Object.freeze({
    id: 'id',
    slug: 'slug',
    type: 'type',
    variant: 'variant',
    title: 'title',
    description: 'description',
    author: 'author',
    status: 'status',
    state: 'state',
    bodyFormat: 'bodyFormat',
    publish_date: 'publish_date',
    url: 'url',
    source: 'source',
    fileKey: 'fileKey',
    thumbnailAssetId: 'thumbnailAssetId',
    metadata: 'metadata',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  });

/**
 * Maps one result row onto the `ContentData` shape the presentations render.
 * Unprojected and unknown fields are simply absent; `toContentListRows` already
 * treats a missing field as empty text.
 */
export function contentFromContentListQueryRow(
  row: Record<string, unknown>,
): ContentData {
  const content: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(ROW_FIELD_TO_CONTENT_KEY)) {
    if (!Object.hasOwn(row, field)) continue;
    const value = row[field];
    if (value === null || value === undefined) continue;
    content[key] = value;
  }
  return content as ContentData;
}

/** Maps a whole result page. Order is preserved: the server already sorted. */
export function contentListQueryRowsToContents(
  rows: ReadonlyArray<Record<string, unknown>>,
): ContentData[] {
  return rows.map((row) => contentFromContentListQueryRow(row));
}

/**
 * The row count to page against, or `undefined` when the server could not
 * produce one (`total.kind === 'unavailable'`), in which case the caller should
 * fall back to the rows it has.
 */
export function contentListQueryTotalValue(
  total: ContentListQueryTotal | undefined,
): number | undefined {
  if (!total || total.kind === 'unavailable') return undefined;
  return total.value;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A content query failure carrying the server's machine-readable code. */
export class ContentListQueryError extends Error {
  /** Server error code, for example `DATA_QUERY_FILTER_NOT_ALLOWED`. */
  readonly code: string;
  /** HTTP status, when the failure came from a response. */
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { code?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'ContentListQueryError';
    this.code = options.code ?? 'CONTENT_QUERY_FAILED';
    this.status = options.status;
  }
}

/** The transport seam `createContentListQueryTransport` implements. */
export interface ContentListQueryTransport {
  query(
    request: ContentListDataQueryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface ContentListQueryTransportOptions {
  /** REST base path. Defaults to `/api/v1`, matching `ContentList`. */
  apiBaseUrl?: string;
  /** Route path under the base. Defaults to `contents/query`. */
  path?: string;
  /** Injectable fetch, for tests and for server-side rendering. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers (an auth header, a tenant hint). Resolved per request. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Forwarded to `fetch`; set `'include'` for cookie-authenticated hosts. */
  credentials?: RequestCredentials;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the generated route's error envelope
 * (`{ error: { ok, status, code, message } }`), or returns `undefined` when the
 * payload is not one.
 */
function readErrorEnvelope(
  payload: unknown,
  status?: number,
): ContentListQueryError | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  const error = payload.error;
  const message =
    typeof error.message === 'string' && error.message
      ? error.message
      : 'The content query was refused.';
  return new ContentListQueryError(message, {
    code: typeof error.code === 'string' ? error.code : undefined,
    status: typeof error.status === 'number' ? error.status : status,
  });
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * A `fetch` transport for `POST /api/v1/contents/query`.
 *
 * The generated route wraps a success as `{ action: 'queryAction', result }`
 * and a refusal as `{ error: { ok: false, status, code, message } }`. This
 * unwraps the first and throws the second as a {@link ContentListQueryError} so
 * a binding's error state carries the server's code rather than a generic
 * "request failed".
 *
 * Non-JSON bodies and HTTP failures are never swallowed, and an `AbortError`
 * propagates untouched so cancellation stays distinguishable from a failure.
 */
export function createContentListQueryTransport(
  options: ContentListQueryTransportOptions = {},
): ContentListQueryTransport {
  const url = joinUrl(
    options.apiBaseUrl ?? '/api/v1',
    options.path ?? 'contents/query',
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'createContentListQueryTransport requires a fetch implementation',
    );
  }
  return {
    async query(request, runOptions) {
      const extraHeaders =
        typeof options.headers === 'function'
          ? await options.headers()
          : options.headers;
      const headers = new Headers(extraHeaders);
      headers.set('content-type', 'application/json');
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...(runOptions?.signal ? { signal: runOptions.signal } : {}),
      });
      const text = await response.text();
      let payload: unknown;
      let parsed = false;
      if (text) {
        try {
          payload = JSON.parse(text);
          parsed = true;
        } catch {
          parsed = false;
        }
      }
      const envelope = readErrorEnvelope(payload, response.status);
      if (envelope) throw envelope;
      if (!response.ok) {
        throw new ContentListQueryError(
          `The content query failed with HTTP ${response.status}.`,
          { code: 'CONTENT_QUERY_HTTP_ERROR', status: response.status },
        );
      }
      if (!parsed || !isRecord(payload)) {
        throw new ContentListQueryError(
          'The content query returned a body that is not a JSON object.',
          { code: 'CONTENT_QUERY_INVALID_RESPONSE', status: response.status },
        );
      }
      // The generated action envelope; a bare result is accepted too so a host
      // can put its own gateway in front of the route.
      return Object.hasOwn(payload, 'result') &&
        Object.hasOwn(payload, 'action')
        ? payload.result
        : payload;
    },
  };
}

// ---------------------------------------------------------------------------
// Binding seam
// ---------------------------------------------------------------------------

/**
 * The reactive query binding `ContentList` reads.
 *
 * Structurally satisfied by `RemoteQueryBinding<Record<string, unknown>>` from
 * `@happyvertical/smrt-svelte/web`, which is the intended implementation:
 *
 * ```ts
 * import { remoteQuery } from '@happyvertical/smrt-svelte/web';
 * import { createContentListQueryTransport } from '@happyvertical/smrt-content/svelte';
 *
 * const transport = createContentListQueryTransport({ apiBaseUrl: '/api/v1' });
 * // inside the host component's initialization
 * const query = { bind: () => remoteQuery(collection, transport) };
 * ```
 *
 * It is declared structurally rather than imported so the content Svelte barrel
 * does not drag the browser data runtime onto every page that renders content.
 */
export interface ContentListQueryBinding {
  /** The current page of result rows, keyed by server field id. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** Row count for the whole query, not just this page. */
  readonly total: ContentListQueryTotal | undefined;
  /** True while a first fill is in flight. */
  readonly loading: boolean;
  /** True while a revalidation over already-rendered rows is in flight. */
  readonly refreshing: boolean;
  /**
   * True when the rendered rows are known to be out of date. Part of the seam
   * so a binding satisfies it structurally; the freshness affordance that reads
   * it lands with #2455.
   */
  readonly stale: boolean;
  /** The last failure, or a falsy value when the query is healthy. */
  readonly error: unknown;
  execute(
    request: ContentListDataQueryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  retry(): Promise<unknown>;
}

/**
 * The opt-in server-query prop.
 *
 * `bind` is called exactly once, during `ContentList` initialization, so a
 * binding created by `remoteQuery(...)` registers its teardown in the
 * component's own effect scope and is disposed with it.
 */
export interface ContentListQuerySource {
  bind(): ContentListQueryBinding;
  /** Translator options — projection, default page size, page-size ceiling. */
  request?: ContentListQueryRequestOptions;
}

/**
 * A human-readable message for a binding error, for the list's error panel.
 * Returns `null` when there is no error.
 */
export function contentListQueryErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ContentListQueryError) {
    return error.code === 'CONTENT_QUERY_FAILED'
      ? error.message
      : `${error.message} (${error.code})`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
