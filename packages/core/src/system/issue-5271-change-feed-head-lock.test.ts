/**
 * PostgreSQL change-feed helper bodies serialize sequence allocation (#5271).
 *
 * Every allocator of `_smrt_changes.seq` takes one transaction-scoped
 * advisory "head lock" before it reads `MAX(seq)`, so two READ COMMITTED
 * writers never pick the same value. The direct single and batch appends wait
 * for it; the drain only tries it, so a reader never waits on the head. Each
 * takes the feed table's own insert lock first, so the head lock can never be
 * held while waiting for that relation lock; the drain takes it NOWAIT, and a
 * role without a table-level privilege for it skips it. Everything sits
 * inside the helpers' exception boundaries (#2026), the staged branch (#2649)
 * never touches the head, and the staging decision does not depend on the
 * staging table existing.
 *
 * The bodies carry the v6, v5 and v4 markers (and, since #5402, v7), so an
 * older process's version probe keeps a current body during a rolling
 * upgrade. Since #5402 the drain body lives in the status drain; the
 * two-argument identity delegates to it.
 *
 * Text-level checks; the PostgreSQL suite proves the installed behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION as DRAIN_BODY,
  POSTGRES_CHANGE_FEED_HELPER_MARKER,
} from './schema.js';

const MARKERS = [
  'smrt-change-feed-helpers:v8',
  'smrt-change-feed-helpers:v7',
  'smrt-change-feed-helpers:v6',
  'smrt-change-feed-helpers:v5',
  'smrt-change-feed-helpers:v4',
];
const RELATION_LOCK = 'LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE';
/** The status drain's staged-entry phase, before the gap-marker phase (#5438). */
const STAGED_PHASE = DRAIN_BODY.slice(
  0,
  DRAIN_BODY.indexOf('<<smrt_drain_gaps>>'),
);
const BLOCKING_HEAD =
  /PERFORM pg_advisory_xact_lock\(\s*hashtext\('smrt-change-feed-head'\)/;
const PRIVILEGE_GUARD =
  "IF has_table_privilege('_smrt_changes', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN";
const TRY_HEAD =
  /pg_try_advisory_xact_lock\(\s*hashtext\('smrt-change-feed-head'\)/;
const NON_READ_COMMITTED =
  /current_setting\('transaction_isolation'\)\s+NOT IN\s+\('read committed',\s*'read uncommitted'\)/;

function indexOf(body: string, pattern: string | RegExp, from = 0): number {
  if (typeof pattern === 'string') return body.indexOf(pattern, from);
  const match = pattern.exec(body.slice(from));
  return match ? from + match.index : -1;
}

/** The lock sits after a `BEGIN` whose `EXCEPTION` handler follows `until`. */
function insideExceptionBlock(body: string, at: number, until: number) {
  const begin = body.lastIndexOf('BEGIN', at);
  const exception = body.indexOf('EXCEPTION WHEN', until);
  const between = body.slice(begin, exception);
  // No handler closes the block between the BEGIN and the protected statement.
  return begin >= 0 && exception > until && !between.includes('EXCEPTION WHEN');
}

describe('change-feed head lock in the PostgreSQL helper bodies (#5271)', () => {
  it('bumps the helper marker past v6 (v7, #5402)', () => {
    expect(POSTGRES_CHANGE_FEED_HELPER_MARKER).toBe(MARKERS[0]);
  });

  it('stamps the v7, v6, v5 and v4 markers into all five helper bodies', () => {
    for (const body of [
      CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION,
      DRAIN_BODY,
    ]) {
      for (const marker of MARKERS) expect(body).toContain(marker);
    }
  });

  it('single append: relation lock, then blocking head lock, then MAX, inside the boundary', () => {
    const body = CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION;
    const direct = body.indexOf('INSERT INTO _smrt_changes (');
    const relation = body.lastIndexOf(RELATION_LOCK, direct);
    const head = indexOf(body, BLOCKING_HEAD, relation);
    const max = body.indexOf('COALESCE(MAX(changes.seq), 0) + 1', head);
    expect(relation).toBeGreaterThan(0);
    expect(head).toBeGreaterThan(relation);
    expect(head).toBeLessThan(direct);
    expect(max).toBeGreaterThan(direct);
    expect(insideExceptionBlock(body, relation, max)).toBe(true);
  });

  it('single append: the staged branch never touches the head', () => {
    const body = CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION;
    const staged = body.slice(
      body.indexOf('IF v_deferred THEN'),
      body.indexOf('END IF;', body.indexOf('IF v_deferred THEN')),
    );
    expect(staged).toContain('INSERT INTO _smrt_changes_pending');
    expect(staged).not.toMatch(BLOCKING_HEAD);
    expect(staged).not.toMatch(TRY_HEAD);
    expect(staged).not.toContain(RELATION_LOCK);
  });

  it('batch append: relation lock, then blocking head lock, then MAX, inside the boundary', () => {
    const body = CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION;
    const stagedEnd = body.indexOf(
      'END IF;',
      body.indexOf('IF v_deferred THEN'),
    );
    const relation = body.indexOf(RELATION_LOCK, stagedEnd);
    const head = indexOf(body, BLOCKING_HEAD, relation);
    const max = body.indexOf(
      'COALESCE((SELECT MAX(seq) FROM _smrt_changes), 0)',
      head,
    );
    expect(relation).toBeGreaterThan(stagedEnd);
    expect(head).toBeGreaterThan(relation);
    expect(max).toBeGreaterThan(head);
    expect(insideExceptionBlock(body, relation, max)).toBe(true);
    const staged = body.slice(body.indexOf('IF v_deferred THEN'), stagedEnd);
    expect(staged).not.toMatch(BLOCKING_HEAD);
    expect(staged).not.toContain(RELATION_LOCK);
  });

  it('drain: without waitMs only TRIES the head lock, after the drain lock and a candidate check, before the purge and MAX', () => {
    // Wait mode (#5403) lives in `IF v_wait THEN` branches, checked in
    // change-feed-drain-status-ddl.test.ts; the try path is checked here.
    // The staged-entry phase; the gap-marker phase (#5438) takes the same
    // locks in the same order and is checked in its own DDL test.
    const body = STAGED_PHASE;
    const drainLock = body.indexOf("hashtext('change-feed-drain')");
    const candidate = body.indexOf('v_has_candidate :=', drainLock);
    const relation = body.indexOf(RELATION_LOCK, candidate);
    const head = indexOf(body, TRY_HEAD, relation);
    const purge = body.indexOf(
      'DELETE FROM _smrt_changes_pending AS sensitive',
    );
    const max = body.indexOf(
      'SELECT COALESCE(MAX(changes.seq), 0) INTO v_base',
    );
    expect(drainLock).toBeGreaterThan(0);
    expect(candidate).toBeGreaterThan(drainLock);
    expect(relation).toBeGreaterThan(candidate);
    expect(head).toBeGreaterThan(relation);
    expect(purge).toBeGreaterThan(head);
    expect(max).toBeGreaterThan(purge);
    // The blocking head wait exists only in wait mode, right after a budget
    // step sets lock_timeout.
    const blocking = indexOf(body, BLOCKING_HEAD);
    expect(blocking).toBeGreaterThan(0);
    const before = body.slice(
      body.lastIndexOf('IF v_wait THEN', blocking),
      blocking,
    );
    expect(before).toContain("PERFORM set_config('lock_timeout'");
    expect(body.slice(blocking + 1)).not.toMatch(BLOCKING_HEAD);
    // The only handlers before MAX are the NOWAIT refusals; the locking
    // block's no-work handler and the helper's own boundary close after it
    // (#5402).
    expect(new Set(body.slice(0, max).match(/EXCEPTION WHEN \w+/g))).toEqual(
      new Set(['EXCEPTION WHEN lock_not_available']),
    );
    expect(
      DRAIN_BODY.indexOf('EXCEPTION WHEN query_canceled', max),
    ).toBeGreaterThan(max);
  });

  it('drain: the feed-table lock is NOWAIT and a refusal ends the pass without draining', () => {
    expect(DRAIN_BODY).toMatch(
      /LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE NOWAIT;\s+EXCEPTION WHEN lock_not_available THEN\s+v_status := 'relation_busy';\s+RAISE EXCEPTION USING ERRCODE = 'SMR01';/,
    );
  });

  it('takes the explicit feed-table lock only with a table-level privilege for it', () => {
    for (const body of [
      CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
    ]) {
      const locks = body.split(RELATION_LOCK).length - 1;
      expect(locks).toBe(1);
      const relation = body.indexOf(RELATION_LOCK);
      const guard = body.lastIndexOf(PRIVILEGE_GUARD, relation);
      expect(guard).toBeGreaterThan(0);
      // Nothing but the guarded block sits between the check and the lock.
      expect(body.slice(guard, relation)).not.toContain('END IF;');
    }
    // The drain (#5403) takes it in two places, try path and wait path, both
    // NOWAIT and both reached only past the privilege check; a role without
    // it takes the lock with a zero-row insert instead (see the status-drain
    // DDL test).
    const drainLocks = STAGED_PHASE.split(RELATION_LOCK);
    expect(drainLocks).toHaveLength(3);
    // The gap-marker phase (#5438) repeats the same two NOWAIT locks.
    expect(DRAIN_BODY.split(RELATION_LOCK)).toHaveLength(5);
    for (const rest of drainLocks.slice(1)) expect(rest).toMatch(/^ NOWAIT;/);
    const columnGrant = DRAIN_BODY.indexOf(
      "IF NOT has_table_privilege('_smrt_changes', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN",
    );
    const tryLock = DRAIN_BODY.indexOf(RELATION_LOCK);
    expect(columnGrant).toBeGreaterThan(0);
    expect(DRAIN_BODY.slice(columnGrant, tryLock)).toContain(
      'ELSIF NOT v_wait THEN',
    );
    const waitLock = DRAIN_BODY.indexOf(RELATION_LOCK, tryLock + 1);
    const waitGuard = DRAIN_BODY.lastIndexOf(PRIVILEGE_GUARD, waitLock);
    expect(waitGuard).toBeGreaterThan(tryLock);
    expect(DRAIN_BODY.slice(waitGuard, waitLock)).not.toContain('END IF;');
  });

  it('decides to stage without consulting whether the staging table exists', () => {
    for (const body of [
      CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
    ]) {
      const deferred = body.indexOf('v_deferred :=');
      const decision = body.slice(deferred, body.indexOf(';', deferred));
      expect(decision).toContain('pg_current_xact_id_if_assigned()');
      expect(decision).not.toContain('to_regclass');
    }
  });

  it('stages, and never allocates, under a fixed-snapshot isolation level', () => {
    for (const body of [
      CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
    ]) {
      const deferred = body.indexOf('v_deferred :=');
      const decision = body.slice(deferred, body.indexOf(';', deferred));
      expect(decision).toMatch(NON_READ_COMMITTED);
    }
    const drain = DRAIN_BODY;
    const isolation = indexOf(drain, NON_READ_COMMITTED);
    expect(isolation).toBeGreaterThan(0);
    expect(isolation).toBeLessThan(
      drain.indexOf("hashtext('change-feed-drain')"),
    );
  });

  it('keeps every helper VOLATILE (the fresh per-statement snapshot is load-bearing)', () => {
    for (const body of [
      CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION,
      DRAIN_BODY,
    ]) {
      expect(body).toMatch(/\bVOLATILE\b/);
      expect(body).not.toMatch(/\b(STABLE|IMMUTABLE)\b/);
    }
  });
});
