/**
 * ReferralTermSnapshotCollection — collection manager for
 * {@link ReferralTermSnapshot}.
 *
 * Snapshots are immutable history: this collection only creates and reads.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ReferralTermSnapshot } from '../models/ReferralTermSnapshot.js';

export class ReferralTermSnapshotCollection extends SmrtCollection<ReferralTermSnapshot> {
  static readonly _itemClass = ReferralTermSnapshot;

  /**
   * Every snapshot minted for one referral, newest first — index 0 is the
   * currently governing snapshot only if the referral's `snapshotId` says
   * so (requalification keeps old rows as history).
   */
  async findByReferral(referralId: string): Promise<ReferralTermSnapshot[]> {
    return await this.list({
      where: { referralId },
      orderBy: 'created_at DESC',
    });
  }
}

export default ReferralTermSnapshotCollection;
