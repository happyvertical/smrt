import { describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../schema/types';
import {
  buildDuckDbIdUpdate,
  collectIndexedColumns,
  storedValueEquals,
  timestampColumnsToProve,
  timestampMicros,
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

  it('proves timestamps only against the stored text, at full precision', () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    // No stored text, no proof: a hydrated Date has lost sub-ms digits.
    expect(storedValueEquals('TIMESTAMP', at, new Date(at))).toBe(false);
    const equal = (next: unknown, stored: string) =>
      storedValueEquals('TIMESTAMP', next, new Date(0), stored);
    expect(equal(at, '2026-01-02 03:04:05.678')).toBe(true);
    expect(equal(at, '2026-01-02 03:04:05.678000')).toBe(true);
    expect(equal(at, at.toISOString())).toBe(true);
    expect(equal(at.toISOString(), '2026-01-02 03:04:05.678')).toBe(true);
    expect(
      equal('2026-01-02T04:04:05.678+01:00', '2026-01-02 03:04:05.678'),
    ).toBe(true);
    // Same millisecond, different microseconds: changed.
    expect(equal(at, '2026-01-02 03:04:05.678901')).toBe(false);
    expect(
      equal('2026-01-02T03:04:05.678901Z', '2026-01-02 03:04:05.678'),
    ).toBe(false);
    // Identical at full precision: provable.
    expect(
      equal('2026-01-02T03:04:05.678901Z', '2026-01-02 03:04:05.678901'),
    ).toBe(true);
    expect(equal(at, '2026-01-02 03:04:05.679')).toBe(false);
    // Unzoned requested text, or digits finer than microseconds, are unprovable.
    expect(equal('2026-01-02 03:04:05.678', '2026-01-02 03:04:05.678')).toBe(
      false,
    );
    expect(
      equal('2026-01-02T03:04:05.6780001Z', '2026-01-02 03:04:05.678'),
    ).toBe(false);
    expect(equal('garbage', 'garbage')).toBe(false);
    expect(equal(new Date(Number.NaN), '2026-01-02 03:04:05.678')).toBe(false);
  });

  it('keeps the literal year for years 0000-0099', () => {
    const at1999 = new Date('1999-01-02T03:04:05Z');
    // A stored year 99 is not 1999.
    expect(
      storedValueEquals(
        'TIMESTAMP',
        at1999,
        new Date(0),
        '0099-01-02 03:04:05',
      ),
    ).toBe(false);
    expect(
      storedValueEquals(
        'TIMESTAMP',
        '0099-01-02T03:04:05Z',
        new Date(0),
        '1999-01-02 03:04:05',
      ),
    ).toBe(false);
    // The same early instant on both sides is still provable.
    const year99 = new Date(Date.UTC(2000, 0, 2, 3, 4, 5));
    year99.setUTCFullYear(99);
    expect(timestampMicros('0099-01-02 03:04:05', true)).toBe(
      BigInt(year99.getTime()) * 1000n,
    );
    expect(
      storedValueEquals(
        'TIMESTAMP',
        year99,
        new Date(0),
        '0099-01-02 03:04:05',
      ),
    ).toBe(true);
    const year0 = new Date(Date.UTC(2000, 0, 1));
    year0.setUTCFullYear(0);
    expect(timestampMicros('0000-01-01T00:00:00Z')).toBe(
      BigInt(year0.getTime()) * 1000n,
    );
    // Negative years and DuckDB's BC rendering are unprovable.
    expect(timestampMicros('-0001-01-02 03:04:05', true)).toBeUndefined();
    expect(timestampMicros('0001-01-02 03:04:05 (BC)', true)).toBeUndefined();
  });

  it('refuses impossible timestamp fields instead of rolling them over', () => {
    // Month 13 would roll to 2027-01; it must not prove equal to that.
    expect(
      storedValueEquals(
        'TIMESTAMP',
        '2026-13-02T03:04:05.678Z',
        new Date(0),
        '2027-01-02 03:04:05.678',
      ),
    ).toBe(false);
    // Minute 60 would roll to the next hour.
    expect(
      storedValueEquals(
        'TIMESTAMP',
        '2026-01-02T03:60:05Z',
        new Date(0),
        '2026-01-02 04:00:05',
      ),
    ).toBe(false);
    expect(timestampMicros('2026-02-30T00:00:00Z')).toBeUndefined();
    expect(timestampMicros('2026-01-02T24:00:00Z')).toBeUndefined();
    expect(timestampMicros('2026-01-02T03:04:60Z')).toBeUndefined();
    expect(timestampMicros('2026-01-02T03:04:05+25:00')).toBeUndefined();
    expect(timestampMicros('2026-01-02 03:04:05', true)).toBeDefined();
  });

  it('reads timestamp text exactly', () => {
    expect(timestampMicros('2026-01-02 03:04:05.5', true)).toBe(
      BigInt(Date.UTC(2026, 0, 2, 3, 4, 5)) * 1000n + 500000n,
    );
    expect(timestampMicros('2026-01-02 03:04:05')).toBeUndefined();
    expect(timestampMicros('2026-01-02T03:04:05-0230')).toBe(
      BigInt(Date.UTC(2026, 0, 2, 5, 34, 5)) * 1000n,
    );
    expect(timestampMicros(42)).toBeUndefined();
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
    created_at: { type: 'TIMESTAMP' },
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

  it('needs the stored text to skip an indexed timestamp', () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    const indexedWithCreated = new Set([...indexed, 'created_at']);
    const data = { id: 'x', created_at: at, updated_at: new Date() };
    const stored = { id: 'x', created_at: new Date(at), updated_at: at };
    expect(
      timestampColumnsToProve(data, stored, indexedWithCreated, types),
    ).toEqual(['created_at']);
    expect([
      ...unchangedIndexedColumns(data, stored, indexedWithCreated, types),
    ]).toEqual([]);
    expect([
      ...unchangedIndexedColumns(data, stored, indexedWithCreated, types, {
        created_at: '2026-01-02 03:04:05.678',
      }),
    ]).toEqual(['created_at']);
    expect([
      ...unchangedIndexedColumns(data, stored, indexedWithCreated, types, {
        created_at: '2026-01-02 03:04:05.678901',
      }),
    ]).toEqual([]);
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
