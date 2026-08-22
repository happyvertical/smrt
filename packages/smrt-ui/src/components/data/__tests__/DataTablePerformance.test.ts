import { describe, expect, it } from 'vitest';
import {
  createDataTablePerformanceColumns,
  createDataTablePerformanceRows,
} from '../__fixtures__/DataTablePerformanceFixture.js';
import {
  DATA_TABLE_SCALE_THRESHOLDS,
  recommendDataTableScaleStrategy,
} from '../DataTablePerformance.js';

describe('DataTable scale thresholds', () => {
  it('uses deterministic, stable-identity benchmark fixtures', () => {
    const rows = createDataTablePerformanceRows(3, 2);
    expect(rows.map((row) => row.id)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(rows[2]?.values).toEqual({ value0: 6, value1: 8 });
    expect(
      createDataTablePerformanceColumns(2).map((column) => column.id),
    ).toEqual(['name', 'group', 'value0', 'value1']);
  });

  it('recommends a bounded scale strategy from documented thresholds', () => {
    expect(recommendDataTableScaleStrategy(250, 20)).toBe('local');
    expect(recommendDataTableScaleStrategy(251, 20)).toBe('virtualization');
    expect(recommendDataTableScaleStrategy(1_001, 2)).toBe('manual-paging');
    expect(DATA_TABLE_SCALE_THRESHOLDS.manualPaging.recommendedPageSize).toBe(
      100,
    );
  });

  it('rejects ambiguous scale inputs', () => {
    expect(() => recommendDataTableScaleStrategy(-1, 2)).toThrow(
      /non-negative/,
    );
    expect(() => recommendDataTableScaleStrategy(2.5, 2)).toThrow(/integers/);
  });
});
