/**
 * CommissionPayoutCollection — collection manager for
 * {@link CommissionPayout}.
 * @packageDocumentation
 */

import {
  type AuditContext,
  SmrtCollection,
  type SmrtCreateInput,
} from '@happyvertical/smrt-core';
import { CommissionPayout } from '../models/CommissionPayout.js';
import { findByReplayKey, resolveReplayOwner } from '../replay-owner.js';
import type { CommissionPayoutStatus } from '../types.js';

export class CommissionPayoutCollection extends SmrtCollection<CommissionPayout> {
  static readonly _itemClass = CommissionPayout;

  /** Persist the first routing snapshot atomically; a duplicate key must not upsert it. */
  override async create(
    options: SmrtCreateInput<CommissionPayout>,
    context?: Partial<AuditContext>,
  ): Promise<CommissionPayout> {
    return super.create({ ...options, _insertOnly: true }, context);
  }

  /** All payout batches for an earner, newest first. */
  async findByEarner(earnerId: string): Promise<CommissionPayout[]> {
    return await this.list({
      where: { earnerId },
      orderBy: 'created_at DESC',
    });
  }

  /** Payout batches by status, newest first. */
  async findByStatus(
    status: CommissionPayoutStatus,
  ): Promise<CommissionPayout[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Look up a payout by its idempotency natural key within one owner
   * (#3305 D1): `options.tenantId` (the earner's tenant, for background
   * settlement), else the active context; neither → global payouts only.
   */
  async findByIdempotencyKey(
    idempotencyKey: string,
    options: { tenantId?: string | null } = {},
  ): Promise<CommissionPayout | null> {
    if (!idempotencyKey) return null;
    const owner = resolveReplayOwner(
      options.tenantId,
      'CommissionPayoutCollection.findByIdempotencyKey',
    );
    return findByReplayKey(this, 'idempotency_key', idempotencyKey, owner);
  }

  /**
   * One page of payouts carrying the derived single-source stamp for
   * `(sourceKind, sourceId)`, newest first with a deterministic id
   * tiebreak. This is the RAW indexed page — stamped rows only, membership
   * unverified. Consumers want
   * `CommissionPayoutService.getSourcePayoutHistory`, which re-verifies
   * each page's membership and fails closed on rows the stamp alone cannot
   * prove.
   */
  async findBySource(
    sourceKind: string,
    sourceId: string,
    page: { limit: number; offset: number },
  ): Promise<CommissionPayout[]> {
    if (!sourceKind || !sourceId) return [];
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: ['created_at DESC', 'id DESC'],
      limit: page.limit,
      offset: page.offset,
    });
  }

  /**
   * Σ totalAmountCents of COMPLETED payouts for an earner+currency —
   * lifetime settled earnings (integer cents).
   */
  async sumPaidByEarner(earnerId: string, currency: string): Promise<number> {
    const completed = await this.list({
      where: { earnerId, currency, status: 'completed' },
    });
    return completed.reduce((sum, p) => sum + p.totalAmountCents, 0);
  }
}

export default CommissionPayoutCollection;
