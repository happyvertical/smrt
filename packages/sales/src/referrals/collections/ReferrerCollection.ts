/**
 * ReferrerCollection — collection manager for {@link Referrer}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Referrer } from '../models/Referrer.js';
import type { ReferrerStatus } from '../types.js';

export class ReferrerCollection extends SmrtCollection<Referrer> {
  static readonly _itemClass = Referrer;

  /**
   * Find referrer roles held by a given profile (a profile may hold the
   * role in several tenants/contexts).
   */
  async findByProfile(profileId: string): Promise<Referrer[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'created_at DESC',
    });
  }

  /** Referrers by status. */
  async findByStatus(status: ReferrerStatus): Promise<Referrer[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** All active referrers (eligible for new links/agreements). */
  async findActive(): Promise<Referrer[]> {
    return await this.findByStatus('active');
  }
}

export default ReferrerCollection;
