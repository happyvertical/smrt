/**
 * Session model - Server-side session management for authenticated users
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { SessionStatus } from '../types/index.js';

/**
 * Constructor options for {@link Session}.
 */
export interface SessionOptions extends SmrtObjectOptions {
  userId?: string;
  tenantId?: string | null;
  status?: SessionStatus;
  /** Accepts a Date or any value the Date constructor can coerce. */
  expiresAt?: Date | string | number;
  userAgent?: string;
  ipAddress?: string;
  /** Accepts a Date or any value the Date constructor can coerce. */
  lastAccessedAt?: Date | string | number;
  data?: Record<string, unknown>;
  authMethod?: SessionAuthMethod | null;
  parentSessionId?: string | null;
}

/**
 * How a session was established. Server-set at mint time, never trusted from
 * the client. Hosts may use any string for their own flows; these are the
 * values this package mints.
 */
export type SessionAuthMethod =
  | 'oidc'
  | 'magic-link'
  | 'terminal'
  | 'mobile'
  | 'pin'
  | (string & {});

/**
 * Default session TTL: 7 days in seconds
 */
export const DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60;

/**
 * Reserved {@link Session.data} keys this package writes at mint time and
 * enforces on every load (#3276). Server-set only: never copy client input
 * into them, and do not overwrite them through `setSessionData`.
 */
export const SESSION_DATA_KEYS = {
  /** `string[]` of permission slugs the session's resolved set is intersected with. */
  permissionCeiling: 'permissionCeiling',
  /** ISO timestamp after which the session is invalid whatever its activity. */
  absoluteExpiresAt: 'absoluteExpiresAt',
  /** Sliding idle timeout in seconds, applied on every recorded activity. */
  idleSeconds: 'idleSeconds',
} as const;

/**
 * Expiry for a session minted or extended now: `ttlSeconds` ahead, bounded by
 * an absolute cap in `data` (an unreadable cap fails closed as already past).
 */
export function resolveSessionExpiry(
  ttlSeconds: number,
  data: Record<string, unknown> | undefined,
): Date {
  const next = Date.now() + ttlSeconds * 1000;
  const raw = data?.[SESSION_DATA_KEYS.absoluteExpiresAt];
  if (raw === undefined || raw === null) return new Date(next);
  const cap =
    typeof raw === 'string' || typeof raw === 'number'
      ? new Date(raw).getTime()
      : Number.NaN;
  return new Date(Number.isNaN(cap) ? 0 : Math.min(next, cap));
}

/**
 * Generate a cryptographically secure session ID
 */
export function generateSessionId(): string {
  // Use crypto.randomUUID for secure, unique session IDs
  return crypto.randomUUID();
}

/**
 * Session represents an authenticated user session.
 *
 * Sessions are stored server-side and linked to users.
 * A session ID is stored in a cookie and used to look up the session.
 *
 * @example
 * ```typescript
 * const session = await sessions.create({
 *   userId: user.id,
 *   tenantId: tenant.id,
 *   expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 *   userAgent: request.headers.get('user-agent'),
 *   ipAddress: getClientAddress(event)
 * });
 * await session.save();
 * ```
 */
@smrt({
  // The row id IS the bearer credential (the `sid` cookie value, and the
  // terminal-auth `accessToken`), so the change feed must never record or
  // serve it — see smrt-core's `change-feed-sensitivity` (#2937).
  sensitive: true,
  // Sessions should not be exposed via public API for security
  api: { include: ['get', 'delete'] },
  mcp: { include: [] },
  cli: { skipApiCheck: true },
})
export class Session extends SmrtObject {
  /**
   * User who owns this session
   */
  @foreignKey('User')
  userId: string = '';

  /**
   * Tenant context for this session (for multi-tenant apps)
   * Null means no tenant context selected
   */
  @foreignKey('Tenant', { nullable: true })
  tenantId: string | null = null;

  /**
   * Session status
   */
  @field({ type: 'text' })
  status: SessionStatus = SessionStatus.ACTIVE;

  /**
   * Session expiration time
   *
   * Indexed: `deleteExpired()` — and the retention sweep that now schedules it
   * (#2375) — scans this column on every pass.
   */
  @field({ type: 'datetime', indexed: true })
  expiresAt: Date = new Date();

  /**
   * User agent string from the browser
   */
  userAgent: string = '';

  /**
   * IP address of the client
   */
  ipAddress: string = '';

  /**
   * Last activity timestamp (updated on each request)
   */
  lastAccessedAt: Date = new Date();

  /**
   * Custom session data (JSON serializable)
   */
  data: Record<string, unknown> = {};

  /**
   * Authentication channel that established this session (#3276, #2944).
   * Null for sessions minted before this column existed or by hosts that do
   * not set it.
   */
  @field({ type: 'text', nullable: true })
  authMethod: SessionAuthMethod | null = null;

  /**
   * Session this one is layered on — the enrolled device's bearer session
   * under a per-person PIN session, for instance. A child is valid only while
   * its parent is, so revoking the device signs out everyone on it.
   *
   * A native UUID column where the engine has one, like every other session
   * id reference, but deliberately not a foreign key: a self-referencing FK would cascade
   * the retention sweep's parent deletes, and the liveness rule in
   * `SessionService.loadSessionContext` already makes an orphan invalid.
   *
   * Sensitive: the value IS the parent's (longer-lived) bearer credential,
   * so public serialization of a child must never reveal it — otherwise a
   * stolen person credential could be traded up for the device's.
   *
   * Indexed: `SessionCollection.findChildren()` and the sign-out cascade
   * query by this column.
   */
  @field({ sqlType: 'UUID', nullable: true, indexed: true, sensitive: true })
  parentSessionId: string | null = null;

  constructor(options: SessionOptions = {}) {
    super(options);
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.status !== undefined) this.status = options.status;
    if (options.expiresAt !== undefined) {
      this.expiresAt =
        options.expiresAt instanceof Date
          ? options.expiresAt
          : new Date(options.expiresAt);
    }
    if (options.userAgent !== undefined) this.userAgent = options.userAgent;
    if (options.ipAddress !== undefined) this.ipAddress = options.ipAddress;
    if (options.lastAccessedAt !== undefined) {
      this.lastAccessedAt =
        options.lastAccessedAt instanceof Date
          ? options.lastAccessedAt
          : new Date(options.lastAccessedAt);
    }
    if (options.data !== undefined) this.data = options.data;
    if (options.authMethod !== undefined) this.authMethod = options.authMethod;
    if (options.parentSessionId !== undefined) {
      this.parentSessionId = options.parentSessionId;
    }
  }

  /** True when this session is layered on another one. */
  isLayered(): boolean {
    return this.parentSessionId !== null && this.parentSessionId !== '';
  }

  /**
   * Absolute expiry cap (`data.absoluteExpiresAt`), or null when the session
   * has none. An unreadable value fails closed as "already passed".
   */
  getAbsoluteExpiry(): Date | null {
    const raw = this.data?.[SESSION_DATA_KEYS.absoluteExpiresAt];
    if (raw === undefined || raw === null) return null;
    const parsed =
      typeof raw === 'string' || typeof raw === 'number'
        ? new Date(raw)
        : new Date(Number.NaN);
    return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  }

  /**
   * Sliding idle timeout (`data.idleSeconds`), or null when the session uses
   * the resolving service's TTL policy.
   */
  getIdleSeconds(): number | null {
    const raw = this.data?.[SESSION_DATA_KEYS.idleSeconds];
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? raw
      : null;
  }

  /**
   * Permission ceiling (`data.permissionCeiling`), or null when the session
   * has none. A present but malformed value fails closed as an empty ceiling.
   */
  getPermissionCeiling(): string[] | null {
    const raw = this.data?.[SESSION_DATA_KEYS.permissionCeiling];
    if (raw === undefined || raw === null) return null;
    return Array.isArray(raw) && raw.every((slug) => typeof slug === 'string')
      ? (raw as string[])
      : [];
  }

  /**
   * Check if the session is currently valid (active, not expired, and not
   * past its absolute cap)
   */
  isValid(): boolean {
    const now = new Date();
    const cap = this.getAbsoluteExpiry();
    return (
      this.status === SessionStatus.ACTIVE &&
      now < this.expiresAt &&
      (cap === null || now < cap)
    );
  }

  /**
   * Check if the session has expired
   */
  isExpired(): boolean {
    return new Date() >= this.expiresAt;
  }

  /**
   * Check if the session was revoked
   */
  isRevoked(): boolean {
    return this.status === SessionStatus.REVOKED;
  }

  /**
   * Update the last accessed timestamp
   */
  touch(): void {
    this.lastAccessedAt = new Date();
  }

  /**
   * Extend the session expiration by the given TTL (in seconds)
   */
  extend(ttlSeconds: number = DEFAULT_SESSION_TTL): void {
    // Activity never pushes expiry past the absolute cap, so every expiry
    // consumer (validity, the EXPIRED transition, retention) honours it.
    this.expiresAt = resolveSessionExpiry(ttlSeconds, this.data);
    this.touch();
  }

  /** Persist routine session activity without failing concurrent requests. */
  async recordActivity(
    extendTtl = false,
    ttlSeconds: number = DEFAULT_SESSION_TTL,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0 && !(await this.reloadValidActivityState())) return false;
      // A session minted with its own idle timeout slides by that timeout
      // whichever service resolves it; the caller's TTL policy applies only
      // to sessions without one.
      const idleSeconds = this.getIdleSeconds();
      if (idleSeconds !== null) this.extend(idleSeconds);
      else if (extendTtl) this.extend(ttlSeconds);
      else this.touch();
      try {
        await this.save();
        return true;
      } catch (error) {
        const isRevisionConflict =
          error instanceof Error &&
          'code' in error &&
          error.code === 'RUNTIME_REVISION_CONFLICT';
        if (!isRevisionConflict) throw error;
        if (attempt === 3) return this.reloadValidActivityState();
      }
    }
    return false;
  }

  private async reloadValidActivityState(): Promise<boolean> {
    if (!this.id) return false;
    const current = await this.getCanonicalPersistedRow({ id: this.id });
    if (!current) return false;
    await this.loadDataFromDb(current);
    return this.isValid();
  }

  /**
   * Revoke the session
   */
  revoke(): void {
    this.status = SessionStatus.REVOKED;
  }

  /**
   * Set the tenant context for this session
   */
  setTenant(tenantId: string | null): void {
    this.tenantId = tenantId;
  }

  /**
   * Get or set custom session data
   */
  getData<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  /**
   * Set custom session data
   */
  setData(key: string, value: unknown): void {
    this.data[key] = value;
  }

  /**
   * Remove custom session data
   */
  removeData(key: string): void {
    delete this.data[key];
  }
}
