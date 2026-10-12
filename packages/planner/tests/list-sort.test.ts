import { describe, expect, it } from 'vitest';
import { nextListSort, sortListRows } from '../src/lib/data/list-sort.ts';

describe('generated list sorting', () => {
  const rows = [
    {
      id: 'a',
      name: 'Item 10',
      amount: 100,
      date: '2026-03-01',
      relation: 'Zoe',
    },
    {
      id: 'b',
      name: 'Item 2',
      amount: 20,
      date: '2026-01-01',
      relation: 'Ada',
    },
    {
      id: 'c',
      name: 'item 2',
      amount: 20,
      date: '2026-01-01',
      relation: 'Ada',
    },
    { id: 'd', name: '', amount: null, date: null, relation: '' },
  ];

  const ids = (key: string, direction: 'ascending' | 'descending') =>
    sortListRows(
      rows,
      { key, direction },
      (row, field) => row[field as keyof typeof row],
    ).map((row) => row.id);

  it('toggles the selected column from ascending to descending', () => {
    expect(nextListSort(null, 'amount')).toEqual({
      key: 'amount',
      direction: 'ascending',
    });
    expect(
      nextListSort({ key: 'amount', direction: 'ascending' }, 'amount'),
    ).toEqual({ key: 'amount', direction: 'descending' });
    expect(
      nextListSort({ key: 'amount', direction: 'descending' }, 'name'),
    ).toEqual({ key: 'name', direction: 'ascending' });
  });

  it('sorts numeric values numerically and keeps ties stable', () => {
    expect(ids('amount', 'ascending')).toEqual(['b', 'c', 'a', 'd']);
    expect(ids('amount', 'descending')).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts dates and natural text while leaving missing values last', () => {
    expect(ids('date', 'ascending')).toEqual(['b', 'c', 'a', 'd']);
    expect(ids('name', 'ascending')).toEqual(['b', 'c', 'a', 'd']);
    expect(ids('relation', 'descending')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns original order when no column is selected', () => {
    expect(sortListRows(rows, null, (row) => row.amount)).toEqual(rows);
  });
});
