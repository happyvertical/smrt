import type {
  DataTableColumnPinning,
  DataTableViewState,
} from './DataTableController.js';
import type { DataTableColumn, DataTableHeaderPathSegment } from './types.js';

export interface DataTableResolvedColumn<T> {
  column: DataTableColumn<T>;
  pin?: DataTableColumnPinning['position'];
  /** A persisted pixel width supersedes the column's presentational default. */
  width?: number;
  /** CSS-safe width used for a sticky offset when one is available. */
  offsetWidth: string;
  stickyOffset?: string;
}

export interface DataTableHeaderGroupCell {
  kind: 'group';
  key: string;
  label: string;
  colspan: number;
  rowspan: number;
  pin?: DataTableColumnPinning['position'];
  stickyOffset?: string;
}

export interface DataTableHeaderLeafCell<T> {
  kind: 'leaf';
  column: DataTableResolvedColumn<T>;
  rowspan: number;
}

export type DataTableHeaderCell<T> =
  | DataTableHeaderGroupCell
  | DataTableHeaderLeafCell<T>;

export interface DataTableLayout<T> {
  columns: DataTableResolvedColumn<T>[];
  headerRows: DataTableHeaderCell<T>[][];
}

function compareOrder<T>(
  left: DataTableColumn<T>,
  right: DataTableColumn<T>,
  order: ReadonlyMap<string, number>,
): number {
  const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
  return leftOrder === rightOrder ? 0 : leftOrder - rightOrder;
}

function headerPath<T>(
  column: DataTableColumn<T>,
): readonly DataTableHeaderPathSegment[] {
  const path = column.headerPath ?? [];
  for (const segment of path) {
    if (
      !segment ||
      typeof segment.id !== 'string' ||
      segment.id.length === 0 ||
      typeof segment.label !== 'string' ||
      segment.label.length === 0
    ) {
      throw new TypeError(
        `DataTable headerPath entries for ${column.id} require non-empty id and label`,
      );
    }
  }
  return path;
}

function offsetWidth<T>(
  column: DataTableColumn<T>,
  width?: number,
  measuredWidth?: number,
): string {
  if (width !== undefined) return `${width}px`;
  if (measuredWidth !== undefined && measuredWidth > 0) {
    return `${measuredWidth}px`;
  }
  return column.width ?? column.minWidth ?? '0px';
}

function resolveHeaderRows<T>(
  columns: readonly DataTableResolvedColumn<T>[],
): DataTableHeaderCell<T>[][] {
  const paths = columns.map(({ column }) => headerPath(column));
  const groupDepth = Math.max(0, ...paths.map((path) => path.length));
  if (groupDepth === 0) {
    return [columns.map((column) => ({ kind: 'leaf', column, rowspan: 1 }))];
  }

  const rows: DataTableHeaderCell<T>[][] = Array.from(
    { length: groupDepth + 1 },
    () => [],
  );
  for (let level = 0; level <= groupDepth; level += 1) {
    let index = 0;
    while (index < columns.length) {
      const path = paths[index];
      if (path.length < level) {
        index += 1;
        continue;
      }
      if (path.length === level) {
        rows[level].push({
          kind: 'leaf',
          column: columns[index],
          rowspan: groupDepth - level + 1,
        });
        index += 1;
        continue;
      }

      const segment = path[level];

      let end = index + 1;
      while (
        end < columns.length &&
        paths[end][level]?.id === segment.id &&
        paths[end][level]?.label === segment.label
      ) {
        end += 1;
      }
      rows[level].push({
        kind: 'group',
        key: `${level}:${index}:${segment.id}`,
        label: segment.label,
        colspan: end - index,
        rowspan: 1,
        ...resolveGroupPin(columns.slice(index, end)),
      });
      index = end;
    }
  }
  return rows;
}

function resolveGroupPin<T>(
  columns: readonly DataTableResolvedColumn<T>[],
): Pick<DataTableHeaderGroupCell, 'pin' | 'stickyOffset'> {
  const pin = columns[0]?.pin;
  if (!pin || !columns.every((column) => column.pin === pin)) return {};
  const edge = pin === 'start' ? columns[0] : columns.at(-1);
  return { pin, stickyOffset: edge?.stickyOffset };
}

/**
 * Resolve a DOM-safe table layout from canonical controller state. Pinning is
 * a partition of the configured order so the visual and assistive orders stay
 * aligned. Header groups are then rebuilt from the final visible leaf order.
 */
export function resolveDataTableLayout<T>(
  columns: readonly DataTableColumn<T>[],
  state: Pick<
    DataTableViewState,
    'columnOrder' | 'columnVisibility' | 'columnWidths' | 'columnPinning'
  >,
  measuredWidths: Readonly<Record<string, number>> = {},
): DataTableLayout<T> {
  const order = new Map(state.columnOrder.map((id, index) => [id, index]));
  const visibility = new Map(
    state.columnVisibility.map((entry) => [entry.columnId, entry.visible]),
  );
  const widths = new Map(
    state.columnWidths.map((entry) => [entry.columnId, entry.width]),
  );
  const pinning = new Map(
    state.columnPinning.map((entry) => [entry.columnId, entry.position]),
  );
  const ordered = columns
    .filter((column) => !column.hidden && visibility.get(column.id) !== false)
    .slice()
    .sort((left, right) => compareOrder(left, right, order));
  const partitions = {
    start: ordered.filter((column) => pinning.get(column.id) === 'start'),
    center: ordered.filter((column) => !pinning.has(column.id)),
    end: ordered.filter((column) => pinning.get(column.id) === 'end'),
  };
  const resolved: DataTableResolvedColumn<T>[] = [];
  let startOffset = '0px';
  for (const column of partitions.start) {
    const width = widths.get(column.id);
    const offset = offsetWidth(column, width, measuredWidths[column.id]);
    resolved.push({
      column,
      pin: 'start',
      width,
      offsetWidth: offset,
      stickyOffset: startOffset,
    });
    startOffset = `calc(${startOffset} + ${offset})`;
  }
  for (const column of partitions.center) {
    const width = widths.get(column.id);
    resolved.push({
      column,
      width,
      offsetWidth: offsetWidth(column, width, measuredWidths[column.id]),
    });
  }
  let endOffset = '0px';
  const endColumns: DataTableResolvedColumn<T>[] = [];
  for (const column of partitions.end.slice().reverse()) {
    const width = widths.get(column.id);
    const offset = offsetWidth(column, width, measuredWidths[column.id]);
    endColumns.unshift({
      column,
      pin: 'end',
      width,
      offsetWidth: offset,
      stickyOffset: endOffset,
    });
    endOffset = `calc(${endOffset} + ${offset})`;
  }
  resolved.push(...endColumns);

  return { columns: resolved, headerRows: resolveHeaderRows(resolved) };
}
