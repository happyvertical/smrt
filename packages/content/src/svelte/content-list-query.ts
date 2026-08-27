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
 * - **Filters compare exactly.** The server compares the stored value. The
 *   adapter folds case only for the token columns (`type`, `status`, `state`),
 *   because free text has to reach the server as the operator typed it.
 * - **NULL semantics are aligned end to end.** `ne`/`notIn` union `IS NULL`
 *   server-side, as `in` already did — unless the caller listed `null`, which
 *   inverts the meaning, and a NEGATED ordered comparison unions so that a
 *   predicate and its negation stay complements. The ordered comparisons,
 *   `isNull`/`isNotNull`, and the `type`/`title` display fallbacks were aligned
 *   on the local side instead, by consulting the original `ContentData` rather
 *   than the flattened display text. See `agents/content-list.md`.
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
 * The schema's `defaultSort`, mirrored so the translator can send it rather
 * than let the normalizer inject it. Cross-asserted against the real schema in
 * `content-list-query.test.ts`.
 */
export const CONTENT_LIST_QUERY_DEFAULT_SORT: ReadonlyArray<{
  field: string;
  direction: 'asc' | 'desc';
}> = Object.freeze([
  Object.freeze({ field: 'updated_at', direction: 'desc' as const }),
  Object.freeze({
    field: CONTENT_LIST_QUERY_IDENTITY_FIELD,
    direction: 'asc' as const,
  }),
]);

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
 * Every server field the content query schema declares as projectable.
 *
 * A host may override `query.request.projection` with any of these. Naming
 * anything else — a typo, a field that was removed, `body`, `tenantId` — is
 * refused by the normalizer with `DATA_QUERY_PROJECTION_NOT_ALLOWED`, which
 * fails the whole list rather than degrading it, so the translator drops the
 * entry instead. Cross-asserted against `buildContentQuerySchema()`.
 */
export const CONTENT_LIST_QUERY_PROJECTABLE_FIELDS: readonly string[] =
  Object.freeze([
    'author',
    'bodyFormat',
    'category',
    'context',
    'created_at',
    'description',
    'fileKey',
    'id',
    'language',
    'metadata',
    'name',
    'original_url',
    'publish_date',
    'slug',
    'source',
    'state',
    'status',
    'tags',
    'thumbnailAssetId',
    'title',
    'type',
    'updated_at',
    'url',
    'variant',
  ]);

/** `stringValue()`'s default ceiling, applied to every field id in a request. */
export const CONTENT_LIST_QUERY_MAX_FIELD_ID_LENGTH = 256;

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
 * The request normalizer's input caps, mirrored from
 * `@happyvertical/smrt-core`. Exceeding any of them fails the *entire* request
 * with a 400 — which turns the translator's "drop, never fail" contract into an
 * error panel — so each one is enforced client-side and reported as a drop.
 *
 * - `MAX_DATA_QUERY_IN_VALUES` — entries in one `in`/`notIn` list.
 * - `MAX_DATA_QUERY_FILTERS` — total filter nodes, counting every `all`/`any`
 *   container as a node exactly the way `normalizeFilter` does.
 * - the scalar cap — characters in any one filter value, wildcards included.
 */
export const CONTENT_LIST_QUERY_MAX_IN_VALUES = 100;
export const CONTENT_LIST_QUERY_MAX_FILTER_NODES = 50;
export const CONTENT_LIST_QUERY_MAX_VALUE_LENGTH = 4_096;
/** `MAX_DATA_QUERY_REQUEST_BYTES` — the whole serialized request. */
export const CONTENT_LIST_QUERY_MAX_REQUEST_BYTES = 100_000;
/** `MAX_DATA_QUERY_FILTERS` also caps the projection array. */
export const CONTENT_LIST_QUERY_MAX_PROJECTION_FIELDS = 50;
/** `stringValue(object.requestId, …, 128)` — non-empty, at most 128 chars. */
export const CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH = 128;
/**
 * `MAX_CONTENT_QUERY_OR_BRANCHES` — the executor's ceiling on the disjunctive
 * normal form it lowers a filter into. Null-safe `ne`/`notIn` cost two branches
 * each and an `all` multiplies, so this one is reachable from a crafted link.
 */
export const CONTENT_LIST_QUERY_MAX_OR_BRANCHES = 128;

/**
 * The request normalizer's *validity* rules, as distinct from its numeric caps.
 *
 * A datetime value is checked against this exact shape (`normalizedInstant`),
 * so `Date#toISOString()` is not automatically acceptable: a year outside the
 * four-digit range serializes as `+275760-09-13T00:00:00.000Z` or
 * `-000001-01-01T00:00:00.000Z`, both of which the server refuses.
 */
const RFC_3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

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
 * `nullValue` marks the two null predicates. `eq`/`ne` are null-aware end to
 * end: the protocol's scalar type admits `null`, the request normalizer rejects
 * a null value only for `gt`/`gte`/`lt`/`lte`/`like`, and the collection query
 * builder special-cases it — `{ field: null }` becomes `IS NULL` and
 * `{ 'field !=': null }` becomes `IS NOT NULL`, not a comparison against NULL.
 *
 * `notContains` is the only DataTable operator with no sound server expression:
 * it would be `not(like)`, and the executor refuses to negate a `like`
 * (`DATA_QUERY_UNSUPPORTED`), which would fail the whole query.
 */
const OPERATOR_MAP: Partial<
  Record<
    DataTableFilterOperator,
    {
      operator: ContentListQueryFilterOperator;
      pattern?: 'contains' | 'prefix' | 'suffix';
      nullValue?: true;
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
  isNull: { operator: 'eq', nullValue: true },
  isNotNull: { operator: 'ne', nullValue: true },
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
  | 'out-of-range'
  /**
   * A bound could not be met without changing which rows come back, and the
   * change is one the operator did not ask for: a filter that had to be left
   * out entirely, or one applied more loosely than requested.
   *
   * Kept distinct from `out-of-range` deliberately. A clamp that NARROWS — an
   * `in` list cut to its first hundred values, a page size reduced — still
   * answers a subset of the question. A filter that widens hands back rows the
   * operator excluded, and calling that "clamped" tells them the opposite of
   * what happened.
   */
  | 'filter-widened'
  /**
   * The value is live and applied, but outside the vocabulary the toolbar can
   * display. Reported so an operator is never shown an apparently unfiltered
   * toolbar over an empty list.
   */
  | 'unlisted-value'
  /**
   * A live filter a single-select control cannot express at all — a non-`equals`
   * operator, a list value, or a valueless one. Reported so the toolbar never
   * silently states something other than the query being run.
   */
  | 'unrepresentable-filter'
  /**
   * An unpaginated view was requested, which a server query cannot express —
   * the endpoint always applies a page limit. Coerced to the page size.
   */
  | 'unpaginated-unsupported';

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
  /**
   * The 1-based page this request actually reads. Equal to `state.page` unless
   * the offset had to be capped, in which case the caller must move its own
   * page marker here — otherwise the UI labels the answer with a page the
   * server never read, and paging from it is meaningless.
   */
  effectivePage: number;
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
const LIKE_METACHARACTER = /[\\%_]/;

export function escapeContentListQueryLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Trims a value so that escaping it and adding wildcards still fits the
 * protocol's scalar cap.
 *
 * Escaping can double a string's length, so a 4096-character search would
 * otherwise become an 8194-character `like` value and 400 the whole request.
 *
 * The unit of measure is the one the server uses. `dataQueryScalar` in
 * `@happyvertical/smrt-core` tests `value.length`, which counts UTF-16 code
 * units — so an astral character (an emoji, most CJK extension blocks) costs
 * TWO. Iteration is still by code point so a surrogate pair is never cut in
 * half, but the *cost* of each code point is its `.length`, not one. Charging
 * one per code point made a search of 4093 ASCII characters plus one emoji
 * measure 4094 here and 4097 at the server: a hard 400 and a whole-list error
 * panel, which is exactly what this bound exists to prevent.
 */
function boundLikeSource(
  text: string,
  budget: number,
  keep: 'leading' | 'trailing' = 'leading',
): { text: string; truncated: boolean } {
  // A shortened pattern is only acceptable because it matches a SUPERSET of
  // what was asked for, and which end survives is what decides that. A prefix
  // pattern (`abc%`) and a contains pattern (`%abc%`) keep their leading
  // characters: anything starting with (or containing) `abcdef` also starts
  // with (or contains) `abc`. A SUFFIX pattern (`%abc`) is the mirror image —
  // keeping the leading characters names a different ending entirely, so the
  // row the operator asked for stops matching while unrelated rows start.
  // Keeping the trailing characters restores the superset property.
  const source = keep === 'trailing' ? [...text].reverse() : [...text];
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (const character of source) {
    // `character.length` is 1 for a BMP code point and 2 for a surrogate pair;
    // an escaped metacharacter (always BMP) adds its backslash.
    const cost =
      character.length + (LIKE_METACHARACTER.test(character) ? 1 : 0);
    if (used + cost > budget) {
      truncated = true;
      break;
    }
    kept.push(character);
    used += cost;
  }
  return {
    text: (keep === 'trailing' ? kept.reverse() : kept).join(''),
    truncated,
  };
}

function likeValue(
  value: string,
  pattern: 'contains' | 'prefix' | 'suffix',
): { value: string; truncated: boolean } {
  // Two wildcard characters is the worst case (`contains`).
  const bounded = boundLikeSource(
    value,
    CONTENT_LIST_QUERY_MAX_VALUE_LENGTH - 2,
    pattern === 'suffix' ? 'trailing' : 'leading',
  );
  const escaped = escapeContentListQueryLikeValue(bounded.text);
  const wrapped =
    pattern === 'prefix'
      ? `${escaped}%`
      : pattern === 'suffix'
        ? `%${escaped}`
        : `%${escaped}%`;
  return { value: wrapped, truncated: bounded.truncated };
}

/** Cuts a plain scalar string to the protocol cap without splitting a pair. */
function boundScalarText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CONTENT_LIST_QUERY_MAX_VALUE_LENGTH) {
    return { text, truncated: false };
  }
  const cut = text.slice(0, CONTENT_LIST_QUERY_MAX_VALUE_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return {
    text: last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut,
    truncated: true,
  };
}

/**
 * `YYYY-MM-DD`, optionally followed by a time or offset — the shapes a link or
 * a saved view can carry for a datetime column.
 */
const CALENDAR_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ].*)?$/;

/** A bare calendar day, which `Date` reads as UTC midnight. Unambiguous. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A time-bearing input that names ONE instant, accepted case-insensitively.
 *
 * Deliberately looser than {@link RFC_3339_INSTANT} in two ways, because this
 * matches the INPUT while that one matches the canonical form sent to the
 * server (the value goes through `toISOString()` first, so the server only ever
 * sees the strict form it insists on):
 *
 * - RFC 3339 §5.6 permits a lower-case `t`/`z`;
 * - seconds are optional. `2026-02-01T12:30Z` and `2026-02-01T12:30+09:00`
 *   carry an offset, so they name one instant for every reader, and `Date`
 *   parses both through its ISO path. The rule this guards is "a time must
 *   carry an offset", not "a time must state its seconds".
 *
 * The `T` separator is still required. RFC 3339 §5.6 allows a space by mutual
 * agreement, but a space leaves the ISO grammar, so `Date` falls through to its
 * implementation-defined legacy parser — which is exactly the "same text, two
 * different instants across engines" hazard this check exists to prevent.
 */
const RFC_3339_INSTANT_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * True when an input names ONE instant, the same one for every reader.
 *
 * A time without an offset is read as LOCAL time by `Date`, so
 * `?updated.gte=2026-02-01T00:00` submits `00:00Z` from London and `15:00Z`
 * the previous day from Tokyo — the identical link returning different rows
 * per viewer. A time-bearing value must therefore carry `Z` or a numeric
 * offset; a bare calendar day is unambiguous and stays accepted, widened to
 * UTC midnight exactly as `Date` already reads it.
 */
function expressibleInstantSource(text: string): string | undefined {
  // Returns the exact string that must be parsed, never merely a verdict about
  // a different one. Validating `text.trim()` and then parsing `text` let
  // `"2026-02-01 "` through: V8's ISO parser rejects the trailing space and
  // falls back to the legacy parser, which reads a bare date as LOCAL midnight
  // — reintroducing the per-viewer divergence this whole check exists to stop,
  // and without even a drop to show for it.
  const trimmed = text.trim();
  if (!isRealCalendarDate(trimmed)) return undefined;
  if (DATE_ONLY.test(trimmed)) return trimmed;
  if (!RFC_3339_INSTANT_INPUT.test(trimmed)) return undefined;
  // Upper-cased for the same reason the space separator is refused: ECMA-262's
  // Date Time String Format specifies `T` and `Z`, so a lower-case `t`/`z`
  // leaves the grammar and lands in engine-specific heuristics. V8 happens to
  // read it as UTC — that is luck, not a guarantee. `toUpperCase()` is
  // locale-independent and this grammar has no other letters, so the
  // canonical form means exactly what the input did.
  return trimmed.toUpperCase();
}

/**
 * True when the date part of an input names a real calendar day.
 *
 * Mirrors the component round-trip `normalizedInstant` performs in
 * `@happyvertical/smrt-core`: build the day from the parsed numbers and check
 * that it reads back as the same numbers. `2026-02-31` does not, and must be
 * refused rather than quietly become `2026-03-03`.
 */
function isRealCalendarDate(text: string): boolean {
  const match = CALENDAR_DATE_PREFIX.exec(text.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
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
  truncated?: { value: boolean },
): ContentListQueryScalar | undefined {
  const text = scalarText(raw);
  if (text === null) return undefined;
  if (field.type === 'datetime') {
    // Validate the INPUT, never the value derived from it. `new Date()` rolls
    // an impossible calendar date forward — `2026-02-31` becomes March 3 — and
    // the rolled-forward instant then passes every shape check, so the query
    // would silently target a date the link never asked for. The server rejects
    // it (`normalizedInstant` re-derives the components and compares), so this
    // has to reject it too, and report the drop.
    const source = expressibleInstantSource(text);
    if (source === undefined) return undefined;
    const parsed = new Date(source);
    if (Number.isNaN(parsed.getTime())) return undefined;
    const instant = parsed.toISOString();
    // Parsing is not the same as being expressible: a year outside the
    // four-digit range round-trips through `Date` but fails the server's
    // RFC 3339 shape check, which would 400 the whole list.
    return RFC_3339_INSTANT.test(instant) ? instant : undefined;
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
  const bounded = boundScalarText(text);
  if (bounded.truncated && truncated) truncated.value = true;
  return bounded.text;
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

  // `isNull` / `isNotNull`, and a literal `null` comparand on `equals` /
  // `notEquals`, which names the same thing. A null scalar is what the
  // normalizer accepts for eq/ne, and the query builder lowers it to
  // `IS NULL` / `IS NOT NULL`. Without the second case the local evaluator
  // would match an absent row while the translator dropped the filter, so the
  // same data-surface command would answer differently by mode.
  if (
    mapping.nullValue ||
    (filter.value === null &&
      (mapping.operator === 'eq' || mapping.operator === 'ne'))
  ) {
    return {
      kind: 'condition',
      field: field.field,
      operator: mapping.operator,
      value: null,
    };
  }

  if (mapping.operator === 'in' || mapping.operator === 'notIn') {
    const entries = Array.isArray(filter.value) ? filter.value : [];
    // TRUNCATION IS ONLY PERMISSIBLE WHEN IT NARROWS.
    //
    // `in` is a union of equalities: losing an entry removes a disjunct, so the
    // result can only shrink. Capping it answers a subset of the question,
    // which is a defensible degradation.
    //
    // `notIn` is an intersection of inequalities: losing an entry removes an
    // EXCLUSION, so the result grows to contain rows the operator asked not to
    // see. The cap keeps arrival order, so a literal `null` past the hundredth
    // entry is the one shed — and the executor then takes its "no null listed"
    // arm and unions `IS NULL` back in, handing back every absent-valued row.
    // A widening list operator is therefore never PARTIALLY applied: if any
    // entry cannot be carried faithfully, the whole filter is left out and
    // reported as such.
    const widening = mapping.operator === 'notIn';
    const values: ContentListQueryScalar[] = [];
    let overflowed = false;
    let truncatedEntry = false;
    let unusableEntry = false;
    for (const entry of entries) {
      const truncated = { value: false };
      // A literal `null` is MEANINGFUL, not missing: in an `in` list it says
      // "or rows with no value", and in a `notIn` list it says "and not rows
      // with no value". `coerceValue` reports it as unusable, so it has to be
      // carried past the coercion — dropping it here would send
      // `notIn ['Ada']` for `notIn ['Ada', null]` and return exactly the
      // authorless rows the caller listed `null` to exclude, undoing the
      // executor's own null-aware lowering.
      const coerced =
        entry === null ? null : coerceValue(field, entry, truncated);
      if (coerced === undefined) {
        unusableEntry = true;
        continue;
      }
      // A shortened entry is not the value the caller named: it would exclude
      // (or match) some other row. Never emit it — losing it narrows an `in`
      // and disqualifies a `notIn`, both of which this handles.
      if (truncated.value) {
        truncatedEntry = true;
        continue;
      }
      if (values.includes(coerced)) continue;
      if (values.length >= CONTENT_LIST_QUERY_MAX_IN_VALUES) {
        overflowed = true;
        break;
      }
      values.push(coerced);
    }
    if (widening && (overflowed || truncatedEntry || unusableEntry)) {
      dropped.push({
        scope: 'filter',
        reason: 'filter-widened',
        columnId,
        detail: filter.operator,
      });
      return null;
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
    // Only `in` reaches here having lost anything, and losing narrows it — so
    // the filter is a genuine SUBSET of the one asked for, which is allowed
    // but must still be reported. An entry that could not be coerced at all
    // (`?updated.in=2026-02-01,soon`) is the case that used to vanish in
    // silence: neither exact, nor superset, nor subset-and-reported, nor
    // not-applied. `unsupported-value` is the accurate reason — the entry could
    // not be used, rather than being out of some range.
    if (unusableEntry) {
      dropped.push({
        scope: 'filter',
        reason: 'unsupported-value',
        columnId,
        detail: filter.operator,
      });
    }
    if (overflowed) {
      dropped.push({
        scope: 'filter',
        reason: 'out-of-range',
        columnId,
        detail: String(entries.length),
      });
    }
    if (truncatedEntry) {
      dropped.push({
        scope: 'filter',
        reason: 'out-of-range',
        columnId,
        detail: filter.operator,
      });
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
    const pattern = likeValue(text, mapping.pattern);
    if (pattern.truncated) {
      // A shortened `like` pattern matches a SUPERSET of what was asked for.
      dropped.push({
        scope: 'filter',
        reason: 'filter-widened',
        columnId,
        detail: filter.operator,
      });
    }
    return {
      kind: 'condition',
      field: field.field,
      operator: 'like',
      value: pattern.value,
    };
  }

  const truncated = { value: false };
  const value = coerceValue(field, filter.value, truncated);
  if (value === undefined) {
    dropped.push({
      scope: 'filter',
      reason: 'unsupported-value',
      columnId,
      detail: filter.operator,
    });
    return null;
  }
  if (truncated.value) {
    // Never emit a value the caller did not name — the same rule the list path
    // applies to its entries. A shortened comparand does not merely loosen the
    // predicate: `gt`/`gte` would widen, `lt`/`lte` would NARROW and hide rows,
    // and `eq`/`ne` would name some third row entirely. There is no honest
    // single label for that, so the filter is not applied at all, which is
    // uniformly a widening and is reported as one.
    dropped.push({
      scope: 'filter',
      reason: 'filter-widened',
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
  dropped: ContentListQueryDrop[],
): ContentListQueryFilter | null {
  const trimmed = search.trim();
  if (!trimmed || searchFields.length === 0) return null;
  const pattern = likeValue(trimmed, 'contains');
  if (pattern.truncated) {
    // The URL layer stores a search verbatim, so an over-long `?q=` would
    // otherwise 400 the whole list instead of searching a shorter term.
    dropped.push({
      scope: 'search',
      reason: 'filter-widened',
      detail: String(trimmed.length),
    });
  }
  const filters: ContentListQueryFilter[] = searchFields.map((field) => ({
    kind: 'condition',
    field,
    operator: 'like',
    value: pattern.value,
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
  // Nothing sortable survived: emit the schema default EXPLICITLY rather than
  // omitting `sort`. The normalizer injects `schema.defaultSort` when the key
  // is absent and then measures the NORMALIZED request against the byte limit,
  // so an omitted sort makes the client's byte count 84 bytes short of the
  // server's — a request the client accepts at 99,917-100,000 bytes and the
  // server refuses outright. Sending it makes the two measurements identical.
  if (terms.length === 0) return [...CONTENT_LIST_QUERY_DEFAULT_SORT];
  // A paged read must be totally ordered or two pages can repeat or skip a row.
  if (!seen.has(CONTENT_LIST_QUERY_IDENTITY_FIELD)) {
    terms.push({ field: CONTENT_LIST_QUERY_IDENTITY_FIELD, direction: 'asc' });
  }
  return terms;
}

/**
 * The one page-size ceiling, resolved from every configured limit.
 *
 * Every candidate narrows: a host that sets a server row budget through
 * `query.request.maxPageSize` must not have it discarded because a looser
 * `urlState.options.maxPageSize` also exists. The schema's `maxPageLimit`
 * (mirrored by `CONTENT_LIST_MAX_PAGE_SIZE`) is always one of the candidates,
 * so the result can never exceed what the endpoint itself enforces.
 *
 * Callers pass this ONE value to the controller seed, the URL sanitizer, the
 * saved-view sanitizer, and the translator, which is what makes it impossible
 * for the page the UI reports and the page the server returns to disagree.
 */
export function resolveContentListMaxPageSize(
  ...candidates: ReadonlyArray<number | null | undefined>
): number {
  const bounds = [...candidates, CONTENT_LIST_MAX_PAGE_SIZE].filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 1,
  );
  return Math.max(1, Math.floor(Math.min(...bounds)));
}

/** Bounds a caller-supplied request id to the normalizer's string rule. */
function boundRequestId(createRequestId?: () => string): string {
  const candidate = (createRequestId ?? defaultRequestId)();
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return defaultRequestId();
  }
  return candidate.length > CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH
    ? candidate.slice(0, CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH)
    : candidate;
}

/**
 * Bounds a caller-supplied projection against the normalizer's *rules*, not
 * only its count.
 *
 * A projection entry must be a non-empty string of at most 256 characters
 * (`stringValue`) AND name a field the schema declares projectable, or the
 * request is refused outright with `DATA_QUERY_PROJECTION_NOT_ALLOWED` — a 400
 * for the whole list, which is precisely what the drop-and-report contract
 * exists to avoid. The identity field is always projected, as the normalizer
 * does, so a projection can never be emptied to nothing.
 */
function boundProjection(
  projection: readonly string[],
  dropped: ContentListQueryDrop[],
): string[] {
  const allowed = new Set(CONTENT_LIST_QUERY_PROJECTABLE_FIELDS);
  const unique = new Set<string>([CONTENT_LIST_QUERY_IDENTITY_FIELD]);
  for (const field of projection) {
    if (
      typeof field !== 'string' ||
      field.length === 0 ||
      field.length > CONTENT_LIST_QUERY_MAX_FIELD_ID_LENGTH ||
      !allowed.has(field)
    ) {
      dropped.push({
        scope: 'state',
        reason: 'unsupported-value',
        detail: typeof field === 'string' ? field.slice(0, 64) : undefined,
      });
      continue;
    }
    unique.add(field);
  }
  const fields = [...unique];
  if (fields.length <= CONTENT_LIST_QUERY_MAX_PROJECTION_FIELDS) return fields;
  dropped.push({
    scope: 'state',
    reason: 'out-of-range',
    detail: String(fields.length),
  });
  return fields.slice(0, CONTENT_LIST_QUERY_MAX_PROJECTION_FIELDS);
}

const requestEncoder = new TextEncoder();

function jsonByteLength(value: unknown): number {
  return requestEncoder.encode(JSON.stringify(value) ?? 'null').byteLength;
}

/**
 * Counts filter nodes exactly the way `normalizeFilter` budgets them: every
 * node, container or condition, costs one.
 */
function countFilterNodes(filter: ContentListQueryFilter): number {
  if (filter.kind === 'condition') return 1;
  if (filter.kind === 'not') return 1 + countFilterNodes(filter.filter);
  return filter.filters.reduce(
    (total, child) => total + countFilterNodes(child),
    1,
  );
}

/**
 * The executor's operator inversion, mirroring `inverseOperator` in
 * `content-query.ts`. `like` has no inverse there — a negated `like` is refused
 * outright — so it is reported as unbounded, which makes the branch budget shed
 * such a filter instead of letting the request 400.
 */
function invertedBranchOperator(
  operator: ContentListQueryFilterOperator,
): ContentListQueryFilterOperator | null {
  switch (operator) {
    case 'eq':
      return 'ne';
    case 'ne':
      return 'eq';
    case 'gt':
      return 'lte';
    case 'gte':
      return 'lt';
    case 'lt':
      return 'gte';
    case 'lte':
      return 'gt';
    case 'in':
      return 'notIn';
    case 'notIn':
      return 'in';
    case 'like':
      return null;
  }
}

function hasNullEntry(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => entry === null);
}

function hasNonNullEntry(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => entry !== null);
}

/**
 * Counts the disjunctive-normal-form branches the executor expands a filter
 * into, mirroring `conditionToDnf`, `filterToDnf` and `crossProduct` in
 * `content-query.ts` — including De Morgan under `not`, where an `any` becomes
 * a product and each condition's operator is inverted.
 *
 * `ne` and `notIn` lower to a UNION with `IS NULL` so their meaning matches the
 * local evaluator's, which costs a second branch each unless the caller listed
 * a `null` explicitly, and a NEGATED ordered comparison unions for the same
 * reason. An `all` multiplies its children. Past
 * {@link CONTENT_LIST_QUERY_MAX_OR_BRANCHES} the executor refuses the request
 * outright, so the translator has to stop adding filters before that rather
 * than hand the operator an error panel.
 *
 * The translator itself emits only conditions, the search `any`, and the outer
 * `all`; the negation arm exists so a future `not` emitter cannot silently
 * under-count and trade shedding for a 400.
 */
function countFilterBranches(
  filter: ContentListQueryFilter,
  negate = false,
): number {
  if (filter.kind === 'condition') {
    const operator = negate
      ? invertedBranchOperator(filter.operator)
      : filter.operator;
    if (operator === null) return Number.POSITIVE_INFINITY;
    // The complement of an ordered comparison unions IS NULL, so it splits.
    if (
      negate &&
      (operator === 'gt' ||
        operator === 'gte' ||
        operator === 'lt' ||
        operator === 'lte')
    ) {
      return 2;
    }
    // A listed null means "exclude absent rows too", which is one AND group.
    if (operator === 'ne') return filter.value === null ? 1 : 2;
    if (operator === 'notIn') return hasNullEntry(filter.value) ? 1 : 2;
    // `in` splits only when the list mixes null and non-null entries.
    if (operator === 'in') {
      return hasNullEntry(filter.value) && hasNonNullEntry(filter.value)
        ? 2
        : 1;
    }
    return 1;
  }
  if (filter.kind === 'not') return countFilterBranches(filter.filter, !negate);
  // De Morgan: a negated `any` behaves as an `all`, and vice versa.
  const combineWithAnd =
    (filter.kind === 'all' && !negate) || (filter.kind === 'any' && negate);
  return filter.filters.reduce(
    (total, child) =>
      combineWithAnd
        ? total * countFilterBranches(child, negate)
        : total + countFilterBranches(child, negate),
    combineWithAnd ? 1 : 0,
  );
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
  const projection = boundProjection(
    options.projection ?? CONTENT_LIST_QUERY_PROJECTION,
    dropped,
  );
  const maxPageSize = resolveContentListMaxPageSize(options.maxPageSize);
  const defaultSize = Math.min(
    Math.max(
      1,
      Math.floor(
        options.defaultPageSize ?? CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
      ),
    ),
    maxPageSize,
  );
  if (state.pageSize === null) {
    // `null` means "unpaginated", which a server query cannot express: the
    // endpoint always applies a limit. Silently falling back would render one
    // page of `limit` rows with no page controls and no way to reach the rest,
    // so the coercion is reported instead. Local mode keeps null semantics.
    dropped.push({ scope: 'pageSize', reason: 'unpaginated-unsupported' });
  }
  const requestedSize = state.pageSize ?? defaultSize;
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

  const requestedPage = Math.max(1, Math.floor(state.page ?? 1));
  let effectivePage = requestedPage;
  let offset = (effectivePage - 1) * limit;
  if (offset > CONTENT_LIST_QUERY_MAX_OFFSET) {
    dropped.push({
      scope: 'page',
      reason: 'out-of-range',
      detail: String(requestedPage),
    });
    offset = Math.floor(CONTENT_LIST_QUERY_MAX_OFFSET / limit) * limit;
    // The caller has to be able to move its own page marker to the page the
    // request will actually read, or the UI labels this answer with a page
    // number the server never saw and navigation from it is nonsense.
    effectivePage = Math.floor(offset / limit) + 1;
  }

  const branches: ContentListQueryFilter[] = [];
  const search = translateSearch(
    state.search ?? '',
    CONTENT_LIST_QUERY_SEARCH_FIELDS,
    dropped,
  );
  // The node budget is spent in the caller's own priority order: search first —
  // it is the operator's most recent, most visible intent — then the
  // declarative filters. The outer `all` container costs a node too.
  let nodeBudget = CONTENT_LIST_QUERY_MAX_FILTER_NODES - 1;
  // The executor lowers the filter to disjunctive normal form and refuses one
  // that expands past its ceiling. The top-level `all` is a cross product, so
  // this budget MULTIPLIES rather than subtracts.
  let branchBudget = 1;
  if (search) {
    branches.push(search);
    nodeBudget -= countFilterNodes(search);
    branchBudget *= countFilterBranches(search);
  }
  for (const filter of state.filters ?? []) {
    const translated = translateFilter(filter, dropped);
    if (!translated) continue;
    const cost = countFilterNodes(translated);
    if (cost > nodeBudget) {
      // Past this many nodes the normalizer refuses the entire request. A
      // partial query beats an error panel, but it is a WIDER one: every filter
      // left out is a restriction the operator asked for and is not getting.
      dropped.push({
        scope: 'filter',
        reason: 'filter-widened',
        columnId: filter.columnId,
        detail: String(CONTENT_LIST_QUERY_MAX_FILTER_NODES),
      });
      continue;
    }
    const branchCost = countFilterBranches(translated);
    if (branchBudget * branchCost > CONTENT_LIST_QUERY_MAX_OR_BRANCHES) {
      dropped.push({
        scope: 'filter',
        reason: 'filter-widened',
        columnId: filter.columnId,
        detail: String(CONTENT_LIST_QUERY_MAX_OR_BRANCHES),
      });
      continue;
    }
    nodeBudget -= cost;
    branchBudget *= branchCost;
    branches.push(translated);
  }

  const sort = translateSorting(state.sorting ?? [], dropped);
  const build = (
    filters: readonly ContentListQueryFilter[],
  ): ContentListDataQueryRequest => ({
    version: 1,
    requestId: boundRequestId(options.createRequestId),
    mode: 'rows',
    projection,
    ...(filters.length === 0
      ? {}
      : {
          filter:
            filters.length === 1
              ? filters[0]
              : { kind: 'all', filters: [...filters] },
        }),
    // Always present: see `translateSorting`. Omitting it would make the
    // client's byte measurement disagree with the server's.
    sort,
    page: { kind: 'offset', offset, limit },
  });

  // The last bound the normalizer applies, and the only one that is a property
  // of the whole request rather than one part of it: 100 `in` values of 4096
  // characters each is inside every per-value cap and still five times the
  // request byte limit. Shed the newest branches until it fits.
  const kept = [...branches];
  let request = build(kept);
  while (
    kept.length > 0 &&
    jsonByteLength(request) > CONTENT_LIST_QUERY_MAX_REQUEST_BYTES
  ) {
    kept.pop();
    dropped.push({
      scope: 'filter',
      reason: 'filter-widened',
      detail: String(CONTENT_LIST_QUERY_MAX_REQUEST_BYTES),
    });
    request = build(kept);
  }
  return { request, dropped, effectivePage };
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
 * The row count to DISPLAY a pager against, or `undefined` when the server
 * could not produce one (`total.kind === 'unavailable'`).
 *
 * Accepts an estimate: an approximate page count is what an estimate is for.
 * Do NOT clamp a page against this — see
 * {@link contentListQueryExactTotal}.
 */
export function contentListQueryTotalValue(
  total: ContentListQueryTotal | undefined,
): number | undefined {
  if (!total || total.kind === 'unavailable') return undefined;
  return total.value;
}

/**
 * The row count a page may be CLAMPED against, or `undefined` when none exists.
 *
 * Clamping moves the operator, so it may only act on a count that is exactly
 * right. `DataQueryTotal` has three kinds and only one of them qualifies:
 *
 * - `exact` — authoritative. Clamp.
 * - `estimated` — an approximation, and clamping on one can strand a page that
 *   really exists: an estimate of 100 rows on a 300-row query hides pages 3
 *   onward, and the operator has no way to reach content that is there. The
 *   opposite risk, offering a page that turns out to be empty, is visible and
 *   self-correcting — they navigate, see nothing, and come back. Refusing to
 *   hide reachable rows is the same rule as "truncation only when it narrows".
 * - `unavailable` — the total is UNKNOWN. Not zero, and emphatically not the
 *   length of the page in hand, which would send every page above the first
 *   back to page one the moment the request settled.
 */
export function contentListQueryExactTotal(
  total: ContentListQueryTotal | undefined,
): number | undefined {
  return total?.kind === 'exact' ? total.value : undefined;
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
  /** Epoch milliseconds of the last successful answer. */
  readonly lastUpdated?: number;
  /** Latest applied envelope, including query-scoped live replacements. */
  readonly result?: unknown;
  /**
   * True when the server had to shorten the answer to fit its byte budget.
   * Optional because `RemoteQueryBinding` does not surface it; when a binding
   * omits it, `ContentList` reads it off the result its own `execute` resolved.
   */
  readonly truncated?: boolean;
  /** Server-side warnings for the same reason, and for shortened values. */
  readonly warnings?: ReadonlyArray<string>;
  execute(
    request: ContentListDataQueryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  /** Revalidate the active query while retaining its usable rows. */
  refresh?(options?: { signal?: AbortSignal }): Promise<unknown>;
  retry(): Promise<unknown>;
  /** Subscribe to changes for the active query rather than the whole table. */
  subscribeLive?():
    | { unsubscribe(): void; reconnect(): void }
    | { unsubscribe(): void }
    | undefined;
}

/**
 * What the server said about the completeness of an answer.
 *
 * `executeContentQuery` drops trailing rows to stay inside `maxResultBytes` and
 * shortens over-long values, flagging both. That matters to a paging client:
 * the next page is computed from `page * limit`, so rows the server dropped are
 * skipped on the following page too. Reporting it is the difference between a
 * short page and silently missing content.
 */
export interface ContentListQueryNotices {
  truncated: boolean;
  warnings: string[];
}

/** Reads the completeness flags off a result envelope, defensively. */
export function readContentListQueryNotices(
  result: unknown,
): ContentListQueryNotices {
  if (!isRecord(result)) return { truncated: false, warnings: [] };
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];
  return { truncated: result.truncated === true, warnings };
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
