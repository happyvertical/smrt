/**
 * SessionCollection - Collection manager for Session objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  DEFAULT_SESSION_TTL,
  generateSessionId,
  Session,
} from '../models/Session.js';
import { SessionStatus } from '../types/index.js';

/**
 * Options for creating a new session
 */
export interface CreateSessionOptions {
  /** User ID for the session */
  userId: string;
  /** Optional tenant ID for multi-tenant context */
  tenantId?: string;
  /** Session TTL in seconds (default: 7 days) */
  ttl?: number;
  /** User agent string */
  userAgent?: string;
  /** Client IP address */
  ipAddress?: string;
  /** Custom session data */
  data?: Record<string, unknown>;
}

/**
 * Collection for managing Session objects
 */
export class SessionCollection extends SmrtCollection<Session> {
  static readonly _itemClass = Session;

  /**
   * Create a new session with a secure ID
   */
  async createSession(options: CreateSessionOptions): Promise<Session> {
    const ttl = options.ttl ?? DEFAULT_SESSION_TTL;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const session = await this.create({
      id: generateSessionId(),
      userId: options.userId,
      tenantId: options.tenantId ?? null,
      status: SessionStatus.ACTIVE,
      expiresAt,
      userAgent: options.userAgent ?? '',
      ipAddress: options.ipAddress ?? '',
      lastAccessedAt: new Date(),
      data: options.data ?? {},
    });

    await session.save();
    return session;
  }

  /**
   * Find a valid session by ID
   * Returns null if session doesn't exist, is expired, or is revoked
   */
  async findValidSession(sessionId: string): Promise<Session | null> {
    const session = await this.get(sessionId);
    if (!session) return null;

    // Check if session is still valid
    if (!session.isValid()) {
      // If expired but still marked active, flip the status with an atomic
      // guarded UPDATE rather than a read-then-save(). A non-atomic save()
      // rewrites the whole row and could clobber a concurrent revoke/extend on
      // a lock-less backend; the WHERE clause makes the EXPIRED transition a
      // no-op once another writer has already changed the status or expiry.
      if (session.isExpired() && session.status === SessionStatus.ACTIVE) {
        const now = new Date().toISOString();
        await this.db.query(
          `UPDATE ${this.tableName}
           SET status = ?, updated_at = ?
           WHERE id = ? AND status = ? AND expires_at < ?`,
          SessionStatus.EXPIRED,
          now,
          sessionId,
          SessionStatus.ACTIVE,
          now,
        );
      }
      return null;
    }

    return session;
  }

  /**
   * Update last accessed time and optionally extend session
   */
  async touch(
    sessionId: string,
    extendTtl: boolean = false,
    ttl: number = DEFAULT_SESSION_TTL,
  ): Promise<boolean> {
    const session = await this.findValidSession(sessionId);
    if (!session) return false;

    session.touch();
    if (extendTtl) {
      session.extend(ttl);
    }
    await session.save();
    return true;
  }

  /**
   * Find all active sessions for a user
   */
  async findByUser(userId: string): Promise<Session[]> {
    const results = await this.list({
      where: {
        userId,
        status: SessionStatus.ACTIVE,
      },
      orderBy: 'last_accessed_at DESC',
    });

    // Filter out expired sessions
    return results.filter((session) => session.isValid());
  }

  /**
   * Delete all sessions for a user (logout from all devices)
   */
  async deleteUserSessions(userId: string): Promise<number> {
    const sessions = await this.list({
      where: { userId },
    });

    let count = 0;
    for (const session of sessions) {
      await session.delete();
      count++;
    }

    return count;
  }

  /**
   * Revoke all sessions for a user (soft delete)
   */
  async revokeUserSessions(userId: string): Promise<number> {
    const sessions = await this.list({
      where: {
        userId,
        status: SessionStatus.ACTIVE,
      },
    });

    let count = 0;
    for (const session of sessions) {
      session.revoke();
      await session.save();
      count++;
    }

    return count;
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(sessionId: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;

    session.revoke();
    await session.save();
    return true;
  }

  /**
   * Delete expired sessions (cleanup job)
   * Returns the number of deleted sessions
   */
  async deleteExpired(): Promise<number> {
    // #1400: a single atomic DELETE. The previous two-pass version listed
    // expired-by-time and revoked sessions separately, so a session that was
    // both got delete()'d twice — the second delete could throw and abort the
    // cleanup job mid-run, leaving expired sessions un-reaped. One statement
    // also avoids hydrating every row just to delete it.
    const now = new Date().toISOString();
    const { rowCount } = await this.db.query(
      `DELETE FROM ${this.tableName}
       WHERE expires_at < ? OR status = ?`,
      now,
      SessionStatus.REVOKED,
    );

    return rowCount ?? 0;
  }

  /**
   * Count active sessions for a user
   */
  async countUserSessions(userId: string): Promise<number> {
    const sessions = await this.findByUser(userId);
    return sessions.length;
  }

  /**
   * Update tenant context for a session (low-level primitive).
   *
   * SECURITY (#1400): this does NOT verify that the session's user is a member
   * of `tenantId` — it is the unguarded storage primitive. Application/route
   * code must go through {@link SessionService.switchTenant}, which fail-closes
   * on a missing/inactive membership before calling this. Calling it directly
   * with an untrusted `tenantId` reintroduces the cross-tenant access bug.
   */
  async setSessionTenant(
    sessionId: string,
    tenantId: string | null,
  ): Promise<boolean> {
    const session = await this.findValidSession(sessionId);
    if (!session) return false;

    session.setTenant(tenantId);
    await session.save();
    return true;
  }

  /**
   * Set custom session data
   */
  async setSessionData(
    sessionId: string,
    key: string,
    value: unknown,
  ): Promise<boolean> {
    const session = await this.findValidSession(sessionId);
    if (!session) return false;

    session.setData(key, value);
    await session.save();
    return true;
  }

  /**
   * Get custom session data
   */
  async getSessionData<T>(
    sessionId: string,
    key: string,
  ): Promise<T | undefined> {
    const session = await this.findValidSession(sessionId);
    if (!session) return undefined;

    return session.getData<T>(key);
  }
}
