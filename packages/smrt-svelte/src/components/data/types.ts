/**
 * DataTable types
 */

import type { Snippet } from 'svelte';

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
  /** Whether column is sortable */
  sortable?: boolean;
  /** Column width (CSS value) */
  width?: string;
  /** Minimum width (CSS value) */
  minWidth?: string;
  /** Maximum width (CSS value) */
  maxWidth?: string;
  /** Text alignment */
  align?: 'left' | 'center' | 'right';
  /** Whether column is hidden */
  hidden?: boolean;
  /** Custom sort function */
  sortFn?: (a: T, b: T, direction: SortDirection) => number;
  /** Column class name */
  className?: string;
}

/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc' | null;

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
  rowKey?: keyof T | ((row: T) => string | number);
  /** Enable row selection */
  selectable?: boolean;
  /** Selected row keys */
  selected?: Set<string | number>;
  /** Selection change callback */
  onSelectionChange?: (selected: Set<string | number>) => void;
  /** Row click callback */
  onRowClick?: (row: T, index: number) => void;
  /** Enable sorting */
  sortable?: boolean;
  /** Current sort state */
  sort?: SortState;
  /** Sort change callback */
  onSortChange?: (sort: SortState) => void;
  /** Loading state */
  loading?: boolean;
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
