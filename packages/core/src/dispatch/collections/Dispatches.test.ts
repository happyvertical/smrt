import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { getTestDatabase } from '../../testing/database.js';
import { DispatchCollection } from './Dispatches.js';

describe('DispatchCollection list paging', () => {
  async function withDispatchRows(
    run: (db: DatabaseInterface) => Promise<void>,
  ): Promise<void> {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    try {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');
      await db.query(
        'CREATE TABLE _smrt_dispatch (id TEXT PRIMARY KEY, type TEXT, status TEXT, source TEXT, created_at TEXT)',
      );
      for (const id of ['d1', 'd2', 'd3']) {
        await db.query(
          `INSERT INTO _smrt_dispatch (id, type, status, source, created_at)
           VALUES ($1, 't', 'pending', 's', $2)`,
          id,
          `2026-01-0${id.slice(1)}T00:00:00.000Z`,
        );
      }
      await run(db);
    } finally {
      await db.close?.();
    }
  }

  it('an offset without a limit skips the offset rows and returns the rest', async () => {
    await withDispatchRows(async (db) => {
      const rows = await DispatchCollection.list(db, {
        orderBy: 'created_at ASC',
        offset: 1,
      });
      expect(rows.map((row) => row.id)).toEqual(['d2', 'd3']);
    });
  });

  it('control: an offset with a limit is unchanged', async () => {
    await withDispatchRows(async (db) => {
      const rows = await DispatchCollection.list(db, {
        orderBy: 'created_at ASC',
        offset: 1,
        limit: 1,
      });
      expect(rows.map((row) => row.id)).toEqual(['d2']);
    });
  });
});

describe('DispatchCollection countByStatus', () => {
  it.each([
    ['PostgreSQL', '2'],
    ['DuckDB', 2n],
  ])('hydrates %s COUNT(*) results', async (_driver, count) => {
    const db = {
      single: async () => ({ count }),
    } as unknown as DatabaseInterface;

    await expect(DispatchCollection.countByStatus(db, 'pending')).resolves.toBe(
      2,
    );
  });
});
