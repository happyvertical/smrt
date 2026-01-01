/**
 * SessionService - Higher-level session management combining sessions with user/permission loading
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  type CreateSessionOptions,
  SessionCollection,
} from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { DEFAULT_SESSION_TTL } from '../models/Session.js';
import type { User } from '../models/User.js';
import { PermissionResolver } from './PermissionResolver.js';

/**
 * Session context with user and permissions
 */
export interface SessionContext {
  /** The User record */
  user: User;
  /** Resolved permission slugs */
  permissions: string[];
  /** Tenant ID from session (if any) */
  tenantId: string | null;
  /** Session ID */
  sessionId: string;
}

/**
 * Options for SessionService
 */
export interface SessionServiceOptions extends SmrtClassOptions {
  /** Default session TTL in seconds (default: 7 days) */
  defaultTTL?: number;
  /** Cookie name (default: 'sid') */
  cookieName?: string;
  /** Whether to auto-extend sessions on access (default: false) */
  autoExtend?: boolean;
}

/**
 * SessionService provides high-level session management that combines
 * session storage with user and permission loading.
 *
 * This is the main service to use for session-based authentication.
 *
 * @example
 * ```typescript
 * const sessionService = await SessionService.create({
 *   db: { type: 'sqlite', url: 'app.db' },
 *   defaultTTL: 7 * 24 * 60 * 60, // 7 days
 * });
 *
 * // Create session after login
 * const sessionId = await sessionService.createSession(userId, tenantId);
 *
 * // Load session context on each request
 * const context = await sessionService.loadSessionContext(sessionId);
 * if (context) {
 *   console.log('User:', context.user.email);
 *   console.log('Permissions:', context.permissions);
 * }
 *
 * // Destroy session on logout
 * await sessionService.destroySession(sessionId);
 * ```
 */
export class SessionService {
  private options: SessionServiceOptions;
  private sessionCollection!: SessionCollection;
  private userCollection!: UserCollection;
  private permissionResolver!: PermissionResolver;
  private defaultTTL: number;
  private autoExtend: boolean;

  constructor(options: SessionServiceOptions) {
    this.options = options;
    this.defaultTTL = options.defaultTTL ?? DEFAULT_SESSION_TTL;
    this.autoExtend = options.autoExtend ?? false;
  }

  /**
   * Initialize collections
   */
  async initialize(): Promise<void> {
    this.sessionCollection = await (SessionCollection as any).create(
      this.options,
    );
    this.userCollection = await (UserCollection as any).create(this.options);
    this.permissionResolver = await PermissionResolver.create(this.options);
  }

  /**
   * Create a new session for a user
   *
   * @param userId - The user ID
   * @param tenantId - Optional tenant context
   * @param options - Additional session options
   * @returns The session ID
   */
  async createSession(
    userId: string,
    tenantId?: string,
    options?: Partial<CreateSessionOptions>,
  ): Promise<string> {
    const session = await this.sessionCollection.createSession({
      userId,
      tenantId,
      ttl: options?.ttl ?? this.defaultTTL,
      userAgent: options?.userAgent,
      ipAddress: options?.ipAddress,
      data: options?.data,
    });

    return session.id as string;
  }

  /**
   * Load full session context (user + permissions)
   *
   * Returns null if session is invalid or user doesn't exist
   */
  async loadSessionContext(sessionId: string): Promise<SessionContext | null> {
    // Find valid session
    const session = await this.sessionCollection.findValidSession(sessionId);
    if (!session) return null;

    // Load user
    const user = await this.userCollection.get(session.userId);
    if (!user || !user.isActive()) return null;

    // Resolve permissions (only if tenant context exists)
    let permissions: string[] = [];
    if (session.tenantId) {
      const result = await this.permissionResolver.resolvePermissions(
        session.userId,
        session.tenantId,
      );
      permissions = Array.from(result.permissions);
    }

    // Touch session (and optionally extend)
    if (this.autoExtend) {
      session.extend(this.defaultTTL);
    } else {
      session.touch();
    }
    await session.save();

    return {
      user,
      permissions,
      tenantId: session.tenantId,
      sessionId: session.id as string,
    };
  }

  /**
   * Refresh session (extend expiry, update lastAccessed)
   */
  async refreshSession(sessionId: string): Promise<boolean> {
    return this.sessionCollection.touch(sessionId, true, this.defaultTTL);
  }

  /**
   * Destroy a session (revoke it)
   */
  async destroySession(sessionId: string): Promise<boolean> {
    return this.sessionCollection.revokeSession(sessionId);
  }

  /**
   * Destroy all sessions for a user (logout from all devices)
   */
  async destroyAllUserSessions(userId: string): Promise<number> {
    return this.sessionCollection.revokeUserSessions(userId);
  }

  /**
   * Switch tenant context for a session
   */
  async switchTenant(
    sessionId: string,
    tenantId: string | null,
  ): Promise<boolean> {
    return this.sessionCollection.setSessionTenant(sessionId, tenantId);
  }

  /**
   * Get all active sessions for a user (for "manage sessions" UI)
   */
  async getUserSessions(userId: string) {
    return this.sessionCollection.findByUser(userId);
  }

  /**
   * Clean up expired sessions (run periodically)
   */
  async cleanupExpiredSessions(): Promise<number> {
    return this.sessionCollection.deleteExpired();
  }

  /**
   * Check if a permission is granted for the session
   */
  async hasPermission(sessionId: string, permission: string): Promise<boolean> {
    const context = await this.loadSessionContext(sessionId);
    if (!context) return false;
    return context.permissions.includes(permission);
  }

  /**
   * Get session data
   */
  async getSessionData<T>(
    sessionId: string,
    key: string,
  ): Promise<T | undefined> {
    return this.sessionCollection.getSessionData<T>(sessionId, key);
  }

  /**
   * Set session data
   */
  async setSessionData(
    sessionId: string,
    key: string,
    value: unknown,
  ): Promise<boolean> {
    return this.sessionCollection.setSessionData(sessionId, key, value);
  }

  /**
   * Static factory method
   */
  static async create(options: SessionServiceOptions): Promise<SessionService> {
    const service = new SessionService(options);
    await service.initialize();
    return service;
  }
}
