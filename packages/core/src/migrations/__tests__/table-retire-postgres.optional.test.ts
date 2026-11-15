/**
 * The retire step on a real PostgreSQL server (#5005). Counterpart of
 * table-retire.test.ts, which runs the same scenarios in process on SQLite,
 * DuckDB and PGlite. No external service is started: set
 * SMRT_TEST_POSTGRES_URL to run it. It plans with the read-only
 * `getPendingSchemaStatements` and runs the planned statements in a
 * transaction it rolls back, so shared fixtures stay as they were.
 */
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { decideMigrationRun } from '../migration-run-decision.js';
import { getPendingSchemaStatements } from '../orchestrate.js';
import { type RetiredTable, registerRetiredTables } from '../retired-tables.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const PKG = '@retire5005/pg';
const names = [
  'r5005_pg_view',
  'r5005_pg_child',
  'r5005_pg_audited',
  'r5005_pg_parent',
  'r5005_pg_rows',
  'r5005_pg_empty',
];

const retired = (
  table: string,
  extra: Partial<RetiredTable> = {},
): RetiredTable => ({
  table,
  lastOwner: `${PKG}:Gone`,
  since: '1.0.0',
  reason: 'Moved onto the order.',
  rows: 'discard',
  definition: { release: '0.9.0', columns: { id: { type: 'TEXT' } } },
  packageName: PKG,
  ...extra,
});

describe.skipIf(!pgUrl)('retire step on real PostgreSQL (#5005)', () => {
  let db: DatabaseInterface;
  let restore: () => void;
  beforeAll(async () => {
    db = await getDatabase({ type: 'postgres', url: pgUrl });
  });
  const clean = async () => {
    await db.query('DROP VIEW IF EXISTS "r5005_pg_view"');
    for (const table of names)
      await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    await db.query('DROP FUNCTION IF EXISTS "r5005_pg_fn"() CASCADE');
  };
  afterEach(async () => {
    restore?.();
    await clean();
  });
  afterAll(async () => {
    await clean();
    await db.close?.();
  });
  const start = async (...declared: RetiredTable[]) => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    await clean();
    registerRetiredTables(PKG, declared);
  };
  const plan = async () => {
    const pending = await getPendingSchemaStatements(db, {
      engineHint: 'postgres',
    });
    return {
      pending,
      decision: decideMigrationRun({
        changes: pending.diff.changes,
        addedTables: pending.diff.added_tables,
        engine: 'postgres',
      }),
    };
  };
  const exists = async (table: string) =>
    (
      await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      )
    ).rows.length > 0;

  it('plans the drop and the planned SQL drops the table, rows and all', async () => {
    await start(retired('r5005_pg_rows'));
    await db.query('CREATE TABLE "r5005_pg_rows" (id TEXT PRIMARY KEY)');
    await db.query(`INSERT INTO "r5005_pg_rows" VALUES ('a'), ('b')`);
    const { pending, decision } = await plan();
    expect(decision.proceed).toBe(true);
    expect(pending.statements).toEqual([
      'DROP TABLE IF EXISTS "r5005_pg_rows"',
    ]);
    const rollback = new Error('rollback');
    await expect(
      db.transaction?.(async (tx) => {
        for (const sql of pending.statements) await tx.query(sql);
        const gone = await tx.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'r5005_pg_rows'`,
        );
        expect(gone.rows).toHaveLength(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await exists('r5005_pg_rows')).toBe(true);
  });

  it('plans nothing for an absent table', async () => {
    await start(retired('r5005_pg_empty'));
    const { pending } = await plan();
    expect(pending.statements).toEqual([]);
  });

  it("stops on rows without rows: 'discard'", async () => {
    await start(retired('r5005_pg_rows', { rows: undefined }));
    await db.query('CREATE TABLE "r5005_pg_rows" (id TEXT PRIMARY KEY)');
    await db.query(`INSERT INTO "r5005_pg_rows" VALUES ('a')`);
    const { decision } = await plan();
    expect(decision.proceed).toBe(false);
    expect(decision.stops.map((stop) => stop.kind)).toEqual([
      'table.retire-rows',
    ]);
  });

  it('names a foreign key, a view and a trigger function that depend on the table', async () => {
    await start(retired('r5005_pg_parent'));
    await db.query('CREATE TABLE "r5005_pg_parent" (id TEXT PRIMARY KEY)');
    await db.query(
      `CREATE TABLE "r5005_pg_child" (id TEXT PRIMARY KEY, p TEXT REFERENCES "r5005_pg_parent"(id))`,
    );
    await db.query(
      'CREATE VIEW "r5005_pg_view" AS SELECT id FROM "r5005_pg_parent"',
    );
    await db.query('CREATE TABLE "r5005_pg_audited" (id TEXT PRIMARY KEY)');
    await db.query(
      `CREATE FUNCTION "r5005_pg_fn"() RETURNS trigger AS $$ BEGIN INSERT INTO "r5005_pg_parent"(id) VALUES (NEW.id); RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await db.query(
      'CREATE TRIGGER "r5005_pg_trg" AFTER INSERT ON "r5005_pg_audited" FOR EACH ROW EXECUTE FUNCTION "r5005_pg_fn"()',
    );
    const { decision } = await plan();
    expect(decision.proceed).toBe(false);
    const messages = decision.stops.map((stop) => stop.message).join('\n');
    expect(messages).toContain('foreign key r5005_pg_child.p');
    expect(messages).toContain('view r5005_pg_view');
    expect(messages).toContain('trigger r5005_pg_trg on r5005_pg_audited');
    expect(new Set(decision.stops.map((stop) => stop.kind))).toEqual(
      new Set(['table.retire-dependent']),
    );
  });
});
