import type { DataTableColumn } from '../types.js';

export interface DataTablePerformanceRow {
  id: string;
  name: string;
  group: string;
  values: Record<string, number>;
}

export function createDataTablePerformanceRows(
  rowCount: number,
  valueColumnCount: number,
): DataTablePerformanceRow[] {
  return Array.from({ length: rowCount }, (_, index) => ({
    id: `row-${index}`,
    name: `Record ${index.toString().padStart(5, '0')}`,
    group: `group-${index % 10}`,
    values: Object.fromEntries(
      Array.from({ length: valueColumnCount }, (_, valueIndex) => [
        `value${valueIndex}`,
        (index * (valueIndex + 3)) % 997,
      ]),
    ),
  }));
}

export function createDataTablePerformanceColumns(
  valueColumnCount: number,
): DataTableColumn<DataTablePerformanceRow>[] {
  return [
    { id: 'name', label: 'Name', accessor: 'name', sortable: true },
    { id: 'group', label: 'Group', accessor: 'group', sortable: true },
    ...Array.from({ length: valueColumnCount }, (_, index) => ({
      id: `value${index}`,
      label: `Value ${index + 1}`,
      accessor: `values.value${index}`,
      sortable: true,
    })),
  ];
}
