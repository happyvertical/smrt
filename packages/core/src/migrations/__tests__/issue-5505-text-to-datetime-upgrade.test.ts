/**
 * #5505: a field the scanner now infers as `datetime` (an unannotated
 * `= new Date()` initializer) used to be a TEXT column. On upgrade the
 * manifest declares TIMESTAMP over a live TEXT column; `db:migrate` plans the
 * conversion. These tests pin what an operator sees: SQLite rebuilds the
 * table and keeps the values (and refuses when the copy would change one);
 * PostgreSQL converts ISO values with an offset, and blocks on empty text
 * (unless `--empty-text-as-null`, which the legacy-timezone confirmation does
 * not imply) and on naive wall-clock text (unless the legacy-timezone
 * confirmation is given), rechecking under the table lock when it applies;
 * DuckDB leaves an indexed timestamp on a self-referencing table to the
 * operator. The PostgreSQL half runs on PGlite under `pnpm test:pglite`.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { getTestDatabase } from '../../testing/database.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { MigrationTracker } from '../tracker.js';

const TABLE = 'dated_visits_5505';
const CHILD = 'visit_notes_5505';

function manifest(
  extra: Partial<SchemaDefinition> = {},
): Record<string, SchemaDefinition> {
  return {
    [TABLE]: {
      tableName: TABLE,
      ddl: '',
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        label: { type: 'TEXT' },
        recorded_at: { type: 'TIMESTAMP' },
        ...(extra.columns ?? {}),
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      version: '1.0.0',
      dependencies: [],
      ...extra,
      ...(extra.columns
        ? {
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              label: { type: 'TEXT' },
              recorded_at: { type: 'TIMESTAMP' },
              ...extra.columns,
            },
          }
        : {}),
    } as SchemaDefinition,
  };
}

function childManifest(): SchemaDefinition {
  return {
    tableName: CHILD,
    ddl: '',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      visit_id: { type: 'TEXT' },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [
      {
        column: 'visit_id',
        referencesTable: TABLE,
        referencesColumn: 'id',
        onDelete: 'CASCADE',
      } as never,
    ],
    version: '1.0.0',
    dependencies: [TABLE],
  } as SchemaDefinition;
}

const executable = (sql: string[]) => sql.filter((s) => !s.startsWith('--'));

describe('TEXT to TIMESTAMP upgrade on SQLite (#5505)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  const comparer = (schemas = manifest()) =>
    new SchemaComparer(db, { engineHint: 'sqlite' }).compare(schemas);
  const stored = async () =>
    (
      await db.query(
        `SELECT id, typeof(recorded_at) AS kind, recorded_at FROM ${TABLE} ORDER BY id`,
      )
    ).rows as Array<{ id: string; kind: string; recorded_at: unknown }>;

  it('rebuilds the table, keeps every value and its storage class, then re-diffs clean', async () => {
    await db.query(
      `CREATE TABLE ${TABLE} (id TEXT PRIMARY KEY, label TEXT, recorded_at TEXT)`,
    );
    await db.query(
      `INSERT INTO ${TABLE} (id, label, recorded_at) VALUES ('a', 'iso', '2026-04-05T06:07:08.000Z'), ('b', 'empty', '')`,
    );

    const diff = await comparer();
    const change = diff.changes.find((c) => c.name === 'recorded_at');
    expect(change?.type).toBe('type_upgrade');
    const statements = executable(getSQLFromDiff(diff));
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) await db.query(sql);

    expect(await stored()).toEqual([
      { id: 'a', kind: 'text', recorded_at: '2026-04-05T06:07:08.000Z' },
      { id: 'b', kind: 'text', recorded_at: '' },
    ]);
    expect((await comparer()).has_changes).toBe(false);
  });

  it('refuses the rebuild when the date/time column would turn numeric-looking text into a number', async () => {
    await db.query(
      `CREATE TABLE ${TABLE} (id TEXT PRIMARY KEY, label TEXT, recorded_at TEXT)`,
    );
    await db.query(
      `INSERT INTO ${TABLE} (id, label, recorded_at) VALUES ('a', 'iso', '2026-04-05T06:07:08.000Z'), ('b', 'padded', '0001')`,
    );
    const diff = await comparer();
    const [result] = await new MigrationTracker({ db }).applyAll(
      [
        {
          id: 'retype_5505_padded',
          description: 'retype',
          version: '1.0.0',
          up: executable(getSQLFromDiff(diff)),
          down: [],
        },
      ],
      { atomic: true },
    );
    expect(result?.success).toBe(false);
    const error = result?.error as { message?: string; cause?: unknown };
    expect(`${error?.message} ${String(error?.cause)}`).toMatch(
      /would change a stored value/,
    );
    // Nothing changed: the original table and its text values are intact.
    expect(await stored()).toEqual([
      { id: 'a', kind: 'text', recorded_at: '2026-04-05T06:07:08.000Z' },
      { id: 'b', kind: 'text', recorded_at: '0001' },
    ]);
  });

  it('applies through the tracker with foreign keys on and keeps cascading child rows', async () => {
    await db.query('PRAGMA foreign_keys = ON');
    await db.query(
      `CREATE TABLE ${TABLE} (id TEXT PRIMARY KEY, label TEXT, recorded_at TEXT)`,
    );
    await db.query(
      `CREATE TABLE ${CHILD} (id TEXT PRIMARY KEY, visit_id TEXT REFERENCES ${TABLE}(id) ON DELETE CASCADE)`,
    );
    await db.query(
      `INSERT INTO ${TABLE} (id, label, recorded_at) VALUES ('a', 'iso', '2026-04-05T06:07:08.000Z')`,
    );
    await db.query(`INSERT INTO ${CHILD} (id, visit_id) VALUES ('n', 'a')`);
    const schemas = { ...manifest(), [CHILD]: childManifest() };
    const diff = await comparer(schemas);
    expect(diff.changes.find((c) => c.name === 'recorded_at')?.type).toBe(
      'type_upgrade',
    );
    const [result] = await new MigrationTracker({ db }).applyAll(
      [
        {
          id: 'retype_5505_parent',
          description: 'retype',
          version: '1.0.0',
          up: executable(getSQLFromDiff(diff)),
          down: [],
        },
      ],
      { atomic: true },
    );
    expect(result?.error).toBeUndefined();
    expect((await db.query(`SELECT id, visit_id FROM ${CHILD}`)).rows).toEqual([
      { id: 'n', visit_id: 'a' },
    ]);
    expect(await stored()).toEqual([
      { id: 'a', kind: 'text', recorded_at: '2026-04-05T06:07:08.000Z' },
    ]);
    expect((await comparer(schemas)).has_changes).toBe(false);
  });
});

describe('TEXT to TIMESTAMP upgrade on DuckDB (#5505)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  });
  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('leaves an indexed timestamp on a self-referencing table to the operator', async () => {
    await db.query(
      `CREATE TABLE ${TABLE} (id TEXT PRIMARY KEY, label TEXT, parent_id TEXT REFERENCES ${TABLE}(id), recorded_at TEXT)`,
    );
    await db.query(
      `CREATE INDEX ${TABLE}_recorded_idx ON ${TABLE} (recorded_at)`,
    );
    await db.query(
      `INSERT INTO ${TABLE} VALUES ('a', 'root', NULL, '2026-04-05T06:07:08.000Z')`,
    );
    await db.query(
      `INSERT INTO ${TABLE} VALUES ('b', 'leaf', 'a', '2026-04-06T06:07:08.000Z')`,
    );
    const diff = await new SchemaComparer(db, {
      engineHint: 'duckdb',
    }).compare(
      manifest({
        columns: { parent_id: { type: 'TEXT' } },
        indexes: [{ name: `${TABLE}_recorded_idx`, columns: ['recorded_at'] }],
        foreignKeys: [
          {
            column: 'parent_id',
            referencesTable: TABLE,
            referencesColumn: 'id',
          } as never,
        ],
      }),
    );
    const change = diff.changes.find((c) => c.name === 'recorded_at');
    expect(change?.kindHint).toBe('type.rebuild-unavailable');
    expect(executable(getSQLFromDiff(diff)).join('\n')).not.toMatch(
      /TIMESTAMP/i,
    );
  });
});

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'TEXT to TIMESTAMP upgrade on PostgreSQL (#5505)',
  () => {
    let db: Awaited<ReturnType<typeof getTestDatabase>>;
    beforeEach(async () => {
      db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      await db.query(
        `CREATE TABLE "${TABLE}" (id TEXT PRIMARY KEY, label TEXT, recorded_at TEXT)`,
      );
    });
    afterEach(async () => {
      await db.close?.();
    });

    const plan = (options: Record<string, unknown> = {}) =>
      new SchemaComparer(db, { engineHint: 'postgres', ...options }).compare(
        manifest(),
      );
    const columnType = async () =>
      (
        await db.query(
          `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'recorded_at'`,
          [TABLE],
        )
      ).rows[0]?.data_type;
    const rows = async () =>
      (await db.query(`SELECT id, recorded_at FROM "${TABLE}" ORDER BY id`))
        .rows as Array<{ id: string; recorded_at: unknown }>;
    /** Run a plan's statements in one transaction, as the tracker does. */
    const apply = async (statements: string[]) => {
      if (!db.transaction) throw new Error('PGlite adapter has transactions');
      await db.transaction(async (tx) => {
        for (const sql of statements) await tx.query(sql);
      });
    };
    /**
     * The PostgreSQL error codes of a failed apply and its causes ('applied'
     * if it succeeded). The adapter redacts messages; `P0001` is the
     * recheck's RAISE EXCEPTION (a failed cast would be `22007`).
     */
    const failure = async (statements: string[]) => {
      try {
        await apply(statements);
        return 'applied';
      } catch (error) {
        const codes: string[] = [];
        for (
          let cause: unknown = error;
          cause;
          cause = (cause as { cause?: unknown }).cause
        )
          codes.push(String((cause as { code?: unknown }).code));
        return codes.join(' ');
      }
    };

    it('converts ISO values written by new Date() serialization', async () => {
      await db.query(
        `INSERT INTO "${TABLE}" VALUES ('a', 'iso', '2026-04-05T06:07:08.000Z')`,
      );
      const diff = await plan();
      for (const sql of executable(getSQLFromDiff(diff))) await db.query(sql);
      expect(await columnType()).toBe('timestamp with time zone');
      const [row] = (await db.query(`SELECT recorded_at FROM "${TABLE}"`))
        .rows as Array<{ recorded_at: Date | string }>;
      expect(new Date(row!.recorded_at).toISOString()).toBe(
        '2026-04-05T06:07:08.000Z',
      );
    });

    it('blocks on empty text until the operator passes emptyTextAsNull', async () => {
      await db.query(
        `INSERT INTO "${TABLE}" VALUES ('a', 'iso', '2026-04-05T06:07:08.000Z'), ('b', 'empty', '')`,
      );
      const blocked = await plan();
      const advisory = blocked.changes.find((c) => c.name === 'recorded_at');
      expect(advisory?.kindHint).toBe('type.invalid-timestamp');
      expect(advisory?.advisory?.message).toContain('--empty-text-as-null');
      expect(executable(getSQLFromDiff(blocked)).join('\n')).not.toMatch(
        /timestamptz/i,
      );

      const allowed = await plan({ emptyTextAsNull: true });
      for (const sql of executable(getSQLFromDiff(allowed)))
        await db.query(sql);
      expect(await columnType()).toBe('timestamp with time zone');
      expect((await rows())[1]).toEqual({ id: 'b', recorded_at: null });
    });

    it('blocks on naive wall-clock text without the legacy-timezone confirmation', async () => {
      await db.query(
        `INSERT INTO "${TABLE}" VALUES ('a', 'naive', '2026-03-01 09:30')`,
      );
      const blocked = await plan();
      const advisory = blocked.changes.find((c) => c.name === 'recorded_at');
      expect(advisory?.kindHint).toBe('type.invalid-timestamp');
      expect(advisory?.advisory?.message).toContain(
        '--postgres-timestamp-legacy-timezone=UTC',
      );
    });

    it('keeps empty text when only the legacy-timezone confirmation is given', async () => {
      await db.query("SET TIME ZONE 'UTC'");
      await db.query(
        `INSERT INTO "${TABLE}" VALUES ('a', 'naive', '2026-03-01 09:30'), ('b', 'empty', '')`,
      );
      const legacy = { postgresTimestampMigration: { legacyTimezone: 'UTC' } };
      const timezoneOnly = await plan(legacy);
      expect(await failure(executable(getSQLFromDiff(timezoneOnly)))).toMatch(
        /\bP0001\b/,
      );
      expect(await columnType()).toBe('text');
      expect(await rows()).toEqual([
        { id: 'a', recorded_at: '2026-03-01 09:30' },
        { id: 'b', recorded_at: '' },
      ]);

      const both = await plan({ ...legacy, emptyTextAsNull: true });
      await apply(executable(getSQLFromDiff(both)));
      expect(await columnType()).toBe('timestamp with time zone');
      const converted = await rows();
      expect(new Date(converted[0]!.recorded_at as string).toISOString()).toBe(
        '2026-03-01T09:30:00.000Z',
      );
      expect(converted[1]).toEqual({ id: 'b', recorded_at: null });
    });

    it('stops when a naive value is written between planning and applying', async () => {
      await db.query(
        `INSERT INTO "${TABLE}" VALUES ('a', 'iso', '2026-04-05T06:07:08.000Z')`,
      );
      const diff = await plan();
      expect(
        diff.changes.find((c) => c.name === 'recorded_at')?.sqlStatements,
      ).toBeDefined();
      await db.query(
        `INSERT INTO "${TABLE}" VALUES ('b', 'late', '2026-03-01 09:30')`,
      );
      expect(await failure(executable(getSQLFromDiff(diff)))).toMatch(
        /\bP0001\b/,
      );
      expect(await columnType()).toBe('text');
      expect((await rows())[1]).toEqual({
        id: 'b',
        recorded_at: '2026-03-01 09:30',
      });
    });
  },
);
