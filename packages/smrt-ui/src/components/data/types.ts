/**
 * DataTable types
 */

import type { Snippet } from 'svelte';
import type {
  DataTableCommand,
  DataTableController,
  DataTableFilter,
  DataTableModes,
  DataTableViewState,
  DataTableViewStateInput,
} from './DataTableController.js';
import type {
  DataSurfaceDescriptor,
  DataSurfaceRegistry,
} from './data-surface.js';
import type { DataTableRowKey } from './DataTableIdentity.js';
import type { DataTableVirtualizationOptions } from './DataTableVirtualization.js';

/** Opt-in mounted-surface wiring for a DataTable instance. */
export interface DataTableDataSurfaceOptions {
  registry: DataSurfaceRegistry;
  /** Explicit stable identity and effective, policy-filtered capabilities. */
  descriptor: DataSurfaceDescriptor;
  /** Controlled tables must settle candidate state before acknowledgement. */
  applyControlledState?: DataTableControlledStateApplier;
  onRefresh?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

export type DataTableControlledStateApplier = (
  state: DataTableViewState,
  command: DataTableCommand,
) => DataTableViewState | undefined | Promise<DataTableViewState | undefined>;

/** Opt-in registration for a standalone search/view toolbar. */
export interface CollectionToolbarDataSurfaceOptions {
  registry: DataSurfaceRegistry;
  descriptor: DataSurfaceDescriptor;
  applyControlledState?: DataTableControlledStateApplier;
  onRefresh?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

/** A group segment owned by a leaf column so restored order can stay valid. */
export interface DataTableHeaderPathSegment {
  /** Stable group identity within its header level. */
  id: string;
  /** Human-readable group header. */
  label: string;
}

/** Presentation metadata for responsive adapters. */
export interface DataTableColumnResponsive {
  /** Higher values are more important when an adapter collapses columns. */
  priority?: number;
  /** Keep this column visible when an adapter performs responsive collapse. */
  keepVisible?: boolean;
}

export type DataTableColumnRole = 'data' | 'status' | 'action';

export type DataTableStructuralRowKind =
  | 'summary'
  | 'subtotal'
  | 'aggregate'
  | 'footer';

/** A non-data row rendered outside the selectable, virtualized data body. */
export interface DataTableStructuralRow<T> {
  /** Stable identifier for a structural row. */
  id: string;
  /** Distinguishes report structure without importing report-domain semantics. */
  kind: DataTableStructuralRowKind;
  /** Row-header content announced to assistive technology. */
  label: string;
  /** Column that receives the row header. Defaults to the first visible column. */
  labelColumnId?: string;
  /** Plain values keyed by column id. */
  values?: Readonly<Record<string, unknown>>;
  /** Optional cell renderer for this one structural row. */
  cell?: Snippet<
    [
      {
        row: DataTableStructuralRow<T>;
        column: DataTableColumn<T>;
        value: unknown;
      },
    ]
  >;
}

/**
 * Column definition for DataTable
 */
export interface DataTableColumn<T> {
  /** Unique column identifier */
  id: string;
  /** Column header label */
  label: string;
  /** Property key to access from row data (supports dot notation) */
  accessor?: keyof T | string;
  /** Custom cell renderer */
  cell?: Snippet<[{ row: T; value: unknown; index: number }]>;
  /** Custom header renderer */
  header?: Snippet<[{ column: DataTableColumn<T> }]>;
  /** Optional group ancestry. Groups are resolved from the final visible layout. */
  headerPath?: readonly DataTableHeaderPathSegment[];
  /**
   * How a custom header participates in sorting. `automatic` (the default)
   * renders a separate action-labelled sort button alongside the custom header,
   * so custom markup can safely contain its own interactive controls.
   * Set `manual` only when the custom header provides and owns its own sorting
   * interaction; this explicit opt-out prevents custom markup from silently
   * disabling a sortable column.
   */
  headerSortMode?: 'automatic' | 'manual';
  /** Whether column is sortable */
  sortable?: boolean;
  /** Column width (CSS value) */
  width?: string;
  /** Minimum width (CSS value) */
  minWidth?: string;
  /** Maximum width (CSS value) */
  maxWidth?: string;
  /** Enables the accessible header resize separator for this column. */
  resizable?: boolean;
  /** Semantic metadata for generic responsive adapters. */
  role?: DataTableColumnRole;
  /** Metadata consumed by responsive adapters without domain coupling. */
  responsive?: DataTableColumnResponsive;
  /** Text alignment */
  align?: 'left' | 'center' | 'right';
  /** Whether column is hidden */
  hidden?: boolean;
  /** Custom sort function */
  sortFn?: (a: T, b: T, direction: SortDirection) => number;
  /** Local text search is enabled by default; set `false` to opt out. */
  searchable?: boolean;
  /** Declarative local filters are enabled by default; set `false` to opt out. */
  filterable?: boolean;
  /** Optional local-only evaluator for a serializable declarative filter. */
  filterFn?: (row: T, value: unknown, filter: DataTableFilter) => boolean;
  /** Column class name */
  className?: string;
}

/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc' | null;

/** A load failure that can be announced and optionally retried by DataTable. */
export type DataTableLoadError = string | Error;

/**
 * Sort state
 */
export interface SortState {
  columnId: string | null;
  direction: SortDirection;
}

/**
 * DataTable props
 */
export interface DataTableProps<T> {
  /** Data rows */
  data: T[];
  /** Column definitions */
  columns: DataTableColumn<T>[];
  /** Unique key accessor for rows */
  rowKey?: DataTableRowKey<T>;
  /**
   * Declares that a DataSurface or agent will address rows. Such tables must
   * provide `rowKey`, even if they do not render selection controls.
   */
  agentAddressable?: boolean;
  /** Enable row selection */
  selectable?: boolean;
  /** Selected row keys */
  selected?: Set<string | number>;
  /** Selection change callback */
  onSelectionChange?: (selected: Set<string | number>) => void;
  /** Row click callback */
  onRowClick?: (row: T, index: number) => void;
  /**
   * Supplies the accessible label used for a row's selection and expansion
   * controls. Defaults to the 1-based display row number.
   */
  rowLabel?: (row: T, index: number) => string;
  /** Enable sorting */
  sortable?: boolean;
  /** Current sort state */
  sort?: SortState;
  /** Sort change callback */
  onSortChange?: (sort: SortState) => void;
  /** Parent owns sorting and supplies already-sorted rows. */
  manualSorting?: boolean;
  /** Optional client-side row filter. */
  filterFn?: (row: T, index: number) => boolean;
  /** Current 1-based page. Pagination is enabled when pageSize is set. */
  page?: number;
  /** Rows per page. */
  pageSize?: number;
  /** Parent owns pagination and supplies only the current page. */
  manualPagination?: boolean;
  /**
   * Opt-in fixed-height virtualization for the data body. It requires rowKey
   * and falls back to the normal semantic body when expanded rows are enabled.
   */
  virtualization?: DataTableVirtualizationOptions;
  /** Total server row count when manualPagination is enabled. */
  totalRows?: number;
  /** Page change callback. */
  onPageChange?: (page: number) => void;
  /** Controlled set of expanded row keys. */
  expanded?: Set<string | number>;
  /** Expansion change callback. */
  onExpandedChange?: (expanded: Set<string | number>) => void;
  /** Predicate controlling which rows can expand. */
  canExpand?: (row: T, index: number) => boolean;
  /** Expanded row content. */
  expandedContent?: Snippet<[{ row: T; index: number }]>;
  /** Optional content above the table. */
  toolbar?: Snippet;
  /** Optional full-width table footer content. */
  footer?: Snippet<[{ rows: T[] }]>;
  /** Generic report-like rows rendered independently from data row interactions. */
  structuralRows?: readonly DataTableStructuralRow<T>[];
  /** Controlled visible column ids. Column.hidden is still respected. */
  visibleColumnIds?: Set<string>;
  /**
   * Headless controller used by rendered interactions and programmatic commands.
   * When supplied, it takes precedence over `state` and the legacy bindables.
   */
  controller?: DataTableController;
  /** Explicit controlled serializable state when no external controller is supplied. */
  state?: DataTableViewStateInput;
  /** Initial serializable state for uncontrolled controller-backed tables. */
  initialState?: Partial<DataTableViewState>;
  /** Called after a controller command proposes or applies a new state. */
  onStateChange?: (
    state: DataTableViewState,
    command: DataTableCommand,
  ) => void;
  /** Explicit ownership for local or caller-supplied filtering, sorting, and paging. */
  modes?: Partial<DataTableModes>;
  /** Registers this mounted instance only when explicitly supplied. */
  dataSurface?: DataTableDataSurfaceOptions;
  /**
   * The initial loading state. When rows are already present, loading keeps
   * them interactive and is announced as a refresh instead of replacing them.
   */
  loading?: boolean;
  /** Explicitly announces a refresh while rendered rows remain available. */
  refreshing?: boolean;
  /** Marks rendered rows as stale while a caller refreshes them. */
  stale?: boolean;
  /** Marks rendered rows as a partial result set. */
  partialResults?: boolean;
  /** Load failure shown without discarding already rendered rows. */
  error?: DataTableLoadError | null;
  /** Invoked by the localized retry button when a load error is present. */
  onRetry?: () => void;
  /** Empty state content */
  empty?: Snippet;
  /** Custom row class function */
  rowClass?: (row: T, index: number) => string;
  /** Table size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Enable striped rows */
  striped?: boolean;
  /** Enable hover highlight */
  hoverable?: boolean;
  /** Enable sticky header */
  stickyHeader?: boolean;
  /** Table caption for accessibility */
  caption?: string;
  /** Dense mode (reduced padding) */
  dense?: boolean;
}

/**
 * Get nested value from object using dot notation
 */
export function getNestedValue<T>(obj: T, path: string): unknown {
  return path.split('.').reduce((acc: unknown, part) => {
    if (acc && typeof acc === 'object' && part in acc) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

/**
 * Default sort function for basic types
 */
export function defaultSort<T>(
  a: T,
  b: T,
  accessor: string,
  direction: SortDirection,
): number {
  if (!direction) return 0;

  const aVal = getNestedValue(a, accessor);
  const bVal = getNestedValue(b, accessor);

  // Handle nullish values
  if (aVal == null && bVal == null) return 0;
  if (aVal == null) return direction === 'asc' ? 1 : -1;
  if (bVal == null) return direction === 'asc' ? -1 : 1;

  // Compare values
  let comparison = 0;
  if (typeof aVal === 'string' && typeof bVal === 'string') {
    comparison = aVal.localeCompare(bVal);
  } else if (typeof aVal === 'number' && typeof bVal === 'number') {
    comparison = aVal - bVal;
  } else if (aVal instanceof Date && bVal instanceof Date) {
    comparison = aVal.getTime() - bVal.getTime();
  } else {
    comparison = String(aVal).localeCompare(String(bVal));
  }

  return direction === 'asc' ? comparison : -comparison;
}
