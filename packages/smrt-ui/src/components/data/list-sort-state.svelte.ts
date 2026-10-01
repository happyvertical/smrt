/**
 * Reactive list-sort state for pages — the one object a list's headers
 * (`SortableHeader list={...}`), phone picker (`ListSortSelect list={...}`),
 * rows (`sortListRows(rows, list.sort, ...)`), and data surface (`sort` /
 * `onSort`) share. Call during component initialisation.
 *
 * - `createUrlListSort(spec, { url, navigate })` — server-paginated lists:
 *   the sort lives in the URL (`?sort=&dir=`); headers are links, and `set`
 *   navigates. Framework-agnostic: pass the router's current URL and its
 *   navigate function (SvelteKit: `() => page.url` and `goto`).
 * - `createLocalListSort(spec)` — lists that load every row: page state.
 */
import {
  isValidListSort,
  type ListSort,
  type ListSortSpec,
  listSortHref,
  parseListSort,
  toggleListSort,
} from './list-sort.js';

export interface ListSortState {
  readonly sort: ListSort;
  readonly spec: ListSortSpec;
  /** Link to the list after activating `columnId`'s header (URL lists only). */
  href(columnId: string): string | undefined;
  /** Activate a header: toggle `columnId` (URL lists: the link navigates). */
  toggle(columnId: string): void | Promise<void>;
  /**
   * Apply a sort (headers, the "Sort by" picker, agents). A sort naming an
   * undeclared column or an unknown direction is ignored.
   */
  set(sort: ListSort): void | Promise<void>;
}

export interface UrlListSortOptions {
  /** The current URL (reactive, e.g. SvelteKit's `page.url`). */
  url: () =>
    | URL
    | { pathname: string; search: string; searchParams: URLSearchParams };
  /** Navigate to a same-page href (keep focus and scroll, replace history). */
  navigate: (href: string) => void | Promise<void>;
}

export function createUrlListSort(
  spec: ListSortSpec,
  options: UrlListSortOptions,
): ListSortState {
  const sort = $derived(parseListSort(options.url().searchParams, spec));
  return {
    get sort() {
      return sort;
    },
    spec,
    href: (columnId) =>
      listSortHref(options.url(), toggleListSort(sort, columnId, spec), spec),
    toggle: () => {},
    set: (next) => {
      if (!isValidListSort(spec, next)) return;
      return options.navigate(listSortHref(options.url(), next, spec));
    },
  };
}

export function createLocalListSort(
  spec: ListSortSpec,
  initial?: ListSort,
): ListSortState {
  let sort = $state<ListSort>(
    isValidListSort(spec, initial) ? { ...initial } : { ...spec.default },
  );
  return {
    get sort() {
      return sort;
    },
    spec,
    href: () => undefined,
    toggle: (columnId) => {
      sort = toggleListSort(sort, columnId, spec);
    },
    set: (next) => {
      if (!isValidListSort(spec, next)) return;
      sort = { columnId: next.columnId, direction: next.direction };
    },
  };
}
