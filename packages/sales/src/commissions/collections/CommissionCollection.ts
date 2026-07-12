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
   * Conditionally claim rows for a payout batch: each row is re-loaded
   * fresh and stamped with `payoutId` only when it is still payable and
   * unclaimed (or already claimed by THIS payout — the idempotent-retry /
   * repair case). Rows claimed by a DIFFERENT payout are skipped, and every
   * claim is verified by a post-save re-read so a lost race never counts
   * toward the caller's totals.
   *
   * Reads and writes go through the model layer (`get` / `save`), so this
   * respects the tenancy interceptor (a cross-tenant id resolves to `null`
   * and is skipped, never mutated) and the DB dialect (an empty FK is `''`
   * on SQLite / `NULL` on the native-`uuid` Postgres/DuckDB columns — the
   * model normalizes both).
   *
   * This is the single place claim semantics live. It narrows the
   * concurrent-batch window to the re-read granularity but is NOT a
   * cross-row transaction — safe concurrent settlement relies on batches
   * using DISJOINT scopes (see `CommissionPayoutService.createPayoutBatch`);
   * overlapping concurrent scopes must be serialized by the caller.
   *
   * Returns the claimed rows (freshly loaded, `payoutId` verified).
   */
  async claimForPayout(
    commissionIds: string[],
    payoutId: string,
  ): Promise<Commission[]> {
    const claimed: Commission[] = [];
    for (const id of commissionIds) {
      const row = await this.get({ id });
      if (!row) continue;
      if (row.payoutId && row.payoutId !== payoutId) continue; // other batch
      if (!row.payoutId) {
        if (!row.isPayable()) continue; // no longer eligible
        row.payoutId = payoutId;
        await row.save();
      }
      const verified = await this.get({ id });
      if (verified && verified.payoutId === payoutId) {
        claimed.push(verified);
      }
    }
    return claimed;
  }
}

export default CommissionCollection;
