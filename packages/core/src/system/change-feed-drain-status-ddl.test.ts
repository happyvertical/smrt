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
const NO_WORK = /EXCEPTION\s+WHEN SQLSTATE 'SMR01' THEN/;

/** The locking block: from its BEGIN to its no-work handler. */
function lockingBlock(): { start: number; end: number; text: string } {
  const end = STATUS.search(NO_WORK);
  const start = STATUS.indexOf('<<smrt_drain_pass>>');
  return { start, end, text: STATUS.slice(start, end) };
}

/** The statements of the locking block that can wait for a lock. */
const BLOCKING_STEPS = [
  'IF NOT EXISTS (SELECT 1 FROM _smrt_changes_pending LIMIT 1)',
  "PERFORM pg_advisory_xact_lock(\n            hashtext('smrt'),",
  'LOCK TABLE _smrt_changes_pending IN ROW EXCLUSIVE MODE;',
  "PERFORM pg_advisory_xact_lock(hashtext('smrt-change-feed-head')",
  'DELETE FROM _smrt_changes_pending AS sensitive',
  "IF has_table_privilege('_smrt_changes_pending', 'UPDATE') THEN",
];
const BUDGET_STEP =
  "PERFORM set_config('lock_timeout', GREATEST(1, floor(v_remaining_ms))::BIGINT::TEXT || 'ms', true);";

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
    // Only the zero-row check (which raises only when nothing was returned)
    // and block terminators follow it.
    expect(
      after
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      "GET DIAGNOSTICS v_sequenced = ROW_COUNT; IF v_sequenced = 0 AND v_purged = 0 THEN v_status := 'empty'; RAISE EXCEPTION USING ERRCODE = 'SMR01'; END IF; END IF;",
    );
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

describe('change-feed waiting drain bodies (#5403)', () => {
  it('applies the remaining budget right before every blocking step of a waiting pass', () => {
    const block = lockingBlock();
    for (const step of BLOCKING_STEPS) {
      const at = STATUS.indexOf(step, block.start);
      expect(at, step).toBeGreaterThan(block.start);
      expect(at, step).toBeLessThan(block.end);
      const budget = STATUS.lastIndexOf(BUDGET_STEP, at);
      expect(budget, step).toBeGreaterThan(block.start);
      // No other statement sits between the budget step and the blocking one.
      const between = STATUS.slice(budget + BUDGET_STEP.length, at);
      expect(
        between
          .replace(/--[^\n]*/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
        step,
      ).toMatch(/^(END IF;)?( END IF;)?$/);
    }
  });

  it('never sets lock_timeout to zero and ends a spent budget as timeout before waiting', () => {
    expect(STATUS).not.toMatch(/set_config\('lock_timeout',\s*'0/);
    const budgets = STATUS.split(BUDGET_STEP).length - 1;
    expect(budgets).toBe(BLOCKING_STEPS.length);
    expect(STATUS).toMatch(
      /IF v_remaining_ms < 1 THEN\s+v_status := 'timeout';\s+RAISE EXCEPTION USING ERRCODE = 'SMR01';\s+END IF;\s+PERFORM set_config\('lock_timeout', GREATEST\(1,/,
    );
  });

  it('caps the budget below the session statement_timeout', () => {
    expect(STATUS).toContain("WHERE name = 'statement_timeout'");
    expect(STATUS).toMatch(
      /v_statement_timeout_ms\s+- EXTRACT\(EPOCH FROM clock_timestamp\(\) - statement_timestamp\(\)\) \* 1000\s+- GREATEST\(v_statement_timeout_ms \/ 10, 50\)/,
    );
  });

  it('refuses a firstStatement call that is not its transaction’s first statement, before any lock', () => {
    const guard = STATUS.indexOf(
      "p_options->'firstStatement' = 'true'::JSONB\n      AND statement_timestamp() <> transaction_timestamp()",
    );
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(lockingBlock().start);
  });

  it('takes a column-grant role’s feed-table lock before the head with a 1 ms limit, holding nothing on refusal', () => {
    const columnGrant = STATUS.indexOf(
      "IF NOT has_table_privilege('_smrt_changes', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN",
    );
    const zeroRow = STATUS.indexOf(
      'INSERT INTO _smrt_changes (seq) SELECT NULL::BIGINT WHERE false;',
    );
    const waitHead = STATUS.indexOf(
      "PERFORM pg_advisory_xact_lock(hashtext('smrt-change-feed-head')",
    );
    const tryHead = STATUS.indexOf(
      "pg_try_advisory_xact_lock(hashtext('smrt-change-feed-head')",
    );
    expect(columnGrant).toBeGreaterThan(0);
    expect(zeroRow).toBeGreaterThan(columnGrant);
    expect(STATUS.slice(columnGrant, zeroRow)).toContain(
      "PERFORM set_config('lock_timeout', '1ms', true);",
    );
    expect(zeroRow).toBeLessThan(waitHead);
    expect(zeroRow).toBeLessThan(tryHead);
    expect(STATUS.slice(zeroRow, waitHead)).toMatch(
      /EXCEPTION WHEN lock_not_available THEN\s+v_status := 'relation_busy';/,
    );
  });

  it('takes the staging table’s insert lock before the head in both modes, NOWAIT without waitMs', () => {
    const tryLock = STATUS.indexOf(
      'LOCK TABLE _smrt_changes_pending IN ROW EXCLUSIVE MODE NOWAIT;',
    );
    const waitLock = STATUS.indexOf(
      'LOCK TABLE _smrt_changes_pending IN ROW EXCLUSIVE MODE;',
    );
    const candidate = STATUS.indexOf('v_has_candidate := EXISTS');
    expect(tryLock).toBeGreaterThan(0);
    expect(waitLock).toBeGreaterThan(0);
    expect(tryLock).toBeLessThan(candidate);
    expect(waitLock).toBeLessThan(candidate);
    expect(STATUS.slice(tryLock)).toMatch(
      /^LOCK TABLE _smrt_changes_pending IN ROW EXCLUSIVE MODE NOWAIT;\s+EXCEPTION WHEN lock_not_available THEN\s+v_status := 'relation_busy';/,
    );
  });

  it('sets the try-only lock limit before the first staging probe and keeps it for the whole pass', () => {
    const block = lockingBlock();
    const tryLimit = STATUS.indexOf(
      "IF NOT v_wait THEN\n          PERFORM set_config('lock_timeout', '1ms', true);",
    );
    const probe = STATUS.indexOf('SELECT 1 FROM _smrt_changes_pending LIMIT 1');
    expect(tryLimit).toBeGreaterThan(block.start);
    expect(tryLimit).toBeLessThan(probe);
    // Inside the block lock_timeout goes back to the caller's value only in
    // wait mode (where the next budget step replaces it).
    const body = STATUS.slice(block.start, block.end);
    const restores = body.split(
      "PERFORM set_config('lock_timeout', v_lock_timeout, true);",
    );
    for (const before of restores.slice(0, -1)) {
      expect(before.trimEnd().endsWith('IF v_wait THEN')).toBe(true);
    }
    const restore = STATUS.indexOf(
      "PERFORM set_config('lock_timeout', v_lock_timeout, true);",
      block.end,
    );
    expect(restore).toBeGreaterThan(block.end);
    expect(restore).toBeLessThan(STATUS.indexOf('v_backlog := EXISTS'));
  });

  it('locks the batch’s rows without waiting before sequencing, or caps a role without UPDATE at 1 ms per row', () => {
    const block = lockingBlock();
    const rowLocks = STATUS.indexOf('FOR UPDATE NOWAIT;', block.start);
    const sequencing = STATUS.indexOf('RETURN QUERY', rowLocks);
    expect(rowLocks).toBeGreaterThan(
      STATUS.indexOf('DELETE FROM _smrt_changes_pending AS sensitive'),
    );
    expect(sequencing).toBeGreaterThan(rowLocks);
    expect(sequencing).toBeLessThan(block.end);
    expect(STATUS.slice(rowLocks, sequencing)).toMatch(
      /ELSE\s+PERFORM set_config\('lock_timeout', '1ms', true\);\s+END IF;/,
    );
    expect(
      STATUS.lastIndexOf(
        "IF has_table_privilege('_smrt_changes_pending', 'UPDATE') THEN",
        rowLocks,
      ),
    ).toBeGreaterThan(STATUS.lastIndexOf(BUDGET_STEP, rowLocks) - 1);
  });

  it('voids the whole call once the sequencing statement has started: a lock timeout then is an error row, not a timeout', () => {
    const flag = STATUS.indexOf('v_emitting := true;');
    const sequencing = STATUS.indexOf('RETURN QUERY', flag);
    expect(flag).toBeGreaterThan(0);
    // Nothing but comments between the flag and the sequencing statement.
    expect(
      STATUS.slice(flag + 'v_emitting := true;'.length, sequencing)
        .replace(/--[^\n]*/g, '')
        .trim(),
    ).toBe('');
    expect(STATUS).toMatch(
      /WHEN lock_not_available THEN\s+IF v_emitting THEN\s+RAISE;\s+END IF;\s+v_status := 'timeout';/,
    );
  });

  it('asks for another look when a candidate was seen but nothing moved', () => {
    expect(STATUS).toMatch(
      /ELSIF v_status = 'empty' THEN[\s\S]*?v_backlog := v_has_candidate;/,
    );
  });
});
