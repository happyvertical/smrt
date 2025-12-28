/**
 * User model - authenticated identity linked to a Profile
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { UserStatus } from '../types/index.js';

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
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class User extends SmrtObject {
  /**
   * Foreign key to smrt-profiles Profile
   * Cross-package reference stored as plain string
   */
  profileId: string = '';

  /**
   * User's email address (unique, used for lookup)
   */
  email: string = '';

  /**
   * User account status
   */
  status: UserStatus = UserStatus.ACTIVE;

  /**
   * Last login timestamp
   */
  lastLoginAt: Date | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.email !== undefined) this.email = options.email;
    if (options.status !== undefined) this.status = options.status;
    if (options.lastLoginAt !== undefined)
      this.lastLoginAt = options.lastLoginAt;
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
