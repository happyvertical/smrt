/**
 * Change-feed gap markers on PGlite (#5438, PR 1a).
 *
 * A staged entry the feed refuses (a data or constraint error, a trigger that
 * raises or silently drops the insert) used to either vanish (the batch
 * removed it and inserted nothing) or stop every later drain behind it. The
 * drain now checks each batch's receipt, isolates the refused row and keeps
 * a durable gap marker for it; markers are given a feed position only while
 * the delivery setting is present, which this release never creates (the
 * tests insert it with plain SQL). Table versions count markers, and the
 * version read can no longer raise.
 *
 * Contention, roles and two-session schedules run in the PostgreSQL lane
 * (`issue-5438-change-feed-gaps-postgres.optional.test.ts`). Runs under
 * `pnpm test:pglite`.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as changeFeed from '../change-feed';
import {
  drainChangeFeed,
  ensureChangeFeedTable,
  getChangesSince,
  getTableVersion,
  probeChangeFeedHelperState,
  pruneChangeFeed,
  resetChangeFeedWarnings,
  settleChangeFeedDrainers,
  stopChangeFeedDrainers,
} from '../change-feed';
import { subscribeToChangeSignals } from '../change-signals';
import { CHANGE_FEED_GAP_DELIVERY_SETTING } from '../system/schema';
import { getTestDatabase } from '../testing/database';

const SUBJECT = 'gap_pglite_notes';
const OTHER = 'gap_pglite_tasks';
const SECRET = 'sessions';
const TENANT_A = '0d5b8f4e-5a51-4f43-9a1e-3c0f2d7b9a11';
const TENANT_B = '7c2e1a90-1f3d-4b6a-8e55-2a9c4d6f0b22';
const IDENTITIES = [
  '_smrt_append_change(text,text,text,text,timestamp with time zone)',
  '_smrt_append_changes(jsonb)',
  '_smrt_drain_changes(integer,text[])',
  '_smrt_drain_changes(integer)',
  '_smrt_drain_changes(integer,text[],jsonb)',
  '_smrt_change_feed_version(text)',
];
const MARKERS = [
  'smrt-change-feed-helpers:v8',
  'smrt-change-feed-helpers:v7',
  'smrt-change-feed-helpers:v6',
  'smrt-change-feed-helpers:v5',
  'smrt-change-feed-helpers:v4',
];

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}

async function all(
  db: DatabaseInterface,
  sql: string,
  ...params: unknown[]
): Promise<Row[]> {
  return rowsOf(await db.query(sql, ...params));
}

async function one(
  db: DatabaseInterface,
  sql: string,
  ...params: unknown[]
): Promise<Row> {
  return (await all(db, sql, ...params))[0] ?? {};
}

async function stage(
  db: DatabaseInterface,
  table: string,
  rowId: string | null,
  tenant: string | null = null,
  operation = 'update',
): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, tenant_id, created_at)
     VALUES ($1, $2, $3, $4::uuid, now())`,
    table,
    rowId,
    operation,
    tenant,
  );
}

async function addMarker(
  db: DatabaseInterface,
  marker: {
    table?: string;
    rowId?: string | null;
    operation?: string | null;
    tenant?: string | null;
    convertedSeq?: number | null;
    blocked?: boolean;
    reconciled?: boolean;
    createdAt?: string;
  } = {},
): Promise<string> {
  const row = await one(
    db,
    `INSERT INTO _smrt_change_gaps
       (table_name, row_id, operation, tenant_key, created_at, blocked_at, converted_seq, reconciled_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, clock_timestamp()),
             CASE WHEN $6 THEN now() END, $7::bigint, CASE WHEN $8 THEN now() END)
     RETURNING gap_id::text AS gap_id`,
    marker.table ?? SUBJECT,
    marker.rowId === undefined ? 'lost' : marker.rowId,
    marker.operation === undefined ? 'update' : marker.operation,
    marker.tenant ?? null,
    marker.createdAt ?? null,
    marker.blocked === true,
    marker.convertedSeq ?? null,
    marker.reconciled === true,
  );
  return String(row.gap_id);
}

/**
 * Delivery is off in this release; the marker phase is exercised by hand.
 * The root's background drainer is settled and stopped first, so it cannot
 * convert the markers before the pass a test inspects.
 */
async function enableDelivery(db: DatabaseInterface): Promise<void> {
  await settleChangeFeedDrainers();
  stopChangeFeedDrainers();
  await db.query(
    'INSERT INTO _smrt_backfills (name, description) VALUES ($1, $2)',
    CHANGE_FEED_GAP_DELIVERY_SETTING,
    'test only: gap delivery',
  );
}

async function statusDrain(
  db: DatabaseInterface,
  options: Record<string, unknown> = {},
  excluded: string[] = [],
): Promise<Row[]> {
  return all(
    db,
    'SELECT * FROM _smrt_drain_changes(1000, $1::text[], $2::jsonb)',
    `{${excluded.join(',')}}`,
    JSON.stringify(options),
  );
}

function statusRowOf(rows: Row[]): Row {
  const row = rows.find((r) => r.status != null && r.drained_seq == null);
  expect(row, JSON.stringify(rows)).toBeDefined();
  return row as Row;
}

async function feed(db: DatabaseInterface): Promise<Row[]> {
  return all(
    db,
    'SELECT seq::int AS seq, table_name, row_id, operation, tenant_id::text AS tenant_id FROM _smrt_changes ORDER BY seq',
  );
}

async function markers(db: DatabaseInterface): Promise<Row[]> {
  return all(
    db,
    `SELECT gap_id::text AS gap_id, table_name, row_id, operation, tenant_key,
            converted_seq::int AS converted_seq, blocked_at IS NOT NULL AS blocked,
            reconciled_at IS NOT NULL AS reconciled
       FROM _smrt_change_gaps ORDER BY created_at, gap_id`,
  );
}

async function pending(db: DatabaseInterface): Promise<Row[]> {
  return all(
    db,
    'SELECT row_id, table_name FROM _smrt_changes_pending ORDER BY pending_id',
  );
}

/** A BEFORE INSERT trigger on the feed that silently drops one row id. */
async function dropFeedInsertFor(
  db: DatabaseInterface,
  rowId: string,
): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION gap_test_drop_feed_row() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.row_id = '${rowId}' THEN RETURN NULL; END IF;
      RETURN NEW;
    END $fn$`);
  await db.query(
    'CREATE TRIGGER gap_test_drop_feed_row BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_test_drop_feed_row()',
  );
}

/** A BEFORE INSERT trigger on the feed that refuses one row id every time. */
async function refuseFeedInsertFor(
  db: DatabaseInterface,
  rowId: string,
  sqlstate: string,
): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION gap_test_refuse_feed_row() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.row_id = '${rowId}' THEN
        RAISE EXCEPTION 'refused by test trigger' USING ERRCODE = '${sqlstate}';
      END IF;
      RETURN NEW;
    END $fn$`);
  await db.query(
    'CREATE TRIGGER gap_test_refuse_feed_row BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_test_refuse_feed_row()',
  );
}

/** Every staged row ends as exactly one feed entry or one marker. */
async function expectAccounted(
  db: DatabaseInterface,
  rowIds: string[],
): Promise<void> {
  const entries = (await feed(db)).map((row) => row.row_id);
  const marked = (await markers(db)).map((row) => row.row_id);
  const staged = (await pending(db)).map((row) => row.row_id);
  for (const rowId of rowIds) {
    const places =
      entries.filter((id) => id === rowId).length +
      marked.filter((id) => id === rowId).length +
      staged.filter((id) => id === rowId).length;
    expect(places, `${rowId} in feed/markers/staging`).toBe(1);
  }
}

async function expectContiguous(db: DatabaseInterface): Promise<void> {
  const seqs = (await feed(db)).map((row) => Number(row.seq));
  expect(seqs).toEqual(seqs.map((_, index) => index + 1));
}

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'change-feed gap markers on PGlite (#5438)',
  () => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      resetChangeFeedWarnings();
      db = (await getTestDatabase({
        type: 'pglite',
        classes: [],
      })) as DatabaseInterface;
      await ensureChangeFeedTable(db);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await db.close?.();
    });

    describe('storage and helpers (T1, T21)', () => {
      it('creates the gap table with a native uuid id, text tenant key and both indexes', async () => {
        const columns = await all(
          db,
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns
            WHERE table_name = '_smrt_change_gaps' ORDER BY ordinal_position`,
        );
        expect(
          Object.fromEntries(columns.map((c) => [c.column_name, c.data_type])),
        ).toEqual({
          gap_id: 'uuid',
          table_name: 'text',
          row_id: 'text',
          operation: 'text',
          tenant_key: 'text',
          created_at: 'timestamp with time zone',
          blocked_at: 'timestamp with time zone',
          converted_seq: 'bigint',
          reconciled_at: 'timestamp with time zone',
        });
        const indexes = (
          await all(
            db,
            "SELECT indexname FROM pg_indexes WHERE tablename = '_smrt_change_gaps'",
          )
        ).map((row) => row.indexname);
        expect(indexes).toEqual(
          expect.arrayContaining([
            'idx_smrt_change_gaps_table',
            'idx_smrt_change_gaps_converted_seq',
          ]),
        );
        const id = await addMarker(db);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
      });

      it('stamps v8 to v4 into all six helper identities and probes them as current', async () => {
        for (const identity of IDENTITIES) {
          const row = await one(
            db,
            'SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)',
            identity,
          );
          const source = String(row.prosrc ?? '');
          for (const marker of MARKERS) {
            expect(source, `${identity} ${marker}`).toContain(marker);
          }
        }
        expect(await probeChangeFeedHelperState(db)).toBe('current');
      });

      it('reads a v7 status drain under a v8 build as mixed, still callable directly', async () => {
        const def = String(
          (
            await one(
              db,
              'SELECT pg_get_functiondef(to_regprocedure($1)) AS def',
              '_smrt_drain_changes(integer,text[],jsonb)',
            )
          ).def,
        )
          // The body also names its own marker in the helpers_current check.
          .replaceAll(
            'smrt-change-feed-helpers:v8',
            'smrt-change-feed-helpers:vX',
          );
        expect(def).toContain('smrt-change-feed-helpers:v7');
        await db.query(def);
        expect(await probeChangeFeedHelperState(db)).toBe('mixed');
      });
    });

    describe('staged batch receipt (T3)', () => {
      it('sequences an untroubled batch contiguously', async () => {
        for (const id of ['a', 'b', 'c']) await stage(db, SUBJECT, id);
        await drainChangeFeed(db);
        expect((await feed(db)).map((row) => row.row_id)).toEqual([
          'a',
          'b',
          'c',
        ]);
        expect(await markers(db)).toEqual([]);
        await expectContiguous(db);
      });

      it('never lets a staged row disappear when a trigger silently drops its feed insert', async () => {
        for (const id of ['a', 'dropped', 'c']) await stage(db, SUBJECT, id);
        await dropFeedInsertFor(db, 'dropped');

        await drainChangeFeed(db);

        await expectAccounted(db, ['a', 'dropped', 'c']);
        expect((await feed(db)).map((row) => row.row_id)).toEqual(['a', 'c']);
        const [marker] = await markers(db);
        expect(marker).toMatchObject({
          table_name: SUBJECT,
          row_id: 'dropped',
          operation: 'update',
          converted_seq: null,
        });
        expect(await pending(db)).toEqual([]);
        await expectContiguous(db);
      });

      it('keeps the receipt check when the drain is the first statement of a caller transaction', async () => {
        for (const id of ['a', 'dropped', 'c']) await stage(db, SUBJECT, id);
        await dropFeedInsertFor(db, 'dropped');
        const transaction = (
          db as unknown as {
            transaction: <T>(
              cb: (tx: DatabaseInterface) => Promise<T>,
            ) => Promise<T>;
          }
        ).transaction.bind(db);

        await transaction(async (tx) => {
          await drainChangeFeed(tx);
        });

        await expectAccounted(db, ['a', 'dropped', 'c']);
        await expectContiguous(db);
      });
    });

    describe('isolating a refused row (T4, T6)', () => {
      for (const sqlstate of ['23514', 'P0001', '22P02']) {
        it(`replaces a row refused with ${sqlstate} by one marker and sequences the others in order`, async () => {
          await stage(db, SUBJECT, 'a', TENANT_A);
          await stage(db, OTHER, 'poison', TENANT_B, 'create');
          await stage(db, SUBJECT, 'c', null, 'delete');
          await refuseFeedInsertFor(db, 'poison', sqlstate);

          await drainChangeFeed(db);

          expect(
            (await feed(db)).map((row) => [row.row_id, row.tenant_id]),
          ).toEqual([
            ['a', TENANT_A],
            ['c', null],
          ]);
          const marked = await markers(db);
          expect(marked).toHaveLength(1);
          expect(marked[0]).toMatchObject({
            table_name: OTHER,
            row_id: 'poison',
            operation: 'create',
            tenant_key: TENANT_B,
            converted_seq: null,
            blocked: false,
          });
          expect(await pending(db)).toEqual([]);

          // The next drain is no longer stopped behind it.
          await stage(db, SUBJECT, 'd');
          await drainChangeFeed(db);
          expect((await feed(db)).map((row) => row.row_id)).toEqual([
            'a',
            'c',
            'd',
          ]);
        });
      }

      it('leaves a row whose own move fails retryably staged, and ends isolation there (T5, single session)', async () => {
        await stage(db, SUBJECT, 'a');
        await stage(db, SUBJECT, 'poison');
        await stage(db, SUBJECT, 'busy');
        await stage(db, SUBJECT, 'd');
        await db.query(`
          CREATE FUNCTION gap_test_retryable() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          BEGIN
            IF NEW.row_id = 'poison' THEN
              RAISE EXCEPTION 'refused' USING ERRCODE = '23514';
            ELSIF NEW.row_id = 'busy' THEN
              RAISE EXCEPTION 'lock wait' USING ERRCODE = '55P03';
            END IF;
            RETURN NEW;
          END $fn$`);
        await db.query(
          'CREATE TRIGGER gap_test_retryable BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_test_retryable()',
        );
        const status = statusRowOf(await statusDrain(db));
        expect(status.error_message).toContain('isolation stopped: 55P03');
        expect((await feed(db)).map((row) => row.row_id)).toEqual(['a']);
        expect((await markers(db)).map((m) => m.row_id)).toEqual(['poison']);
        expect((await pending(db)).map((row) => row.row_id)).toEqual([
          'busy',
          'd',
        ]);
      });

      it('starts no isolation for a duplicate on the feed sequence key', async () => {
        await stage(db, SUBJECT, 'a');
        await stage(db, SUBJECT, 'b');
        await db.query(`
          CREATE FUNCTION gap_test_seq_key() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          BEGIN
            IF NEW.row_id = 'b' THEN
              RAISE unique_violation USING CONSTRAINT = '_smrt_changes_pkey',
                MESSAGE = 'duplicate key value violates unique constraint "_smrt_changes_pkey"';
            END IF;
            RETURN NEW;
          END $fn$`);
        await db.query(
          'CREATE TRIGGER gap_test_seq_key BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_test_seq_key()',
        );
        const rows = await statusDrain(db);
        expect(rows.find((row) => row.error_code != null)?.error_code).toBe(
          '23505',
        );
        expect(rows.filter((row) => row.drained_seq != null)).toEqual([]);
        expect(await markers(db)).toEqual([]);
        expect((await pending(db)).map((row) => row.row_id)).toEqual([
          'a',
          'b',
        ]);
      });

      it('keeps the staged row when its marker cannot be written', async () => {
        await stage(db, SUBJECT, 'a');
        await stage(db, SUBJECT, 'poison');
        await stage(db, SUBJECT, 'c');
        await refuseFeedInsertFor(db, 'poison', '23514');
        await db.query(`
          CREATE FUNCTION gap_test_refuse_marker() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          BEGIN RAISE EXCEPTION 'marker refused' USING ERRCODE = 'P0001'; END $fn$`);
        await db.query(
          'CREATE TRIGGER gap_test_refuse_marker BEFORE INSERT ON _smrt_change_gaps FOR EACH ROW EXECUTE FUNCTION gap_test_refuse_marker()',
        );

        await statusDrain(db);

        expect(await markers(db)).toEqual([]);
        expect((await pending(db)).map((row) => row.row_id)).toContain(
          'poison',
        );
        await expectAccounted(db, ['a', 'poison', 'c']);
      });

      it('carries exactly the staged tenant on each marker, NULL only for a global row', async () => {
        await stage(db, SUBJECT, 'pa', TENANT_A);
        await stage(db, SUBJECT, 'pb', TENANT_B);
        await stage(db, SUBJECT, 'pg', null);
        await db.query(`
          CREATE FUNCTION gap_test_refuse_p() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          BEGIN
            IF NEW.row_id LIKE 'p%' THEN
              RAISE EXCEPTION 'refused' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
          END $fn$`);
        await db.query(
          'CREATE TRIGGER gap_test_refuse_p BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_test_refuse_p()',
        );

        await drainChangeFeed(db);

        const byRow = Object.fromEntries(
          (await markers(db)).map((m) => [m.row_id, m.tenant_key]),
        );
        expect(byRow).toEqual({ pa: TENANT_A, pb: TENANT_B, pg: null });
        expect(await feed(db)).toEqual([]);
      });
    });

    describe('sensitive tables (T7)', () => {
      it('neither isolates nor converts a sensitive table and purges its markers in the drain and in retention', async () => {
        await enableDelivery(db);
        await stage(db, SECRET, 'sid-1');
        await addMarker(db, { table: SECRET, rowId: 'sid-2' });
        await drainChangeFeed(db);
        expect(await pending(db)).toEqual([]);
        expect(await markers(db)).toEqual([]);
        expect(
          (await feed(db)).filter((row) => row.table_name === SECRET),
        ).toEqual([]);

        await stage(db, SUBJECT, 'x');
        await drainChangeFeed(db);
        await addMarker(db, { table: SECRET, rowId: 'sid-3', convertedSeq: 1 });
        await addMarker(db, {
          table: SECRET,
          rowId: 'sid-4',
          reconciled: true,
        });
        await addMarker(db, {
          table: SUBJECT,
          rowId: 'kept',
          reconciled: true,
        });
        // The sweep's own drain purges them first; the sweep repeats it.
        await pruneChangeFeed(db, { maxRows: 1000 });
        expect((await markers(db)).map((m) => m.row_id)).toEqual(['kept']);
      });
    });

    describe('delivery stays off in this release (T8)', () => {
      it('keeps markers unconverted across drains, reads and retention without the setting', async () => {
        await addMarker(db, { rowId: 'm1' });
        await stage(db, SUBJECT, 'e1');
        await drainChangeFeed(db);
        await getChangesSince(db, { since: 0 });
        await pruneChangeFeed(db, { maxRows: 1000 });
        const [marker] = await markers(db);
        expect(marker).toMatchObject({ row_id: 'm1', converted_seq: null });
        expect(
          (await feed(db)).filter((row) => row.operation === 'gap'),
        ).toEqual([]);
      });

      it('exports no way to enable delivery', () => {
        expect(
          Object.keys(changeFeed).filter((name) => /gap|deliver/i.test(name)),
        ).toEqual([]);
      });
    });

    describe('marker conversion with the setting inserted by hand (T9, T10, T11, T14)', () => {
      it('converts each marker once into a row-less gap row, keeps it as evidence and never returns or signals it', async () => {
        await stage(db, SUBJECT, 'e1');
        await drainChangeFeed(db);
        // Explicit times: PGlite's clock can give two inserts the same one.
        await addMarker(db, {
          tenant: TENANT_A.toUpperCase(),
          createdAt: '2026-01-01T00:00:00Z',
        });
        await addMarker(db, {
          rowId: null,
          operation: null,
          createdAt: '2026-01-01T00:00:01Z',
        });
        await enableDelivery(db);
        const signals: unknown[] = [];
        const unsubscribe = subscribeToChangeSignals(db, (signal) => {
          signals.push(signal);
        });
        try {
          const rows = await statusDrain(db);
          // A parser that keys entries on drained_seq (v6, PR 0) sees none.
          expect(rows.filter((row) => row.drained_seq != null)).toEqual([]);
          expect(statusRowOf(rows).status).toBe('drained');
          const allocation = rows.find(
            (row) => row.drained_operation === 'allocated',
          );
          expect(allocation).toMatchObject({
            drained_seq: null,
            drained_row_id: '2',
            drained_tenant_id: '3',
            error_code: null,
          });

          const gaps = (await feed(db)).filter(
            (row) => row.operation === 'gap',
          );
          expect(gaps).toEqual([
            {
              seq: 2,
              table_name: SUBJECT,
              row_id: null,
              operation: 'gap',
              tenant_id: TENANT_A,
            },
            {
              seq: 3,
              table_name: SUBJECT,
              row_id: null,
              operation: 'gap',
              tenant_id: null,
            },
          ]);
          const evidence = await markers(db);
          expect(evidence.map((m) => [m.converted_seq, m.tenant_key])).toEqual([
            [2, TENANT_A],
            [3, null],
          ]);
          expect(evidence[1]).toMatchObject({ row_id: null, operation: null });
          await expectContiguous(db);

          expect(await drainChangeFeed(db)).toBe(0);
          expect((await feed(db)).length).toBe(3);
          const page = await getChangesSince(db, { since: 0 });
          expect(page.changes.map((entry) => entry.rowId)).toEqual(['e1']);
          expect(page.cursor).toBe(3);
          expect(signals).toEqual([]);
        } finally {
          unsubscribe();
        }
      });

      it('blocks a marker whose feed insert fails or affects nothing, converts the rest and retries on request', async () => {
        // Each table has a retained entry, so its version is its own.
        await stage(db, 'gap_refused', 'e');
        await stage(db, 'gap_dropped', 'e');
        await stage(db, SUBJECT, 'e');
        await drainChangeFeed(db);
        await enableDelivery(db);
        await addMarker(db, { table: 'gap_refused', createdAt: '2026-01-01' });
        await addMarker(db, { table: 'gap_dropped', createdAt: '2026-01-02' });
        await addMarker(db, { table: SUBJECT, createdAt: '2026-01-03' });
        await db.query(`
          CREATE FUNCTION gap_test_marker_feed() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          BEGIN
            IF NEW.operation = 'gap' AND NEW.table_name = 'gap_refused' THEN
              RAISE EXCEPTION 'refused' USING ERRCODE = 'P0001';
            ELSIF NEW.operation = 'gap' AND NEW.table_name = 'gap_dropped' THEN
              RETURN NULL;
            END IF;
            RETURN NEW;
          END $fn$`);
        await db.query(
          'CREATE TRIGGER gap_test_marker_feed BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_test_marker_feed()',
        );
        const before = await getTableVersion(db, 'gap_refused');

        await statusDrain(db);

        const state = Object.fromEntries(
          (await markers(db)).map((m) => [
            m.table_name,
            [m.blocked, m.converted_seq],
          ]),
        );
        expect(state).toEqual({
          gap_refused: [true, null],
          gap_dropped: [true, null],
          [SUBJECT]: [false, 4],
        });
        expect(await getTableVersion(db, 'gap_refused')).toBe(before);

        // Ordinary passes skip blocked markers.
        await statusDrain(db);
        expect(
          (await feed(db)).filter((row) => row.operation === 'gap'),
        ).toHaveLength(1);

        await db.query('DROP TRIGGER gap_test_marker_feed ON _smrt_changes');
        await statusDrain(db, { retryBlocked: true });
        expect(
          (await markers(db)).every(
            (m) => m.converted_seq != null && m.blocked === false,
          ),
        ).toBe(true);
        await expectContiguous(db);
      });

      it('converts at most 200 markers per pass', async () => {
        await enableDelivery(db);
        await db.query(
          `INSERT INTO _smrt_change_gaps (table_name, row_id, operation, created_at)
           SELECT $1, 'r' || g, 'update', now() + g * interval '1 microsecond'
           FROM generate_series(1, 450) AS g`,
          SUBJECT,
        );
        const converted: number[] = [];
        for (let pass = 0; pass < 3; pass += 1) {
          const before = Number(
            (
              await one(
                db,
                'SELECT count(*)::int AS n FROM _smrt_change_gaps WHERE converted_seq IS NOT NULL',
              )
            ).n,
          );
          const status = statusRowOf(await statusDrain(db));
          const after = Number(
            (
              await one(
                db,
                'SELECT count(*)::int AS n FROM _smrt_change_gaps WHERE converted_seq IS NOT NULL',
              )
            ).n,
          );
          converted.push(after - before);
          expect(status.backlog_remaining).toBe(pass < 2);
        }
        expect(converted).toEqual([200, 200, 50]);
        await expectContiguous(db);
      });

      it('converts markers when the staging table is gone and reports no error row', async () => {
        await enableDelivery(db);
        await addMarker(db);
        await db.query('DROP TABLE _smrt_changes_pending');
        const rows = await statusDrain(db);
        expect(rows.filter((row) => row.error_code != null)).toEqual([]);
        expect(statusRowOf(rows).status).toBe('drained');
        expect((await markers(db))[0]?.converted_seq).toBe(1);
      });
    });

    describe('allocation range and atomicity (T13, T23)', () => {
      it('holds back a gap sequence allocated by the first statement of a caller transaction, then frees it on rollback', async () => {
        await stage(db, SUBJECT, 'e1');
        await drainChangeFeed(db);
        await enableDelivery(db);
        await addMarker(db);
        const transaction = (
          db as unknown as {
            transaction: <T>(
              cb: (tx: DatabaseInterface) => Promise<T>,
            ) => Promise<T>;
          }
        ).transaction.bind(db);
        const rollback = new Error('roll back');
        let insideCursor = -1;
        await expect(
          transaction(async (tx) => {
            await drainChangeFeed(tx);
            const page = await getChangesSince(tx, { since: 0 });
            insideCursor = page.cursor;
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect(insideCursor).toBe(1);
        expect((await markers(db))[0]?.converted_seq).toBeNull();
        expect((await feed(db)).map((row) => row.seq)).toEqual([1]);

        await db.query(
          'DELETE FROM _smrt_backfills WHERE name = $1',
          CHANGE_FEED_GAP_DELIVERY_SETTING,
        );
        await stage(db, SUBJECT, 'e2');
        await drainChangeFeed(db);
        expect((await feed(db)).map((row) => [row.seq, row.row_id])).toEqual([
          [1, 'e1'],
          [2, 'e2'],
        ]);
      });

      it('leaves staged rows, markers and the feed as they were when the pass rolls back', async () => {
        await enableDelivery(db);
        await addMarker(db);
        await stage(db, SUBJECT, 'a');
        await stage(db, SUBJECT, 'poison');
        await refuseFeedInsertFor(db, 'poison', '23514');
        const before = {
          feed: await feed(db),
          markers: await markers(db),
          pending: await pending(db),
        };
        await db.query('BEGIN');
        await statusDrain(db);
        expect((await feed(db)).length).toBeGreaterThan(0);
        await db.query('ROLLBACK');
        expect({
          feed: await feed(db),
          markers: await markers(db),
          pending: await pending(db),
        }).toEqual(before);
      });
    });

    describe('table versions (T15, T16, T17)', () => {
      it('counts each marker once, keeps the value across conversion and never decreases', async () => {
        const versions: number[] = [];
        const read = async () => {
          const value = await getTableVersion(db, SUBJECT);
          versions.push(value);
          return value;
        };
        await stage(db, SUBJECT, 'a');
        await drainChangeFeed(db);
        const v0 = await read();

        await stage(db, SUBJECT, 'lost-1');
        await stage(db, SUBJECT, 'lost-2');
        await db.query(`
          CREATE FUNCTION gap_test_refuse_lost() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          BEGIN
            IF NEW.row_id LIKE 'lost-%' THEN
              RAISE EXCEPTION 'refused' USING ERRCODE = '23514';
            END IF;
            IF NEW.operation = 'gap' AND (SELECT count(*) FROM _smrt_changes WHERE operation = 'gap') >= 1 THEN
              RAISE EXCEPTION 'second gap refused' USING ERRCODE = 'P0001';
            END IF;
            RETURN NEW;
          END $fn$`);
        await db.query(
          'CREATE TRIGGER gap_test_refuse_lost BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_test_refuse_lost()',
        );
        const v1 = await read();
        expect(v1).toBe(v0 + 2); // staged rows count before the drain
        await drainChangeFeed(db);
        const v2 = await read();
        expect(v2).toBe(v1); // two markers replace two staged rows

        await enableDelivery(db);
        await statusDrain(db);
        const state = (await markers(db)).map((m) => [
          m.converted_seq != null,
          m.blocked,
        ]);
        expect(state.sort()).toEqual([
          [false, true],
          [true, false],
        ]);
        const v3 = await read();
        expect(v3).toBeGreaterThanOrEqual(v2);

        await addMarker(db, { reconciled: true });
        const v4 = await read();
        expect(v4).toBe(v3 + 1);

        await stage(db, SUBJECT, 'b');
        await drainChangeFeed(db);
        const v5 = await read();
        expect(v5).toBeGreaterThan(v4);

        for (let i = 1; i < versions.length; i += 1) {
          expect(versions[i]).toBeGreaterThanOrEqual(versions[i - 1] as number);
        }
        // A validator from before the loss never matches afterwards.
        expect(versions.slice(2)).not.toContain(v0);
      });

      it('answers an unrepeatable value instead of raising when the staging table is gone', async () => {
        await stage(db, SUBJECT, 'a');
        await drainChangeFeed(db);
        await db.query('DROP TABLE _smrt_changes_pending');
        const first = await getTableVersion(db, SUBJECT);
        const second = await getTableVersion(db, SUBJECT);
        expect(first).not.toBe(second);
      });

      it('answers an unrepeatable value when the gap table is gone, and keeps a reader transaction usable', async () => {
        await stage(db, SUBJECT, 'a');
        await drainChangeFeed(db);
        await db.query('DROP TABLE _smrt_change_gaps');
        expect(await getTableVersion(db, SUBJECT)).not.toBe(
          await getTableVersion(db, SUBJECT),
        );
        const transaction = (
          db as unknown as {
            transaction: <T>(
              cb: (tx: DatabaseInterface) => Promise<T>,
            ) => Promise<T>;
          }
        ).transaction.bind(db);
        const after = await transaction(async (tx) => {
          await getTableVersion(tx, SUBJECT);
          return one(tx, 'SELECT 1 AS ok');
        });
        expect(after.ok).toBe(1);
      });

      it('probes for the routine once per handle and answers unknown without raising once it is gone', async () => {
        await stage(db, SUBJECT, 'a');
        await drainChangeFeed(db);
        const spy = vi.spyOn(db, 'query');
        for (let i = 0; i < 5; i += 1) await getTableVersion(db, SUBJECT);
        const probes = spy.mock.calls.filter((call) =>
          String(call[0]).includes('has_function_privilege'),
        );
        expect(probes).toHaveLength(1);
        spy.mockRestore();

        await db.query('DROP FUNCTION _smrt_change_feed_version(text)');
        const a = await getTableVersion(db, SUBJECT);
        const b = await getTableVersion(db, SUBJECT);
        expect(a).not.toBe(b);
      });
    });

    describe('retention (T18)', () => {
      it('deletes the feed prefix, then evidence below the retained floor; dryRun counts both and deletes neither', async () => {
        for (let i = 1; i <= 10; i += 1) await stage(db, SUBJECT, `r${i}`);
        await drainChangeFeed(db);
        await addMarker(db, { rowId: 'ev-2', convertedSeq: 2 });
        await addMarker(db, { rowId: 'ev-8', convertedSeq: 8 });
        await addMarker(db, { rowId: 'open' });
        await addMarker(db, { rowId: 'blocked', blocked: true });
        await addMarker(db, { rowId: 'retired', reconciled: true });

        const dry = await pruneChangeFeed(db, { maxRows: 5, dryRun: true });
        expect(dry).toEqual({ pruned: 5, prunedGapRecords: 1 });
        expect((await feed(db)).length).toBe(10);
        expect((await markers(db)).length).toBe(5);

        const real = await pruneChangeFeed(db, { maxRows: 5 });
        expect(real).toEqual({ pruned: 5, prunedGapRecords: 1 });
        expect((await markers(db)).map((m) => m.row_id).sort()).toEqual([
          'blocked',
          'ev-8',
          'open',
          'retired',
        ]);

        // Evidence an interrupted sweep left behind goes with the next one.
        await addMarker(db, { rowId: 'orphan', convertedSeq: 3 });
        const next = await pruneChangeFeed(db, { maxRows: 1000 });
        expect(next).toEqual({ pruned: 0, prunedGapRecords: 1 });
        expect((await markers(db)).map((m) => m.row_id)).not.toContain(
          'orphan',
        );
      });
    });

    describe('backlog for the drainer (T24)', () => {
      it('reports backlog only for unblocked markers while delivery is enabled', async () => {
        await addMarker(db);
        expect(statusRowOf(await statusDrain(db)).backlog_remaining).toBe(
          false,
        );

        await db.query('UPDATE _smrt_change_gaps SET blocked_at = now()');
        await enableDelivery(db);
        expect(statusRowOf(await statusDrain(db)).backlog_remaining).toBe(
          false,
        );

        await db.query(
          `INSERT INTO _smrt_change_gaps (table_name, created_at)
           SELECT $1, now() FROM generate_series(1, 201)`,
          SUBJECT,
        );
        const first = statusRowOf(await statusDrain(db));
        expect(first.status).toBe('drained');
        expect(first.backlog_remaining).toBe(true);
        const second = statusRowOf(await statusDrain(db));
        expect(second.backlog_remaining).toBe(false);
      });
    });
  },
);
