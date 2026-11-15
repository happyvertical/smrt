import { DatabaseSync } from 'node:sqlite';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { expect, it, vi } from 'vitest';
import { EMPTY_APP } from './definition.ts';
import { assertCanUndoRows } from './extract-model.ts';

it('scans a referencing table once when undoing 10,000 inserted rows', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const collection = vi
    .spyOn(ObjectRegistry, 'getCollection')
    .mockResolvedValue({
      getStiChildMetaType: () => undefined,
    } as never);
  try {
    sqlite.exec(`
      CREATE TABLE _archive (version INTEGER, tbl TEXT, col TEXT, record_id TEXT, value TEXT);
      CREATE TABLE u_sales (id TEXT, customer TEXT);
    `);
    const archive = sqlite.prepare(
      "INSERT INTO _archive VALUES (1, 'Customer', '$row', ?, 'null')",
    );
    for (let index = 0; index < 10000; index++) archive.run(`created-${index}`);
    const sale = sqlite.prepare('INSERT INTO u_sales VALUES (?, ?)');
    for (let index = 0; index < 100; index++)
      sale.run(`sale-${index}`, 'existing');
    const db = {
      query: vi.fn(async (sql: string, params: (string | number)[] = []) => ({
        rows: sqlite.prepare(sql).all(...params),
      })),
    };
    await assertCanUndoRows(
      {
        ...EMPTY_APP,
        models: {
          Customer: { fields: { name: { type: 'text' } } },
          Sale: {
            fields: { customer: { type: 'reference', ref: 'Customer' } },
          },
        },
      },
      db,
      1,
    );
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(collection).toHaveBeenCalledTimes(1);
  } finally {
    collection.mockRestore();
    sqlite.close();
  }
});
