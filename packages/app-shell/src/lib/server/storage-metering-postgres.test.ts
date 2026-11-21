// The PostgreSQL size query of storage metering (#5199): the registered
// `test:postgres` suite. Runs on an in-process PGlite (its twin) and ALSO on a
// real server when SMRT_TEST_POSTGRES_URL is set (CI's "Registered PostgreSQL
// Suites" lane). What only a real server shows: BIGINT arrives from the pool as
// digits, and `pg_total_relation_size` on a shared database.
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogQueryOf,
  measurePostgresSchemaBytes,
  PG_SCHEMA_BYTES_SQL,
} from './storage-metering.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;

describe.each(backends)('app schema size on PostgreSQL (%s)', (backend) => {
  let db: any;
  let pglite: any;
  const tag = Math.random().toString(36).slice(2, 8);
  const small = `app_size_small_${tag}`;
  const big = `app_size_big_${tag}`;
  const empty = `app_size_empty_${tag}`;

  beforeAll(async () => {
    if (backend === 'postgres') {
      db = await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
      } as never);
    } else {
      const { PGlite } = await importPGlite();
      pglite = await PGlite.create();
      db = await getDatabase({ type: 'pglite', client: pglite } as never);
    }
    for (const s of [small, big, empty]) await db.query(`CREATE SCHEMA "${s}"`);
    await db.query(
      `CREATE TABLE "${small}".t (id serial PRIMARY KEY, body text)`,
    );
    await db.query(
      `CREATE TABLE "${big}".t (id serial PRIMARY KEY, body text)`,
    );
    await db.query(`CREATE INDEX ON "${big}".t (body)`);
    await db.query(
      `INSERT INTO "${big}".t (body) SELECT repeat(md5(g::text), 4) FROM generate_series(1, 3000) g`,
    );
  });
  afterAll(async () => {
    for (const s of [small, big, empty])
      await db.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {});
    if (backend === 'postgres') await db.close?.();
    else await pglite?.close();
  });

  it('counts one schema: tables with their indexes, and only that schema', async () => {
    const query = catalogQueryOf(db);
    const bigBytes = await measurePostgresSchemaBytes(query, big);
    const smallBytes = await measurePostgresSchemaBytes(query, small);
    const emptyBytes = await measurePostgresSchemaBytes(query, empty);
    expect(emptyBytes).toBe(0);
    expect(smallBytes).toBeGreaterThan(0);
    expect(bigBytes).toBeGreaterThan(smallBytes);
    // equals the table's own total (heap + index + toast), counted once
    const tableTotal = (
      await db.query(`SELECT pg_total_relation_size('"${big}".t')::text AS b`)
    ).rows[0].b;
    const heapOnly = (
      await db.query(`SELECT pg_relation_size('"${big}".t')::text AS b`)
    ).rows[0].b;
    expect(bigBytes).toBe(Number(tableTotal));
    expect(bigBytes).toBeGreaterThan(Number(heapOnly)); // the index is in
  });

  it('binds the schema name (a hostile name is data, not SQL)', async () => {
    expect(PG_SCHEMA_BYTES_SQL).not.toContain('app_');
    const query = catalogQueryOf(db);
    expect(
      await measurePostgresSchemaBytes(query, `x"; DROP TABLE t; --`),
    ).toBe(0);
    expect(await measurePostgresSchemaBytes(query, big)).toBeGreaterThan(0);
  });
});
