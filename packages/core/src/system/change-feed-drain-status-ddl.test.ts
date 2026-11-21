/**
 * The PostgreSQL drain helper bodies after the status drain (#5402).
 *
 * The drain body lives in `_smrt_drain_changes(integer, text[], jsonb)`.
 * Every statement that can take a lock sits in one block whose handler
 * catches the private no-work SQLSTATE, so a pass that finds no work rolls
 * the block back and keeps none of its locks. The sequencing statement is the
 * last statement of that block, and the status extras are computed in a
 * separate block, so nothing that can fail runs after it in its
 * subtransaction. The older identities delegate, each inside its own
 * exception boundary, and the append bodies differ from v6 only in their
 * marker lines.
 *
 * Text-level checks; the PGlite and PostgreSQL suites prove the behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION,
  ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  ENSURE_POSTGRES_CHANGE_FEED_SCHEMA,
  POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION_IDENTITY,
  POSTGRES_CHANGE_FEED_HELPER_MARKER,
  REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
} from './schema.js';

const MARKERS = [
  'smrt-change-feed-helpers:v7',
  'smrt-change-feed-helpers:v6',
  'smrt-change-feed-helpers:v5',
  'smrt-change-feed-helpers:v4',
];
const STATUS = CREATE_POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION;
const NO_WORK = "EXCEPTION WHEN SQLSTATE 'SMR01' THEN";

/** The locking block: from its BEGIN to its no-work handler. */
function lockingBlock(): { start: number; end: number; text: string } {
  const end = STATUS.indexOf(NO_WORK);
  const start = STATUS.lastIndexOf(
    'BEGIN',
    STATUS.indexOf('SELECT 1 FROM _smrt_changes_pending LIMIT 1'),
  );
  return { start, end, text: STATUS.slice(start, end) };
}

describe('change-feed status drain bodies (#5402)', () => {
  it('bumps the helper marker to v7 and stamps v7 to v4 into all five helper bodies', () => {
    expect(POSTGRES_CHANGE_FEED_HELPER_MARKER).toBe(MARKERS[0]);
    for (const body of [
      CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION,
      STATUS,
    ]) {
      for (const marker of MARKERS) expect(body).toContain(marker);
      expect(body).toMatch(/\bVOLATILE\b/);
      expect(body).not.toMatch(/\b(STABLE|IMMUTABLE)\b/);
    }
  });

  it('declares the status drain with the seven drain columns plus status, backlog and helper currency', () => {
    expect(POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION_IDENTITY).toBe(
      '_smrt_drain_changes(integer,text[],jsonb)',
    );
    expect(STATUS).toMatch(
      /p_limit INTEGER,\s+p_excluded_tables TEXT\[\],\s+p_options JSONB\s+\)/,
    );
    expect(STATUS).toMatch(
      /error_message TEXT,\s+status TEXT,\s+backlog_remaining BOOLEAN,\s+helpers_current BOOLEAN\s+\)/,
    );
  });

  it('takes every lock inside the block a no-work pass rolls back', () => {
    const block = lockingBlock();
    expect(block.start).toBeGreaterThan(0);
    expect(block.end).toBeGreaterThan(block.start);
    for (const lock of [
      'SELECT 1 FROM _smrt_changes_pending LIMIT 1',
      "hashtext('change-feed-drain')",
      'LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE NOWAIT',
      "pg_try_advisory_xact_lock(hashtext('smrt-change-feed-head')",
      'DELETE FROM _smrt_changes_pending AS sensitive',
      'INSERT INTO _smrt_changes (',
    ]) {
      const at = STATUS.indexOf(lock);
      expect(at, lock).toBeGreaterThan(block.start);
      expect(at, lock).toBeLessThan(block.end);
    }
    // Every no-work exit raises instead of returning, so the block rolls back.
    expect(block.text).not.toMatch(/\bRETURN;/);
    for (const status of [
      'empty',
      'drain_busy',
      'relation_busy',
      'head_busy',
    ]) {
      expect(block.text).toMatch(
        new RegExp(
          `v_status := '${status}';\\s+RAISE EXCEPTION USING ERRCODE = 'SMR01';`,
        ),
      );
    }
  });

  it('makes the sequencing statement the last statement of the locking block', () => {
    const block = lockingBlock();
    const sequencing = STATUS.indexOf('RETURN QUERY', block.start);
    expect(sequencing).toBeLessThan(block.end);
    const after = STATUS.slice(
      STATUS.indexOf('ORDER BY inserted.seq;', sequencing) +
        'ORDER BY inserted.seq;'.length,
      block.end,
    );
    // Only block terminators follow it.
    expect(after.replace(/\s+/g, ' ').trim()).toBe('END IF;');
  });

  it('computes the status extras in their own block after the locking block, then one status row', () => {
    const block = lockingBlock();
    const backlog = STATUS.indexOf('v_backlog := EXISTS');
    const helpers = STATUS.indexOf('v_helpers := (');
    expect(backlog).toBeGreaterThan(block.end);
    expect(helpers).toBeGreaterThan(backlog);
    const extras = STATUS.slice(
      STATUS.lastIndexOf('BEGIN', backlog),
      STATUS.indexOf('END;', helpers),
    );
    expect(extras).toContain(
      'EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN',
    );
    expect(
      STATUS.indexOf('v_status,\n      v_backlog,\n      v_helpers;'),
    ).toBeGreaterThan(helpers);
  });

  it('keeps an exception boundary around the delegators, which return only entry and error rows', () => {
    const two = CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION;
    expect(two).toMatch(/p_limit INTEGER,\s+p_excluded_tables TEXT\[\]\s+\)/);
    expect(two).toMatch(
      /FROM _smrt_drain_changes\(\s+p_limit,\s+p_excluded_tables,\s+'\{\}'::JSONB\s+\) AS drained\s+WHERE drained\.status IS NULL;/,
    );
    expect(two).toContain(
      'EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN',
    );
    expect(two).not.toMatch(/\bstatus TEXT\b/);
    const compat = CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION;
    expect(compat).toContain(
      'EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN',
    );
  });

  it('installs the status drain first and reconciles its owner and grants with the two-argument drain', () => {
    for (const install of [
      REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      ENSURE_POSTGRES_CHANGE_FEED_SCHEMA,
    ]) {
      const status = install.indexOf('p_options JSONB');
      const two = install.indexOf('$smrt_change_feed_drain$');
      expect(status).toBeGreaterThan(0);
      expect(two).toBeGreaterThan(status);
      expect(install).toContain(
        "'ALTER FUNCTION _smrt_drain_changes(integer,text[],jsonb) OWNER TO %I'",
      );
      expect(install).toContain("acldefault('f', p.proowner)");
      expect(install).toMatch(
        /could not be made equal to _smrt_drain_changes\(integer,text\[\]\)/,
      );
    }
  });
});
