/**
 * Atomic shared-storage limiter for terminal device-code approvals.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { UsersCliAuthApproveLimit } from '../models/CliAuthApproveLimit.js';

export type CliAuthApproveReservation =
  | { allowed: true; windowStartedAt: string }
  | { allowed: false; retryAfterSeconds: number };

export class UsersCliAuthApproveLimitCollection extends SmrtCollection<UsersCliAuthApproveLimit> {
  static readonly _itemClass = UsersCliAuthApproveLimit;

  /**
   * Atomically reserve one attempt across every process using this database.
   * Failed attempts retain their reservation; successful attempts release it.
   */
  async reserveAttempt(input: {
    maxAttempts: number;
    userId: string;
    windowMs: number;
  }): Promise<CliAuthApproveReservation> {
    const now = new Date();
    const nowIso = now.toISOString();
    const windowFloorIso = new Date(
      now.getTime() - input.windowMs,
    ).toISOString();
    const reserved = await this.db.query(
      `INSERT INTO ${this.tableName} (
         id, slug, context, user_id, attempt_count, window_started_at,
         created_at, updated_at
       ) VALUES (?, ?, '', ?, 1, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         attempt_count = CASE
           WHEN ${this.tableName}.window_started_at <= ? THEN 1
           ELSE ${this.tableName}.attempt_count + 1
         END,
         window_started_at = CASE
           WHEN ${this.tableName}.window_started_at <= ?
             THEN excluded.window_started_at
           ELSE ${this.tableName}.window_started_at
         END,
         updated_at = excluded.updated_at
       WHERE ${this.tableName}.window_started_at <= ?
          OR ${this.tableName}.attempt_count < ?
       RETURNING attempt_count, window_started_at`,
      randomUUID(),
      `terminal-auth-${input.userId}`,
      input.userId,
      nowIso,
      nowIso,
      nowIso,
      windowFloorIso,
      windowFloorIso,
      windowFloorIso,
      input.maxAttempts,
    );
    if (reserved.rows.length === 1) {
      const reservedWindow = reserved.rows[0]?.window_started_at;
      const windowStartedAt =
        reservedWindow instanceof Date
          ? reservedWindow.toISOString()
          : new Date(String(reservedWindow)).toISOString();
      return { allowed: true, windowStartedAt };
    }

    const current = await this.db.query(
      `SELECT window_started_at FROM ${this.tableName}
        WHERE user_id = ? LIMIT 1`,
      input.userId,
    );
    const windowStartedAt = current.rows[0]?.window_started_at;
    const startedMs =
      windowStartedAt instanceof Date
        ? windowStartedAt.getTime()
        : new Date(String(windowStartedAt)).getTime();
    const remainingMs = Number.isFinite(startedMs)
      ? startedMs + input.windowMs - now.getTime()
      : input.windowMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
  }

  /** Release the reservation for an attempt that did not fail authentication. */
  async releaseAttempt(userId: string, windowStartedAt: string): Promise<void> {
    await this.db.query(
      `UPDATE ${this.tableName}
          SET attempt_count = CASE
                WHEN attempt_count > 0 THEN attempt_count - 1
                ELSE 0
              END,
              updated_at = ?
        WHERE user_id = ? AND window_started_at = ?`,
      new Date().toISOString(),
      userId,
      windowStartedAt,
    );
    await this.db.query(
      `DELETE FROM ${this.tableName}
        WHERE user_id = ? AND window_started_at = ? AND attempt_count = 0`,
      userId,
      windowStartedAt,
    );
  }
}
