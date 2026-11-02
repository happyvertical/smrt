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

  constructor(options: UserOptions = {}) {
    super(options);
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.email !== undefined) this.email = normalizeEmail(options.email);
    if (options.username !== undefined)
      this.username = normalizeUsername(options.username) || null;
    if (options.status !== undefined) this.status = options.status;
    if (options.lastLoginAt !== undefined)
      this.lastLoginAt = options.lastLoginAt;
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
    this.email = normalizeEmail(this.email);
    this.emailKey = this.email || null;
    this.username = normalizeUsername(this.username) || null;
    this.usernameKey = this.username;
    return super.save(options);
  }
}
