/**
 * `useListSurface` — mount a page's rendered list on the nearest
 * `<Provider webmcp>` data-surface registry in one call.
 *
 * A thin convenience over {@link mountListDataSurface} that owns the whole
 * lifecycle (descriptor, controller, identity-keyed re-mount, context
 * updates, destroy) and adds what a bare mount does not:
 *
 * - the visible rows, projected to the declared columns and capped, are
 *   published as `state.rows`, so an agent reading the surface sees what the
 *   person sees even on a page with no server catalog surface;
 * - a `find` control (when any column is `searchable`) looks rows up by text:
 *   payload `{ text }` (or a bare string) keeps the rows whose searchable
 *   columns contain it, case-insensitively, across ALL rows — not only the
 *   published first page — and publishes them as `state.rows` with
 *   `state.find = { text, matches }`. An empty text clears it. It narrows
 *   only what the agent reads; the page's own list is unchanged.
 *
 * - sorting (when `sort` and `onSort` are given): the current order is
 *   published as `state.sort` and in the table snapshot, `sortable` columns
 *   are declared sortable, and a `set-sorting` control
 *   (`{ sorting: [{ columnId, direction }] }`, one rule) calls `onSort` — the
 *   same path the page's own column headers take, so a server-paginated
 *   list re-queries in that order (see `list-sort` in
 *   `@happyvertical/smrt-ui/data`).
 *
 * Otherwise a read-only mirror: no remote filter/page/selection commands are
 * accepted (the page's own controls stay the source of truth); `refresh` is
 * honoured when supplied. Only declared columns leave the page: never declare
 * a secret (tokens, keys), and mark names/emails the person can see as
 * `personal`. No-op without a WebMCP Provider. Call during component init.
 */
import {
  createDataTableController,
  type DataSurfaceDescriptor,
  type DataSurfaceJsonValue,
  type DataSurfaceKind,
  type DataSurfaceRegistry,
  type DataSurfaceSubject,
  type DataTableController,
  type DataTableViewState,
  type ListSort,
} from '@happyvertical/smrt-ui/data';
import { onDestroy } from 'svelte';
import {
  type ListDataSurfaceHandle,
  mountListDataSurface,
} from './list-data-surface.svelte.js';
import { tryGetWebMcpUiContext } from './webmcp-ui-context.js';

export interface ListSurfaceColumn {
  id: string;
  label: string;
  description?: string;
  /** The row identity column (exactly one; defaults to the first column). */
  rowKey?: boolean;
  /** A status column (drives status badges in generic renderers). */
  status?: boolean;
  /** Text an agent can look rows up by with the `find` control. */
  searchable?: boolean;
  /** `personal` for names/emails a person sees on the page; never declare secrets. */
  sensitivity?: 'public' | 'personal';
  /** The list can be ordered by this column (needs `sort` + `onSort` on the options). */
  sortable?: boolean;
}

type JsonPrimitive = string | number | boolean | null;

export interface ListSurfaceOptions {
  surfaceId: string;
  kind?: DataSurfaceKind;
  subject?: DataSurfaceSubject;
  label: string;
  description: string;
  columns: readonly ListSurfaceColumn[];
  /** The rows as rendered (after the page's own filters), any shape. */
  rows: readonly object[];
  /** Extra JSON state, e.g. the active filter. */
  context?: Record<string, DataSurfaceJsonValue>;
  refresh?: () => boolean | Promise<boolean>;
  /** Cap on published rows (default 50). */
  maxRows?: number;
  /** The list's current order, as the page shows it. */
  sort?: ListSort | null;
  /**
   * Re-order the list (the page's header-click path). Return `false` to deny.
   * Server-sorted lists navigate to the new `?sort=&dir=` URL here.
   */
  onSort?: (
    sort: ListSort,
  ) => boolean | undefined | Promise<boolean | undefined>;
}

function sortEnabled(options: ListSurfaceOptions): boolean {
  return (
    typeof options.onSort === 'function' &&
    options.columns.some((column) => column.sortable)
  );
}

const DEFAULT_MAX_ROWS = 50;
const MAX_QUERY_ROWS = 300;
const MAX_FIND_TEXT = 200;

function toJsonPrimitive(value: unknown): JsonPrimitive {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

/** Project rows to the declared columns only; everything else is dropped. */
export function projectListRows(
  rows: readonly object[],
  columns: readonly ListSurfaceColumn[],
  maxRows = DEFAULT_MAX_ROWS,
): Array<Record<string, JsonPrimitive>> {
  return rows.slice(0, maxRows).map((row) => {
    const projected: Record<string, JsonPrimitive> = {};
    for (const column of columns) {
      projected[column.id] = toJsonPrimitive(
        (row as Record<string, unknown>)[column.id],
      );
    }
    return projected;
  });
}

function normalizeText(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Rows whose searchable columns contain `text` (case- and accent-insensitive). */
export function findListRows<T extends object>(
  rows: readonly T[],
  columns: readonly ListSurfaceColumn[],
  text: string,
): T[] {
  const wanted = normalizeText(text);
  if (!wanted) return [...rows];
  const searchable = columns.filter((column) => column.searchable);
  return rows.filter((row) =>
    searchable.some((column) => {
      const value = (row as Record<string, unknown>)[column.id];
      return (
        (typeof value === 'string' || typeof value === 'number') &&
        normalizeText(String(value))
          .replace(/\p{M}/gu, '')
          .includes(wanted.replace(/\p{M}/gu, ''))
      );
    }),
  );
}

/** The descriptor {@link useListSurface} mounts. */
export function listSurfaceDescriptor(
  options: ListSurfaceOptions,
): DataSurfaceDescriptor {
  const rowKey =
    options.columns.find((column) => column.rowKey)?.id ??
    options.columns[0]?.id ??
    'id';
  const searchableIds = options.columns
    .filter((column) => column.searchable)
    .map((column) => column.id);
  const sortableIds = sortEnabled(options)
    ? options.columns
        .filter((column) => column.sortable)
        .map((column) => column.id)
    : [];
  const columns: DataSurfaceDescriptor['columns'] = options.columns.map(
    (column) => ({
      id: column.id,
      label: column.label,
      ...(column.description ? { description: column.description } : {}),
      ...(column.sensitivity ? { sensitivity: column.sensitivity } : {}),
      capabilities: [
        'read',
        ...(column.searchable ? (['search'] as const) : []),
        ...(sortableIds.includes(column.id) ? (['sort'] as const) : []),
      ],
      ...(sortableIds.includes(column.id)
        ? { operators: { sort: ['asc', 'desc'] as const } }
        : {}),
      ...(column.id === rowKey
        ? { role: 'row-key' as const }
        : column.status
          ? { role: 'status' as const }
          : {}),
    }),
  );
  const searchLabels = options.columns
    .filter((column) => column.searchable)
    .map((column) => column.label.toLowerCase());
  return {
    version: 1,
    identity: {
      kind: options.kind ?? 'list',
      surfaceId: options.surfaceId,
      ...(options.subject ? { subject: options.subject } : {}),
    },
    schemaVersion: 1,
    label: options.label,
    description: options.description,
    rowKey,
    columns,
    query: {
      modes: ['rows'],
      projectableColumnIds: columns.map((column) => column.id),
      ...(searchableIds.length > 0
        ? { searchableColumnIds: searchableIds }
        : {}),
      filterableColumnIds: [],
      sortableColumnIds: sortableIds,
    },
    controls: [
      ...(options.refresh ? [{ id: 'refresh', label: 'Refresh' }] : []),
      ...(sortableIds.length > 0
        ? [
            {
              id: 'set-sorting',
              label: 'Sort',
              description: `Re-order the list the way its column headers do. Payload: { sorting: [{ columnId, direction: 'asc' | 'desc' }] } with exactly one rule; sortable columns: ${sortableIds.join(', ')}. The current order is state.sort.`,
            },
          ]
        : []),
      ...(searchableIds.length > 0
        ? [
            {
              id: 'find',
              label: 'Find',
              description: `Look rows up by ${searchLabels.join(' or ')}. Payload: { text } — rows containing it (any case) are published in state.rows; empty text clears.`,
            },
          ]
        : []),
    ],
    actions: [],
    // Constant: a mount publishes its descriptor once, so a row count
    // captured here would cap the surface for the life of the mount.
    limits: {
      maxQueryRows: MAX_QUERY_ROWS,
      maxQueryBytes: 1_000_000,
      maxSelectionSize: MAX_QUERY_ROWS,
    },
  };
}

function findTextFromPayload(
  payload: DataSurfaceJsonValue | undefined,
): string | null {
  const raw =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object' && !Array.isArray(payload)
        ? ['text', 'q', 'query', 'search', 'title']
            .map(
              (key) => (payload as Record<string, DataSurfaceJsonValue>)[key],
            )
            .find((value) => typeof value === 'string')
        : undefined;
  if (typeof raw !== 'string' || raw.length > MAX_FIND_TEXT) return null;
  return raw;
}

function surfaceContext(
  options: ListSurfaceOptions,
  findText: string,
): Record<string, DataSurfaceJsonValue | undefined> {
  const visible = findText
    ? findListRows(options.rows, options.columns, findText)
    : options.rows;
  const rows = projectListRows(visible, options.columns, options.maxRows);
  return {
    ...(options.context ?? {}),
    ...(options.sort
      ? {
          sort: {
            columnId: options.sort.columnId,
            direction: options.sort.direction,
          },
        }
      : {}),
    rowCount: options.rows.length,
    rows,
    rowsTruncated: visible.length > rows.length,
    find: findText ? { text: findText, matches: visible.length } : undefined,
  };
}

export function useListSurface(
  getOptions: () => ListSurfaceOptions | null,
  registry?: DataSurfaceRegistry,
): void {
  const uiContext = tryGetWebMcpUiContext();
  let handle: ListDataSurfaceHandle | null = null;
  let mountedKey: string | null = null;
  let mountedRegistry: DataSurfaceRegistry | null = null;
  let latest: ListSurfaceOptions | null = null;
  let controller: DataTableController | null = null;
  let findText = '';

  const sortingOf = (options: ListSurfaceOptions) =>
    options.sort
      ? [{ columnId: options.sort.columnId, direction: options.sort.direction }]
      : [];

  const teardown = () => {
    handle?.destroy();
    handle = null;
    controller = null;
    mountedKey = null;
    mountedRegistry = null;
    findText = '';
  };

  $effect(() => {
    const options = getOptions();
    const resolved =
      registry ??
      (uiContext?.enabled ? uiContext.dataSurfaceRegistry : undefined);
    latest = options;
    if (!resolved || !options) {
      teardown();
      return;
    }
    // Re-mount on identity change: SvelteKit reuses a page component across
    // a param-only navigation, and a mount keeps its first subject.
    const key = JSON.stringify([
      options.surfaceId,
      options.kind ?? 'list',
      options.subject ?? null,
      options.columns.map((column) => [
        column.id,
        column.searchable === true,
        column.sortable === true,
      ]),
      Boolean(options.refresh),
      sortEnabled(options),
    ]);
    if (key !== mountedKey || resolved !== mountedRegistry) {
      teardown();
      const context = surfaceContext(options, '');
      delete context.find;
      const sortable = sortEnabled(options);
      const columnIds = options.columns.map((column) => column.id);
      const mountedController = sortable
        ? createDataTableController({
            columnIds,
            // Controlled: the page's `sort` is the source of truth; an agent's
            // command is only a proposal until `onSort` applies it.
            state: {
              ...createDataTableController({ columnIds }).getState(),
              sorting: sortingOf(options),
            },
          })
        : createDataTableController({ columnIds });
      controller = mountedController;
      handle = mountListDataSurface({
        registry: resolved,
        descriptor: listSurfaceDescriptor(options),
        controller: mountedController,
        context: context as Record<string, DataSurfaceJsonValue>,
        acceptsTableCommand: (command) =>
          sortable &&
          command.type === 'setSorting' &&
          command.sorting.length === 1,
        ...(sortable
          ? {
              applyControlledState: async (next: DataTableViewState) => {
                const rule = next.sorting[0];
                if (!rule || !latest?.onSort) return undefined;
                const result = await latest.onSort({
                  columnId: rule.columnId,
                  direction: rule.direction,
                });
                return result === false ? undefined : next;
              },
            }
          : {}),
        ...(options.refresh ? { refresh: options.refresh } : {}),
        onControl: (controlId, payload) => {
          if (controlId !== 'find' || !latest || !handle) return false;
          const text = findTextFromPayload(payload);
          if (text === null) return false;
          findText = text.trim();
          handle.update(surfaceContext(latest, findText));
          return true;
        },
      });
      mountedKey = key;
      mountedRegistry = resolved;
      return;
    }
    if (controller?.isControlled()) {
      controller.replaceState({
        ...controller.getState(),
        sorting: sortingOf(options),
      });
    }
    handle?.update(surfaceContext(options, findText));
  });

  onDestroy(teardown);
}
