// The dialect's column types are what core's own DDL creates (#5186): an
// engine ADD COLUMN and core's planned table must agree, or the next boot's
// storage-family check refuses the column. Table-driven per field type, on
// both databases.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { harnessDatabase } from './db/harness.ts';
import { dialectFor } from './db/index.ts';
import { FIELD_TYPES, type FieldType } from './definition.ts';
import { AppHost, MemoryVersionStore } from './index.ts';

const dirs: string[] = [];
const hosts: AppHost[] = [];
const released: Array<() => Promise<void> | undefined> = [];
afterAll(async () => {
  for (const h of hosts) await h.close();
  for (const r of released) await r();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const fieldsOf = () =>
  Object.fromEntries(
    FIELD_TYPES.map((t) => [
      `f${t[0].toUpperCase()}${t.slice(1)}`,
      t === 'choice'
        ? { type: t, choices: ['a', 'b'] }
        : t === 'reference'
          ? { type: t, ref: 'Probe' }
          : { type: t },
    ]),
  );

describe.each(['sqlite', 'postgres'] as const)('column types on %s', (kind) => {
  it('storage family of each field type matches the column core creates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-dialect-'));
    dirs.push(dir);
    const dialect = dialectFor({ kind });
    const pg = kind === 'postgres' ? await harnessDatabase(dir) : null;
    if (pg) released.push(() => pg.release?.());
    const host = await AppHost.open(dir, {
      store: new MemoryVersionStore(),
      database: pg ? pg.config : { kind: 'sqlite' },
    });
    hosts.push(host);
    await host.execute(
      {
        type: 'defineModel',
        name: 'Probe',
        fields: fieldsOf() as never,
      },
      { author: 't' },
    );
    let created: Record<string, string>;
    if (pg && pg.config.kind === 'pglite') {
      const rows = (
        await pg.config.client.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'u_probes'`,
        )
      ).rows;
      created = Object.fromEntries(
        rows.map((r: { column_name: string; data_type: string }) => [
          r.column_name,
          r.data_type,
        ]),
      );
    } else {
      const db = new DatabaseSync(join(dir, 'app.db'), { readOnly: true });
      created = Object.fromEntries(
        (
          db
            .prepare(`SELECT name, type FROM pragma_table_info('u_probes')`)
            .all() as any[]
        ).map((r) => [r.name, r.type]),
      );
      db.close();
    }
    const wrong: string[] = [];
    for (const t of FIELD_TYPES as readonly FieldType[]) {
      const have = created[`f_${t}`];
      expect(have, `column f_${t}`).toBeTruthy();
      if (
        dialect.storageFamily(have) !==
        dialect.storageFamily(dialect.columnType(t))
      )
        wrong.push(
          `${t}: core made ${have}, dialect says ${dialect.columnType(t)}`,
        );
    }
    expect(wrong).toEqual([]);
  });
});

// Per field type, through the real engine path (removeField, then undo), with
// the stored column read RAW before and after (SQLite: typeof + quote(); PostgreSQL:
// the value cast to text), not through hydration. `date` is the one date/time
// field type: it is DATETIME on SQLite (ISO text) and TIMESTAMPTZ on PostgreSQL,
// so one case holds a date-only value and one a full UTC timestamp.
const ROUND_TRIP: Array<[string, Record<string, unknown>, unknown[]]> = [
  ['date', { type: 'date' }, ['2026-01-05', '2026-11-20T12:34:56.000Z']],
  ['boolean', { type: 'boolean' }, [true, false]],
  ['integer', { type: 'integer' }, [5, -7]],
  ['number', { type: 'number' }, [1.5, 0.1]],
  ['money', { type: 'money' }, [12345, 1]],
  ['json', { type: 'json' }, [{ k: [1, 2], s: 'x' }, { a: null }]],
  ['text', { type: 'text' }, ['n', ' padded ']],
];

describe.each([
  'sqlite',
  'postgres',
] as const)('archive round trip on %s', (kind) => {
  it.each(
    ROUND_TRIP,
  )('removeField then undo restores %s values byte-identically', async (type, def, values) => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-archive-'));
    dirs.push(dir);
    const pg = kind === 'postgres' ? await harnessDatabase(dir) : null;
    if (pg) released.push(() => pg.release?.());
    const host = await AppHost.open(dir, {
      store: new MemoryVersionStore(),
      database: pg ? pg.config : { kind: 'sqlite' },
    });
    hosts.push(host);
    await host.execute(
      {
        type: 'defineModel',
        name: 'Keep',
        fields: { label: { type: 'text' }, value: def } as never,
      },
      { author: 't' },
    );
    for (const [i, v] of values.entries())
      await host.create('Keep', { label: `r${i}`, value: v });
    const raw = async (): Promise<unknown[]> => {
      if (pg && pg.config.kind === 'pglite') {
        const c = pg.config.client;
        return c.transaction(async (tx) => {
          await tx.query(`SELECT set_config('search_path', 'app', true)`);
          return (
            await tx.query(
              `SELECT label, CAST("value" AS TEXT) AS v FROM u_keeps ORDER BY label`,
            )
          ).rows;
        });
      }
      const db = new DatabaseSync(join(dir, 'app.db'), { readOnly: true });
      try {
        return db
          .prepare(
            `SELECT label, typeof("value") AS t, quote("value") AS v FROM u_keeps ORDER BY label`,
          )
          .all();
      } finally {
        db.close();
      }
    };
    const before = await raw();
    expect(before).toHaveLength(values.length);
    await host.execute(
      { type: 'removeField', model: 'Keep', field: 'value' },
      { author: 't', approved: true },
    );
    await host.execute({ type: 'undo' }, { author: 't', approved: true });
    expect(await raw(), type).toEqual(before);
  });
});
