import { DatabaseSync } from 'node:sqlite';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { expect, it, vi } from 'vitest';
import { JOURNAL_LIMITS, prepareLoad, undoRows } from './data-migrations.ts';
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
it('refuses a load preview whose stored originals exceed the journal budget', async () => {
  const f = fixture();
  try {
    f.sqlite
      .prepare('INSERT INTO u_notes VALUES (?, ?, ?)')
      .run('one', 'first', 'x'.repeat(JOURNAL_LIMITS.bytes));
    await expect(
      prepareLoad(def, f.db, {
        type: 'loadRecords',
        model: 'Note',
        mode: 'upsert',
        key: ['name'],
        rows: [{ name: 'first', body: 'small' }],
      }),
    ).rejects.toThrow(/undo journal.*bytes/);
    expect(
      f.sqlite.prepare('SELECT body FROM u_notes').get()?.body,
    ).toHaveLength(JOURNAL_LIMITS.bytes);
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

it('checks exact stored load metadata in planning without app writes or leftover copies', async () => {
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { AppHost, MemoryVersionStore } = await import('./index.ts');
  const dir = mkdtempSync(join(tmpdir(), 'load-plan-budget-'));
  const host = await AppHost.open(dir, { store: new MemoryVersionStore() });
  try {
    await host.execute(
      { type: 'defineModel', name: 'Memo', fields: { body: { type: 'text' } } },
      { author: 't', approved: true },
    );
    await host.execute(
      {
        type: 'loadRecords',
        model: 'Memo',
        mode: 'insert',
        rows: [{ body: 'x' }],
      },
      { author: 't', approved: true },
    );
    const probe = new DatabaseSync(join(dir, 'app.db'));
    const bytes = Number(
      probe
        .prepare(
          "SELECT SUM(length(CAST(value AS BLOB))) AS n FROM _archive WHERE version = ? AND col IN ('$row','$after','$deleted')",
        )
        .get(host.version)?.n,
    );
    probe.close();
    await host.execute({ type: 'undo' }, { author: 't', approved: true });
    const body = 'x'.repeat(JOURNAL_LIMITS.bytes - bytes + 2);
    const command = {
      type: 'loadRecords' as const,
      model: 'Memo',
      mode: 'insert' as const,
      rows: [{ body }],
    };
    expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(
      JOURNAL_LIMITS.bytes,
    );
    const version = host.version;
    await expect(host.plan(command)).rejects.toThrow(/undo journal.*bytes/);
    expect(host.version).toBe(version);
    expect(await host.list('Memo')).toEqual([]);
    expect(
      readdirSync(dir).filter((name) => name.startsWith('.load-preview-')),
    ).toEqual([]);
    await expect(
      host.execute(command, { author: 't', approved: true }),
    ).rejects.toThrow(/undo journal.*bytes/);
    expect(await host.list('Memo')).toEqual([]);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
