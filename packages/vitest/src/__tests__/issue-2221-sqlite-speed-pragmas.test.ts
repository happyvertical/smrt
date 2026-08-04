/**
 * Regression tests for Issue #2221 — file-backed SQLite test databases must
 * run without fsync durability.
 *
 * SQLite's defaults (`synchronous=FULL`, DELETE journal) cost 2-3 fsyncs per
 * transaction. On CI runners with slow fsync (9.5 ms/write measured on the
 * metal fleet) that turned the users package's catalog-seeding tests into
 * 200-400 s timeouts. Test databases are throwaway, so the setup file strips
 * durability from local file-backed SQLite handles.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applySqliteSpeedPragmas } from '../setup.js';

const testDir = join(tmpdir(), `smrt-vitest-issue-2221-${Date.now()}`);

async function pragmaValue(
  db: { query: (sql: string) => Promise<unknown> },
  pragma: string,
): Promise<unknown> {
  // The sql adapter returns pg-style results: { rows: [{ <pragma>: value }] }.
  const result = (await db.query(`PRAGMA ${pragma}`)) as {
    rows?: Array<Record<string, unknown>>;
  };
  const row = result?.rows?.[0];
  return row ? Object.values(row)[0] : undefined;
}

describe('Issue #2221 - SQLite speed pragmas', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('disables durability on a local file-backed SQLite database', async () => {
    const url = join(testDir, 'speed-pragmas.db');
    const options = { type: 'sqlite' as const, url };
    const db = (await getDatabase(options)) as unknown as {
      query: (sql: string) => Promise<unknown>;
    };

    await applySqliteSpeedPragmas(db, options);

    // synchronous: 0 = OFF; journal_mode reports the active mode string.
    expect(Number(await pragmaValue(db, 'synchronous'))).toBe(0);
    expect(String(await pragmaValue(db, 'journal_mode')).toLowerCase()).toBe(
      'memory',
    );
    // The database still works after the pragmas.
    await db.query('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
    await db.query('INSERT INTO t DEFAULT VALUES');
    const count = (await db.query('SELECT COUNT(*) AS n FROM t')) as {
      rows?: Array<{ n: number | bigint }>;
    };
    expect(Number(count.rows?.[0]?.n)).toBe(1);
  });

  it('leaves in-memory SQLite untouched (no file, no fsync to save)', async () => {
    const options = { type: 'sqlite' as const, url: ':memory:' };
    const db = (await getDatabase(options)) as unknown as {
      query: (sql: string) => Promise<unknown>;
    };

    const before = Number(await pragmaValue(db, 'synchronous'));
    await applySqliteSpeedPragmas(db, options);
    expect(Number(await pragmaValue(db, 'synchronous'))).toBe(before);
  });

  it('never throws for a handle without a query method', async () => {
    await expect(
      applySqliteSpeedPragmas({}, {
        type: 'sqlite',
        url: join(testDir, 'no-query.db'),
      } as Parameters<typeof applySqliteSpeedPragmas>[1]),
    ).resolves.toBeUndefined();
  });
});
