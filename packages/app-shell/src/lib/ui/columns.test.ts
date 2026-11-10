import { describe, expect, it } from 'vitest';
import {
  cellText,
  indexReferences,
  orderByCreated,
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
