import { DatabaseSync } from 'node:sqlite';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { expect, it, vi } from 'vitest';
import { undoRows } from './data-migrations.ts';
import { EMPTY_APP } from './definition.ts';

const def = {
  ...EMPTY_APP,
  models: {
    Note: {
      label: 'Notes',
      titleField: 'name',
      fields: {
        name: { type: 'text' as const },
        body: { type: 'text' as const },
      },
    },
  },
};
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    'CREATE TABLE u_notes (id TEXT, name TEXT, body TEXT); CREATE TABLE _archive (id INTEGER PRIMARY KEY, version INTEGER, tbl TEXT, col TEXT, record_id TEXT, value TEXT)',
  );
  const collection = vi
    .spyOn(ObjectRegistry, 'getCollection')
    .mockResolvedValue({ getStiChildMetaType: () => undefined } as never);
  const db = {
    query: async (
      sql: string,
      params: import('node:sqlite').SQLInputValue[] = [],
    ) => ({
      rows: sqlite.prepare(sql).all(...params),
    }),
  };
  return {
    sqlite,
    db,
    close: () => {
      collection.mockRestore();
      sqlite.close();
    },
  };
}
it('names all conflicting records with bounded human labels and a total', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 12; i++) {
      f.sqlite
        .prepare('INSERT INTO u_notes VALUES (?, ?, ?)')
        .run(`secret-id-${i}`, `Friendly ${i}`, 'edited');
      for (const [col, value] of [
        ['$row', { id: `secret-id-${i}`, name: `Friendly ${i}`, body: 'old' }],
        ['$after', { body: 'merged' }],
      ])
        f.sqlite
          .prepare(
            'INSERT INTO _archive (version,tbl,col,record_id,value) VALUES (1,?,?,?,?)',
          )
          .run('Note', String(col), `secret-id-${i}`, JSON.stringify(value));
    }
    const error = await undoRows(def, f.db, 1).catch((e) => e);
    expect(error.message).toMatch(/12 records/);
    expect(error.message).toContain('Friendly 11');
    expect(error.message).not.toContain('secret-id');
    expect(error.message).not.toContain('Note.body');
    expect((error.message.match(/Friendly /g) ?? []).length).toBe(10);
    expect(error.message).toContain('2 more');
  } finally {
    f.close();
  }
});
it('explains missing undo safety information without storage terminology', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`INSERT INTO u_notes VALUES ('secret-id', 'My note', 'body');
      INSERT INTO _archive (version,tbl,col,record_id,value) VALUES (1,'Note','$row','secret-id','{"name":"My note"}')`);
    await expect(undoRows(def, f.db, 1)).rejects.toThrow(
      /Notes “My note”: the saved information needed to safely undo is unavailable/,
    );
  } finally {
    f.close();
  }
});
