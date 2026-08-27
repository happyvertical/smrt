/**
 * Shared content-list data adapter.
 *
 * Every ContentList presentation (grid, detailed, compact) and every
 * agent-addressable data surface resolves rows, columns, filters, sorting, and
 * per-row action eligibility here, so switching presentation can never change
 * which rows exist or what may be done to them.
 *
 * The module owns no transport, no DOM, and no routing: callers supply the
 * content array, a `getViewHref` resolver, and a `DataTableController` that
 * holds the serializable view state.
 *
 * Query modes are `manual`: this adapter, not the renderer, applies search,
 * filters, sorting, and paging, so a card view and the compact table can never
 * disagree about the visible rows. #2452 replaces the local implementation of
 * that transform with a server query behind the same contract.
 */

import {
  compareDataTableRowIds,
  createDataTableController,
  type DataSurfaceActionDescriptor,
  type DataSurfaceColumnDescriptor,
  type DataSurfaceDescriptor,
  type DataSurfaceLimits,
  type DataSurfaceRegistry,
  type DataSurfaceSubject,
  type DataTableColumn,
  type DataTableCommand,
  type DataTableController,
  type DataTableFilter,
  type DataTableRowId,
  type DataTableSortRule,
  type DataTableViewState,
  defaultSort,
  getNestedValue,
} from '@happyvertical/smrt-ui/data';
import type { ContentData } from '../mock-smrt-client.js';

/** Stable surface identity for the default mounted content list. */
export const CONTENT_LIST_SURFACE_ID = 'content-list';

/** Descriptor and view-state schema version owned by this adapter. */
export const CONTENT_LIST_SCHEMA_VERSION = 1;

/** Row identity column. Selection and expansion address rows by this value. */
export const CONTENT_LIST_ROW_KEY = 'id';

/** Stable filter ids dispatched by the toolbar and accepted from a surface. */
export const CONTENT_LIST_TYPE_FILTER_ID = 'type';
export const CONTENT_LIST_STATUS_FILTER_ID = 'status';

/** Prefix for rows the source array could not identify durably. */
const UNIDENTIFIED_ROW_PREFIX = 'content-list:unidentified:';

export type ContentListViewMode = 'grid' | 'detailed' | 'compact';

export type ContentListColumnId =
  | 'type'
  | 'title'
  | 'author'
  | 'status'
  | 'state'
  | 'publish'
  | 'updated'
  | 'site'
  | 'description';

export type ContentListActionId = 'view' | 'edit' | 'delete';

/** Columns rendered by the compact table and published to a data surface. */
export const CONTENT_LIST_VISIBLE_COLUMN_IDS = [
  'type',
  'title',
  'author',
  'status',
  'state',
  'publish',
  'updated',
  'site',
] as const satisfies readonly ContentListColumnId[];

/**
 * `description` is searched but never rendered or published: it participates in
 * local search so the rebuilt list keeps the legacy search reach.
 */
export const CONTENT_LIST_HIDDEN_COLUMN_IDS = [
  'description',
] as const satisfies readonly ContentListColumnId[];

export const CONTENT_LIST_COLUMN_IDS = [
  ...CONTENT_LIST_VISIBLE_COLUMN_IDS,
  ...CONTENT_LIST_HIDDEN_COLUMN_IDS,
] as const satisfies readonly ContentListColumnId[];

/**
 * Structural columns the compact table owns. They carry no query capability and
 * are never published to a data surface, but the controller still has to know
 * them: column order is reconciled from its known column ids, so leaving them
 * out would push selection and actions behind every data column.
 */
export const CONTENT_LIST_SELECTION_COLUMN_ID = 'select';
export const CONTENT_LIST_ACTIONS_COLUMN_ID = 'actions';

/** Every column of the compact table, in render order. */
export const CONTENT_LIST_TABLE_COLUMN_IDS = [
  CONTENT_LIST_SELECTION_COLUMN_ID,
  ...CONTENT_LIST_COLUMN_IDS,
  CONTENT_LIST_ACTIONS_COLUMN_ID,
] as const satisfies readonly string[];

/**
 * One resolved list row. Display values are flattened so a column accessor,
 * local search, and local sorting all read the same normalized text.
 */
export interface ContentListRow {
  /** Canonical row id used by Svelte keys, selection, and expansion. */
  id: DataTableRowId;
  /**
   * False when the source content carried no durable id, or repeated one that
   * an earlier row already claimed. Such rows still render, but they are never
   * selection-eligible because no stable address exists for them.
   */
  identified: boolean;
  content: ContentData;
  type: string;
  typeLabel: string;
  title: string;
  description: string;
  author: string;
  status: string;
  statusLabel: string;
  state: string;
  stateLabel: string;
  publish: string;
  publishLabel: string;
  updated: string;
  updatedLabel: string;
  site: string;
}

export type ContentListColumnLabels = Partial<
  Record<ContentListColumnId, string>
>;

export type ContentListActionLabels = Partial<
  Record<ContentListActionId, string>
>;

export interface ContentListControllerOptions {
  /** Initial free-text search. */
  search?: string;
  /** Locks or seeds the type filter. */
  type?: string | null;
  /** Seeds the status filter. */
  status?: string | null;
  /** Initial sort rules; empty keeps the caller-supplied order. */
  sorting?: readonly DataTableSortRule[];
  /** `null` keeps the historical unpaginated list. #2452 supplies a size. */
  pageSize?: number | null;
  onStateChange?: (
    state: DataTableViewState,
    command: DataTableCommand,
  ) => void;
}

export interface ContentListSurfaceDescriptorOptions {
  /** Distinguishes several mounted lists in one application. */
  surfaceId?: string;
  /** Optional owning subject, for example a site or a collection. */
  subject?: DataSurfaceSubject;
  label?: string;
  description?: string;
  /** Label for the declared row-key column. */
  rowKeyLabel?: string;
  columnLabels?: ContentListColumnLabels;
  actionLabels?: ContentListActionLabels;
  limits?: Partial<DataSurfaceLimits>;
}

/**
 * Opt-in agent addressability for the compact table. The host owns the
 * registry; the descriptor defaults to `buildContentListSurfaceDescriptor()`.
 */
export interface ContentListDataSurface {
  registry: DataSurfaceRegistry;
  descriptor?: DataSurfaceDescriptor;
}

export interface ContentListActionOptions {
  getViewHref?: (content: ContentData) => string | null;
  /** Hosts without an edit affordance can drop the action entirely. */
  canEdit?: boolean;
  /** Hosts without a delete affordance can drop the action entirely. */
  canDelete?: boolean;
}

const DEFAULT_COLUMN_LABELS: Record<ContentListColumnId, string> = {
  type: 'Type',
  title: 'Title',
  author: 'Author',
  status: 'Status',
  state: 'State',
  publish: 'Publish',
  updated: 'Updated',
  site: 'Site',
  description: 'Description',
};

/**
 * The `ContentData` field each published column reads. Column ids are stable
 * public identifiers and do not always match the field name, so the mapping is
 * explicit — advertising a field that does not exist would mislead an adapter
 * that maps a descriptor onto the model. `site` is derived from `url`/`source`
 * and therefore names no single field.
 */
const CONTENT_LIST_COLUMN_FIELD_NAMES: Partial<
  Record<ContentListColumnId, string>
> = {
  type: 'type',
  title: 'title',
  author: 'author',
  status: 'status',
  state: 'state',
  publish: 'publish_date',
  updated: 'updatedAt',
};

const DEFAULT_ACTION_LABELS: Record<ContentListActionId, string> = {
  view: 'View',
  edit: 'Edit',
  delete: 'Delete',
};

const DEFAULT_SURFACE_LIMITS: DataSurfaceLimits = {
  maxQueryRows: 200,
  maxQueryBytes: 50_000,
  maxSelectionSize: 200,
};

/** Local table commands a mounted content list accepts from a data surface. */
const CONTENT_LIST_CONTROLS: Array<{ id: string; label: string }> = [
  { id: 'set-search', label: 'Search contents' },
  { id: 'set-filters', label: 'Filter contents' },
  { id: 'set-sorting', label: 'Sort contents' },
  { id: 'toggle-sorting', label: 'Toggle column sorting' },
  { id: 'set-page', label: 'Change page' },
  { id: 'set-page-size', label: 'Change page size' },
  { id: 'set-selected-rows', label: 'Replace the row selection' },
  { id: 'toggle-row-selection', label: 'Toggle one row selection' },
  { id: 'reset', label: 'Reset the list view' },
  { id: 'focus', label: 'Focus the list' },
  { id: 'reveal', label: 'Scroll the list into view' },
  { id: 'highlight', label: 'Highlight the list' },
];

function getTextValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalizes a content type for filtering; unknown values become `content`. */
export function normalizeContentType(value: unknown): string {
  return getTextValue(value).trim().toLowerCase() || 'content';
}

/** Normalizes a status/state token for filtering and badge variants. */
export function normalizeContentToken(value: unknown): string {
  return getTextValue(value).trim().toLowerCase();
}

/**
 * The type tokens the toolbar select offers.
 *
 * `Content.type` is freeform, so this is a display vocabulary rather than the
 * model's domain: a value outside it is still a valid filter, and the list
 * surfaces it rather than hiding it (see `ContentList`).
 */
export const CONTENT_LIST_TYPE_OPTIONS = [
  'article',
  'document',
  'mirror',
] as const;

/**
 * The status tokens the toolbar select offers.
 *
 * `Content.status` is `published | draft | review | archived | deleted`.
 * `review` is offered because it is a real, reachable state that governance
 * puts content into; omitting it meant `?status=review` restored a live
 * predicate the toolbar could not show.
 *
 * `deleted` is deliberately NOT offered: it is the trash lifecycle, which is
 * #2454's, and exposing it here would imply a restore/purge affordance this
 * list does not have.
 */
export const CONTENT_LIST_STATUS_OPTIONS = [
  'published',
  'draft',
  'review',
  'archived',
] as const;

/**
 * Resolves the normalized type a `type` prop locks the list to, or `null` when
 * the list is unlocked. Shared so the lock effect and the initial restore
 * cannot disagree about what "locked" means.
 */
export function normalizeContentListTypeLock(
  value: string | null | undefined,
): string | null {
  return value?.trim() ? normalizeContentType(value) : null;
}

export function contentTypeLabel(value: unknown): string {
  switch (normalizeContentType(value)) {
    case 'article':
      return 'Article';
    case 'mirror':
      return 'Mirror';
    case 'document':
      return 'Document';
    default:
      return 'Content';
  }
}

/** Badge variant for a status; unrecognized statuses degrade to `unknown`. */
export function contentStatusVariant(value: unknown): string {
  switch (normalizeContentToken(value)) {
    case 'published':
      return 'published';
    case 'draft':
      return 'draft';
    case 'archived':
      return 'archived';
    default:
      return 'unknown';
  }
}

/** Badge variant for a workflow state; unrecognized states degrade to `unknown`. */
export function contentStateVariant(value: unknown): string {
  switch (normalizeContentToken(value)) {
    case 'highlighted':
      return 'highlighted';
    case 'active':
      return 'active';
    case 'deprecated':
      return 'deprecated';
    default:
      return 'unknown';
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function resolveSite(content: ContentData): string {
  const url = getTextValue(content.url);
  if (url) {
    const hostname = hostnameOf(url);
    if (hostname) return hostname;
  }
  return getTextValue(content.source);
}

/** Renders an ISO timestamp as a stable calendar date, or echoes free text. */
export function formatContentListDate(value: unknown): string {
  const text = getTextValue(value);
  if (!text) return '';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? text
    : parsed.toISOString().slice(0, 10);
}

/**
 * Resolves the rows every presentation renders.
 *
 * A content without a durable id — or one repeating an id an earlier row
 * already claimed — still renders, keyed by its position, but is marked
 * unidentified so it never enters a selection that outlives the current order.
 */
export function toContentListRows(
  contents: readonly ContentData[],
): ContentListRow[] {
  const claimed = new Set<string>();
  return contents.map((content, index) => {
    const declaredId = getTextValue(content.id);
    const identified = declaredId.length > 0 && !claimed.has(declaredId);
    if (identified) claimed.add(declaredId);
    const type = normalizeContentType(content.type);
    const status = normalizeContentToken(content.status);
    const state = normalizeContentToken(content.state);
    const publish = getTextValue(content.publish_date);
    const updated = getTextValue(content.updatedAt);
    return {
      id: identified ? declaredId : `${UNIDENTIFIED_ROW_PREFIX}${index}`,
      identified,
      content,
      type,
      typeLabel: contentTypeLabel(content.type),
      title: getTextValue(content.title) || 'Untitled content',
      description: getTextValue(content.description),
      author: getTextValue(content.author),
      status,
      statusLabel: getTextValue(content.status),
      state,
      stateLabel: getTextValue(content.state),
      publish,
      publishLabel: formatContentListDate(publish),
      updated,
      updatedLabel: formatContentListDate(updated),
      site: resolveSite(content),
    };
  });
}

/** Row ids that may take part in selection. Unidentified rows are excluded. */
export function selectableContentListRowIds(
  rows: readonly ContentListRow[],
): DataTableRowId[] {
  return rows.filter((row) => row.identified).map((row) => row.id);
}

/**
 * Resolves a selection to rows. Unidentified rows are dropped rather than
 * throwing, so one malformed content can never break a bulk workflow (#2453).
 */
export function resolveSelectedContentListRows(
  rows: readonly ContentListRow[],
  state: DataTableViewState,
): ContentListRow[] {
  const selected = new Set(state.selectedRowIds.map((rowId) => String(rowId)));
  return rows.filter((row) => row.identified && selected.has(String(row.id)));
}

/** The durable contents behind the current selection. */
export function resolveSelectedContents(
  rows: readonly ContentListRow[],
  state: DataTableViewState,
): ContentData[] {
  return resolveSelectedContentListRows(rows, state).map((row) => row.content);
}

/**
 * Column metadata shared by the compact table and the local query helpers.
 * Callers add cell snippets; they must not change ids, accessors, or the
 * searchable/filterable/sortable flags the descriptor is derived from.
 */
export function buildContentListColumns(
  labels: ContentListColumnLabels = {},
): DataTableColumn<ContentListRow>[] {
  const label = (id: ContentListColumnId) =>
    labels[id] ?? DEFAULT_COLUMN_LABELS[id];
  return [
    {
      id: 'type',
      label: label('type'),
      accessor: 'type',
      sortable: true,
      searchable: false,
      width: '8rem',
    },
    {
      id: 'title',
      label: label('title'),
      accessor: 'title',
      sortable: true,
    },
    {
      id: 'author',
      label: label('author'),
      accessor: 'author',
      sortable: true,
    },
    {
      id: 'status',
      label: label('status'),
      accessor: 'status',
      sortable: true,
      searchable: false,
      role: 'status',
    },
    {
      id: 'state',
      label: label('state'),
      accessor: 'state',
      sortable: true,
      searchable: false,
      role: 'status',
    },
    {
      id: 'publish',
      label: label('publish'),
      accessor: 'publish',
      sortable: true,
      searchable: false,
    },
    {
      id: 'updated',
      label: label('updated'),
      accessor: 'updated',
      sortable: true,
      searchable: false,
    },
    {
      id: 'site',
      label: label('site'),
      accessor: 'site',
      sortable: true,
      searchable: false,
    },
    {
      id: 'description',
      label: label('description'),
      accessor: 'description',
      sortable: false,
      filterable: false,
      hidden: true,
    },
  ];
}

/**
 * Columns whose stored values are lowercase tokens rather than free text.
 *
 * Only these may have their case normalized by a filter: their domain is a
 * fixed vocabulary the model writes in lower case, so folding the operator's
 * input to match it is a correction. Every other column holds text a person
 * typed.
 */
export const CONTENT_LIST_TOKEN_COLUMN_IDS = [
  'type',
  'status',
  'state',
] as const satisfies readonly ContentListColumnId[];

const TOKEN_COLUMNS = new Set<string>(CONTENT_LIST_TOKEN_COLUMN_IDS);

/**
 * One normalizer per filter column, so a filter built by the toolbar, by the
 * `type` lock, and by a restored view all compare equal.
 *
 * CASE IS PRESERVED FOR FREE TEXT. This helper was written for #2451, when
 * every comparison happened in the browser and lowercasing everything was
 * harmless. Under #2452 a stored filter value becomes a server-side `eq` or
 * `like` predicate compared against the STORED text, so lowercasing `NASA`
 * would send `%nasa%` and miss `NASA Update` on a case-sensitive backend
 * (PostgreSQL, DuckDB). Local matching is unaffected either way: the local
 * evaluator compares through `textValue()`, which lower-cases BOTH sides at
 * compare time, so a case-preserving stored value still matches
 * case-insensitively there.
 */
export function normalizeContentListFilterValue(
  columnId: string,
  value: string,
): string {
  if (columnId === CONTENT_LIST_TYPE_FILTER_ID)
    return normalizeContentType(value);
  if (TOKEN_COLUMNS.has(columnId)) return normalizeContentToken(value);
  return value.trim();
}

/** Builds the declarative filter set for the two toolbar filters. */
export function contentListFilters(values: {
  type?: string | null;
  status?: string | null;
}): DataTableFilter[] {
  const filters: DataTableFilter[] = [];
  if (values.type?.trim()) {
    filters.push({
      columnId: CONTENT_LIST_TYPE_FILTER_ID,
      operator: 'equals',
      value: normalizeContentListFilterValue(
        CONTENT_LIST_TYPE_FILTER_ID,
        values.type,
      ),
    });
  }
  if (values.status?.trim()) {
    filters.push({
      columnId: CONTENT_LIST_STATUS_FILTER_ID,
      operator: 'equals',
      value: normalizeContentListFilterValue(
        CONTENT_LIST_STATUS_FILTER_ID,
        values.status,
      ),
    });
  }
  return filters;
}

/**
 * Reads one filter's value, or `null` when the filter is not applied.
 *
 * Value-only, and therefore NOT enough to drive a single-select toolbar
 * control: it reports the same string for `equals 'draft'` and
 * `notEquals 'draft'`. Use {@link readContentListSelectFilter} for anything
 * that displays the filter to an operator.
 */
export function readContentListFilter(
  state: DataTableViewState,
  columnId: string,
): string | null {
  const filter = state.filters.find(
    (candidate) => candidate.columnId === columnId,
  );
  return typeof filter?.value === 'string' ? filter.value : null;
}

/**
 * The value a toolbar select carries while a live filter cannot be represented
 * as one of its options. It is only ever set programmatically on a disabled
 * option, so it can never be submitted; `applyContentListFilter` would replace
 * every filter on the column anyway.
 */
export const CONTENT_LIST_UNREPRESENTABLE_OPTION = '\u0000unrepresentable';

/** What a single-select toolbar control can honestly display for one column. */
export interface ContentListSelectFilterState {
  /** The value to display, or `''` when there is nothing to display. */
  value: string;
  /**
   * False when a live filter exists on this column that a single select cannot
   * express — a non-`equals` operator, a list value, a valueless operator, or
   * more than one filter. The caller must then not render a plain value: it
   * would state something other than the query being run.
   */
  representable: boolean;
  /** A short, operator-facing summary of the live predicate when it is not. */
  detail: string | null;
}

function describeContentListFilter(filter: DataTableFilter): string {
  if (filter.value === undefined) return filter.operator;
  const value = Array.isArray(filter.value)
    ? filter.value.map(String).join(', ')
    : String(filter.value);
  return `${filter.operator} ${value}`;
}

/**
 * Resolves what a toolbar select may show for one column.
 *
 * A select offers a single `equals` value, but the filter vocabulary a link or
 * a saved view can restore is much wider. `?status.in=draft,review` and
 * `?status.isNull=1` constrain the query while a value-only read reports
 * nothing, and `?status.notEquals=draft` reports `draft` — the exact inverse of
 * what is being applied. This is the seam that keeps the control from
 * misstating the query: either it can show the predicate exactly, or the caller
 * is told it cannot and reports it.
 */
export function readContentListSelectFilter(
  state: DataTableViewState,
  columnId: string,
): ContentListSelectFilterState {
  const applied = state.filters.filter(
    (candidate) => candidate.columnId === columnId,
  );
  if (applied.length === 0) {
    return { value: '', representable: true, detail: null };
  }
  const unrepresentable = (): ContentListSelectFilterState => ({
    value: '',
    representable: false,
    detail: applied.map(describeContentListFilter).join('; '),
  });
  if (applied.length > 1) return unrepresentable();
  const [filter] = applied;
  if (filter.operator !== 'equals' || typeof filter.value !== 'string') {
    return unrepresentable();
  }
  return { value: filter.value, representable: true, detail: null };
}

/**
 * True when a column is filtered to exactly the given value and nothing else.
 *
 * A locked filter has to be checked as a whole rather than by reading one
 * value: a `notEquals` on the locked value, or a second filter on the same
 * column, would otherwise satisfy a value-only comparison while selecting rows
 * the lock is meant to exclude.
 */
export function isContentListFilterExactly(
  state: DataTableViewState,
  columnId: string,
  value: string,
): boolean {
  const applied = state.filters.filter(
    (filter) => filter.columnId === columnId,
  );
  return (
    applied.length === 1 &&
    applied[0].operator === 'equals' &&
    applied[0].value === normalizeContentListFilterValue(columnId, value)
  );
}

/**
 * Replaces one filter while preserving the others, so locking the type filter
 * never discards a status the operator chose.
 *
 * A blank value clears the filter: normalizing whitespace into an `equals ''`
 * filter would silently exclude every row instead.
 */
export function applyContentListFilter(
  controller: DataTableController,
  columnId: string,
  value: string | null,
): void {
  const current = controller
    .getState()
    .filters.filter((filter) => filter.columnId !== columnId);
  const requested = typeof value === 'string' ? value.trim() : '';
  const next = requested
    ? [
        ...current,
        {
          columnId,
          operator: 'equals' as const,
          value: normalizeContentListFilterValue(columnId, requested),
        },
      ]
    : current;
  controller.dispatch({ type: 'setFilters', filters: next });
}

export function createContentListController(
  options: ContentListControllerOptions = {},
): DataTableController {
  return createDataTableController({
    columnIds: CONTENT_LIST_TABLE_COLUMN_IDS,
    hiddenColumnIds: CONTENT_LIST_HIDDEN_COLUMN_IDS,
    // This adapter owns the transform in every presentation, so the renderer
    // must not apply a second, subtly different pass over the same rows.
    modes: { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
    initialState: {
      search: options.search ?? '',
      filters: contentListFilters({
        type: options.type ?? null,
        status: options.status ?? null,
      }),
      sorting: options.sorting ? [...options.sorting] : [],
      pageSize: options.pageSize ?? null,
    },
    onStateChange: options.onStateChange,
  });
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).toLowerCase();
  }
  return JSON.stringify(value)?.toLowerCase() ?? '';
}

function sameFilterValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined
  ) {
    return false;
  }
  return textValue(left) === textValue(right);
}

function compareFilterValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const leftText = textValue(left);
  const rightText = textValue(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

/**
 * True when the content behind a row carries no value at all for a column.
 *
 * `ContentListRow` flattens every field to display text, so an absent value and
 * an empty one both read as `''` — which made every ordered comparison treat
 * "no author" as the smallest possible author, and made `isNull` match nothing.
 * The original `ContentData` still distinguishes them, so the null-sensitive
 * operators consult it. A derived column such as `site` has no single source
 * field and is never absent.
 */
function isAbsentContentValue(
  row: ContentListRow,
  column: DataTableColumn<ContentListRow>,
): boolean {
  const fieldName =
    CONTENT_LIST_COLUMN_FIELD_NAMES[column.id as ContentListColumnId];
  if (!fieldName) return false;
  const source = (row.content as Record<string, unknown>)[fieldName];
  return source === null || source === undefined;
}

/**
 * The single declarative-filter evaluator. It follows DataTable's operator
 * semantics so a persisted or agent-issued filter behaves the same here as it
 * would in a locally filtered table.
 *
 * The null-sensitive operators (`gt`/`gte`/`lt`/`lte`, `isNull`/`isNotNull`)
 * additionally agree with SQL, so the same shared link means the same thing on
 * a client-array list and a server-backed one (#2452).
 */
function matchesContentListFilter(
  row: ContentListRow,
  column: DataTableColumn<ContentListRow>,
  filter: DataTableFilter,
): boolean {
  if (column.filterable === false) return true;
  const value = getNestedValue(row, String(column.accessor ?? column.id));
  const expected = filter.value;
  const valueText = textValue(value);
  const expectedText = textValue(expected);
  switch (filter.operator) {
    case 'equals':
      return sameFilterValue(value, expected);
    case 'notEquals':
      return !sameFilterValue(value, expected);
    case 'contains':
      return valueText.includes(expectedText);
    case 'notContains':
      return !valueText.includes(expectedText);
    case 'startsWith':
      return valueText.startsWith(expectedText);
    case 'endsWith':
      return valueText.endsWith(expectedText);
    case 'in':
      return (
        Array.isArray(expected) &&
        expected.some((entry) => sameFilterValue(value, entry))
      );
    case 'notIn':
      return (
        Array.isArray(expected) &&
        !expected.some((entry) => sameFilterValue(value, entry))
      );
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // An absent value takes part in no ordered comparison, exactly as SQL
      // yields UNKNOWN for NULL. Without this the flattened empty string sorts
      // below everything, so `publish_date lt X` would match every row that was
      // never published — and disagree with the server for the same link.
      if (isAbsentContentValue(row, column)) return false;
      const comparison = compareFilterValues(value, expected);
      if (filter.operator === 'gt') return comparison > 0;
      if (filter.operator === 'gte') return comparison >= 0;
      if (filter.operator === 'lt') return comparison < 0;
      return comparison <= 0;
    }
    case 'isNull':
      return (
        isAbsentContentValue(row, column) ||
        value === null ||
        value === undefined
      );
    case 'isNotNull':
      return !(
        isAbsentContentValue(row, column) ||
        value === null ||
        value === undefined
      );
    default:
      return false;
  }
}

/**
 * Applies search, declarative filters, and sorting once for every
 * presentation. Pagination stays separate so a caller can report the unpaged
 * result count (DataTable's `totalRows`) alongside the current page.
 */
export function selectContentListRows(
  rows: readonly ContentListRow[],
  state: DataTableViewState,
  columns: DataTableColumn<ContentListRow>[] = buildContentListColumns(),
): ContentListRow[] {
  const search = state.search.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (
      search &&
      !columns.some(
        (column) =>
          column.searchable !== false &&
          textValue(
            getNestedValue(row, String(column.accessor ?? column.id)),
          ).includes(search),
      )
    ) {
      return false;
    }
    return state.filters.every((filter) => {
      const column = columns.find(
        (candidate) => candidate.id === filter.columnId,
      );
      return Boolean(column && matchesContentListFilter(row, column, filter));
    });
  });

  if (state.sorting.length === 0) return filtered;
  return filtered.slice().sort((left, right) => {
    for (const rule of state.sorting) {
      const column = columns.find(
        (candidate) => candidate.id === rule.columnId,
      );
      if (!column) continue;
      const result = defaultSort(
        left,
        right,
        String(column.accessor ?? column.id),
        rule.direction,
      );
      if (result !== 0) return result;
    }
    return compareDataTableRowIds(left.id, right.id);
  });
}

/** Slices the current page. An unset page size keeps the whole result. */
export function paginateContentListRows(
  rows: readonly ContentListRow[],
  state: DataTableViewState,
): ContentListRow[] {
  if (!state.pageSize) return [...rows];
  const start = (state.page - 1) * state.pageSize;
  return rows.slice(start, start + state.pageSize);
}

/**
 * Resolves the host-owned view link. An unknown subtype — or a resolver that
 * throws on one — degrades to plain text rather than a dead link.
 */
export function resolveContentHref(
  content: ContentData,
  getViewHref?: (content: ContentData) => string | null,
): string | null {
  if (!getViewHref) return null;
  try {
    const href = getViewHref(content);
    return typeof href === 'string' && href.length > 0 ? href : null;
  } catch {
    return null;
  }
}

/**
 * Per-row action eligibility, used identically by all three presentations.
 * `view` requires a resolvable href, so unpublished content never renders one.
 */
export function contentListRowActions(
  row: ContentListRow,
  options: ContentListActionOptions = {},
): ContentListActionId[] {
  const actions: ContentListActionId[] = [];
  if (resolveContentHref(row.content, options.getViewHref))
    actions.push('view');
  if (options.canEdit !== false) actions.push('edit');
  if (options.canDelete !== false) actions.push('delete');
  return actions;
}

function surfaceColumn(
  id: ContentListColumnId,
  labels: ContentListColumnLabels,
  order: number,
  column: DataTableColumn<ContentListRow>,
): DataSurfaceColumnDescriptor {
  const capabilities: DataSurfaceColumnDescriptor['capabilities'] = [
    'read',
    'filter',
    'sort',
    'project',
  ];
  if (column.searchable !== false) capabilities.push('search');
  const fieldName = CONTENT_LIST_COLUMN_FIELD_NAMES[id];
  return {
    id,
    label: labels[id] ?? DEFAULT_COLUMN_LABELS[id],
    capabilities,
    ...(fieldName ? { fieldName } : {}),
    visibility: 'basic',
    order,
    role: column.role === 'status' ? 'status' : 'data',
  };
}

/**
 * Builds the discovery contract for a mounted content list. Only rendered
 * columns are published: the search-only `description` column stays private.
 */
export function buildContentListSurfaceDescriptor(
  options: ContentListSurfaceDescriptorOptions = {},
): DataSurfaceDescriptor {
  const columnLabels = options.columnLabels ?? {};
  const actionLabels = options.actionLabels ?? {};
  const columns = buildContentListColumns(columnLabels);
  const visibleColumns = CONTENT_LIST_VISIBLE_COLUMN_IDS.map((id, index) => {
    const column = columns.find((candidate) => candidate.id === id);
    if (!column) {
      throw new Error(`Missing content list column definition: ${id}`);
    }
    return surfaceColumn(id, columnLabels, index, column);
  });
  // The row-key column must be declared even though the table renders identity
  // through Svelte keys rather than a visible column.
  const rowKeyColumn: DataSurfaceColumnDescriptor = {
    id: CONTENT_LIST_ROW_KEY,
    label: options.rowKeyLabel ?? 'Content id',
    capabilities: ['read', 'project'],
    fieldName: CONTENT_LIST_ROW_KEY,
    role: 'row-key',
  };
  const columnIds = visibleColumns.map((column) => column.id);
  const searchableColumnIds = visibleColumns
    .filter((column) => column.capabilities.includes('search'))
    .map((column) => column.id);
  const actions: DataSurfaceActionDescriptor[] = [
    {
      id: 'view',
      label: actionLabels.view ?? DEFAULT_ACTION_LABELS.view,
      selectionScopes: ['explicit-ids'],
      columnIds: ['title'],
    },
    {
      id: 'edit',
      label: actionLabels.edit ?? DEFAULT_ACTION_LABELS.edit,
      selectionScopes: ['explicit-ids'],
    },
    {
      id: 'delete',
      label: actionLabels.delete ?? DEFAULT_ACTION_LABELS.delete,
      sensitivity: 'sensitive',
      selectionScopes: ['explicit-ids', 'current-page'],
      requiresConfirmation: true,
    },
  ];
  return {
    version: 1,
    identity: {
      surfaceId: options.surfaceId ?? CONTENT_LIST_SURFACE_ID,
      kind: 'table',
      ...(options.subject ? { subject: options.subject } : {}),
    },
    schemaVersion: CONTENT_LIST_SCHEMA_VERSION,
    label: options.label ?? 'Contents',
    ...(options.description ? { description: options.description } : {}),
    rowKey: CONTENT_LIST_ROW_KEY,
    columns: [rowKeyColumn, ...visibleColumns],
    query: {
      modes: ['rows', 'count'],
      projectableColumnIds: [CONTENT_LIST_ROW_KEY, ...columnIds],
      searchableColumnIds,
      filterableColumnIds: columnIds,
      sortableColumnIds: columnIds,
    },
    controls: CONTENT_LIST_CONTROLS.map((control) => ({ ...control })),
    actions,
    limits: { ...DEFAULT_SURFACE_LIMITS, ...options.limits },
  };
}
