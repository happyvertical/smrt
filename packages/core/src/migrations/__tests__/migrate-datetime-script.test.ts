/**
 * `scripts/migrate-datetime-to-timestamp.ts`, run as its usage line says, on
 * SQLite database files: the table is retyped and keeps its rows, its
 * constraints, its indexes and triggers as written, and its children's rows;
 * a failure part-way changes nothing; the backup is a consistent snapshot.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packageRoot = resolve(__dirname, '../../..');
const script = join(packageRoot, 'scripts/migrate-datetime-to-timestamp.ts');
const tsx = join(packageRoot, 'node_modules/.bin/tsx');

describe('the DATETIME to TIMESTAMP script', () => {
  let directory: string;
  let file: string;

  const run = (...flags: string[]) =>
    spawnSync(tsx, [script, ...flags, file], {
      encoding: 'utf8',
      env: process.env,
    });
  const withDb = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(file);
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const columnType = (db: DatabaseSync, table: string, column: string) =>
    (
      db.prepare(`PRAGMA table_xinfo("${table}")`).all() as {
        name: string;
        type: string;
      }[]
    ).find((col) => col.name === column)?.type;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'smrt-datetime-script-'));
    file = join(directory, 'app.db');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs, retypes the table, and keeps its rows and its unique index', () => {
    withDb((db) => {
      db.exec(
        "CREATE TABLE sqliteX_orders (id TEXT PRIMARY KEY, code TEXT NOT NULL, placed_at DATETIME DEFAULT (datetime('now')))",
      );
      db.exec(
        'CREATE UNIQUE INDEX sqliteX_orders_code ON sqliteX_orders (code)',
      );
      db.exec(
        "INSERT INTO sqliteX_orders (id, code, placed_at) VALUES ('o1', 'A-1', '2026-01-02 03:04:05')",
      );
    });

    const result = run('--no-backup');
    expect(result.stderr).not.toMatch(/Migration failed/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Processing table: sqliteX_orders');

    withDb((db) => {
      expect(columnType(db, 'sqliteX_orders', 'placed_at')).toBe('TIMESTAMP');
      expect(db.prepare('SELECT id, code FROM sqliteX_orders').all()).toEqual([
        { id: 'o1', code: 'A-1' },
      ]);
      expect(() =>
        db.exec("INSERT INTO sqliteX_orders (id, code) VALUES ('o2', 'A-1')"),
      ).toThrow();
    });
  }, 60_000);

  it('keeps a column UNIQUE constraint and replays a partial index exactly as written', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE events (id TEXT PRIMARY KEY, code TEXT UNIQUE, kind TEXT, at DATETIME)',
      );
      db.exec(
        "CREATE INDEX events_datetime_kind ON events (at) WHERE kind = 'DATETIME'",
      );
      db.exec(
        "INSERT INTO events VALUES ('e1', 'C-1', 'DATETIME', '2026-01-01')",
      );
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(columnType(db, 'events', 'at')).toBe('TIMESTAMP');
      expect(() =>
        db.exec("INSERT INTO events VALUES ('e2', 'C-1', 'x', NULL)"),
      ).toThrow(/UNIQUE/);
      expect(
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name = 'events_datetime_kind'",
          )
          .get(),
      ).toEqual({
        sql: "CREATE INDEX events_datetime_kind ON events (at) WHERE kind = 'DATETIME'",
      });
    });
  }, 60_000);

  it('keeps the rows of a child with ON DELETE CASCADE', () => {
    withDb((db) => {
      db.exec('CREATE TABLE parents (id TEXT PRIMARY KEY, created DATETIME)');
      db.exec(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents (id) ON DELETE CASCADE)',
      );
      db.exec("INSERT INTO parents VALUES ('p1', '2026-01-01')");
      db.exec("INSERT INTO children VALUES ('c1', 'p1')");
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(columnType(db, 'parents', 'created')).toBe('TIMESTAMP');
      expect(db.prepare('SELECT id, parent_id FROM children').all()).toEqual([
        { id: 'c1', parent_id: 'p1' },
      ]);
    });
  }, 60_000);

  it('changes nothing when the rebuild fails after the old table was dropped', () => {
    withDb((db) => {
      db.exec('CREATE TABLE parents (id TEXT PRIMARY KEY, created DATETIME)');
      db.exec(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents (id))',
      );
      db.exec("INSERT INTO parents VALUES ('p1', '2026-01-01')");
      // A row the final foreign-key check refuses: the run fails after the
      // drop and rename, before it commits.
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec("INSERT INTO children VALUES ('c1', 'missing')");
    });

    const result = run('--no-backup');
    expect(result.status).toBe(1);

    withDb((db) => {
      expect(columnType(db, 'parents', 'created')).toBe('DATETIME');
      expect(db.prepare('SELECT id FROM parents').all()).toEqual([
        { id: 'p1' },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE '%smrt_timestamp_new%'",
          )
          .all(),
      ).toEqual([]);
    });
  }, 60_000);

  it('keeps implicit rowids, including gaps, and leaves WITHOUT ROWID tables alone', () => {
    withDb((db) => {
      db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, at DATETIME)');
      db.exec("INSERT INTO notes VALUES ('n1', '2026-01-01')");
      db.exec("INSERT INTO notes VALUES ('n2', '2026-01-02')");
      db.exec("INSERT INTO notes VALUES ('n3', '2026-01-03')");
      db.exec("DELETE FROM notes WHERE id = 'n1'");
      db.exec(
        'CREATE TABLE plain (id TEXT PRIMARY KEY, at DATETIME) WITHOUT ROWID',
      );
      db.exec("INSERT INTO plain VALUES ('p1', '2026-01-01')");
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(columnType(db, 'notes', 'at')).toBe('TIMESTAMP');
      expect(
        db.prepare('SELECT rowid, id FROM notes ORDER BY id').all(),
      ).toEqual([
        { rowid: 2, id: 'n2' },
        { rowid: 3, id: 'n3' },
      ]);
      expect(columnType(db, 'plain', 'at')).toBe('TIMESTAMP');
      expect(db.prepare('SELECT id FROM plain').all()).toEqual([{ id: 'p1' }]);
    });
  }, 60_000);

  it('refuses a table whose rowid aliases are all shadowed, changing nothing', () => {
    withDb((db) => {
      db.exec('CREATE TABLE shadow (rowid, _rowid_, oid, at DATETIME)');
      db.exec("INSERT INTO shadow VALUES (1, 2, 3, '2026-01-01')");
    });

    expect(run('--no-backup').status).toBe(1);

    withDb((db) => {
      expect(columnType(db, 'shadow', 'at')).toBe('DATETIME');
    });
  }, 60_000);

  it('does not reissue the id of a deleted AUTOINCREMENT row', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, at DATETIME)',
      );
      db.exec("INSERT INTO tickets (at) VALUES ('2026-01-01')");
      db.exec("INSERT INTO tickets (at) VALUES ('2026-01-02')");
      db.exec("INSERT INTO tickets (at) VALUES ('2026-01-03')");
      db.exec('DELETE FROM tickets WHERE id = 3');
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(columnType(db, 'tickets', 'at')).toBe('TIMESTAMP');
      db.exec("INSERT INTO tickets (at) VALUES ('2026-01-04')");
      expect(db.prepare('SELECT max(id) AS id FROM tickets').get()).toEqual({
        id: 4,
      });
    });
  }, 60_000);

  it('leaves every table as it was when a later table fails', () => {
    withDb((db) => {
      db.exec('CREATE TABLE first_one (id TEXT PRIMARY KEY, at DATETIME)');
      db.exec('CREATE TABLE second_one (id TEXT PRIMARY KEY, at DATETIME)');
      // The name the rebuild of second_one needs.
      db.exec('CREATE TABLE second_one_smrt_timestamp_new (id TEXT)');
      db.exec("INSERT INTO first_one VALUES ('f1', '2026-01-01')");
    });

    expect(run('--no-backup').status).toBe(1);

    withDb((db) => {
      expect(columnType(db, 'first_one', 'at')).toBe('DATETIME');
      expect(columnType(db, 'second_one', 'at')).toBe('DATETIME');
      expect(db.prepare('SELECT id FROM first_one').all()).toEqual([
        { id: 'f1' },
      ]);
    });
  }, 60_000);

  it('rewrites declared types and defaults only, never names or constraints', () => {
    withDb((db) => {
      db.exec(
        `CREATE TABLE t ("datetime" INTEGER, "timestamp" INTEGER, at DATETIME DEFAULT (datetime('now')), CHECK(datetime > 0))`,
      );
      db.exec('INSERT INTO t (datetime, timestamp) VALUES (1, 1)');
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      const sql = String(
        (
          db
            .prepare("SELECT sql FROM sqlite_master WHERE name = 't'")
            .get() as {
            sql: string;
          }
        ).sql,
      );
      expect(sql).toContain('CHECK(datetime > 0)');
      expect(sql).toContain('"datetime" INTEGER');
      expect(sql).toContain('"timestamp" INTEGER');
      expect(sql).toContain('current_timestamp');
      expect(columnType(db, 't', 'at')).toBe('TIMESTAMP');
      expect(() =>
        db.exec('INSERT INTO t (datetime, timestamp) VALUES (-1, 1)'),
      ).toThrow(/CHECK/);
    });
  }, 60_000);

  it('converts DATETIME(n) declarations, and a second run changes nothing', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE precise (id TEXT PRIMARY KEY, a DATETIME(6), b DATETIME (3))',
      );
    });

    expect(run('--no-backup').status).toBe(0);
    withDb((db) => {
      expect(columnType(db, 'precise', 'a')).toBe('TIMESTAMP(6)');
      expect(columnType(db, 'precise', 'b')).toBe('TIMESTAMP (3)');
    });

    const second = run('--no-backup');
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain('Creating new table');
  }, 60_000);

  it('migrates a table whose only DATETIME column is generated', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE gen (id TEXT PRIMARY KEY, raw TEXT, at DATETIME GENERATED ALWAYS AS (raw) STORED)',
      );
      db.exec("INSERT INTO gen (id, raw) VALUES ('g1', '2026-01-01')");
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(columnType(db, 'gen', 'at')).toBe('TIMESTAMP');
      expect(db.prepare('SELECT id, at FROM gen').all()).toEqual([
        { id: 'g1', at: '2026-01-01' },
      ]);
    });
  }, 60_000);

  it('keeps rowids of an INTEGER PRIMARY KEY DESC table, which is not a rowid alias', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE desc_key (id INTEGER PRIMARY KEY DESC, at DATETIME)',
      );
      db.exec("INSERT INTO desc_key (id, at) VALUES (10, '2026-01-01')");
      db.exec("INSERT INTO desc_key (id, at) VALUES (20, '2026-01-02')");
      db.exec("INSERT INTO desc_key (id, at) VALUES (30, '2026-01-03')");
      db.exec('DELETE FROM desc_key WHERE id = 10');
      db.exec('CREATE TABLE alias_key (id INTEGER PRIMARY KEY, at DATETIME)');
      db.exec("INSERT INTO alias_key VALUES (5, '2026-01-01')");
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(columnType(db, 'desc_key', 'at')).toBe('TIMESTAMP');
      expect(
        db.prepare('SELECT rowid, id FROM desc_key ORDER BY id').all(),
      ).toEqual([
        { rowid: 2, id: 20 },
        { rowid: 3, id: 30 },
      ]);
      expect(db.prepare('SELECT rowid AS r, id FROM alias_key').all()).toEqual([
        { r: 5, id: 5 },
      ]);
    });
  }, 60_000);

  it('restores an AUTOINCREMENT counter above 2^53 exactly', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE big_seq (id INTEGER PRIMARY KEY AUTOINCREMENT, at DATETIME)',
      );
      db.exec("INSERT INTO big_seq (at) VALUES ('2026-01-01')");
      db.exec(
        "UPDATE sqlite_sequence SET seq = 9007199254740993 WHERE name = 'big_seq'",
      );
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(columnType(db, 'big_seq', 'at')).toBe('TIMESTAMP');
      expect(
        db
          .prepare(
            "SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'big_seq'",
          )
          .get(),
      ).toEqual({ seq: '9007199254740993' });
    });
  }, 60_000);

  it('converts quoted DATETIME types, and a second run changes nothing', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE quoted (id TEXT PRIMARY KEY, a "DATETIME", b [DATETIME], c `DATETIME`)',
      );
    });

    expect(run('--no-backup').status).toBe(0);
    withDb((db) => {
      for (const column of ['a', 'b', 'c'])
        expect(columnType(db, 'quoted', column)).toBe('TIMESTAMP');
    });
    expect(run('--no-backup').stdout).not.toContain('Creating new table');
  }, 60_000);

  it('keeps a constraint written right after a quoted DATETIME type', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE glued (id TEXT PRIMARY KEY, a [DATETIME]UNIQUE, b "DATETIME"UNIQUE, c `DATETIME`UNIQUE)',
      );
      db.exec("INSERT INTO glued VALUES ('g1', '1', '1', '1')");
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      for (const column of ['a', 'b', 'c']) {
        expect(columnType(db, 'glued', column)).toBe('TIMESTAMP');
        expect(() =>
          db.exec(
            `INSERT INTO glued (id, a, b, c) VALUES ('g2', ${column === 'a' ? "'1'" : "'2'"}, ${column === 'b' ? "'1'" : "'3'"}, ${column === 'c' ? "'1'" : "'4'"})`,
          ),
        ).toThrow(/UNIQUE/);
      }
    });
  }, 60_000);

  it('keeps a column name written directly against a quoted DATETIME type', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE tight (id TEXT PRIMARY KEY, raw TEXT, g[DATETIME] GENERATED ALWAYS AS (raw) STORED, p[DATETIME], q"DATETIME", r`DATETIME`)',
      );
      db.exec(
        "INSERT INTO tight (id, raw, p) VALUES ('t1', '2026-01-01', 'x')",
      );
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      for (const column of ['g', 'p', 'q', 'r'])
        expect(columnType(db, 'tight', column)).toBe('TIMESTAMP');
      expect(db.prepare('SELECT g, p FROM tight').all()).toEqual([
        { g: '2026-01-01', p: 'x' },
      ]);
    });
  }, 60_000);

  it('keeps non-ASCII column names written directly against a quoted DATETIME type', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE accents (id TEXT PRIMARY KEY, raw TEXT, café[DATETIME] AS (raw) STORED, naïve"DATETIME"UNIQUE, ΩX`DATETIME`UNIQUE, café2[DATETIME]UNIQUE AS (raw) STORED)',
      );
      db.exec(
        "INSERT INTO accents (id, raw, naïve, ΩX) VALUES ('a1', '2026-01-01', 'x', 'y')",
      );
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      for (const column of ['café', 'naïve', 'ΩX', 'café2'])
        expect(columnType(db, 'accents', column)).toBe('TIMESTAMP');
      expect(db.prepare('SELECT café, naïve, ΩX FROM accents').all()).toEqual([
        { café: '2026-01-01', naïve: 'x', ΩX: 'y' },
      ]);
      expect(() =>
        db.exec(
          "INSERT INTO accents (id, raw, naïve, ΩX) VALUES ('a2', 'r', 'x', 'z')",
        ),
      ).toThrow(/UNIQUE/);
    });
  }, 60_000);

  it('leaves DATETIME2 and SMALLDATETIME columns alone', () => {
    withDb((db) => {
      db.exec(
        'CREATE TABLE other (id TEXT PRIMARY KEY, a DATETIME2, b SMALLDATETIME)',
      );
    });

    const result = run('--no-backup');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Creating new table');
    withDb((db) => {
      expect(columnType(db, 'other', 'a')).toBe('DATETIME2');
      expect(columnType(db, 'other', 'b')).toBe('SMALLDATETIME');
    });
  }, 60_000);

  it('replays triggers and indexes whose ON clause spells the table in another case', () => {
    withDb((db) => {
      db.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, at DATETIME)');
      db.exec('CREATE TABLE audit (note TEXT)');
      db.exec(
        "CREATE TRIGGER orders_audit AFTER INSERT ON Orders BEGIN INSERT INTO audit VALUES ('x'); END",
      );
      db.exec('CREATE INDEX orders_at ON ORDERS (at)');
    });

    expect(run('--no-backup').status).toBe(0);

    withDb((db) => {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('orders_audit', 'orders_at') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: 'orders_at' }, { name: 'orders_audit' }]);
      db.exec("INSERT INTO orders VALUES ('o1', '2026-01-01')");
      expect(db.prepare('SELECT note FROM audit').all()).toEqual([
        { note: 'x' },
      ]);
    });
  }, 60_000);

  it('backs up committed rows that are still only in the WAL', () => {
    const writer = new DatabaseSync(file);
    try {
      writer.exec('PRAGMA journal_mode = WAL');
      writer.exec('PRAGMA wal_autocheckpoint = 0');
      writer.exec('CREATE TABLE logs (id TEXT PRIMARY KEY, at DATETIME)');
      writer.exec("INSERT INTO logs VALUES ('l1', '2026-01-01')");

      expect(run().status).toBe(0);
    } finally {
      writer.close();
    }

    const backup = readdirSync(directory).find((name) =>
      name.startsWith('app.db.backup-'),
    );
    expect(backup).toBeDefined();
    const copy = new DatabaseSync(join(directory, backup as string));
    try {
      expect(copy.prepare('SELECT id, at FROM logs').all()).toEqual([
        { id: 'l1', at: '2026-01-01' },
      ]);
      expect(columnType(copy, 'logs', 'at')).toBe('DATETIME');
    } finally {
      copy.close();
    }
    expect(existsSync(file)).toBe(true);
  }, 60_000);
});
