/**
 * SessionService - Higher-level session management combining sessions with user/permission loading
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import {
  type CreateSessionOptions,
  SessionCollection,
} from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { Membership } from '../models/Membership.js';
import { DEFAULT_SESSION_TTL, type Session } from '../models/Session.js';
import type { User } from '../models/User.js';
import { PermissionResolver } from './PermissionResolver.js';

/**
 * Session context with user and permissions
 */
export interface SessionContext {
  /** The User record */
  user: User;
  /** Active membership for the current tenant, if one was resolved */
  membership?: Membership | null;
  /** Resolved permission slugs */
  permissions: string[];
  /** Tenant ID from session (if any) */
  tenantId: string | null;
  /** Session ID */
  sessionId: string;
}

/**
 * Result of {@link SessionService.switchTenant}.
 *
 * A successful switch into a non-null tenant ROTATES the session id (#1354
 * follow-up): a brand-new {@link Session} is minted and the old one is revoked,
 * so a captured pre-switch id stops validating. Callers MUST persist `sessionId`
 * (e.g. re-set the session cookie) after a rotation.
 */
export interface SwitchTenantResult {
  /** Whether the switch succeeded (true also for a `null` clear). */
  switched: boolean;
  /**
   * The session id to use going forward: the NEW id after a rotation, the
   * unchanged id after a `null` clear, or `null` when the switch failed
   * (unknown session or non-member — fail-closed).
   */
  sessionId: string | null;
  /** The resulting session (new on rotation; existing on clear; null on failure). */
  session: Session | null;
  /** True only when a fresh session id was minted (non-null tenant switch). */
  rotated: boolean;
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
  private membershipCollection!: MembershipCollection;
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
    this.sessionCollection = await SessionCollection.create(this.options);
    this.userCollection = await UserCollection.create(this.options);
    this.membershipCollection =
      await MembershipCollection.create(this.options);
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
    let membership: Membership | null = null;
    if (session.tenantId) {
      const resolvedMembership =
        await this.membershipCollection.findByUserAndTenant(
          session.userId,
          session.tenantId,
        );
      membership = resolvedMembership?.isActive() ? resolvedMembership : null;

      const result = await this.permissionResolver.resolvePermissions(
        session.userId,
        session.tenantId,
        { membership },
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
      membership,
      permissions,
      tenantId: session.tenantId,
      sessionId: session.id as string,
    };
  }

  /**
   * Get the initialized database connection backing this session service.
   */
  getDatabase() {
    return this.sessionCollection.db;
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
   * Switch tenant context for a session.
   *
   * A session's `tenantId` is the tenant-isolation key for every `@TenantScoped`
   * query, so it must never be set to a tenant the session's user is not an
   * active member of — otherwise a caller could read/write another tenant's data
   * by feeding an arbitrary id here (e.g. straight from untrusted form data).
   *
   * Fail-closed (#1400): the user's ACTIVE membership in the target tenant is
   * verified BEFORE any write. A non-member switch returns
   * `{ switched: false, ... }` and mutates nothing.
   *
   * Session-id ROTATION (#1354 follow-up): a successful switch into a non-null
   * tenant mints a BRAND-NEW session (fresh secure id, fresh TTL) for the same
   * user with the new tenant, then REVOKES the old session — so any captured
   * pre-switch session id immediately stops validating, shrinking the blast
   * radius of a leaked id across a privilege/tenant boundary. The device context
   * (user agent, IP, custom data) carries over to the new session. Callers MUST
   * persist the returned `sessionId` (e.g. re-set the cookie).
   *
   * Passing `null` clears the tenant context, is always allowed, and stays
   * in-place (no rotation — there is no privilege boundary being crossed).
   *
   * @returns A {@link SwitchTenantResult}; check `switched` for success.
   */
  async switchTenant(
    sessionId: string,
    tenantId: string | null,
  ): Promise<SwitchTenantResult> {
    const failClosed: SwitchTenantResult = {
      switched: false,
      sessionId: null,
      session: null,
      rotated: false,
    };

    const session = await this.sessionCollection.findValidSession(sessionId);
    if (!session) return failClosed;

    // Clearing the tenant context crosses no privilege boundary, so keep the
    // existing session in place (no rotation needed).
    if (tenantId === null) {
      const ok = await this.sessionCollection.setSessionTenant(sessionId, null);
      if (!ok) return failClosed;
      const updated = await this.sessionCollection.findValidSession(sessionId);
      return {
        switched: true,
        sessionId,
        session: updated,
        rotated: false,
      };
    }

    // Fail-closed membership check BEFORE any write.
    const membership = await this.membershipCollection.findByUserAndTenant(
      session.userId,
      tenantId,
    );
    if (!membership || !membership.isActive()) {
      return failClosed;
    }

    // Rotate FAIL-CLOSED: revoke the old session FIRST, then mint the fresh one.
    // If the second write fails the caller ends up needing to re-auth (the old
    // id is already invalid) rather than retaining a still-valid stale-tenant
    // session — so a captured pre-switch id provably stops validating before we
    // ever report success.
    await this.sessionCollection.revokeSession(sessionId);
    const rotated = await this.sessionCollection.createSession({
      userId: session.userId,
      tenantId,
      ttl: this.defaultTTL,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      data: session.data,
    });

    return {
      switched: true,
      sessionId: rotated.id as string,
      session: rotated,
      rotated: true,
    };
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
