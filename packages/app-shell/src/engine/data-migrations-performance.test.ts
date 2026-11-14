import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { undoRows } from './data-migrations.ts';
import type { AppDefinition } from './definition.ts';

const def = {
  format: 1,
  models: { Item: { fields: { name: { type: 'text' } } } },
} as unknown as AppDefinition;

beforeEach(() => {
  vi.spyOn(ObjectRegistry, 'getCollection').mockResolvedValue({
    getStiChildMetaType: () => undefined,
  } as never);
});
afterEach(() => vi.restoreAllMocks());

function executor(size: number, update = false, conflict = false) {
  const rows = Array.from({ length: size }, (_, i) => ({
    id: String(i),
    name: 'loaded',
  }));
  const originals = rows.map((row) => ({
    tbl: 'Item',
    record_id: row.id,
    value: JSON.stringify(update ? { ...row, name: 'original' } : null),
  }));
  const posts = rows.map((row) => ({
    tbl: 'Item',
    record_id: row.id,
    col: '$after',
    value: JSON.stringify(row),
  }));
  if (conflict) rows[rows.length - 1].name = 'edited';
  const statements: string[] = [];
  return {
    statements,
    async query(sql: string, params: unknown[] = []) {
      statements.push(sql);
      if (sql.includes("col = '$row'")) return { rows: originals };
      if (sql.includes("col IN ('$after', '$deleted')")) return { rows: posts };
      if (sql.startsWith('SELECT *')) return { rows };
      if (sql.includes('pragma_table_xinfo')) return { rows: [] };
      if (sql.startsWith('DELETE FROM "u_items"')) {
        expect(params.length).toBeLessThanOrEqual(500);
      }
      return { rows: [] };
    },
  };
}

it.each([
  1, 501, 1001,
])('undo batches deletion of %i created records after one model read', async (size) => {
  const db = executor(size);
  await undoRows(def, db, 3);
  expect(
    db.statements.filter((sql) => sql.startsWith('DELETE FROM "u_items"')),
  ).toHaveLength(Math.ceil(size / 500));
  expect(
    db.statements.filter((sql) => sql.startsWith('SELECT *')),
  ).toHaveLength(1);
  expect(db.statements).toHaveLength(4 + Math.ceil(size / 500));
});

it('reads generated-column metadata once for an entire updated model', async () => {
  const db = executor(501, true);
  await undoRows(def, db, 3);
  expect(
    db.statements.filter((sql) => sql.includes('pragma_table_xinfo')),
  ).toHaveLength(1);
  expect(db.statements.filter((sql) => sql.startsWith('UPDATE'))).toHaveLength(
    501,
  );
});

it('refuses a last-row conflict before any batch deletion or archive mutation', async () => {
  const db = executor(1001, false, true);
  await expect(undoRows(def, db, 3)).rejects.toThrow(/changed since/);
  expect(
    db.statements.filter((sql) => /^(DELETE|UPDATE|INSERT)/.test(sql)),
  ).toHaveLength(0);
});

it('previews actual changed fields from hash journals and retains legacy postimages', async () => {
  const { createHash } = await import('node:crypto');
  const { AppRuntime } = await import('./app-runtime.ts');
  const hash = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('base64');
  const entries = [
    {
      tbl: 'Item',
      record_id: 'hash',
      col: '$row',
      value: JSON.stringify({ name: 'old', code: 'keep' }),
    },
    {
      tbl: 'Item',
      record_id: 'hash',
      col: '$after',
      value: JSON.stringify({
        $load: 1,
        hashes: { name: hash('new'), code: hash('keep') },
      }),
    },
    {
      tbl: 'Item',
      record_id: 'legacy',
      col: '$row',
      value: JSON.stringify({ name: 'old' }),
    },
    {
      tbl: 'Item',
      record_id: 'legacy',
      col: '$after',
      value: JSON.stringify({ name: 'new' }),
    },
    { tbl: 'Item', record_id: 'insert', col: '$row', value: 'null' },
    {
      tbl: 'Item',
      record_id: 'insert',
      col: '$after',
      value: JSON.stringify({ $load: 1, hashes: { name: hash('new') } }),
    },
  ];
  const runtime = new AppRuntime('', def, 3);
  Object.assign(runtime, { db: { query: async () => ({ rows: entries }) } });
  expect(
    await runtime.countOverwrites(3, [{ op: 'loadRecords' } as never]),
  ).toEqual([
    { table: 'u_items', column: 'name', replaced: 2 },
    { table: 'u_items', column: '(remove created record)', replaced: 1 },
  ]);
});
