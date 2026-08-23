import { render } from '@testing-library/svelte';
import type { Component } from 'svelte';
import { bench, describe } from 'vitest';
import {
  createDataTablePerformanceColumns,
  createDataTablePerformanceRows,
  type DataTablePerformanceRow,
} from '../__fixtures__/DataTablePerformanceFixture.js';
import DataTable from '../DataTable.svelte';
import { createDataTableController } from '../DataTableController.js';
import type { DataTableProps } from '../types.js';

const localRows = createDataTablePerformanceRows(250, 18);
const localColumns = createDataTablePerformanceColumns(18);
const transformRows = createDataTablePerformanceRows(1_000, 18);
const manualPageRows = createDataTablePerformanceRows(100, 18);
const BenchmarkDataTable = DataTable as unknown as Component<
  DataTableProps<DataTablePerformanceRow>
>;

describe('DataTable scale thresholds', () => {
  bench('local render: 250 rows and 20 columns', () => {
    const table = render(BenchmarkDataTable, {
      props: { data: localRows, columns: localColumns, rowKey: 'id' },
    });
    table.unmount();
  });

  bench('client transforms: 1,000 rows and 20 columns', () => {
    const controller = createDataTableController({
      columnIds: localColumns.map((column) => column.id),
      initialState: {
        search: 'record 00',
        sorting: [{ columnId: 'value0', direction: 'desc' }],
      },
    });
    const table = render(BenchmarkDataTable, {
      props: {
        data: transformRows,
        columns: localColumns,
        rowKey: 'id',
        controller,
      },
    });
    table.unmount();
  });

  bench(
    'manual paging: 100 supplied rows from a 100,000-row remote result',
    () => {
      const controller = createDataTableController({
        columnIds: localColumns.map((column) => column.id),
        modes: { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
        initialState: { page: 500, pageSize: 100 },
      });
      const table = render(BenchmarkDataTable, {
        props: {
          data: manualPageRows,
          columns: localColumns,
          rowKey: 'id',
          controller,
          totalRows: 100_000,
        },
      });
      table.unmount();
    },
  );
});
