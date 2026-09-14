/**
 * Tests for the statement-counting test helper (#2875).
 *
 * Runs entirely against in-memory SQLite so the ceiling instrument itself
 * stays in the default unit lane rather than requiring Postgres.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  expectStatementCeiling,
  normalizeStatement,
  withStatementCount,
} from '../statement-count.js';

describe('withStatementCount / expectStatementCeiling (#2875)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = (await getDatabase({
      type: 'sqlite',
      url: ':memory:',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await db.query(
      'CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, status TEXT)',
    );
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('counts each db.query() call issued inside the scope', async () => {
    const { result, count } = await withStatementCount(
      db,
      async (countedDb) => {
        await countedDb.query(
          "INSERT INTO widgets (id, name) VALUES ('1', 'a')",
        );
        await countedDb.query(
          "INSERT INTO widgets (id, name) VALUES ('2', 'b')",
        );
        const rows = await countedDb.query('SELECT * FROM widgets');
        return rows.rows.length;
      },
    );

    expect(count).toBe(3);
    expect(result).toBe(2);
  });

  it('counts statements issued through the tagged-template methods and their aliases', async () => {
    const { count } = await withStatementCount(db, async (countedDb) => {
      await countedDb.execute`INSERT INTO widgets (id, name) VALUES ('1', 'a')`;
      await countedDb.xx`INSERT INTO widgets (id, name) VALUES ('2', 'b')`;
      await countedDb.many`SELECT * FROM widgets`;
      await countedDb.oo`SELECT * FROM widgets`;
      await countedDb.single`SELECT * FROM widgets WHERE id = '1'`;
      await countedDb.oO`SELECT * FROM widgets WHERE id = '1'`;
      await countedDb.pluck`SELECT count(*) FROM widgets`;
      await countedDb.ox`SELECT count(*) FROM widgets`;
    });

    expect(count).toBe(8);
  });

  it('returns the callback result unchanged', async () => {
    const { result } = await withStatementCount(db, async () => 'unchanged');
    expect(result).toBe('unchanged');
  });

  it('restores the original query method after the scope completes', async () => {
    const originalQuery = db.query;

    await withStatementCount(db, async (countedDb) => {
      await countedDb.query('SELECT 1');
    });

    expect(db.query).toBe(originalQuery);

    // A statement issued after the scope must not be counted anywhere —
    // there is nothing left listening.
    await db.query('SELECT 1');
  });

  it('restores the original query method even when the body throws', async () => {
    const originalQuery = db.query;

    await expect(
      withStatementCount(db, async (countedDb) => {
        await countedDb.query('SELECT 1');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // This is the precedent's known failure mode (see the issue body):
    // a hand-rolled wrapper that replaces db.query without a finally leaks
    // into every later test sharing this handle once the body throws.
    expect(db.query).toBe(originalQuery);
  });

  it('counts statements issued through db.transaction(cb) via the tx handle', async () => {
    const { count } = await withStatementCount(db, async (countedDb) => {
      await countedDb.transaction?.(async (tx) => {
        await tx.query("INSERT INTO widgets (id, name) VALUES ('1', 'a')");
        await tx.query("INSERT INTO widgets (id, name) VALUES ('2', 'b')");
      });
    });

    // Wrapping only the outer handle would under-count this to 0 and pass a
    // ceiling that should have failed — exactly the falsely-passing gap the
    // helper exists to close (see #2862's bootstrap path).
    expect(count).toBe(2);
  });

  it('counts statements issued through db.beginTransaction() via the tx handle', async () => {
    const { count } = await withStatementCount(db, async (countedDb) => {
      const tx = await countedDb.beginTransaction?.();
      await tx?.query("INSERT INTO widgets (id, name) VALUES ('1', 'a')");
      await tx?.query("INSERT INTO widgets (id, name) VALUES ('2', 'b')");
      await tx?.commit();
    });

    expect(count).toBe(2);
  });

  it('preserves the receiver when calling a receiver-sensitive beginTransaction()', async () => {
    // A fake handle whose beginTransaction() reads instance state off `this`
    // rather than closing over it -- if instrument() ever invoked the
    // original as a bare function (losing `this`), this would throw instead
    // of returning a working transaction handle.
    let issued = 0;
    // The tx handle is a distinct object from the outer db, matching every
    // real @happyvertical/sql adapter (beginTransaction() always returns a
    // fresh handle, never `this`).
    const fakeTx = {
      query: async () => {
        issued += 1;
        return { rows: [], rowCount: 0 };
      },
    };
    const fakeDb = {
      marker: 'receiver-ok',
      query: async () => {
        throw new Error('unexpected call on the outer handle');
      },
      beginTransaction: async function (this: {
        marker: string;
      }): Promise<DatabaseInterface> {
        if (this?.marker !== 'receiver-ok') {
          throw new Error('beginTransaction lost its receiver');
        }
        return fakeTx as unknown as DatabaseInterface;
      },
    } as unknown as DatabaseInterface;

    const { count } = await withStatementCount(fakeDb, async (countedDb) => {
      const tx = await countedDb.beginTransaction?.();
      await tx?.query('SELECT 1');
    });

    expect(count).toBe(1);
    expect(issued).toBe(1);
  });

  it('does not double-count statements issued on the outer handle around a transaction', async () => {
    const { count } = await withStatementCount(db, async (countedDb) => {
      await countedDb.query('SELECT 1');
      await countedDb.transaction?.(async (tx) => {
        await tx.query('SELECT 2');
      });
      await countedDb.query('SELECT 3');
    });

    expect(count).toBe(3);
  });

  it('groups statements by normalized shape, descending by count', async () => {
    const { byShape } = await withStatementCount(db, async (countedDb) => {
      for (let i = 0; i < 5; i++) {
        await countedDb.query(`SELECT * FROM widgets WHERE id = '${i}'`);
      }
      await countedDb.query('SELECT count(*) FROM widgets');
    });

    expect(byShape[0].count).toBe(5);
    expect(byShape[0].shape).toBe("SELECT * FROM widgets WHERE id = '?'");
    expect(byShape[1].count).toBe(1);
    expect(byShape[0].examples.length).toBeLessThanOrEqual(3);
  });

  describe('expectStatementCeiling', () => {
    it('does not throw when the count is at or under the ceiling', async () => {
      const statementResult = await withStatementCount(
        db,
        async (countedDb) => {
          await countedDb.query('SELECT 1');
          await countedDb.query('SELECT 2');
        },
      );

      expect(() => expectStatementCeiling(statementResult, 2)).not.toThrow();
    });

    it('throws with a grouped shape breakdown when the ceiling is exceeded', async () => {
      const statementResult = await withStatementCount(
        db,
        async (countedDb) => {
          for (let i = 0; i < 4; i++) {
            await countedDb.query(`SELECT * FROM widgets WHERE id = '${i}'`);
          }
        },
      );

      let thrown: Error | undefined;
      try {
        expectStatementCeiling(statementResult, 2);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown?.message).toContain(
        'statement count ceiling exceeded: expected <= 2, got 4',
      );
      expect(thrown?.message).toContain("SELECT * FROM widgets WHERE id = '?'");
    });
  });

  describe('normalizeStatement', () => {
    it('collapses whitespace', () => {
      expect(normalizeStatement('SELECT   *\nFROM   widgets')).toBe(
        'SELECT * FROM widgets',
      );
    });

    it('elides string literals and standalone numeric literals', () => {
      expect(
        normalizeStatement(
          "SELECT * FROM widgets WHERE name = 'alice' LIMIT 10",
        ),
      ).toBe("SELECT * FROM widgets WHERE name = '?' LIMIT ?");
    });

    it('normalizes numbered placeholders', () => {
      expect(
        normalizeStatement('SELECT * FROM widgets WHERE id = $1 AND name = $2'),
      ).toBe('SELECT * FROM widgets WHERE id = $N AND name = $N');
    });
  });
});
