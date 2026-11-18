import { describe, expect, it } from 'vitest';
import {
  cellText,
  indexReferences,
  mainDateField,
  orderByCreated,
  orderRows,
  referencedModels,
  selectColumns,
} from './columns.ts';
import type { ModelInfo, RecordRow } from './types.ts';

const person = {
  fields: { name: { type: 'text' } },
} as unknown as ModelInfo;

describe('columns', () => {
  it('takes visible non-json fields, capped', () => {
    const cols = selectColumns(
      {
        fields: {
          a: { type: 'text' },
          b: { type: 'json' },
          c: { type: 'text', hidden: true },
          d: { type: 'money' },
          e: { type: 'text' },
        },
      },
      2,
    );
    expect(cols.map((c) => c.name)).toEqual(['a', 'd']);
  });

  it('orders newest first and is stable', () => {
    const rows = [
      { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-03-01T00:00:00Z' },
      { id: 'c', createdAt: '2026-03-01T00:00:00Z' },
    ];
    expect(orderByCreated(rows).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('renders cells by type', () => {
    expect(cellText({ type: 'boolean' }, 1)).toBe('Yes');
    expect(cellText({ type: 'boolean' }, 0)).toBe('No');
    expect(cellText({ type: 'money' }, 250)).toContain('2.50');
    expect(cellText({ type: 'text' }, null)).toBe('');
    expect(cellText({ type: 'json' }, { a: 1 })).toBe('{"a":1}');
    const refs = indexReferences({
      Person: [{ id: 'p1', name: 'Ada' } as RecordRow],
    });
    expect(
      cellText(
        { type: 'reference', ref: 'Person' },
        'p1',
        { Person: person },
        refs,
      ),
    ).toBe('Ada');
    expect(
      cellText(
        { type: 'reference', ref: 'Person' },
        'gone',
        { Person: person },
        refs,
      ),
    ).toBe('gone');
  });

  it('finds referenced models once', () => {
    expect(
      referencedModels({
        a: { type: 'reference', ref: 'P' },
        b: { type: 'reference', ref: 'P' },
        c: { type: 'text' },
      }),
    ).toEqual(['P']);
  });
});

describe('ordering by the main date', () => {
  const walks = {
    fields: {
      client: { type: 'reference' as const, ref: 'Client' },
      day: { type: 'date' as const },
      notes: { type: 'text' as const },
    },
  };

  it('finds the first visible date field, preferring a date-named one', () => {
    expect(mainDateField(walks)).toBe('day');
    expect(mainDateField({ fields: { n: { type: 'text' } } })).toBeNull();
    expect(
      mainDateField({
        fields: {
          paid: { type: 'date' },
          date: { type: 'date' },
        },
      }),
    ).toBe('date');
    expect(
      mainDateField({ fields: { d: { type: 'date', hidden: true } } }),
    ).toBeNull();
  });

  it('orders rows newest first by that date, undated rows last', () => {
    const rows = [
      { id: 'a', day: '2026-03-01', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', day: '2026-05-01', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'c', createdAt: '2026-01-03T00:00:00Z' },
      { id: 'd', day: '2026-04-01', createdAt: '2026-01-04T00:00:00Z' },
    ];
    expect(orderRows(walks, rows).map((r) => r.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  it('falls back to newest created without a date field', () => {
    const rows = [
      { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-03-01T00:00:00Z' },
    ];
    expect(
      orderRows({ fields: { n: { type: 'text' } } }, rows).map((r) => r.id),
    ).toEqual(['b', 'a']);
  });
});
