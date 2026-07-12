/**
 * CommissionCollection — collection manager for {@link Commission}.
 *
 * "Unsettled" throughout means `payoutId` is empty — the row has not been
 * gathered into a {@link CommissionPayout} batch yet. The emptiness check is
 * applied in memory (`!c.payoutId`) rather than as a `WHERE payout_id = ''`
 * filter so the semantics hold whether an adapter stores the empty
 * reference as `''` or `NULL`.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Commission } from '../models/Commission.js';
import type { CommissionStatus } from '../types.js';

export class CommissionCollection extends SmrtCollection<Commission> {
  static readonly _itemClass = Commission;

  /** All commissions for an earner, newest first. */
  async findByEarner(earnerId: string): Promise<Commission[]> {
    return await this.list({
      where: { earnerId },
      orderBy: 'created_at DESC',
    });
  }

  /** All commissions derived from one earning event. */
  async findByEvent(earningEventId: string): Promise<Commission[]> {
    return await this.list({
      where: { earningEventId },
      orderBy: 'created_at DESC',
    });
  }

  /** Commissions by lifecycle status, newest first. */
  async findByStatus(status: CommissionStatus): Promise<Commission[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** Look up a commission by its idempotency natural key. */
  async findByDedupeKey(dedupeKey: string): Promise<Commission | null> {
    if (!dedupeKey) return null;
    const results = await this.list({ where: { dedupeKey }, limit: 1 });
    return results[0] ?? null;
  }

  /**
   * Payable commissions for an earner+currency that no payout batch has
   * settled yet — the rows `CommissionPayoutService.createPayoutBatch`
   * gathers.
   *
   * Pass `scope` to narrow the gather to one earning source (e.g. a single
   * ad network): only commissions whose `(sourceKind, sourceId)` match are
   * returned. This lets a caller cut a payout batch that claims *only* its
   * network's commissions, so concurrent per-network batches settle
   * disjoint sets instead of one sweeping the other's rows.
   */
  async findPayableUnsettled(
    earnerId: string,
    currency: string,
    scope?: { sourceKind: string; sourceId: string },
  ): Promise<Commission[]> {
    const where: Record<string, unknown> = {
      earnerId,
      currency,
      status: 'payable',
    };
    if (scope) {
      where.sourceKind = scope.sourceKind;
      where.sourceId = scope.sourceId;
    }
    const payable = await this.list({ where, orderBy: 'created_at ASC' });
    return payable.filter((c) => !c.payoutId);
  }

  /** Σ amountCents of {@link findPayableUnsettled} rows (integer cents). */
  async sumPayableByEarner(
    earnerId: string,
    currency: string,
  ): Promise<number> {
    const payable = await this.findPayableUnsettled(earnerId, currency);
    return payable.reduce((sum, c) => sum + c.amountCents, 0);
  }

  /** Commissions settled by one payout batch. */
  async findByPayout(payoutId: string): Promise<Commission[]> {
    return await this.list({
      where: { payoutId },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Atomically claim rows for a payout batch. Each row is stamped with
   * `payoutId` through a single guarded `UPDATE ... WHERE id = ? AND
   * (payout_id IS NULL OR payout_id = '') AND status = 'payable'` — a
   * row-level compare-and-set: the database serializes concurrent writers,
   * so if two batches race for the same row exactly one UPDATE matches and
   * the other stamps zero rows. Ownership is then confirmed by a re-read, so
   * a lost race never counts toward the caller's totals. A row already owned
   * by THIS payout (idempotent retry / repair) doesn't re-match the UPDATE
   * but is still returned via the re-read; a row owned by a DIFFERENT payout
   * is skipped.
   *
   * This is the single place claim semantics live. Because the stamp is
   * atomic, a commission can never be claimed into two payouts even when
   * batch scopes overlap or run concurrently. The raw UPDATE deliberately
   * bypasses the model save hooks (status-transition / dedupe guards,
   * tenancy interceptor): it mutates only `payout_id` on a row already
   * resolved in-scope by the caller's gather, so those guards have nothing
   * to add.
   *
   * Returns the claimed rows (freshly loaded, `payoutId` verified).
   */
  async claimForPayout(
    commissionIds: string[],
    payoutId: string,
  ): Promise<Commission[]> {
    const claimed: Commission[] = [];
    for (const id of commissionIds) {
      if (!id) continue;
      await this.db
        .execute`UPDATE commissions SET payout_id = ${payoutId} WHERE id = ${id} AND (payout_id IS NULL OR payout_id = '') AND status = 'payable'`;
      const verified = await this.get({ id });
      if (verified && verified.payoutId === payoutId) {
        claimed.push(verified);
      }
    }
    return claimed;
  }
}

export default CommissionCollection;
