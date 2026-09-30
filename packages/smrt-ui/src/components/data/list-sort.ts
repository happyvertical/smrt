/**
 * List sorting — one contract for every list, client or server paginated.
 *
 * - A list declares its sortable columns and a default sort (usually its main
 *   date column, newest first).
 * - Clicking a header toggles that column between ascending and descending;
 *   a column not yet sorted starts at its `firstDirection` (dates and numbers
 *   usually `desc`, text `asc`). Sorting never "clears" back to unsorted: the
 *   list always has one well-defined order.
 * - Server-paginated lists keep the sort in the URL (`?sort=<column>&dir=<asc|desc>`)
 *   so the database orders the WHOLE result set, not just the current page.
 *   The default sort is omitted from the URL, and changing the sort drops the
 *   page parameter (back to page 1).
 * - Values are validated against the declared columns, so a URL or an agent
 *   command can only pick a declared column and a known direction.
 *
 * Pure functions, no Svelte or DOM: usable in `+page.server.ts` loads,
 * components, and data-surface handlers alike.
 */

export type ListSortDirection = 'asc' | 'desc';

export interface ListSort {
  columnId: string;
  direction: ListSortDirection;
}

export interface ListSortColumnSpec {
  id: string;
  /** Direction on the first click of this column (default `asc`; use `desc` for dates and counts). */
  firstDirection?: ListSortDirection;
}

/** A column offered by `ListSortSelect` (the phone / card-list sort picker). */
export interface ListSortSelectColumn {
  id: string;
  label: string;
  /** Picks the plain words: dates "newest first", numbers "highest first", text "A–Z". */
  kind?: 'date' | 'number' | 'text';
}

export interface ListSortSpec {
  /** Sortable columns. Ids are what the URL and agents use. */
  columns: readonly (ListSortColumnSpec | string)[];
  /** The list's order with no `sort` parameter. Must name a declared column. */
  default: ListSort;
  /** Query parameter names (default `sort` and `dir`). */
  sortParam?: string;
  dirParam?: string;
  /** Page parameter to drop when the sort changes (default `page`; `null` keeps it). */
  pageParam?: string | null;
}

function columnSpecs(spec: ListSortSpec): ListSortColumnSpec[] {
  return spec.columns.map((column) =>
    typeof column === 'string' ? { id: column } : column,
  );
}

function columnSpec(
  spec: ListSortSpec,
  columnId: string,
): ListSortColumnSpec | undefined {
  return columnSpecs(spec).find((column) => column.id === columnId);
}

function isDirection(value: unknown): value is ListSortDirection {
  return value === 'asc' || value === 'desc';
}

/** The ids of the sortable columns. */
export function listSortColumnIds(spec: ListSortSpec): string[] {
  return columnSpecs(spec).map((column) => column.id);
}

/** Whether `sort` names a declared column and a known direction. */
export function isValidListSort(
  spec: ListSortSpec,
  sort: Partial<ListSort> | null | undefined,
): sort is ListSort {
  return (
    !!sort &&
    typeof sort.columnId === 'string' &&
    columnSpec(spec, sort.columnId) !== undefined &&
    isDirection(sort.direction)
  );
}

/**
 * Read the sort from URL parameters. An unknown column falls back to the
 * default; a missing or unknown direction falls back to the column's first
 * direction (or the default's direction for the default column).
 */
export function parseListSort(
  params: URLSearchParams | { get(name: string): string | null },
  spec: ListSortSpec,
): ListSort {
  const columnId = params.get(spec.sortParam ?? 'sort');
  const direction = params.get(spec.dirParam ?? 'dir');
  const column = columnId ? columnSpec(spec, columnId) : undefined;
  if (!column) {
    return isDirection(direction) && !columnId
      ? { columnId: spec.default.columnId, direction }
      : { ...spec.default };
  }
  if (isDirection(direction)) return { columnId: column.id, direction };
  return {
    columnId: column.id,
    direction:
      column.id === spec.default.columnId
        ? spec.default.direction
        : (column.firstDirection ?? 'asc'),
  };
}

/** The sort after activating a column's header (toggle; never cleared). */
export function toggleListSort(
  current: ListSort,
  columnId: string,
  spec: ListSortSpec,
): ListSort {
  const column = columnSpec(spec, columnId);
  if (!column) return current;
  if (current.columnId === columnId) {
    return {
      columnId,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
  }
  return { columnId, direction: column.firstDirection ?? 'asc' };
}

/**
 * URL parameters for `sort`: sets (or, for the default, removes) the sort
 * parameters and drops the page parameter when the sort changed.
 */
export function listSortSearchParams(
  params: URLSearchParams | string,
  sort: ListSort,
  spec: ListSortSpec,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const sortParam = spec.sortParam ?? 'sort';
  const dirParam = spec.dirParam ?? 'dir';
  const previous = parseListSort(next, spec);
  const isDefault =
    sort.columnId === spec.default.columnId &&
    sort.direction === spec.default.direction;
  if (isDefault) {
    next.delete(sortParam);
    next.delete(dirParam);
  } else {
    next.set(sortParam, sort.columnId);
    next.set(dirParam, sort.direction);
  }
  const pageParam = spec.pageParam === undefined ? 'page' : spec.pageParam;
  if (
    pageParam &&
    (previous.columnId !== sort.columnId ||
      previous.direction !== sort.direction)
  ) {
    next.delete(pageParam);
  }
  return next;
}

/** `?query` string (with the leading `?`, or `''`) for a sort link. */
export function listSortHref(
  url: URL | { pathname: string; search: string },
  sort: ListSort,
  spec: ListSortSpec,
): string {
  const query = listSortSearchParams(url.search, sort, spec).toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

/** `aria-sort` for a header cell. */
export function listSortAria(
  current: ListSort | null | undefined,
  columnId: string,
): 'ascending' | 'descending' | 'none' {
  if (!current || current.columnId !== columnId) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}

/** A plain-language label for the header's action, e.g. "Sort by Date, newest first". */
export function listSortActionLabel(
  current: ListSort | null | undefined,
  columnId: string,
  label: string,
  spec?: ListSortSpec,
): string {
  const next = spec
    ? toggleListSort(current ?? spec.default, columnId, spec).direction
    : current?.columnId === columnId && current.direction === 'asc'
      ? 'desc'
      : 'asc';
  return `Sort by ${label}, ${next === 'asc' ? 'ascending' : 'descending'}`;
}

export type ListSortValue = string | number | boolean | Date | null | undefined;

function comparable(value: ListSortValue): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value;
}

/**
 * Compare two values for `direction`. Empty values (null, undefined, '',
 * invalid dates) always sort last. Strings compare with `localeCompare`
 * (numeric-aware, case-insensitive).
 */
export function compareListValues(
  left: ListSortValue,
  right: ListSortValue,
  direction: ListSortDirection,
): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const sign = direction === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
  return (
    String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    }) * sign
  );
}

/** A sorted copy of `rows` (stable; empties last). */
export function sortListRows<T>(
  rows: readonly T[],
  sort: ListSort | null | undefined,
  getValue: (row: T, columnId: string) => ListSortValue,
): T[] {
  if (!sort) return [...rows];
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        compareListValues(
          getValue(left.row, sort.columnId),
          getValue(right.row, sort.columnId),
          sort.direction,
        ) || left.index - right.index,
    )
    .map((entry) => entry.row);
}

/**
 * Resolve a sort to an allow-listed ORDER BY term for a server query. `map`
 * names the SQL expression (or ORM field) for each sortable column; the
 * result is only ever built from `map` values, never from the input.
 * Returns e.g. `COALESCE(c.publish_date, c.created_at) DESC NULLS LAST`.
 */
export function listSortOrderBy(
  sort: ListSort,
  map: Readonly<Record<string, string>>,
  options: { nulls?: 'last' | 'first' | false } = {},
): string {
  const expression = Object.hasOwn(map, sort.columnId)
    ? map[sort.columnId]
    : undefined;
  if (!expression) {
    throw new Error(`Unknown sort column: ${sort.columnId}`);
  }
  const nulls = options.nulls === undefined ? 'last' : options.nulls;
  return `${expression} ${sort.direction === 'asc' ? 'ASC' : 'DESC'}${
    nulls ? ` NULLS ${nulls === 'last' ? 'LAST' : 'FIRST'}` : ''
  }`;
}
