import { describe, expect, it } from 'vitest';
import { resolveDataTableRows } from '../DataTableIdentity.js';

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [
  { id: 'ada', name: 'Ada' },
  { id: 'linus', name: 'Linus' },
];

describe('resolveDataTableRows', () => {
  it('uses stable canonical IDs and preserves source indexes', () => {
    expect(
      resolveDataTableRows(rows, 'id', { requireStableIdentity: true }),
    ).toEqual([
      { row: rows[0], sourceIndex: 0, rowId: 'ada' },
      { row: rows[1], sourceIndex: 1, rowId: 'linus' },
    ]);
  });

  it('keeps the index fallback only for presentational local tables', () => {
    expect(resolveDataTableRows(rows, undefined)).toEqual([
      { row: rows[0], sourceIndex: 0, rowId: 0 },
      { row: rows[1], sourceIndex: 1, rowId: 1 },
    ]);
    expect(() =>
      resolveDataTableRows(rows, undefined, { requireStableIdentity: true }),
    ).toThrow(/rowKey is required/);
  });

  it('rejects duplicate, empty, and non-finite stable row IDs', () => {
    expect(() =>
      resolveDataTableRows(
        [
          { id: 'same', name: 'Ada' },
          { id: 'same', name: 'Linus' },
        ],
        'id',
      ),
    ).toThrow(/unique/);
    expect(() => resolveDataTableRows([{ id: '', name: 'Ada' }], 'id')).toThrow(
      /non-empty/,
    );
    expect(() =>
      resolveDataTableRows([{ id: Number.NaN, name: 'Ada' }], (row) => row.id),
    ).toThrow(/finite/);
  });
});
