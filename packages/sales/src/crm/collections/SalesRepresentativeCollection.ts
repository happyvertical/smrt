/**
 * SalesRepresentativeCollection — collection manager for SalesRepresentative.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { SalesRepresentative } from '../models/SalesRepresentative.js';

export class SalesRepresentativeCollection extends SmrtCollection<SalesRepresentative> {
  static readonly _itemClass = SalesRepresentative;

  /**
   * Find rep roles held by a given profile (a profile may hold the role in
   * several tenants/contexts).
   *
   * @param profileId - smrt-profiles Profile id
   * @returns Reps for that profile, newest first
   */
  async findByProfile(profileId: string): Promise<SalesRepresentative[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active reps (eligible for new lead/opportunity assignment).
   */
  async findActive(): Promise<SalesRepresentative[]> {
    return await this.list({
      where: { status: 'active' },
      orderBy: 'created_at DESC',
    });
  }
}

export default SalesRepresentativeCollection;
