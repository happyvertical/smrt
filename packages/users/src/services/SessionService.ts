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
import {
  DEFAULT_SESSION_TTL,
  type Session,
  type SessionAuthMethod,
} from '../models/Session.js';
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
  /**
   * Membership provenance used to authorize the tenant context. An inherited
   * source is present only when the resolver selected an ACTIVE ancestor
   * membership whose role explicitly inherits to descendants.
   */
  tenantAuthorization?: {
    membershipId: string | null;
    inheritedFromTenantId: string | null;
  } | null;
  /** Tenant ID from session (if any) */
  tenantId: string | null;
  /** Session ID */
  sessionId: string;
  /**
   * How the session was established (#2944). Null for sessions minted
   * before the column existed or by hosts that do not set it. Hosts gate on
   * this — "enrolled tablets cannot enumerate other tablets" — instead of
   * smuggling channel markers through permission lists.
   *
   * Optional so contexts built by older hosts and test doubles still type
   * check; `loadSessionContext` always sets it.
   */
  authMethod?: SessionAuthMethod | null;
  /**
   * The session this one is layered on (#3276): for a per-person PIN
   * session, the enrolled device's bearer session and the device account it
   * belongs to. Null for first-class sessions; always set by
   * `loadSessionContext`.
   */
  parent?: SessionParentContext | null;
  /**
   * The ceiling `permissions` was intersected with (#3276), snapshotted into
   * the session at mint — e.g. the device policy a PIN session was signed in
   * under. Null or absent when the session has no ceiling. A session with a
   * ceiling never receives super-admin bypass or system context.
   */
  permissionCeiling?: string[] | null;
}

/**
 * Identity of the session a layered session rides on. Server-side only:
 * `sessionId` is the parent's bearer credential, so never serialize this
 * object to a client — `userId` is the non-secret device identity.
 */
export interface SessionParentContext {
  sessionId: string;
  userId: string;
  tenantId: string | null;
  authMethod: SessionAuthMethod | null;
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
    this.membershipCollection = await MembershipCollection.create(this.options);
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
      authMethod: options?.authMethod,
      parentSessionId: options?.parentSessionId,
    });

    return session.id as string;
  }

  /**
   * Load full session context (user + permissions)
   *
   * Returns null if session is invalid or user doesn't exist
   */
  async loadSessionContext(sessionId: string): Promise<SessionContext | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const session = await this.sessionCollection.findValidSession(sessionId);
      if (!session) return null;

      // Reject a principal that is already inactive before persisting activity.
      // Otherwise a suspended user's probe can keep extending an otherwise
      // valid session indefinitely even though no context is returned.
      const initialUser = await this.userCollection.get(session.userId);
      if (!initialUser?.isActive()) return null;

      // A layered session is valid only while the session it rides on is
      // (#3276). Un-enrolling a device, or revoking its bearer, therefore
      // signs out every person on it without any cascade bookkeeping. Checked
      // before activity is persisted so an orphaned child cannot be kept
      // alive by probing it, mirroring the inactive-user rule above.
      let parent: SessionParentContext | null = null;
      if (session.isLayered()) {
        const parentSession = await this.sessionCollection.findValidSession(
          session.parentSessionId as string,
        );
        if (!parentSession) return null;
        // A child never acts outside its parent's tenant, however it was
        // minted. A cleared (null) tenant context is narrower, so allowed.
        if (
          session.tenantId !== null &&
          session.tenantId !== parentSession.tenantId
        ) {
          return null;
        }
        const parentUser = await this.userCollection.get(parentSession.userId);
        if (!parentUser?.isActive()) return null;
        parent = {
          sessionId: parentSession.id as string,
          userId: parentSession.userId,
          tenantId: parentSession.tenantId,
          authMethod: parentSession.authMethod,
        };
      }

      // Activity persistence can conflict-reload the instance. Establish the
      // authorization snapshot only after that reload has converged.
      if (!(await session.recordActivity(this.autoExtend, this.defaultTTL))) {
        return null;
      }
      const userId = session.userId;
      const tenantId = session.tenantId;

      const user = await this.userCollection.get(userId);
      if (!user?.isActive()) return null;

      let permissions: string[] = [];
      let membership: Membership | null = null;
      let tenantAuthorization: SessionContext['tenantAuthorization'] = null;
      if (tenantId) {
        const resolvedMembership =
          await this.membershipCollection.findByUserAndTenant(userId, tenantId);
        membership = resolvedMembership?.isActive() ? resolvedMembership : null;

        // Pass the RAW row: an inactive direct membership pins resolution to
        // the empty set, while a missing row (null) lets the resolver apply
        // opt-in ancestor-membership inheritance (`Role.inheritsToDescendants`).
        const result = await this.permissionResolver.resolvePermissions(
          userId,
          tenantId,
          { membership: resolvedMembership },
        );
        permissions = Array.from(result.permissions);
        tenantAuthorization = {
          membershipId: result.membershipId,
          inheritedFromTenantId: result.inheritedFromTenantId,
        };
      }

      // A ceiling snapshotted into the session at mint (#3276) caps whatever
      // the person's own membership resolves to; it can only remove slugs.
      const permissionCeiling = session.getPermissionCeiling();
      if (permissionCeiling) {
        const allowed = new Set(permissionCeiling);
        permissions = permissions.filter((slug) => allowed.has(slug));
      }

      // Bind identity, tenant and permissions to one authoritative session
      // state. Routine activity may advance the revision without invalidating
      // this snapshot; security-bearing field changes require reconstruction.
      const current = await this.sessionCollection.findValidSession(sessionId);
      if (!current) return null;
      if (current.userId !== userId || current.tenantId !== tenantId) continue;

      return {
        user,
        membership,
        permissions,
        tenantAuthorization,
        tenantId,
        sessionId: session.id as string,
        authMethod: session.authMethod,
        parent,
        permissionCeiling,
      };
    }
    return null;
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
    const revoked = await this.sessionCollection.revokeSession(sessionId);
    if (revoked) {
      // Children are already invalid (liveness rule); mark them so session
      // listings and audits agree with what the user experiences.
      await this.sessionCollection.revokeChildren(sessionId).catch(() => 0);
    }
    return revoked;
  }

  /**
   * The parent session id of a live layered session, or null. Records no
   * activity: for callers that must vet the parent before the child is
   * accepted and its idle expiry extended.
   */
  async getParentSessionId(sessionId: string): Promise<string | null> {
    const session = await this.sessionCollection.findValidSession(sessionId);
    return session?.isLayered() ? session.parentSessionId : null;
  }

  /**
   * Revoke the active sessions layered on `parentSessionId`, optionally
   * sparing one — the hand-over on a single-occupant device (#3276).
   */
  async destroyChildSessions(
    parentSessionId: string,
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
    return this.sessionCollection.revokeChildren(parentSessionId, options);
  }

  /**
   * Revoke a user's sessions established through one auth method — e.g.
   * every PIN session after an administrator resets that user's PIN.
   */
  async destroyUserSessionsByAuthMethod(
    userId: string,
    authMethod: SessionAuthMethod,
  ): Promise<number> {
    return this.sessionCollection.revokeUserSessionsByAuthMethod(
      userId,
      authMethod,
    );
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

    // A layered session (#3276) inherits its tenant scope from the session
    // it rides on and may never widen it: a person signed in by PIN on a
    // tenant's tablet stays inside that tenant.
    if (session.isLayered()) {
      const parentSession = await this.sessionCollection.findValidSession(
        session.parentSessionId as string,
      );
      if (!parentSession || parentSession.tenantId !== tenantId) {
        return failClosed;
      }
    }

    // Fail-closed membership check BEFORE any write.
    const membership = await this.membershipCollection.findByUserAndTenant(
      session.userId,
      tenantId,
    );
    if (!membership?.isActive()) {
      return failClosed;
    }

    // Rotate FAIL-CLOSED: revoke the old session FIRST, then mint the fresh one.
    // If the second write fails the caller ends up needing to re-auth (the old
    // id is already invalid) rather than retaining a still-valid stale-tenant
    // session — so a captured pre-switch id provably stops validating before we
    // ever report success.
    await this.sessionCollection.revokeSession(sessionId);
    // Anything layered on the old id is already invalid; mark it so listings
    // agree (a device switching tenant signs its people out).
    await this.sessionCollection.revokeChildren(sessionId).catch(() => 0);
    const rotated = await this.sessionCollection.createSession({
      userId: session.userId,
      tenantId,
      ttl: session.getIdleSeconds() ?? this.defaultTTL,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      data: session.data,
      authMethod: session.authMethod,
      parentSessionId: session.parentSessionId,
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
