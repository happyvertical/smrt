/**
 * User model - authenticated identity linked to a Profile
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { normalizeIdentityEmail } from '@happyvertical/smrt-profiles';
import type { User as UserContract } from '@happyvertical/smrt-types';
import { UserStatus } from '../types/index.js';

/**
 * Constructor options for {@link User}.
 */
export interface UserOptions extends SmrtObjectOptions {
  profileId?: string;
  email?: string;
  username?: string | null;
  status?: UserStatus;
  lastLoginAt?: Date | null;
  principalKind?: UserPrincipalKind | null;
  servicePrincipalTenantId?: string | null;
  servicePrincipalKey?: string | null;
  retiredAt?: Date | null;
}

/**
 * Kind of principal a User row is. `null` (every existing row) is a person.
 * `service` is a non-login service principal (#5245): no sign-in, magic-link,
 * invitation, OAuth, mobile or session path can ever resolve it as a session.
 */
export type UserPrincipalKind = 'service';

/** {@link User.principalKind} of a non-login service principal (#5245). */
export const SERVICE_PRINCIPAL_KIND: UserPrincipalKind = 'service';

/**
 * Refusal raised when a service principal (#5245) is asked to do something it
 * never may: hold a session, be reactivated after retirement, or carry a
 * login identifier. Expected and safe to surface as a 400/403.
 */
export class ServicePrincipalError extends Error {
  readonly status: 400 | 403 | 409;
  constructor(message: string, status: 400 | 403 | 409 = 403) {
    super(message);
    this.name = 'ServicePrincipalError';
    this.status = status;
  }
}

/**
 * Basic email validation regex.
 * Validates format: local@domain.tld
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * Validate email format.
 * @param email - Email address to validate
 * @returns true if email format is valid
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Normalize email address (lowercase and trim).
 * @param email - Email address to normalize
 * @returns Normalized email
 */
export function normalizeEmail(email: string): string {
  if (!email || typeof email !== 'string') return '';
  return email.trim() ? normalizeIdentityEmail(email) : '';
}

/** Normalize a username into its globally unique login identity. */
export function normalizeUsername(username: string | null | undefined): string {
  if (typeof username !== 'string') return '';
  const normalized = username.normalize('NFKC').trim().toLowerCase();
  return USERNAME_REGEX.test(normalized) ? normalized : '';
}

/**
 * User represents an authenticated identity in the system.
 *
 * Users are linked to Profiles from smrt-profiles via profileId.
 * A User can have multiple Memberships across different Tenants.
 *
 * @example
 * ```typescript
 * const user = await users.create({
 *   profileId: 'profile-uuid',
 *   email: 'user@example.com',
 *   status: UserStatus.ACTIVE
 * });
 * await user.save();
 * ```
 */
@smrt({
  // #1400: read-only generated surface — User is auth identity (email/status/
  // profileId), provisioned via OIDC/magic-link, not arbitrary authed POST/PUT.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  // #3742: CLI mirrors the read-only surface; `cli` without `include` is full CRUD.
  cli: { include: ['list', 'get'] },
  // #5245: one service principal per (tenant, caller key). NULLs are distinct,
  // so every person row (all three columns null) is unaffected.
  indexes: [
    {
      name: 'users_service_principal_tenant_key',
      columns: ['servicePrincipalTenantId', 'servicePrincipalKey'],
      unique: true,
    },
  ],
})
export class User extends SmrtObject implements UserContract {
  /**
   * Foreign key to smrt-profiles Profile (cross-package)
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { unique: true })
  @field({ description: 'The personal profile linked to this account.' })
  profileId: string = '';

  /**
   * User's email address (unique, used for lookup).
   *
   * Indexed: `findByEmail()` filters on this raw column directly (#2364,
   * epic #2382 finding A3). Distinct from `emailKey`'s unique index below —
   * `emailKey` is a separately normalized column (`normalizeIdentityEmail()`)
   * that arbitrates cross-connection uniqueness, and its index does not serve
   * a read path that filters on `email` itself.
   */
  @field({
    description: 'The email address used for this account.',
    indexed: true,
  })
  email: string = '';

  /** Durable normalized key for cross-connection email uniqueness. */
  @field({
    description:
      'The standardized email address used to recognize this account; maintained automatically.',
    type: 'text',
    nullable: true,
    unique: true,
    readonly: true,
  })
  emailKey: string | null = null;

  /** Optional globally unique username login identity. */
  @field({
    description:
      'Optional username used to sign in; lowercase and globally unique.',
    type: 'text',
    nullable: true,
    indexed: true,
  })
  username: string | null = null;

  /** Durable canonical username key used for cross-connection uniqueness. */
  @field({
    description:
      'The standardized username used to recognize this account; maintained automatically.',
    type: 'text',
    nullable: true,
    unique: true,
    readonly: true,
  })
  usernameKey: string | null = null;

  /**
   * User account status
   */
  @field({
    description:
      'Whether this account is active, inactive, pending, or suspended.',
    type: 'text',
  })
  status: UserStatus = UserStatus.ACTIVE;

  /**
   * Last login timestamp
   */
  @field({ description: 'When this person most recently signed in.' })
  lastLoginAt: Date | null = null;

  /**
   * `null` for a person (the default; every existing row). `service` marks a
   * non-login service principal (#5245) created only through
   * `ServicePrincipalService`; sessions are refused for it at mint and at
   * every resolution.
   */
  @field({
    description:
      'Empty for a person; "service" for an automated account that can never sign in.',
    type: 'text',
    nullable: true,
    readonly: true,
  })
  principalKind: UserPrincipalKind | null = null;

  /** The only tenant a service principal is valid in (#5245); null for a person. */
  @field({
    description:
      'For an automated account, the organization it belongs to; empty for a person.',
    sqlType: 'UUID',
    nullable: true,
    readonly: true,
  })
  servicePrincipalTenantId: string | null = null;

  /** Caller-supplied idempotency key, unique within the tenant (#5245). */
  @field({
    description:
      'For an automated account, the key its creator gave it; empty for a person.',
    type: 'text',
    nullable: true,
    readonly: true,
  })
  servicePrincipalKey: string | null = null;

  /**
   * When a service principal was permanently retired (#5245). Once set, the
   * row can never be saved active or pending again.
   */
  @field({
    description:
      'When this automated account was permanently retired; empty while in use.',
    nullable: true,
    readonly: true,
  })
  retiredAt: Date | null = null;

  constructor(options: UserOptions = {}) {
    super(options);
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.email !== undefined) this.email = normalizeEmail(options.email);
    if (options.username !== undefined)
      this.username = normalizeUsername(options.username) || null;
    if (options.status !== undefined) this.status = options.status;
    if (options.lastLoginAt !== undefined)
      this.lastLoginAt = options.lastLoginAt;
    if (options.principalKind !== undefined)
      this.principalKind = options.principalKind;
    if (options.servicePrincipalTenantId !== undefined)
      this.servicePrincipalTenantId = options.servicePrincipalTenantId;
    if (options.servicePrincipalKey !== undefined)
      this.servicePrincipalKey = options.servicePrincipalKey;
    if (options.retiredAt !== undefined) this.retiredAt = options.retiredAt;
  }

  /**
   * `principalKind`/`retiredAt` as last read from or written to the
   * database (#5245). A loaded service principal can never be saved back as
   * a person, and a retirement can never be cleared, whatever the caller
   * does to the in-memory fields.
   */
  #storedPrincipalKind: UserPrincipalKind | null = null;
  #storedRetiredAt: Date | null = null;

  override async initialize(): Promise<this> {
    await super.initialize();
    // Collections mark a hydrated row persisted before initialize(), so this
    // snapshots the authoritative stored values.
    if (this.isPersisted) this.#rememberStoredPrincipal();
    return this;
  }

  override async loadDataFromDb(data: Record<string, unknown>) {
    const result = await super.loadDataFromDb(data);
    this.#rememberStoredPrincipal();
    return result;
  }

  #rememberStoredPrincipal(): void {
    this.#storedPrincipalKind = this.principalKind ?? null;
    this.#storedRetiredAt = this.retiredAt ?? null;
  }

  /** True for a non-login service principal (#5245); never holds a session. */
  isServicePrincipal(): boolean {
    return isServicePrincipalKind(this.principalKind);
  }

  /**
   * Whether this row may ever hold a session: only a person
   * (`principalKind` null). Any other kind, known or not, fails closed.
   */
  canHoldSession(): boolean {
    return this.principalKind == null;
  }

  /**
   * Validate the user's email format.
   * @returns true if email is valid
   */
  hasValidEmail(): boolean {
    return isValidEmail(this.email);
  }

  /**
   * Check if user is active
   */
  isActive(): boolean {
    return this.status === UserStatus.ACTIVE;
  }

  /**
   * Check if user is suspended
   */
  isSuspended(): boolean {
    return this.status === UserStatus.SUSPENDED;
  }

  /**
   * Check if user is pending verification
   */
  isPending(): boolean {
    return this.status === UserStatus.PENDING;
  }

  /**
   * Record a login event
   */
  recordLogin(): void {
    this.lastLoginAt = new Date();
  }

  /** Keep the durable email key derived from the public email field. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (
      this.#storedPrincipalKind != null &&
      this.principalKind !== this.#storedPrincipalKind
    )
      throw new ServicePrincipalError(
        'A service principal can never become another kind of principal',
      );
    if (this.#storedRetiredAt != null && this.retiredAt == null)
      throw new ServicePrincipalError(
        'A retired service principal cannot be reactivated',
      );
    this.assertServicePrincipalInvariants();
    this.email = normalizeEmail(this.email);
    this.emailKey = this.email || null;
    this.username = normalizeUsername(this.username) || null;
    this.usernameKey = this.username;
    const saved = await super.save(options);
    this.#rememberStoredPrincipal();
    return saved;
  }

  /**
   * Service principal invariants (#5245), enforced on every ORM save: it has
   * no login identifier (no email or username can address it), it is bound to
   * a tenant and key, and once retired it can never be active or pending
   * again. A person row (`principalKind` null) must not carry service fields.
   */
  private assertServicePrincipalInvariants(): void {
    if (this.principalKind != null && !this.isServicePrincipal())
      throw new ServicePrincipalError('Unknown principal kind', 400);
    if (!this.isServicePrincipal()) {
      if (
        this.servicePrincipalTenantId != null ||
        this.servicePrincipalKey != null ||
        this.retiredAt != null
      )
        throw new ServicePrincipalError(
          'Only a service principal carries service principal fields',
          400,
        );
      return;
    }
    if (normalizeEmail(this.email) || normalizeUsername(this.username))
      throw new ServicePrincipalError(
        'A service principal has no email or username',
        400,
      );
    if (!this.servicePrincipalTenantId || !this.servicePrincipalKey)
      throw new ServicePrincipalError(
        'A service principal is bound to a tenant and key',
        400,
      );
    if (
      this.retiredAt != null &&
      (this.status === UserStatus.ACTIVE || this.status === UserStatus.PENDING)
    )
      throw new ServicePrincipalError(
        'A retired service principal cannot be reactivated',
      );
  }
}

/** True when a stored `principal_kind` value marks a service principal. */
export function isServicePrincipalKind(value: unknown): boolean {
  return value === SERVICE_PRINCIPAL_KIND;
}
