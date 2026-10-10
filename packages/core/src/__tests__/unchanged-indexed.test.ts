import { describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../schema/types';
import {
  buildDuckDbIdUpdate,
  collectIndexedColumns,
  storedValueEquals,
  unchangedIndexedColumns,
} from '../unchanged-indexed';

const schema = (overrides: Partial<SchemaDefinition>): SchemaDefinition => ({
  tableName: 't',
  columns: {},
  indexes: [],
  triggers: [],
  foreignKeys: [],
  version: '1',
  dependencies: [],
  ...overrides,
});

describe('collectIndexedColumns (#3737)', () => {
  it('unions keys, unique and FK columns, declared indexes and JSON-path columns', () => {
    const indexed = collectIndexedColumns(
      [
        schema({
          columns: {
            id: { type: 'UUID', primaryKey: true },
            code: { type: 'TEXT', unique: true },
            owner_id: {
              type: 'UUID',
              foreignKey: { table: 'owners', column: 'id' },
            },
            note: { type: 'TEXT' },
          },
          indexes: [
            { name: 'a', columns: ['created_at', 'status'] },
            {
              name: 'b',
              columns: [],
              jsonPath: { column: '_meta_data', path: '$.k' },
            },
          ],
          foreignKeys: [
            {
              column: 'parent_id',
              referencesTable: 'p',
              referencesColumn: 'id',
            },
          ],
        }),
        undefined,
        schema({ indexes: [{ name: 'c', columns: ['_meta_type'] }] }),
      ],
      ['slug', 'tenantId', '_meta_type'],
    );
    expect([...indexed].sort()).toEqual(
      [
        '_meta_data',
        '_meta_type',
        'code',
        'created_at',
        'id',
        'owner_id',
        'parent_id',
        'slug',
        'status',
        'tenant_id',
      ].sort(),
    );
    expect(indexed.has('note')).toBe(false);
  });
});

describe('storedValueEquals (#3737)', () => {
  it('treats null and undefined alike but never null and empty string', () => {
    expect(storedValueEquals('TEXT', null, undefined)).toBe(true);
    expect(storedValueEquals('TEXT', undefined, null)).toBe(true);
    expect(storedValueEquals('TEXT', '', null)).toBe(false);
    expect(storedValueEquals('TEXT', null, '')).toBe(false);
    expect(storedValueEquals('TEXT', 'x', null)).toBe(false);
  });

  it('compares text exactly', () => {
    expect(storedValueEquals('TEXT', 'a', 'a')).toBe(true);
    expect(storedValueEquals('TEXT', 'a', 'A')).toBe(false);
    expect(storedValueEquals('TEXT', '', '')).toBe(true);
    expect(storedValueEquals('TEXT', '1', 1)).toBe(false);
  });

  it('compares UUIDs without regard to case, but only well-formed ones', () => {
    const id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    expect(storedValueEquals('UUID', id.toUpperCase(), id)).toBe(true);
    expect(storedValueEquals('UUID', id, id.replace('1111', '2222'))).toBe(
      false,
    );
    expect(storedValueEquals('UUID', 'ABC', 'abc')).toBe(false);
    expect(storedValueEquals('TEXT', id.toUpperCase(), id)).toBe(false);
  });

  it('compares timestamps as instants and refuses unzoned strings', () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    expect(storedValueEquals('TIMESTAMP', at, new Date(at))).toBe(true);
    expect(storedValueEquals('TIMESTAMP', at, at.toISOString())).toBe(true);
    expect(
      storedValueEquals('TIMESTAMP', at, '2026-01-02T04:04:05.678+01:00'),
    ).toBe(true);
    expect(storedValueEquals('TIMESTAMP', at, new Date(at.getTime() + 1))).toBe(
      false,
    );
    expect(storedValueEquals('TIMESTAMP', at, '2026-01-02 03:04:05.678')).toBe(
      false,
    );
    expect(storedValueEquals('TIMESTAMP', 'garbage', 'garbage')).toBe(false);
    expect(storedValueEquals('TIMESTAMP', new Date(Number.NaN), at)).toBe(
      false,
    );
  });

  it('compares JSON structurally and refuses unparseable text', () => {
    expect(
      storedValueEquals('JSON', { a: 1, b: [1, 2] }, '{"b":[1,2],"a":1}'),
    ).toBe(true);
    expect(storedValueEquals('JSON', ['x'], '["x"]')).toBe(true);
    expect(storedValueEquals('JSON', ['x'], '["y"]')).toBe(false);
    expect(storedValueEquals('JSON', 'not json', 'not json')).toBe(false);
  });

  it('compares booleans and numbers, across bigint and number', () => {
    expect(storedValueEquals('BOOLEAN', true, true)).toBe(true);
    expect(storedValueEquals('BOOLEAN', true, false)).toBe(false);
    expect(storedValueEquals('BOOLEAN', true, 1)).toBe(false);
    expect(storedValueEquals('INTEGER', 5, 5)).toBe(true);
    expect(storedValueEquals('INTEGER', 5, 6)).toBe(false);
    expect(storedValueEquals('INTEGER', 5, BigInt(5))).toBe(true);
    expect(storedValueEquals('INTEGER', 5, '5')).toBe(false);
  });

  it('never proves binary values equal', () => {
    expect(storedValueEquals('BLOB', Buffer.from('a'), Buffer.from('a'))).toBe(
      false,
    );
  });
});

describe('unchangedIndexedColumns (#3737)', () => {
  const indexed = new Set(['id', 'slug', 'context', 'tenant_id', 'updated_at']);
  const types = {
    tenant_id: { type: 'UUID' },
    updated_at: { type: 'TIMESTAMP' },
  };

  it('reports only indexed columns whose value provably equals the stored one', () => {
    const unchanged = unchangedIndexedColumns(
      {
        id: 'x',
        slug: 'same',
        context: 'new-context',
        tenant_id: null,
        label: 'same',
        updated_at: new Date(),
      },
      {
        id: 'x',
        slug: 'same',
        context: 'old-context',
        tenant_id: null,
        label: 'same',
        updated_at: new Date(0),
      },
      indexed,
      types,
    );
    expect([...unchanged]).toEqual(['slug', 'tenant_id']);
  });

  it('skips a column the stored row does not carry', () => {
    expect([
      ...unchangedIndexedColumns({ slug: 's' }, {}, indexed, types),
    ]).toEqual([]);
  });
});

describe('buildDuckDbIdUpdate (#3737)', () => {
  it('quotes every identifier, including reserved words', () => {
    const { sql, values } = buildDuckDbIdUpdate('my"table', 'id-1', {
      order: 2,
      'we"ird': true,
    });
    expect(sql).toBe(
      'UPDATE "my""table" SET "order" = ?, "we""ird" = ? WHERE "id" = ?',
    );
    expect(values).toEqual([2, true, 'id-1']);
  });

  it('binds like the adapter upsert: NULL literals, text casts, ISO dates, JSON text', () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    const buffer = Buffer.from('x');
    const { sql, values } = buildDuckDbIdUpdate('t', 'id-1', {
      a: null,
      b: undefined,
      c: '',
      d: at,
      e: ['x'],
      f: { k: 1 },
      g: 'text',
      h: false,
      i: buffer,
    });
    expect(sql).toBe(
      'UPDATE "t" SET "a" = NULL, "b" = NULL, "c" = CAST(? AS TEXT), "d" = ?, "e" = CAST(? AS JSON), "f" = CAST(? AS JSON), "g" = ?, "h" = ?, "i" = ? WHERE "id" = ?',
    );
    expect(values).toEqual([
      '',
      '2026-01-02T03:04:05.678Z',
      '["x"]',
      '{"k":1}',
      'text',
      false,
      buffer,
      'id-1',
    ]);
  });
});
