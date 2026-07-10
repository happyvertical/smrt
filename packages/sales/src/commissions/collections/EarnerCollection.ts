/**
 * EarnerCollection — collection manager for {@link Earner}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Earner } from '../models/Earner.js';
import type { EarnerStatus } from '../types.js';

export class EarnerCollection extends SmrtCollection<Earner> {
  static readonly _itemClass = Earner;

  /** Earners linked to a smrt-profiles Profile. */
  async findByProfile(profileId: string): Promise<Earner[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'created_at DESC',
    });
  }

  /** Earners by status. */
  async findByStatus(status: EarnerStatus): Promise<Earner[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** All active earners. */
  async findActive(): Promise<Earner[]> {
    return await this.findByStatus('active');
  }
}

export default EarnerCollection;
