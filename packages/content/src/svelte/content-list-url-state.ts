/**
 * Shareable URL state for ContentList (#2452).
 *
 * A content list view is a link: an operator narrows the list, copies the
 * address bar, and a colleague opens the same result. That makes the query
 * string an *untrusted* input — it arrives from whoever sent the link, not from
 * the operator's own session — so every restored value is re-derived here
 * against the adapter's published column and operator vocabulary rather than
 * trusted as written.
 *
 * The module owns two things:
 *
 * 1. A compact, human-legible parameter shape (`q`, `type`, `status`, `sort`,
 *    `page`, `size`, and `<column>.<operator>` for the richer operators). A
 *    base64 blob would round-trip just as well but would be unreadable, and an
 *    unreadable link is one nobody can sanity-check before sending it.
 * 2. `sanitizeContentListViewState`, the single validator shared with the
 *    saved-views module (`content-list-saved-views.ts`), so a crafted URL and a
 *    tampered stored view are held to exactly the same allowlist.
 *
 * ## What may be restored
 *
 * | Aspect | Allowlist |
 * |--------|-----------|
 * | filters, sorting | `CONTENT_LIST_VISIBLE_COLUMN_IDS` — the columns the surface descriptor publishes with `filter`/`sort` capability |
 * | projection (order, visibility, widths, pinning) | `CONTENT_LIST_TABLE_COLUMN_IDS`, and a hidden column can never be forced visible |
 * | filter operators | `CONTENT_LIST_FILTER_OPERATORS` |
 * | filter values | strings only, normalized by `normalizeContentListFilterValue` |
 *
 * The search-only `description` column, the structural `select`/`actions`
 * columns, and any column id the adapter does not publish are dropped from
 * filters and sorting. Dropping — never throwing — is deliberate: a stale link
 * or an out-of-date saved view must still open the list, minus the parts that
 * are no longer meaningful.
 *
 * ## What is deliberately NOT URL state
 *
 * Selection and expansion are excluded, and `sanitizeContentListViewState`
 * never emits them either. A shared link must not carry another operator's
 * selection: the recipient would inherit a checked set they never chose, and
 * the very next bulk action — delete included — would run against it. Row ids
 * are also the one part of view state that leaks data (which specific contents
 * someone had singled out) into a URL that gets pasted into chat and tickets.
 */

import type {
  DataTableColumnPinning,
  DataTableColumnVisibility,
  DataTableColumnWidth,
  DataTableController,
  DataTableFilter,
  DataTableFilterOperator,
  DataTableSortRule,
  DataTableTransition,
  DataTableViewState,
} from '@happyvertical/smrt-ui/data';
import {
  CONTENT_LIST_ACTIONS_COLUMN_ID,
  CONTENT_LIST_HIDDEN_COLUMN_IDS,
  CONTENT_LIST_SELECTION_COLUMN_ID,
  CONTENT_LIST_TABLE_COLUMN_IDS,
  CONTENT_LIST_VISIBLE_COLUMN_IDS,
  normalizeContentListFilterValue,
} from './content-list-controller.js';

/** Query-string parameter carrying the free-text search. */
export const CONTENT_LIST_SEARCH_PARAM = 'q';
/** Query-string parameter carrying the ordered sort rules. */
export const CONTENT_LIST_SORT_PARAM = 'sort';
/** Query-string parameter carrying the 1-based page. */
export const CONTENT_LIST_PAGE_PARAM = 'page';
/** Query-string parameter carrying the page size. */
export const CONTENT_LIST_PAGE_SIZE_PARAM = 'size';

/**
 * Parameter names this module owns. A column may not shadow one of them; the
 * assertion below keeps that true if a future column is ever named `q` or
 * `page`.
 */
export const CONTENT_LIST_RESERVED_PARAMS = [
  CONTENT_LIST_SEARCH_PARAM,
  CONTENT_LIST_SORT_PARAM,
  CONTENT_LIST_PAGE_PARAM,
  CONTENT_LIST_PAGE_SIZE_PARAM,
] as const;

/** Separator between a column id and a non-default operator in a param name. */
const OPERATOR_SEPARATOR = '.';

/** Separator between entries of an `in`/`notIn` list value. */
const LIST_SEPARATOR = ',';

/**
 * Escape character for a list entry that contains the separator.
 *
 * Without it, `author in ["Smith, John"]` serializes to `Smith, John` and
 * restores as two values — a silently *different* query rather than a failed
 * one. Both the separator and the escape character itself are escaped on write
 * and unescaped on read, so the round trip is exact.
 */
const LIST_ESCAPE = '\\';

/**
 * The list entry that means the VALUE `null` — "and rows with no value at all".
 *
 * A query string carries text, and `null` has no natural text form: writing it
 * as `null` would be indistinguishable from an author actually called "null".
 * This token cannot collide with any real value, BY CONSTRUCTION rather than by
 * being unlikely: {@link escapeListEntry} doubles every backslash a real value
 * contains, so the only two-character sequences a real entry can begin with are
 * `\\` and `\,`. A lone backslash followed by `0` is therefore unreachable
 * from any string — including the literal two characters `\0`, which serialize
 * as `\\0` and read back as themselves.
 *
 * It survives URL encoding: `URLSearchParams` writes the backslash as `%5C` and
 * reads it back unchanged.
 */
const LIST_NULL_TOKEN = `${LIST_ESCAPE}0`;

function escapeListEntry(value: string | null): string {
  if (value === null) return LIST_NULL_TOKEN;
  return value.replace(/[\\,]/g, (character) => `${LIST_ESCAPE}${character}`);
}

/**
 * Splits on unescaped separators only, unescaping each entry as it goes.
 *
 * Returns `null` for {@link LIST_NULL_TOKEN}, which is a value rather than an
 * absence — an empty entry (`a,,b`) is the empty STRING and stays one.
 */
function splitListValue(raw: string): Array<string | null> {
  const entries: Array<string | null> = [];
  let current = '';
  let isNull = false;
  let escaped = false;
  for (const character of raw) {
    if (escaped) {
      // A backslash followed by `0` is the null token; every real backslash
      // arrives doubled, so this sequence cannot come from a string.
      if (character === '0' && current === '') isNull = true;
      else current += character;
      escaped = false;
      continue;
    }
    if (character === LIST_ESCAPE) {
      escaped = true;
      continue;
    }
    if (character === LIST_SEPARATOR) {
      entries.push(isNull ? null : current);
      current = '';
      isNull = false;
      continue;
    }
    current += character;
  }
  // A trailing lone escape is data, not a prefix: keep it rather than losing it.
  if (escaped) current += LIST_ESCAPE;
  entries.push(isNull ? null : current);
  return entries;
}

/**
 * Columns a restored filter or sort rule may address: exactly the columns the
 * surface descriptor publishes with `filter` and `sort` capability.
 */
export const CONTENT_LIST_QUERYABLE_COLUMN_IDS =
  CONTENT_LIST_VISIBLE_COLUMN_IDS;

/**
 * Operators a restored filter may use. This is the full DataTable operator
 * vocabulary the adapter's evaluator implements — narrower than "anything that
 * parses", so an unrecognized operator can never reach the query layer.
 */
export const CONTENT_LIST_FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'in',
  'notIn',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
] as const satisfies readonly DataTableFilterOperator[];

/** Operators that carry no value at all. */
const VALUELESS_OPERATORS = new Set<DataTableFilterOperator>([
  'isNull',
  'isNotNull',
]);

/** Operators whose value is a list rather than a scalar. */
const LIST_OPERATORS = new Set<DataTableFilterOperator>(['in', 'notIn']);

/**
 * Upper bound for a restored page size, mirroring the surface descriptor's
 * `limits.maxQueryRows`. A link is an untrusted input into a server query
 * (#2452), so `?size=1000000` must clamp rather than become a row budget.
 */
export const CONTENT_LIST_MAX_PAGE_SIZE = 200;

const QUERYABLE_COLUMNS = new Set<string>(CONTENT_LIST_QUERYABLE_COLUMN_IDS);
const HIDDEN_COLUMNS = new Set<string>(CONTENT_LIST_HIDDEN_COLUMN_IDS);
const STRUCTURAL_COLUMNS = new Set<string>([
  CONTENT_LIST_SELECTION_COLUMN_ID,
  CONTENT_LIST_ACTIONS_COLUMN_ID,
]);
const LAYOUT_COLUMNS = new Set<string>(CONTENT_LIST_TABLE_COLUMN_IDS);
const FILTER_OPERATORS = new Set<string>(CONTENT_LIST_FILTER_OPERATORS);
const RESERVED_PARAMS = new Set<string>(CONTENT_LIST_RESERVED_PARAMS);

for (const columnId of LAYOUT_COLUMNS) {
  if (RESERVED_PARAMS.has(columnId)) {
    throw new Error(
      `Content list column "${columnId}" collides with a reserved URL parameter`,
    );
  }
}

/** Why one piece of a restored view was discarded. */
export type ContentListStateDropReason =
  /** The column id is not published by the adapter at all. */
  | 'unknown-column'
  /** The column exists but is search-only and never published. */
  | 'hidden-column'
  /** The column is structural (`select`/`actions`) and carries no query. */
  | 'structural-column'
  /** The operator is outside `CONTENT_LIST_FILTER_OPERATORS`. */
  | 'unsupported-operator'
  /** The value is missing, blank, or not expressible as normalized text. */
  | 'unsupported-value'
  /** The entry is not shaped like the state it claims to be. */
  | 'malformed'
  /** The value was outside the accepted range and was clamped or reset. */
  | 'out-of-range';

/** Which part of the view a drop applies to. */
export type ContentListStateDropScope =
  /** The payload as a whole was not shaped like a view state. */
  | 'state'
  | 'search'
  | 'filter'
  | 'sorting'
  | 'page'
  | 'pageSize'
  | 'columnOrder'
  | 'columnVisibility'
  | 'columnWidths'
  | 'columnPinning';

/**
 * One discarded piece of a restored view. Reported rather than thrown so a UI
 * can tell the operator "this saved view referenced a column that no longer
 * exists" instead of failing to open the list.
 */
export interface ContentListStateDrop {
  scope: ContentListStateDropScope;
  reason: ContentListStateDropReason;
  columnId?: string;
  detail?: string;
}

/**
 * The validated subset of a view state.
 *
 * Deliberately `Partial`: only the aspects the source actually carried are
 * present, and selection/expansion are never present at all.
 */
export interface ContentListViewStateSanitization {
  state: Partial<DataTableViewState>;
  dropped: ContentListStateDrop[];
}

export interface ContentListStateValidationOptions {
  /** Overrides the clamp on a restored page size. */
  maxPageSize?: number;
}

export interface ContentListUrlStateOptions
  extends ContentListStateValidationOptions {
  /**
   * Namespaces every owned parameter, so two lists can share one URL. With a
   * prefix set, an unrecognized prefixed parameter is reported rather than
   * ignored as a foreign parameter.
   */
  prefix?: string;
  /**
   * The page size that is considered the default and therefore omitted from —
   * and filled back in by — the query string. Hosts that seed a page size must
   * pass the same value both ways or a clean link will restore as unpaginated.
   */
  defaultPageSize?: number | null;
}

/** Reading a URL additionally reports what it refused to restore. */
export interface ContentListUrlStateReading
  extends ContentListViewStateSanitization {
  state: Partial<DataTableViewState>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Classifies a column id for filtering and sorting. The three rejection
 * reasons are distinguished because they mean different things to an operator:
 * an unknown column is a stale or crafted link, a hidden column is an attempt
 * to reach a field the surface never publishes, and a structural column is a
 * category error.
 */
function classifyQueryColumn(
  columnId: string,
): 'allowed' | ContentListStateDropReason {
  if (QUERYABLE_COLUMNS.has(columnId)) return 'allowed';
  if (HIDDEN_COLUMNS.has(columnId)) return 'hidden-column';
  if (STRUCTURAL_COLUMNS.has(columnId)) return 'structural-column';
  return 'unknown-column';
}

/** Text a filter value may be expressed as. Objects and arrays are refused. */
function filterText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Normalizes one filter value the way the adapter does, so a filter restored
 * from a link compares equal to the same filter built by the toolbar.
 *
 * THREE outcomes, not two. Conflating the last two is what let a legitimate
 * value be discarded in three separate layers: each test asked whether the
 * value was PRESENT rather than whether it was VALID, and `null` reads as
 * absent to any check written with truthiness.
 *
 * - a string — the normalized value;
 * - `null` — the VALUE null, which names absence ("and rows with no value");
 * - `undefined` — unusable, and the only case a caller may drop.
 */
function normalizedFilterValue(
  columnId: string,
  raw: unknown,
): string | null | undefined {
  // A literal `null` is a value the caller wrote deliberately, not a missing
  // one. The executor lowers it to `IS NULL` / `IS NOT NULL` and the local
  // evaluator matches it through `isAbsentContentValue`; dropping it here
  // persisted a WIDER filter than the one in memory, so copying the link
  // brought back exactly the rows it excluded.
  if (raw === null) return null;
  const text = filterText(raw);
  if (text === null) return undefined;
  // A blank SCALAR clears the filter, matching `applyContentListFilter`. A
  // blank LIST entry is the empty string, which is a real value for a column
  // that stores one — see `sanitizeFilter`.
  if (text.trim() === '') return undefined;
  return normalizeContentListFilterValue(columnId, text);
}

function sanitizeFilter(
  raw: unknown,
  drops: ContentListStateDrop[],
): DataTableFilter | null {
  if (!isPlainObject(raw)) {
    drops.push({ scope: 'filter', reason: 'malformed' });
    return null;
  }
  const columnId = raw.columnId;
  if (typeof columnId !== 'string' || columnId.length === 0) {
    drops.push({ scope: 'filter', reason: 'malformed' });
    return null;
  }
  const classification = classifyQueryColumn(columnId);
  if (classification !== 'allowed') {
    drops.push({ scope: 'filter', reason: classification, columnId });
    return null;
  }
  const operator = raw.operator;
  if (typeof operator !== 'string' || !FILTER_OPERATORS.has(operator)) {
    drops.push({
      scope: 'filter',
      reason: 'unsupported-operator',
      columnId,
      detail: typeof operator === 'string' ? operator : undefined,
    });
    return null;
  }
  const typedOperator = operator as DataTableFilterOperator;
  if (VALUELESS_OPERATORS.has(typedOperator)) {
    return { columnId, operator: typedOperator };
  }
  if (LIST_OPERATORS.has(typedOperator)) {
    if (!Array.isArray(raw.value)) {
      drops.push({
        scope: 'filter',
        reason: 'unsupported-value',
        columnId,
        detail: operator,
      });
      return null;
    }
    const values: Array<string | null> = [];
    for (const entry of raw.value) {
      // An empty entry is the empty STRING — a real value for a column that
      // stores one, and one the list encoding round-trips natively (`a,,b`).
      // Only `undefined` means unusable.
      const normalized =
        typeof entry === 'string' && entry.trim() === ''
          ? ''
          : normalizedFilterValue(columnId, entry);
      if (normalized !== undefined && !values.includes(normalized)) {
        values.push(normalized);
      }
    }
    if (values.length === 0) {
      drops.push({
        scope: 'filter',
        reason: 'unsupported-value',
        columnId,
        detail: operator,
      });
      return null;
    }
    return { columnId, operator: typedOperator, value: values };
  }
  const value = normalizedFilterValue(columnId, raw.value);
  if (value === undefined) {
    drops.push({
      scope: 'filter',
      reason: 'unsupported-value',
      columnId,
      detail: operator,
    });
    return null;
  }
  return { columnId, operator: typedOperator, value };
}

function sanitizeFilters(
  raw: unknown,
  drops: ContentListStateDrop[],
): DataTableFilter[] {
  if (!Array.isArray(raw)) {
    drops.push({ scope: 'filter', reason: 'malformed' });
    return [];
  }
  const filters: DataTableFilter[] = [];
  for (const entry of raw) {
    const filter = sanitizeFilter(entry, drops);
    if (filter) filters.push(filter);
  }
  return filters;
}

function sanitizeSorting(
  raw: unknown,
  drops: ContentListStateDrop[],
): DataTableSortRule[] {
  if (!Array.isArray(raw)) {
    drops.push({ scope: 'sorting', reason: 'malformed' });
    return [];
  }
  const seen = new Set<string>();
  const sorting: DataTableSortRule[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.columnId !== 'string') {
      drops.push({ scope: 'sorting', reason: 'malformed' });
      continue;
    }
    const columnId = entry.columnId;
    const classification = classifyQueryColumn(columnId);
    if (classification !== 'allowed') {
      drops.push({ scope: 'sorting', reason: classification, columnId });
      continue;
    }
    if (entry.direction !== 'asc' && entry.direction !== 'desc') {
      drops.push({ scope: 'sorting', reason: 'malformed', columnId });
      continue;
    }
    // First rule wins, matching the controller's own sort normalization.
    if (seen.has(columnId)) continue;
    seen.add(columnId);
    sorting.push({ columnId, direction: entry.direction });
  }
  return sorting;
}

function sanitizeColumnOrder(
  raw: unknown,
  drops: ContentListStateDrop[],
): string[] {
  if (!Array.isArray(raw)) {
    drops.push({ scope: 'columnOrder', reason: 'malformed' });
    return [];
  }
  const order: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      drops.push({ scope: 'columnOrder', reason: 'malformed' });
      continue;
    }
    if (!LAYOUT_COLUMNS.has(entry)) {
      drops.push({
        scope: 'columnOrder',
        reason: 'unknown-column',
        columnId: entry,
      });
      continue;
    }
    if (!order.includes(entry)) order.push(entry);
  }
  return order;
}

function sanitizeColumnVisibility(
  raw: unknown,
  drops: ContentListStateDrop[],
): DataTableColumnVisibility[] {
  if (!Array.isArray(raw)) {
    drops.push({ scope: 'columnVisibility', reason: 'malformed' });
    return [];
  }
  const entries = new Map<string, boolean>();
  for (const entry of raw) {
    if (
      !isPlainObject(entry) ||
      typeof entry.columnId !== 'string' ||
      typeof entry.visible !== 'boolean'
    ) {
      drops.push({ scope: 'columnVisibility', reason: 'malformed' });
      continue;
    }
    const columnId = entry.columnId;
    if (!LAYOUT_COLUMNS.has(columnId)) {
      drops.push({
        scope: 'columnVisibility',
        reason: 'unknown-column',
        columnId,
      });
      continue;
    }
    // A search-only column stays hidden no matter what a stored view asks for:
    // making `description` visible would publish a field the surface
    // descriptor deliberately withholds.
    if (HIDDEN_COLUMNS.has(columnId)) {
      if (entry.visible) {
        drops.push({
          scope: 'columnVisibility',
          reason: 'hidden-column',
          columnId,
        });
      }
      entries.set(columnId, false);
      continue;
    }
    entries.set(columnId, entry.visible);
  }
  return [...entries.entries()].map(([columnId, visible]) => ({
    columnId,
    visible,
  }));
}

function sanitizeColumnWidths(
  raw: unknown,
  drops: ContentListStateDrop[],
): DataTableColumnWidth[] {
  if (!Array.isArray(raw)) {
    drops.push({ scope: 'columnWidths', reason: 'malformed' });
    return [];
  }
  const entries = new Map<string, number>();
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.columnId !== 'string') {
      drops.push({ scope: 'columnWidths', reason: 'malformed' });
      continue;
    }
    const columnId = entry.columnId;
    if (!LAYOUT_COLUMNS.has(columnId)) {
      drops.push({
        scope: 'columnWidths',
        reason: 'unknown-column',
        columnId,
      });
      continue;
    }
    const width = entry.width;
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
      drops.push({
        scope: 'columnWidths',
        reason: 'unsupported-value',
        columnId,
      });
      continue;
    }
    entries.set(columnId, width);
  }
  return [...entries.entries()].map(([columnId, width]) => ({
    columnId,
    width,
  }));
}

function sanitizeColumnPinning(
  raw: unknown,
  drops: ContentListStateDrop[],
): DataTableColumnPinning[] {
  if (!Array.isArray(raw)) {
    drops.push({ scope: 'columnPinning', reason: 'malformed' });
    return [];
  }
  const entries = new Map<string, DataTableColumnPinning['position']>();
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.columnId !== 'string') {
      drops.push({ scope: 'columnPinning', reason: 'malformed' });
      continue;
    }
    const columnId = entry.columnId;
    if (!LAYOUT_COLUMNS.has(columnId)) {
      drops.push({
        scope: 'columnPinning',
        reason: 'unknown-column',
        columnId,
      });
      continue;
    }
    if (entry.position !== 'start' && entry.position !== 'end') {
      drops.push({
        scope: 'columnPinning',
        reason: 'unsupported-value',
        columnId,
      });
      continue;
    }
    entries.set(columnId, entry.position);
  }
  return [...entries.entries()].map(([columnId, position]) => ({
    columnId,
    position,
  }));
}

function sanitizePage(raw: unknown, drops: ContentListStateDrop[]): number {
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw <= 0
  ) {
    drops.push({ scope: 'page', reason: 'malformed' });
    return 1;
  }
  return raw;
}

function sanitizePageSize(
  raw: unknown,
  maxPageSize: number,
  drops: ContentListStateDrop[],
): number | null {
  if (raw === null || raw === undefined) return null;
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw <= 0
  ) {
    drops.push({ scope: 'pageSize', reason: 'malformed' });
    return null;
  }
  if (raw > maxPageSize) {
    drops.push({
      scope: 'pageSize',
      reason: 'out-of-range',
      detail: String(raw),
    });
    return maxPageSize;
  }
  return raw;
}

/**
 * The single validator behind both restoration paths.
 *
 * Every restored aspect is re-derived from the adapter's published vocabulary,
 * so neither a crafted query string nor a tampered saved view can introduce a
 * filter, a sort rule, or a projection on a column the surface does not
 * publish. Invalid input is dropped and reported, never thrown, and selection
 * and expansion are never emitted.
 */
export function sanitizeContentListViewState(
  input: unknown,
  options: ContentListStateValidationOptions = {},
): ContentListViewStateSanitization {
  const dropped: ContentListStateDrop[] = [];
  if (!isPlainObject(input)) {
    return { state: {}, dropped: [{ scope: 'state', reason: 'malformed' }] };
  }
  const maxPageSize = options.maxPageSize ?? CONTENT_LIST_MAX_PAGE_SIZE;
  const state: Partial<DataTableViewState> = {};

  if (Object.hasOwn(input, 'search')) {
    if (typeof input.search === 'string') {
      state.search = input.search;
    } else {
      dropped.push({ scope: 'search', reason: 'malformed' });
      state.search = '';
    }
  }
  if (Object.hasOwn(input, 'filters')) {
    state.filters = sanitizeFilters(input.filters, dropped);
  }
  if (Object.hasOwn(input, 'sorting')) {
    state.sorting = sanitizeSorting(input.sorting, dropped);
  }
  if (Object.hasOwn(input, 'page')) {
    state.page = sanitizePage(input.page, dropped);
  }
  if (Object.hasOwn(input, 'pageSize')) {
    state.pageSize = sanitizePageSize(input.pageSize, maxPageSize, dropped);
  }
  if (Object.hasOwn(input, 'columnOrder')) {
    state.columnOrder = sanitizeColumnOrder(input.columnOrder, dropped);
  }
  if (Object.hasOwn(input, 'columnVisibility')) {
    state.columnVisibility = sanitizeColumnVisibility(
      input.columnVisibility,
      dropped,
    );
  }
  if (Object.hasOwn(input, 'columnWidths')) {
    state.columnWidths = sanitizeColumnWidths(input.columnWidths, dropped);
  }
  if (Object.hasOwn(input, 'columnPinning')) {
    state.columnPinning = sanitizeColumnPinning(input.columnPinning, dropped);
  }
  return { state, dropped };
}

/**
 * Merges a patch onto a controller's current state, validating it first.
 *
 * INVARIANT: no exported path may apply unvalidated state to a controller.
 * This function is the only application point the package publishes, and it is
 * routinely composed with values that came from somewhere untrusted — a query
 * string, a `localStorage` blob, an agent command. Sanitizing here means the
 * composition `applyContentListViewState(controller, storedView.snapshot.state)`
 * is safe even though the store's read path deliberately keeps the raw payload
 * so a stale view's drops can still be reported (see
 * `restoreContentListSavedView`). Sanitization is idempotent, so calling this
 * with an already-validated patch changes nothing.
 *
 * Only the *patch* is sanitized, never the merged result: the sanitizer never
 * emits selection or expansion, so sanitizing the merge would silently clear
 * the operator's current selection.
 *
 * Restoration is a state replacement rather than a command: it is not a user
 * interaction and must not reset the page the way `setSearch`/`setFilters` do.
 * Aspects the patch omits — selection and expansion above all — are carried
 * over from the controller untouched.
 *
 * Use {@link sanitizeContentListViewState} directly when the caller needs to
 * report what was refused.
 */
export function applyContentListViewState(
  controller: DataTableController,
  patch: Partial<DataTableViewState>,
  options: ContentListStateValidationOptions = {},
): DataTableTransition {
  const { state: safe } = sanitizeContentListViewState(patch, options);
  return controller.replaceState({ ...controller.getState(), ...safe });
}

function parameterName(name: string, prefix: string): string {
  return `${prefix}${name}`;
}

function filterParameterName(filter: DataTableFilter, prefix: string): string {
  return filter.operator === 'equals'
    ? parameterName(filter.columnId, prefix)
    : parameterName(
        `${filter.columnId}${OPERATOR_SEPARATOR}${filter.operator}`,
        prefix,
      );
}

function serializeSorting(sorting: readonly DataTableSortRule[]): string {
  return sorting
    .map((rule) =>
      rule.direction === 'desc' ? `-${rule.columnId}` : rule.columnId,
    )
    .join(LIST_SEPARATOR);
}

/**
 * Serializes a view state into shareable query parameters.
 *
 * The state is validated on the way out as well as on the way in: a link this
 * module produces can never carry a filter or sort on a column the surface
 * does not publish, even if the caller's controller somehow holds one.
 * Defaults are omitted so an untouched list produces a clean URL.
 */
export function contentListViewStateToSearchParams(
  state: Partial<DataTableViewState>,
  options: ContentListUrlStateOptions = {},
): URLSearchParams {
  const prefix = options.prefix ?? '';
  const defaultPageSize = options.defaultPageSize ?? null;
  const { state: safe } = sanitizeContentListViewState(state, options);
  const params = new URLSearchParams();

  // Written verbatim so the link round-trips exactly; only a search that is
  // blank once trimmed counts as the default and is omitted.
  const search = safe.search ?? '';
  if (search.trim()) {
    params.set(parameterName(CONTENT_LIST_SEARCH_PARAM, prefix), search);
  }

  for (const filter of safe.filters ?? []) {
    if (VALUELESS_OPERATORS.has(filter.operator)) {
      params.append(filterParameterName(filter, prefix), '1');
      continue;
    }
    if (Array.isArray(filter.value)) {
      params.append(
        filterParameterName(filter, prefix),
        filter.value
          .map((entry) =>
            escapeListEntry(entry === null ? null : String(entry)),
          )
          .join(LIST_SEPARATOR),
      );
      continue;
    }
    if (filter.value === null) {
      // `equals null` and `isNull` are the same predicate — both lower to
      // `eq null`, and the local evaluator answers them identically. The
      // valueless operator already has a query-string form, so the scalar null
      // is written as that rather than inventing a second token for it.
      const nullOperator =
        filter.operator === 'notEquals' ? 'isNotNull' : 'isNull';
      params.append(
        filterParameterName({ ...filter, operator: nullOperator }, prefix),
        '1',
      );
      continue;
    }
    params.append(
      filterParameterName(filter, prefix),
      String(filter.value ?? ''),
    );
  }

  if (safe.sorting?.length) {
    params.set(
      parameterName(CONTENT_LIST_SORT_PARAM, prefix),
      serializeSorting(safe.sorting),
    );
  }
  if (safe.page !== undefined && safe.page > 1) {
    params.set(
      parameterName(CONTENT_LIST_PAGE_PARAM, prefix),
      String(safe.page),
    );
  }
  if (safe.pageSize !== undefined && safe.pageSize !== defaultPageSize) {
    params.set(
      parameterName(CONTENT_LIST_PAGE_SIZE_PARAM, prefix),
      safe.pageSize === null ? 'all' : String(safe.pageSize),
    );
  }
  return params;
}

/**
 * Writes the owned parameters into a copy of an existing query string,
 * preserving every parameter this module does not own (routing keys, campaign
 * tags, a sibling list's prefixed parameters).
 */
export function mergeContentListViewStateIntoSearchParams(
  params: URLSearchParams,
  state: Partial<DataTableViewState>,
  options: ContentListUrlStateOptions = {},
): URLSearchParams {
  const prefix = options.prefix ?? '';
  const next = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (!ownedParameter(key, prefix)) next.append(key, value);
  }
  for (const [key, value] of contentListViewStateToSearchParams(
    state,
    options,
  ).entries()) {
    next.append(key, value);
  }
  return next;
}

/**
 * True when a parameter name belongs to this module's vocabulary, and may
 * therefore be *removed* while rewriting the query string.
 *
 * Ownership is decided by the BASE name only. A key such as `facet.contains`
 * carries a known operator suffix but names no ContentList column, so it is a
 * host's parameter and must survive — this module promises every parameter it
 * does not own is preserved, and deleting one silently breaks the host's own
 * routing on the very first filter change.
 *
 * This is deliberately narrower than the recognizer in
 * {@link readContentListViewStateFromSearchParams}, which reports an
 * operator-suffixed unknown column so a crafted `evil.contains=` stays visible.
 * Reporting a refusal and deleting a parameter are different acts.
 */
function ownedParameter(key: string, prefix: string): boolean {
  if (prefix && !key.startsWith(prefix)) return false;
  const name = prefix ? key.slice(prefix.length) : key;
  if (RESERVED_PARAMS.has(name)) return true;
  const separator = name.indexOf(OPERATOR_SEPARATOR);
  const columnId = separator === -1 ? name : name.slice(0, separator);
  return LAYOUT_COLUMNS.has(columnId);
}

function parseInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(value) ? value : null;
}

function parseSortParam(
  raw: string,
  drops: ContentListStateDrop[],
): DataTableSortRule[] {
  const rules: DataTableSortRule[] = [];
  for (const token of raw.split(LIST_SEPARATOR)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const direction = trimmed.startsWith('-') ? 'desc' : 'asc';
    const columnId =
      trimmed.startsWith('-') || trimmed.startsWith('+')
        ? trimmed.slice(1)
        : trimmed;
    if (!columnId) {
      drops.push({ scope: 'sorting', reason: 'malformed' });
      continue;
    }
    rules.push({ columnId, direction });
  }
  return rules;
}

/**
 * Reads a view state from query parameters and reports everything it refused.
 *
 * Foreign parameters are ignored silently: a shared link routinely carries
 * routing and campaign keys this module knows nothing about, and reporting
 * them as drops would bury the reports that matter. A parameter that *looks*
 * like a content-list filter — a known column, or any name carrying a known
 * operator suffix — is reported when it is refused, which is what makes a
 * crafted `description=` or `evil.contains=` visible rather than silent.
 */
export function readContentListViewStateFromSearchParams(
  params: URLSearchParams,
  options: ContentListUrlStateOptions = {},
): ContentListUrlStateReading {
  const prefix = options.prefix ?? '';
  const drops: ContentListStateDrop[] = [];
  const candidate: {
    search: string;
    filters: unknown[];
    sorting: DataTableSortRule[];
    page: number;
    pageSize: number | null;
  } = {
    search: '',
    filters: [],
    sorting: [],
    page: 1,
    pageSize: options.defaultPageSize ?? null,
  };

  for (const [key, value] of params.entries()) {
    if (prefix && !key.startsWith(prefix)) continue;
    const name = prefix ? key.slice(prefix.length) : key;
    if (name === CONTENT_LIST_SEARCH_PARAM) {
      candidate.search = value;
      continue;
    }
    if (name === CONTENT_LIST_SORT_PARAM) {
      candidate.sorting = [
        ...candidate.sorting,
        ...parseSortParam(value, drops),
      ];
      continue;
    }
    if (name === CONTENT_LIST_PAGE_PARAM) {
      const page = parseInteger(value);
      if (page === null || page < 1) {
        drops.push({ scope: 'page', reason: 'malformed', detail: value });
        continue;
      }
      candidate.page = page;
      continue;
    }
    if (name === CONTENT_LIST_PAGE_SIZE_PARAM) {
      // `all` is the only way a link can say "unpaginated" when the host's
      // default page size is a number, since an omitted parameter means default.
      if (value.trim() === 'all') {
        candidate.pageSize = null;
        continue;
      }
      const size = parseInteger(value);
      if (size === null || size < 1) {
        drops.push({ scope: 'pageSize', reason: 'malformed', detail: value });
        candidate.pageSize = options.defaultPageSize ?? null;
        continue;
      }
      candidate.pageSize = size;
      continue;
    }

    const separator = name.indexOf(OPERATOR_SEPARATOR);
    const columnId = separator === -1 ? name : name.slice(0, separator);
    const operator = separator === -1 ? 'equals' : name.slice(separator + 1);
    const recognizable =
      LAYOUT_COLUMNS.has(columnId) ||
      (separator !== -1 && FILTER_OPERATORS.has(operator)) ||
      Boolean(prefix);
    if (!recognizable) continue;
    if (separator !== -1 && !FILTER_OPERATORS.has(operator)) {
      drops.push({
        scope: 'filter',
        reason: 'unsupported-operator',
        columnId,
        detail: operator,
      });
      continue;
    }
    candidate.filters.push({
      columnId,
      operator,
      ...(VALUELESS_OPERATORS.has(operator as DataTableFilterOperator)
        ? {}
        : LIST_OPERATORS.has(operator as DataTableFilterOperator)
          ? // An entirely empty parameter (`?status.in=`) is a list with no
            // values, which the sanitizer refuses and reports. An empty entry
            // WITHIN a list (`?status.in=a,`) is the empty string, which is a
            // real value for a column that stores one.
            { value: value === '' ? [] : splitListValue(value) }
          : { value }),
    });
  }

  const sanitized = sanitizeContentListViewState(candidate, options);
  return { state: sanitized.state, dropped: [...drops, ...sanitized.dropped] };
}

/**
 * Reads a view state from query parameters.
 *
 * The result always carries `search`, `filters`, `sorting`, `page`, and
 * `pageSize` — an absent parameter restores that aspect's default, so a clean
 * link restores a clean view rather than leaving stale state in place. Use
 * {@link readContentListViewStateFromSearchParams} when the refusals matter.
 */
export function contentListViewStateFromSearchParams(
  params: URLSearchParams,
  options: ContentListUrlStateOptions = {},
): Partial<DataTableViewState> {
  return readContentListViewStateFromSearchParams(params, options).state;
}
