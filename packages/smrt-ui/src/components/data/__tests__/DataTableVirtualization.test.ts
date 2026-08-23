import { describe, expect, it } from 'vitest';
import {
  maximumDataTableVirtualScrollTop,
  resolveDataTableVirtualWindow,
  scrollTopForDataTableRow,
} from '../DataTableVirtualization.js';

const options = { rowHeight: 20, viewportHeight: 100, overscan: 2 };

describe('DataTable virtualization window', () => {
  it('renders a fixed-height window with bounded overscan', () => {
    expect(
      resolveDataTableVirtualWindow({
        options,
        rowCount: 100,
        scrollTop: 200,
      }),
    ).toMatchObject({
      enabled: true,
      startIndex: 8,
      endIndex: 17,
      topSpacerHeight: 160,
      bottomSpacerHeight: 1_660,
      totalBodyHeight: 2_000,
    });
  });

  it('clamps a restored scroll position to the body extent', () => {
    expect(
      resolveDataTableVirtualWindow({
        options,
        rowCount: 10,
        scrollTop: 1_000,
      }),
    ).toMatchObject({
      startIndex: 3,
      endIndex: 10,
      topSpacerHeight: 60,
      bottomSpacerHeight: 0,
    });
  });

  it('falls back to a semantic full body for variable-height data rows', () => {
    expect(
      resolveDataTableVirtualWindow({
        options,
        rowCount: 12,
        scrollTop: 100,
        hasVariableRowHeight: true,
        headerRowCount: 2,
        summaryRowCount: 1,
      }),
    ).toEqual({
      enabled: false,
      reason: 'variable-row-height',
      startIndex: 0,
      endIndex: 12,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalBodyHeight: 0,
      headerRowCount: 2,
      summaryRowCount: 1,
    });
  });

  it('keeps headers and summaries outside the body calculation', () => {
    const withStructuralRows = resolveDataTableVirtualWindow({
      options,
      rowCount: 100,
      scrollTop: 0,
      headerRowCount: 2,
      summaryRowCount: 3,
    });
    expect(withStructuralRows.totalBodyHeight).toBe(2_000);
    expect(withStructuralRows.headerRowCount).toBe(2);
    expect(withStructuralRows.summaryRowCount).toBe(3);
  });

  it('extends the virtual scroll range by a measured summary footer', () => {
    expect(maximumDataTableVirtualScrollTop(100, options, 24)).toBe(1_924);
    expect(() => maximumDataTableVirtualScrollTop(1, options, -1)).toThrow(
      /footerHeight/,
    );
  });

  it('derives scroll restoration from a row position, not a display key', () => {
    expect(scrollTopForDataTableRow(0, 100, options, 400)).toBe(0);
    expect(scrollTopForDataTableRow(25, 100, options, 0)).toBe(420);
    expect(scrollTopForDataTableRow(99, 100, options, 0)).toBe(1_900);
  });

  it('rejects invalid fixed-height configuration', () => {
    expect(() =>
      resolveDataTableVirtualWindow({
        options: { rowHeight: 0, viewportHeight: 100 },
        rowCount: 1,
        scrollTop: 0,
      }),
    ).toThrow(/rowHeight/);
    expect(() => scrollTopForDataTableRow(2, 2, options)).toThrow(/rowIndex/);
  });
});
