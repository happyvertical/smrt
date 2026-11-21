/**
 * Gap-marker storage and helper bodies, as text, plus the embedded engines
 * (#5438, PR 1a).
 *
 * The table joins the system schema under a new version and checksum; its id
 * is a native uuid on PostgreSQL and DuckDB and TEXT on SQLite, its tenant key
 * text everywhere. The drain and version bodies carry the v8 marker over the
 * older ones, and their new blocks catch `query_canceled` explicitly. SQLite
 * and DuckDB are untouched in this release: no feed statement they run names
 * the gap table. Behaviour on PostgreSQL engines is proved by the PGlite and
 * PostgreSQL suites.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  getChangesSince,
  getTableVersion,
  pruneChangeFeed,
} from '../change-feed';
import {
  ALL_SYSTEM_TABLES,
  CREATE_POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_VERSION_FUNCTION,
  CREATE_SMRT_CHANGE_GAPS_TABLE,
  ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  ENSURE_POSTGRES_CHANGE_FEED_SCHEMA,
  getSystemTableDDLForEngine,
  POSTGRES_CHANGE_FEED_HELPER_MARKER,
  REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  SMRT_SCHEMA_DDL_CHECKSUMS,
  SMRT_SCHEMA_VERSION,
} from '../system/schema';
import { getTestDatabase } from '../testing/database';

const STATUS = CREATE_POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION;
const VERSION = CREATE_POSTGRES_CHANGE_FEED_VERSION_FUNCTION;

describe('gap table DDL (T1)', () => {
  it('is part of the system schema under a recorded version', () => {
    expect(ALL_SYSTEM_TABLES).toContain(CREATE_SMRT_CHANGE_GAPS_TABLE);
    expect(SMRT_SCHEMA_DDL_CHECKSUMS[SMRT_SCHEMA_VERSION]).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('renders the id as uuid on PostgreSQL and DuckDB and as text on SQLite; the tenant key stays text', () => {
    const pg = getSystemTableDDLForEngine(
      CREATE_SMRT_CHANGE_GAPS_TABLE,
      'postgres',
    );
    expect(pg).toContain('gap_id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(pg).toContain('tenant_key TEXT');
    expect(pg).toContain('created_at TIMESTAMPTZ NOT NULL');
    const duck = getSystemTableDDLForEngine(
      CREATE_SMRT_CHANGE_GAPS_TABLE,
      'duckdb',
    );
    expect(duck).toContain('gap_id UUID PRIMARY KEY');
    expect(duck).toContain('tenant_key TEXT');
    const lite = getSystemTableDDLForEngine(
      CREATE_SMRT_CHANGE_GAPS_TABLE,
      'sqlite',
    );
    expect(lite).toContain('gap_id TEXT PRIMARY KEY');
    // A SQLite file whose name reads as DuckDB still gets valid DDL.
    expect(duck).not.toContain('gen_random_uuid');
    expect(lite).not.toContain('gen_random_uuid');
    const json = getSystemTableDDLForEngine(
      CREATE_SMRT_CHANGE_GAPS_TABLE,
      'json',
    );
    expect(json).toContain('gap_id TEXT PRIMARY KEY');
    for (const ddl of [pg, duck, lite]) {
      expect(ddl).toContain('idx_smrt_change_gaps_table');
      expect(ddl).toContain('idx_smrt_change_gaps_converted_seq');
    }
  });

  it('travels with every helper install statement', () => {
    for (const statement of [
      ENSURE_POSTGRES_CHANGE_FEED_SCHEMA,
      ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
    ]) {
      expect(statement).toContain(
        'CREATE TABLE IF NOT EXISTS _smrt_change_gaps',
      );
      expect(statement).toContain('_smrt_change_feed_version(');
    }
  });
});

describe('helper bodies (T21)', () => {
  it('stamps v8 over the v7 to v4 markers and stays VOLATILE', () => {
    expect(POSTGRES_CHANGE_FEED_HELPER_MARKER).toBe(
      'smrt-change-feed-helpers:v8',
    );
    for (const body of [STATUS, VERSION]) {
      for (const marker of ['v8', 'v7', 'v6', 'v5', 'v4']) {
        expect(body).toContain(`-- smrt-change-feed-helpers:${marker}`);
      }
      expect(body).toMatch(/\nVOLATILE\n/);
    }
  });

  it('checks the staged batch receipt and never returns entries through RETURN QUERY inside a block', () => {
    expect(STATUS).toContain('IF v_removed <> v_inserted THEN');
    const passStart = STATUS.indexOf('<<smrt_drain_pass>>');
    const passEnd = STATUS.indexOf('<<smrt_drain_gaps>>');
    expect(passStart).toBeGreaterThan(0);
    expect(STATUS.slice(passStart, passEnd)).not.toMatch(/^\s*RETURN QUERY/m);
  });

  it('classifies only row-attributable errors for isolation, sparing the sequence-key duplicate', () => {
    expect(STATUS).toContain("v_code LIKE '22%'");
    expect(STATUS).toContain("v_code = 'P0001'");
    expect(STATUS).toMatch(
      /v_code = '23505'\s+AND v_constraint IS NOT DISTINCT FROM/,
    );
    expect(STATUS).toContain("feed_key.contype = 'p'");
    expect(STATUS).toContain('LIMIT 64');
    expect(STATUS).toContain('LIMIT 200');
  });

  it('catches query_canceled explicitly in every new block and re-raises it', () => {
    const blocks = STATUS.split('WHEN query_canceled THEN').length - 1;
    expect(blocks).toBeGreaterThanOrEqual(6);
    expect(VERSION).toContain(
      'WHEN query_canceled OR assert_failure OR OTHERS',
    );
  });

  it('gates conversion on the delivery setting under a row lock', () => {
    expect(STATUS).toContain(
      "@happyvertical/smrt-core:change-feed-gap-delivery:v1'\n            FOR SHARE OF setting;",
    );
    expect(STATUS).toContain('FOR SHARE OF setting NOWAIT;');
    expect(STATUS).toContain("'gap',");
  });

  it('reads every version term in one statement', () => {
    const query = VERSION.slice(VERSION.indexOf('RETURN QUERY'));
    expect(query.indexOf(';')).toBeGreaterThan(
      query.indexOf('_smrt_change_gaps'),
    );
    expect(query).toContain('marker.converted_seq IS NULL');
  });
});

describe.each([
  'sqlite',
  'duckdb',
] as const)('embedded engines are untouched (T2, T18) — %s', (engine) => {
  let db: DatabaseInterface | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close?.();
    db = undefined;
  });

  it('issues no feed statement naming the gap table, even with markers present', async () => {
    db = (await getTestDatabase({
      type: engine,
      classes: [],
    })) as DatabaseInterface;
    await db.query(
      `INSERT INTO _smrt_change_gaps (gap_id, table_name, row_id, operation, created_at)
         VALUES ('5b7f0c2e-9a1d-4e3b-8c6f-1d2e3f4a5b6c', 'gap_embedded', 'lost', 'update', CURRENT_TIMESTAMP)`,
    );
    const spy = vi.spyOn(db, 'query');
    for (let i = 0; i < 5; i += 1) {
      await appendChange(db, {
        table: 'gap_embedded',
        rowId: `r${i}`,
        operation: 'update',
      });
    }
    const version = await getTableVersion(db, 'gap_embedded');
    expect(version).toBe(5);
    const page = await getChangesSince(db, { since: 0 });
    expect(page.changes).toHaveLength(5);
    const pruned = await pruneChangeFeed(db, { maxRows: 2 });
    expect(pruned).toEqual({ pruned: 3 });
    const dry = await pruneChangeFeed(db, { maxRows: 1, dryRun: true });
    expect(dry).toEqual({ pruned: 1 });
    expect(
      spy.mock.calls.filter((call) =>
        String(call[0]).includes('_smrt_change_gaps'),
      ),
    ).toEqual([]);
    const left = await db.query('SELECT COUNT(*) AS n FROM _smrt_change_gaps');
    const rows = Array.isArray(left)
      ? left
      : ((left as { rows?: unknown[] }).rows ?? []);
    expect(Number((rows[0] as { n: unknown }).n)).toBe(1);
  });
});
