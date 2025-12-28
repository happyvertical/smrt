/**
 * UserCollection - Collection manager for User objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { User } from '../models/User.js';
import { UserStatus } from '../types/index.js';

/**
 * Collection for managing User objects
 */
export class UserCollection extends SmrtCollection<User> {
  static readonly _itemClass = User;

  /**
   * Find user by email address
   */
  async findByEmail(email: string): Promise<User | null> {
    const results = await this.list({
      where: { email },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find user by profile ID
   */
  async findByProfile(profileId: string): Promise<User | null> {
    const results = await this.list({
      where: { profileId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find users by status
   */
  async findByStatus(status: UserStatus): Promise<User[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active users
   */
  async findActive(): Promise<User[]> {
    return await this.findByStatus(UserStatus.ACTIVE);
  }

  /**
   * Find all pending users
   */
  async findPending(): Promise<User[]> {
    return await this.findByStatus(UserStatus.PENDING);
  }

  /**
   * Get or create user for a profile
   */
  async getOrCreateForProfile(
    profileId: string,
    email: string,
    defaults: Partial<{ status: UserStatus }> = {},
  ): Promise<User> {
    const existing = await this.findByProfile(profileId);
    if (existing) {
      return existing;
    }

    const user = await this.create({
      profileId,
      email,
      status: defaults.status ?? UserStatus.ACTIVE,
    });
    await user.save();
    return user;
  }
}
