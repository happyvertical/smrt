import type { DataTableColumn } from './types.js';

/** Choose narrow-mode columns without changing their declared display order. */
export function responsiveColumns<T>(
  columns: readonly DataTableColumn<T>[],
  width: number,
  minimumWidth: number,
): DataTableColumn<T>[] {
  const target =
    Number.isFinite(minimumWidth) && minimumWidth > 0 ? minimumWidth : 160;
  const budget = Math.max(1, Math.floor(Math.max(0, width) / target));
  const retained = new Set(
    columns
      .filter((column) => column.responsive?.keepVisible)
      .map((column) => column.id),
  );
  const ranked = columns
    .map((column, index) => ({ column, index }))
    .sort((a, b) => {
      const priority = (column: DataTableColumn<T>) =>
        Number.isFinite(column.responsive?.priority)
          ? (column.responsive?.priority ?? 0)
          : 0;
      return priority(b.column) - priority(a.column) || a.index - b.index;
    });
  for (const { column } of ranked) {
    if (retained.size >= budget) break;
    retained.add(column.id);
  }
  return columns.filter((column) => retained.has(column.id));
}
