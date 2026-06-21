/**
 * User model - authenticated identity linked to a Profile
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { UserStatus } from '../types/index.js';

/**
 * Basic email validation regex.
 * Validates format: local@domain.tld
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  return email.trim().toLowerCase();
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
  cli: true,
})
export class User extends SmrtObject {
  /**
   * Foreign key to smrt-profiles Profile (cross-package)
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId: string = '';

  /**
   * User's email address (unique, used for lookup)
   */
  email: string = '';

  /**
   * User account status
   */
  @field({ type: 'text' })
  status: UserStatus = UserStatus.ACTIVE;

  /**
   * Last login timestamp
   */
  lastLoginAt: Date | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.email !== undefined) this.email = normalizeEmail(options.email);
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
}
