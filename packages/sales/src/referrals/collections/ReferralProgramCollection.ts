/**
 * ReferralProgramCollection — collection manager for {@link ReferralProgram}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ReferralProgram } from '../models/ReferralProgram.js';
import type { ReferralProgramStatus } from '../types.js';

export class ReferralProgramCollection extends SmrtCollection<ReferralProgram> {
  static readonly _itemClass = ReferralProgram;

  /**
   * Look up a program by its natural key within the ambient tenant scope
   * (`(tenant_id, key)` is the conflict key, so under a tenant context the
   * auto-filter narrows this to at most one row).
   */
  async findByKey(key: string): Promise<ReferralProgram | null> {
    const results = await this.list({ where: { key }, limit: 1 });
    return results[0] ?? null;
  }

  /** Programs by status. */
  async findByStatus(
    status: ReferralProgramStatus,
  ): Promise<ReferralProgram[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** All active programs. */
  async findActive(): Promise<ReferralProgram[]> {
    return await this.findByStatus('active');
  }
}

export default ReferralProgramCollection;
