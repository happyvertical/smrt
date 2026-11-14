import { DatabaseSync } from 'node:sqlite';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { expect, it, vi } from 'vitest';
import {
  applyLoad,
  JOURNAL_LIMITS,
  prepareLoad,
  undoRows,
} from './data-migrations.ts';
import { EMPTY_APP } from './definition.ts';

const def = {
  ...EMPTY_APP,
  models: {
    Note: {
      fields: {
        name: { type: 'text' as const },
        body: { type: 'text' as const },
        length: {
          type: 'integer' as const,
          calculated: { op: 'length', value: { col: 'body' } } as never,
        },
      },
    },
  },
};
const command = {
  type: 'loadRecords' as const,
  model: 'Note',
  mode: 'upsert' as const,
  key: ['name'],
  rows: [{ name: 'one', body: 'new' }],
};
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE u_notes (id TEXT PRIMARY KEY, name TEXT, body TEXT,
    sdk_meta TEXT DEFAULT 'default', optional TEXT, updated_at TEXT,
    length INTEGER GENERATED ALWAYS AS (length(body)) VIRTUAL);
    CREATE TABLE _archive (id INTEGER PRIMARY KEY, version INTEGER, tbl TEXT,
    col TEXT, record_id TEXT, value TEXT, created_at TEXT)`);
  let sequence = 0;
  const db = {
    query: async (sql: string, params: any[] = []) => ({
      rows: sqlite.prepare(sql).all(...params),
    }),
    insert: async (table: string, rows: Record<string, any>[]) => {
      for (const row of rows) {
        const columns = Object.keys(row);
        sqlite
          .prepare(
            `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
    },
    transaction: async (run: (tx: any) => Promise<any>): Promise<any> => {
      const name = `s${sequence++}`;
      sqlite.exec(`SAVEPOINT ${name}`);
      try {
        const result = await run(db);
        sqlite.exec(`RELEASE ${name}`);
        return result;
      } catch (e) {
        sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    },
  };
  const collection = {
    getStiChildMetaType: () => undefined,
    create: async (data: any) => {
      // Stand in for SDK defaults, a variable slug and a normalizing save hook.
      sqlite
        .prepare(
          'INSERT INTO u_notes (id,name,body,sdk_meta,updated_at) VALUES (?,?,?,?,?)',
        )
        .run(
          data.id,
          data.name,
          data.body.toUpperCase(),
          `derived:${data.body}`,
          '2026-11-14T00:00:00.000Z',
        );
    },
    update: async (id: string, data: any) => {
      sqlite
        .prepare(
          'UPDATE u_notes SET name=?,body=?,sdk_meta=?,updated_at=? WHERE id=?',
        )
        .run(
          data.name,
          data.body.toUpperCase(),
          `derived:${data.body}`,
          '2026-11-14T00:00:00.000Z',
          id,
        );
    },
  };
  const spy = vi
    .spyOn(ObjectRegistry, 'getCollection')
    .mockResolvedValue(collection as never);
  const before = () =>
    sqlite.prepare('SELECT * FROM u_notes').get() as Record<string, any>;
  return {
    sqlite,
    db,
    before,
    close: () => {
      spy.mockRestore();
      sqlite.close();
    },
  };
}

it('shares exact UTF-8 journal bytes for inserts, updates, null/default/calculated fields and normalizing hooks', async () => {
  const f = fixture();
  try {
    const input = { ...command, rows: [{ name: 'one', body: 'é😀' }] };
    for (let version = 1; version <= 2; version++) {
      const planned = await prepareLoad(def, f.db, input);
      await f.db.transaction((tx) =>
        applyLoad(def, tx, input, version, 'seed'),
      );
      const bytes = Number(
        f.sqlite
          .prepare(
            'SELECT SUM(length(CAST(value AS BLOB))) AS n FROM _archive WHERE version=?',
          )
          .get(version)?.n,
      );
      expect(bytes).toBe(planned.journalBytes);
      expect(f.before()).toMatchObject({
        body: 'É😀',
        sdk_meta: 'derived:é😀',
        optional: null,
        length: 2,
      });
    }
    await undoRows(def, f.db, 2);
    expect(f.before()).toMatchObject({ body: 'É😀' });
  } finally {
    f.close();
  }
});

it('protects derived metadata while preserving later edits to unchanged columns and restores full originals', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(
      "INSERT INTO u_notes (id,name,body,sdk_meta,optional,updated_at) VALUES ('one','one','old','old-derived',NULL,'old-time')",
    );
    await f.db.transaction((tx) => applyLoad(def, tx, command, 1, 'seed'));
    f.sqlite.exec("UPDATE u_notes SET sdk_meta='later' WHERE id='one'");
    await expect(
      f.db.transaction((tx) => undoRows(def, tx, 1)),
    ).rejects.toThrow(/changed since/);
    expect(f.before().body).toBe('NEW');
    f.sqlite.exec(
      "UPDATE u_notes SET sdk_meta='derived:new',optional='later unrelated' WHERE id='one'",
    );
    await undoRows(def, f.db, 1);
    expect(f.before()).toMatchObject({
      body: 'old',
      sdk_meta: 'old-derived',
      optional: 'later unrelated',
      updated_at: 'old-time',
    });
  } finally {
    f.close();
  }
});

it('refuses edited inserts and continues to undo legacy full-value postimages', async () => {
  const f = fixture();
  try {
    await f.db.transaction((tx) => applyLoad(def, tx, command, 1, 'seed'));
    f.sqlite.exec("UPDATE u_notes SET optional='later' ");
    await expect(undoRows(def, f.db, 1)).rejects.toThrow(/changed since/);
    f.sqlite.exec('DELETE FROM _archive; DELETE FROM u_notes');
    f.sqlite.exec(
      "INSERT INTO u_notes (id,name,body) VALUES ('legacy','one','new')",
    );
    await f.db.insert('_archive', [
      {
        version: 2,
        tbl: 'Note',
        col: '$row',
        record_id: 'legacy',
        value: JSON.stringify({ id: 'legacy', name: 'one', body: 'old' }),
      },
      {
        version: 2,
        tbl: 'Note',
        col: '$after',
        record_id: 'legacy',
        value: JSON.stringify({ body: 'new' }),
      },
    ]);
    await undoRows(def, f.db, 2);
    expect(f.before().body).toBe('old');
  } finally {
    f.close();
  }
});

it('rejects exact metadata overflow in plan and apply before writes and accepts the boundary', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(
      "INSERT INTO u_notes (id,name,body,sdk_meta) VALUES ('one','one','x','metadata')",
    );
    const baseline = await prepareLoad(def, f.db, command);
    const padding = JOURNAL_LIMITS.bytes - baseline.journalBytes;
    const boundary = padding + 1 - (String(padding + 1).length - 1);
    f.sqlite.prepare('UPDATE u_notes SET body=?').run('x'.repeat(boundary));
    const planned = await prepareLoad(def, f.db, command);
    expect(planned.journalBytes).toBe(JOURNAL_LIMITS.bytes);
    await f.db.transaction((tx) => applyLoad(def, tx, command, 1, 'seed'));
    await undoRows(def, f.db, 1);
    f.sqlite.prepare('UPDATE u_notes SET body=?').run('x'.repeat(boundary + 1));
    const original = f.before();
    await expect(prepareLoad(def, f.db, command)).rejects.toThrow(
      /undo journal.*bytes/,
    );
    await expect(
      f.db.transaction((tx) => applyLoad(def, tx, command, 2, 'seed')),
    ).rejects.toThrow(/undo journal.*bytes/);
    expect(f.before()).toEqual(original);
    expect(
      f.sqlite.prepare('SELECT COUNT(*) AS n FROM _archive').get()?.n,
    ).toBe(0);
  } finally {
    f.close();
  }
});

it('bounds full command input before reading metadata', async () => {
  const f = fixture();
  const query = vi.spyOn(f.db, 'query');
  try {
    await expect(
      prepareLoad(def, f.db, {
        ...command,
        rows: Array.from({ length: 10001 }, () => ({})),
      }),
    ).rejects.toThrow(/10000/);
    await expect(
      prepareLoad(def, f.db, {
        ...command,
        rows: [{ body: 'x'.repeat(JOURNAL_LIMITS.bytes) }],
      }),
    ).rejects.toThrow(/bytes/);
    expect(query).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('agrees with real SDK metadata and preserves undo through restart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { AppHost, MemoryVersionStore } = await import('./index.ts');
  const dir = mkdtempSync(join(tmpdir(), 'bounded-load-sdk-'));
  const store = new MemoryVersionStore();
  let host = await AppHost.open(dir, { store });
  try {
    await host.execute(
      {
        type: 'defineModel',
        name: 'Memo',
        fields: {
          body: { type: 'text' },
          optional: { type: 'text' },
          len: {
            type: 'integer',
            calculated: { op: 'add', left: { value: 1 }, right: { value: 2 } },
          },
        },
      },
      { author: 't', approved: true },
    );
    const input = {
      type: 'loadRecords' as const,
      model: 'Memo',
      mode: 'insert' as const,
      rows: [{ body: 'é😀' }],
    };
    expect((await host.plan(input)).preview).toMatchObject({ insert: 1 });
    await host.execute(input, { author: 't', approved: true });
    expect(await host.list('Memo')).toMatchObject([{ body: 'é😀', len: 3 }]);
    await host.close();
    host = await AppHost.open(dir, { store });
    await host.execute({ type: 'undo' }, { author: 't', approved: true });
    expect(await host.list('Memo')).toEqual([]);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
