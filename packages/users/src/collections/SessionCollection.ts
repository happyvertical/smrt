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
      // If expired but still marked active, update status
      if (session.isExpired() && session.status === SessionStatus.ACTIVE) {
        session.status = SessionStatus.EXPIRED;
        await session.save();
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
    // Get all expired or revoked sessions
    const now = new Date();
    const sessions = await this.list({
      where: {
        'expiresAt <': now.toISOString(),
      },
    });

    let count = 0;
    for (const session of sessions) {
      await session.delete();
      count++;
    }

    // Also delete revoked sessions that are old
    const revokedSessions = await this.list({
      where: {
        status: SessionStatus.REVOKED,
      },
    });

    for (const session of revokedSessions) {
      await session.delete();
      count++;
    }

    return count;
  }

  /**
   * Count active sessions for a user
   */
  async countUserSessions(userId: string): Promise<number> {
    const sessions = await this.findByUser(userId);
    return sessions.length;
  }

  /**
   * Update tenant context for a session
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
