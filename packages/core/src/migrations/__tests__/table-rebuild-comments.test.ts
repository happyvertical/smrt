/**
 * A DuckDB table rebuild keeps the table's catalog comments (P5a, E7).
 *
 * The rebuild drops the table and creates it again, which discards every
 * `COMMENT ON` the catalog held for it. The comments are read at planning,
 * written again after the indexes, and part of the plan guard, so a comment
 * changed after planning stops a saved plan like any other table change.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../../schema/types.js';
import { isCommentOnlySql } from '../change-kinds.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { createMigrationDefinition } from '../generator.js';
import { asTableChangedSincePlan } from '../rebuild-plan-guard.js';
import { MigrationTracker } from '../tracker.js';

const TRICKY = "it's */ -- kept";

const schema = (): Record<string, SchemaDefinition> => ({
  commented_prices: {
    tableName: 'commented_prices',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      label: { type: 'TEXT' },
      amount: { type: 'REAL' },
    },
    indexes: [{ name: 'commented_prices_label', columns: ['label'] }],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1',
  },
});

describe('DuckDB rebuild comments', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    await db.query(
      'CREATE TABLE commented_prices (id TEXT PRIMARY KEY, label TEXT, amount REAL)',
    );
    await db.query(
      'CREATE INDEX commented_prices_label ON commented_prices (label)',
    );
    await db.query("INSERT INTO commented_prices VALUES ('a', 'x', 1.5)");
    const literal = `'${TRICKY.replace(/'/g, "''")}'`;
    await db.query(`COMMENT ON TABLE commented_prices IS ${literal}`);
    await db.query(`COMMENT ON COLUMN commented_prices.amount IS ${literal}`);
    await db.query("COMMENT ON COLUMN commented_prices.label IS 'label'");
    await db.query(`COMMENT ON INDEX commented_prices_label IS ${literal}`);
  });

  afterEach(async () => {
    await db.close?.();
  });

  const plan = async () =>
    getSQLFromDiff(
      await new SchemaComparer(db, { engineHint: 'duckdb' }).compare(schema()),
    ).filter((sql) => !isCommentOnlySql(sql));

  const comments = async () => ({
    table: (
      await db.query(
        "SELECT comment FROM duckdb_tables() WHERE table_name = 'commented_prices'",
      )
    ).rows[0]?.comment,
    columns: (
      await db.query(
        "SELECT column_name, comment FROM duckdb_columns() WHERE table_name = 'commented_prices' ORDER BY column_index",
      )
    ).rows.map((row) => [row.column_name, row.comment ?? null]),
    indexes: (
      await db.query(
        "SELECT index_name, comment FROM duckdb_indexes() WHERE table_name = 'commented_prices'",
      )
    ).rows.map((row) => [row.index_name, row.comment ?? null]),
  });

  it('keeps table, column and index comments through a rebuild', async () => {
    const before = await comments();
    const statements = await plan();
    expect(statements.length).toBeGreaterThan(0);

    // Through the tracker.
    const tracker = new MigrationTracker({ db, engineHint: 'duckdb' });
    await tracker.initialize();
    const [result] = await tracker.applyAll(
      [createMigrationDefinition(`comments_${Date.now()}`, statements)],
      { atomic: true },
    );
    expect(result.error).toBeUndefined();

    const type = await db.query(
      "SELECT data_type FROM duckdb_columns() WHERE table_name = 'commented_prices' AND column_name = 'amount'",
    );
    expect(type.rows[0]?.data_type).toBe('DOUBLE');
    expect(await comments()).toEqual(before);
    expect(before.table).toBe(TRICKY);
  });

  it('keeps table, column and index comments through a rebuild (self-run plan)', async () => {
    const before = await comments();
    const statements = await plan();
    await db.transaction?.(async (tx) => {
      for (const sql of statements) await tx.query(sql);
    });
    expect(await comments()).toEqual(before);
  });

  it('stops when a comment changed after planning', async () => {
    const statements = await plan();
    await db.query("COMMENT ON COLUMN commented_prices.label IS 'changed'");
    let failure: unknown;
    try {
      await db.transaction?.(async (tx) => {
        for (const sql of statements) await tx.query(sql);
      });
    } catch (error) {
      failure = error;
    }
    expect(asTableChangedSincePlan(failure)?.table).toBe('commented_prices');
    const type = await db.query(
      "SELECT data_type FROM duckdb_columns() WHERE table_name = 'commented_prices' AND column_name = 'amount'",
    );
    expect(type.rows[0]?.data_type).toBe('FLOAT');
  });
});
