/**
 * Atomic shared-storage primitives behind {@link LoginAttemptLimiter}.
 *
 * Every mutation here is a single conditional statement so concurrent
 * attempts across replicas cannot all pass the budget check before any one
 * of them records its failure. Keys arrive already hashed.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  type LoginAttemptScope,
  UsersLoginAttempt,
} from '../models/LoginAttempt.js';

/** Result of {@link UsersLoginAttemptCollection.reserveAttempt}. */
export type LoginAttemptReservation =
  | { allowed: true; attemptCount: number; windowStartedAt: string }
  | { allowed: false; retryAfterSeconds: number; lockedOut: boolean };

export interface ReserveLoginAttemptInput {
  limiterKey: string;
  scope: LoginAttemptScope;
  maxAttempts: number;
  windowMs: number;
  /**
   * A key whose last failure is older than this has its failure streak
   * forgiven on the next reservation, so an old lockout history does not
   * haunt a key forever.
   */
  streakResetMs: number;
  /** How long after this write the row must survive the retention sweep. */
  retainMs: number;
}

export interface RecordLoginFailureInput {
  limiterKey: string;
  maxAttempts: number;
  /** How long after this write the row must survive the retention sweep. */
  retainMs: number;
  /**
   * When positive, one earlier failure is forgiven for each full interval of
   * this length since the key's last failure, before this one is counted.
   * Used for shared sources so ordinary, spaced-out mistakes never accumulate
   * while a burst still escalates.
   */
  streakDecayMs?: number;
  /** Returns the lockout length for the n-th consecutive exhausted budget (0-based), or 0 for none. */
  lockoutMsFor: (exhaustedBudgets: number) => number;
}

export interface RecordedLoginFailure {
  failureStreak: number;
  lockedUntil: string | null;
}

function toIso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

function toMs(value: unknown): number {
  if (value === null || value === undefined) return Number.NaN;
  return value instanceof Date
    ? value.getTime()
    : new Date(String(value)).getTime();
}

export class UsersLoginAttemptCollection extends SmrtCollection<UsersLoginAttempt> {
  static readonly _itemClass = UsersLoginAttempt;

  /**
   * Atomically reserve one attempt for a key across every process using this
   * database. Failed attempts retain their reservation (see
   * {@link recordFailure}); successful or aborted attempts release it.
   */
  async reserveAttempt(
    input: ReserveLoginAttemptInput,
  ): Promise<LoginAttemptReservation> {
    const now = new Date();
    const nowIso = now.toISOString();
    const windowFloorIso = new Date(
      now.getTime() - input.windowMs,
    ).toISOString();
    const streakFloorIso = new Date(
      now.getTime() - input.streakResetMs,
    ).toISOString();
    const retainUntilIso = new Date(
      now.getTime() + input.retainMs,
    ).toISOString();
    // limiter_key is the UPSERT arbiter. A derived slug would create a second
    // unique conflict during concurrent first inserts that PostgreSQL cannot
    // arbitrate, so the slug is random and never queried.
    const id = randomUUID();
    const table = this.tableName;
    const reserved = await this.db.query(
      `INSERT INTO ${table} (
         id, slug, context, limiter_key, scope, attempt_count,
         window_started_at, failure_streak, locked_until, retain_until,
         created_at, updated_at
       ) VALUES (?, ?, '', ?, ?, 1, ?, 0, NULL, ?, ?, ?)
       ON CONFLICT (limiter_key) DO UPDATE SET
         attempt_count = CASE
           WHEN ${table}.window_started_at <= ?
             OR (${table}.locked_until IS NOT NULL AND ${table}.locked_until <= ?)
             THEN 1
           ELSE ${table}.attempt_count + 1
         END,
         window_started_at = CASE
           WHEN ${table}.window_started_at <= ?
             OR (${table}.locked_until IS NOT NULL AND ${table}.locked_until <= ?)
             THEN excluded.window_started_at
           ELSE ${table}.window_started_at
         END,
         failure_streak = CASE
           WHEN ${table}.last_failed_at IS NULL
             OR ${table}.last_failed_at <= ? THEN 0
           ELSE ${table}.failure_streak
         END,
         locked_until = NULL,
         retain_until = excluded.retain_until,
         updated_at = excluded.updated_at
       WHERE (${table}.locked_until IS NULL OR ${table}.locked_until <= ?)
         AND (
           ${table}.window_started_at <= ?
           OR ${table}.attempt_count < ?
           OR (${table}.locked_until IS NOT NULL AND ${table}.locked_until <= ?)
         )
       RETURNING attempt_count, window_started_at`,
      id,
      `login-attempt-${id}`,
      input.limiterKey,
      input.scope,
      nowIso,
      retainUntilIso,
      nowIso,
      nowIso,
      windowFloorIso,
      nowIso,
      windowFloorIso,
      nowIso,
      streakFloorIso,
      nowIso,
      windowFloorIso,
      input.maxAttempts,
      nowIso,
    );
    const row = reserved.rows?.[0];
    if (reserved.rows?.length === 1 && row) {
      return {
        allowed: true,
        attemptCount: Number(row.attempt_count ?? 1),
        windowStartedAt: toIso(row.window_started_at),
      };
    }

    const current = await this.db.query(
      `SELECT window_started_at, locked_until FROM ${table}
        WHERE limiter_key = ? LIMIT 1`,
      input.limiterKey,
    );
    const currentRow = current.rows?.[0];
    const windowEndsMs = toMs(currentRow?.window_started_at) + input.windowMs;
    const lockedUntilMs = toMs(currentRow?.locked_until);
    const lockedOut =
      Number.isFinite(lockedUntilMs) && lockedUntilMs > now.getTime();
    // Once a lockout has been applied it is the sole gate (an elapsed lockout
    // rolls the window in the UPSERT above), so report whichever gate is
    // actually active rather than the later of the two.
    let untilMs = 0;
    if (lockedOut) untilMs = lockedUntilMs;
    else if (Number.isFinite(windowEndsMs)) untilMs = windowEndsMs;
    const remainingMs = untilMs > 0 ? untilMs - now.getTime() : input.windowMs;
    return {
      allowed: false,
      lockedOut,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
  }

  /**
   * Record that a reserved attempt failed authentication. The reservation is
   * kept (it already counts against the window); the streak advances, and if
   * this failure exhausted the window's budget or completed another
   * `maxAttempts` consecutive failures the key is locked for the backoff the
   * caller computes from how many budgets in a row have been exhausted.
   */
  async recordFailure(
    input: RecordLoginFailureInput,
  ): Promise<RecordedLoginFailure> {
    const now = new Date();
    const nowIso = now.toISOString();
    const retainUntilIso = new Date(
      now.getTime() + input.retainMs,
    ).toISOString();
    const row =
      (input.streakDecayMs ?? 0) > 0
        ? await this.advanceDecayedStreak(input, now, retainUntilIso)
        : await this.advanceStreak(input.limiterKey, nowIso, retainUntilIso);
    if (!row) return { failureStreak: 0, lockedUntil: null };

    const failureStreak = Number(row.failure_streak ?? 0);
    const attemptCount = Number(row.attempt_count ?? 0);
    // Lock when this failure exhausts the window's budget OR completes
    // another `maxAttempts` consecutive failures. The second condition is
    // what makes the backoff unavoidable: a client that paces itself one
    // attempt under the budget and waits for the window to roll never
    // exhausts a window, but its streak still crosses the boundary.
    // A decayed streak can land back on the number it held (one forgiven,
    // one added); only a failure that moved the streak UP onto the boundary
    // counts, or a source resting on a boundary would re-lock on every
    // spaced-out mistake.
    const previousStreak =
      row.previous_streak === undefined
        ? failureStreak - 1
        : Number(row.previous_streak);
    const budgetExhausted = attemptCount >= input.maxAttempts;
    const streakBoundary =
      failureStreak > previousStreak && failureStreak % input.maxAttempts === 0;
    if (!budgetExhausted && !streakBoundary) {
      return { failureStreak, lockedUntil: null };
    }

    const exhaustedBudgets = Math.max(
      0,
      Math.floor(failureStreak / input.maxAttempts) - 1,
    );
    const lockoutMs = input.lockoutMsFor(exhaustedBudgets);
    if (!(lockoutMs > 0)) return { failureStreak, lockedUntil: null };

    const lockedUntil = new Date(Date.now() + lockoutMs).toISOString();
    // Only ever lengthen a lockout; a concurrent failure that computed a
    // longer one must not be shortened by this write. The streak guard ties
    // the lock to the state it was computed from: a success that reset the
    // streak in between must not be followed by this lock.
    await this.db.query(
      `UPDATE ${this.tableName}
          SET locked_until = ?, updated_at = ?
        WHERE limiter_key = ?
          AND failure_streak >= ?
          AND (locked_until IS NULL OR locked_until < ?)`,
      lockedUntil,
      nowIso,
      input.limiterKey,
      failureStreak,
      lockedUntil,
    );
    return { failureStreak, lockedUntil };
  }

  /** Count one more consecutive failure for a key. */
  private async advanceStreak(
    limiterKey: string,
    nowIso: string,
    retainUntilIso: string,
  ): Promise<Record<string, unknown> | undefined> {
    const advanced = await this.db.query(
      `UPDATE ${this.tableName}
          SET failure_streak = failure_streak + 1, last_failed_at = ?,
              retain_until = ?, updated_at = ?
        WHERE limiter_key = ?
        RETURNING attempt_count, failure_streak`,
      nowIso,
      retainUntilIso,
      nowIso,
      limiterKey,
    );
    return advanced.rows?.[0];
  }

  /**
   * Count one more failure after forgiving one earlier failure per full
   * `streakDecayMs` since the key's last failure. The elapsed time is
   * computed here rather than in SQL so it is identical on every engine. When
   * nothing is forgiven the write is the plain atomic increment. Otherwise it
   * is a compare-and-set on BOTH values the forgiveness was computed from —
   * the streak and the last-failure time — so concurrent failures cannot
   * each apply the same forgiveness: the loser re-reads, finds the last
   * failure is now, forgives nothing and increments. (The streak alone is not
   * a sufficient guard: forgiving one and adding one writes the same number
   * back.) After repeated conflicts it falls back to the plain increment.
   */
  private async advanceDecayedStreak(
    input: RecordLoginFailureInput,
    now: Date,
    retainUntilIso: string,
  ): Promise<Record<string, unknown> | undefined> {
    const nowIso = now.toISOString();
    const decayMs = input.streakDecayMs as number;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.db.query(
        `SELECT failure_streak, last_failed_at FROM ${this.tableName}
          WHERE limiter_key = ? LIMIT 1`,
        input.limiterKey,
      );
      const currentRow = current.rows?.[0];
      if (!currentRow) return undefined;
      const streak = Number(currentRow.failure_streak ?? 0);
      const elapsedMs = now.getTime() - toMs(currentRow.last_failed_at);
      const forgiven =
        Number.isFinite(elapsedMs) && elapsedMs > 0
          ? Math.floor(elapsedMs / decayMs)
          : 0;
      if (forgiven === 0 || streak === 0) break;
      const advanced = await this.db.query(
        `UPDATE ${this.tableName}
            SET failure_streak = ?, last_failed_at = ?, retain_until = ?,
                updated_at = ?
          WHERE limiter_key = ? AND failure_streak = ? AND last_failed_at = ?
          RETURNING attempt_count, failure_streak`,
        Math.max(0, streak - forgiven) + 1,
        nowIso,
        retainUntilIso,
        nowIso,
        input.limiterKey,
        streak,
        toIso(currentRow.last_failed_at),
      );
      if (advanced.rows?.[0]) {
        return { ...advanced.rows[0], previous_streak: streak };
      }
    }
    return this.advanceStreak(input.limiterKey, nowIso, retainUntilIso);
  }

  /**
   * Release the reservation for an attempt that did not fail authentication.
   * Deliberately leaves in-window failures in place — a success must not
   * refill the budget mid-window (see the terminal-auth tests).
   */
  async releaseAttempt(
    limiterKey: string,
    windowStartedAt: string,
    options: { resetStreak?: boolean } = {},
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const streakSql = options.resetStreak
      ? ', failure_streak = 0, locked_until = NULL'
      : '';
    await this.db.query(
      `UPDATE ${this.tableName}
          SET attempt_count = CASE
                WHEN attempt_count > 0 THEN attempt_count - 1
                ELSE 0
              END,
              updated_at = ?${streakSql}
        WHERE limiter_key = ? AND window_started_at = ?`,
      nowIso,
      limiterKey,
      windowStartedAt,
    );
    await this.db.query(
      `DELETE FROM ${this.tableName}
        WHERE limiter_key = ? AND window_started_at = ?
          AND attempt_count = 0 AND failure_streak = 0`,
      limiterKey,
      windowStartedAt,
    );
  }

  /**
   * Delete rows that are not locked out and are past the horizon the limiter
   * that last wrote them recorded in `retain_until` (retention sweep), so a
   * limiter configured with a longer window or streak horizon than the
   * defaults never has a live budget erased. Returns the number removed (or,
   * under `dryRun`, matched).
   */
  async deleteIdle(options: { dryRun?: boolean } = {}): Promise<number> {
    const nowIso = new Date().toISOString();
    const predicate =
      'retain_until < ? AND (locked_until IS NULL OR locked_until < ?)';
    const counted = await this.db.query(
      `SELECT COUNT(*) AS total FROM ${this.tableName} WHERE ${predicate}`,
      nowIso,
      nowIso,
    );
    const total = Number(counted.rows?.[0]?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) return 0;
    if (!options.dryRun) {
      await this.db.query(
        `DELETE FROM ${this.tableName} WHERE ${predicate}`,
        nowIso,
        nowIso,
      );
    }
    return total;
  }
}
