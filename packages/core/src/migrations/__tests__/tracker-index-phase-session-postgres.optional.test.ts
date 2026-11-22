/**
 * The tracker's concurrent-index phase on real PostgreSQL (#5435): its
 * tracking rows are written on the phase's own session, so a pool of one
 * connection finishes; a backend lost during the phase leaves its rows
 * unfinished and the rerun converges with valid indexes; and on a
 * transaction handle, which cannot pin a session, a statement that must run
 * outside a transaction is refused before anything runs. Needs
 * `SMRT_TEST_POSTGRES_URL`; works in a database of its own.
 */
import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigrationDefinition } from '../generator.js';
import { MigrationTracker } from '../tracker.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const adminUrl =
  process.env.SMRT_TEST_POSTGRES_ADMIN_URL ??
  process.env.SMRT_TEST_POSTGRES_URL;

const definition = (id: string, up: string[]) =>
  createMigrationDefinition(id, up, [], {
    packageName: '@idxphase/fixture',
    version: '1',
  });

describe.skipIf(!pgUrl)('tracker index phase on its own session', () => {
  let admin: DatabaseInterface;
  let url: string;
  let databaseName: string;
  const handles: DatabaseInterface[] = [];

  const connect = async (max?: number) => {
    const db = await getDatabase({
      type: 'postgres',
      url,
      dbid: randomUUID(),
      ...(max ? { max } : {}),
    } as Parameters<typeof getDatabase>[0]);
    handles.push(db);
    return db;
  };
  const valid = async (db: DatabaseInterface, index: string) =>
    (
      await db.query(
        `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${index}'`,
      )
    ).rows.map((row) => row.valid === true || row.valid === 't');
  const status = async (db: DatabaseInterface, name: string) =>
    (
      await db.query(
        `SELECT status FROM _smrt_schema_migrations WHERE name = '${name}'`,
      )
    ).rows[0]?.status;

  beforeAll(async () => {
    admin = await getDatabase({ type: 'postgres', url: adminUrl as string });
    databaseName = `smrt_idxphase_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const parsed = new URL(pgUrl as string);
    const owner = `"${decodeURIComponent(parsed.username).replace(/"/g, '""')}"`;
    await admin.query(`CREATE DATABASE ${databaseName} OWNER ${owner}`);
    parsed.pathname = `/${databaseName}`;
    url = String(parsed);
  });
  afterAll(async () => {
    for (const handle of handles) await handle.close?.();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.close?.();
  });

  it('finishes an index-bearing batch in concurrent-index mode on a pool of one', async () => {
    const db = await connect(1);
    await db.query('CREATE TABLE idxphase_one (id int PRIMARY KEY, a int)');
    const tracker = new MigrationTracker({ db, engineHint: 'postgres' });
    const results = await tracker.applyAll(
      [
        definition('idxphase_one_m', [
          'ALTER TABLE idxphase_one ADD COLUMN b int',
          'CREATE INDEX idxphase_one_a ON idxphase_one (a)',
        ]),
      ],
      { atomic: true, postgresSafe: true },
    );
    expect(results.map((r) => r.success)).toEqual([true]);
    expect(await status(db, 'idxphase_one_m')).toBe('completed');
    expect(await valid(db, 'idxphase_one_a')).toEqual([true]);
  }, 60_000);

  it('records a built and a failed index of one phase on a pool of one', async () => {
    const db = await connect(1);
    await db.query('CREATE TABLE idxphase_mixed (id int PRIMARY KEY, a int)');
    await db.query('INSERT INTO idxphase_mixed VALUES (1, 7), (2, 7)');
    const tracker = new MigrationTracker({ db, engineHint: 'postgres' });
    const results = await tracker.applyAll(
      [
        definition('idxphase_mixed_ok', [
          'CREATE INDEX idxphase_mixed_a ON idxphase_mixed (a)',
        ]),
        definition('idxphase_mixed_dup', [
          'CREATE UNIQUE INDEX idxphase_mixed_ua ON idxphase_mixed (a)',
        ]),
      ],
      { atomic: true, postgresSafe: true, continueOnError: true },
    );
    expect(results.map((r) => r.success)).toEqual([true, false]);
    expect(await status(db, 'idxphase_mixed_ok')).toBe('completed');
    expect(await status(db, 'idxphase_mixed_dup')).toBe('failed');
  }, 60_000);

  it('leaves the rows unfinished when the phase backend ends, and the rerun converges with valid indexes', async () => {
    const db = await connect();
    const blocker = await connect();
    await db.query('CREATE TABLE idxphase_kill (id int PRIMARY KEY, a int)');
    const writer = await blocker.beginTransaction!();
    await writer.query('INSERT INTO idxphase_kill VALUES (1, 1)');
    const first = new MigrationTracker({ db, engineHint: 'postgres' }).applyAll(
      [
        definition('idxphase_kill_m', [
          'CREATE INDEX idxphase_kill_a ON idxphase_kill (a)',
        ]),
      ],
      { atomic: true, postgresSafe: true },
    );
    let pid: number | undefined;
    for (let attempt = 0; attempt < 200 && pid === undefined; attempt++) {
      const { rows } = await admin.query(
        `SELECT pid FROM pg_stat_activity WHERE datname = '${databaseName}' AND query ILIKE 'CREATE INDEX CONCURRENTLY%idxphase_kill_a%'`,
      );
      pid = rows[0]?.pid as number | undefined;
      if (pid === undefined) await new Promise((r) => setTimeout(r, 50));
    }
    expect(pid).toBeDefined();
    await admin.query(`SELECT pg_terminate_backend(${pid})`);
    const outcome = await first.catch((error: unknown) => error);
    await writer.commit();
    expect(
      Array.isArray(outcome) ? outcome.map((r) => r.success) : [false],
    ).toEqual([false]);
    expect(await status(db, 'idxphase_kill_m')).not.toBe('completed');

    const rerun = await new MigrationTracker({
      db,
      engineHint: 'postgres',
    }).applyAll(
      [
        definition('idxphase_kill_m', [
          'CREATE INDEX idxphase_kill_a ON idxphase_kill (a)',
        ]),
      ],
      { atomic: true, postgresSafe: true, reconcile: true },
    );
    expect(rerun.map((r) => r.success)).toEqual([true]);
    expect(await valid(db, 'idxphase_kill_a')).toEqual([true]);
  }, 60_000);

  it('refuses an explicit CONCURRENTLY statement on a transaction handle before anything runs, leaving the transaction usable', async () => {
    const db = await connect();
    await db.query('CREATE TABLE idxphase_tx (id int PRIMARY KEY, a int)');
    const tx = await db.beginTransaction!();
    const tracker = new MigrationTracker({
      db: tx as unknown as DatabaseInterface,
      engineHint: 'postgres',
    });
    await expect(
      tracker.applyAll(
        [
          definition('idxphase_tx_concurrently', [
            'CREATE INDEX CONCURRENTLY idxphase_tx_a ON idxphase_tx (a)',
          ]),
        ],
        { postgresSafe: true },
      ),
    ).rejects.toThrow(/idxphase_tx_concurrently/);
    await expect(tx.query('SELECT 1 AS ok')).resolves.toBeDefined();
    await tx.rollback();
    expect(await valid(db, 'idxphase_tx_a')).toEqual([]);

    // Control: a plain index under the defaults is built in the transaction.
    const tx2 = await db.beginTransaction!();
    await new MigrationTracker({
      db: tx2 as unknown as DatabaseInterface,
      engineHint: 'postgres',
    }).applyAll(
      [
        definition('idxphase_tx_plain', [
          'CREATE INDEX idxphase_tx_b ON idxphase_tx (a)',
        ]),
      ],
      {},
    );
    await tx2.commit();
    expect(await valid(db, 'idxphase_tx_b')).toEqual([true]);
  }, 60_000);
});
