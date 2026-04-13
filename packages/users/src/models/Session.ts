/**
 * Session model - Server-side session management for authenticated users
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { SessionStatus } from '../types/index.js';

/**
 * Default session TTL: 7 days in seconds
 */
export const DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60;

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
  // Sessions should not be exposed via public API for security
  api: { include: ['get', 'delete'] },
  mcp: { include: [] },
  cli: true,
})
export class Session extends SmrtObject {
  /**
   * User who owns this session
   */
  userId: string = '';

  /**
   * Tenant context for this session (for multi-tenant apps)
   * Null means no tenant context selected
   */
  tenantId: string | null = null;

  /**
   * Session status
   */
  @field({ type: 'text' })
  status: SessionStatus = SessionStatus.ACTIVE;

  /**
   * Session expiration time
   */
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

  constructor(options: any = {}) {
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
  }

  /**
   * Check if the session is currently valid (active and not expired)
   */
  isValid(): boolean {
    return this.status === SessionStatus.ACTIVE && new Date() < this.expiresAt;
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
    this.expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    this.touch();
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
