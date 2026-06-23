/**
 * PayoutCollection — collection manager for {@link Payout} rows.
 *
 * Adds helpers for the common operator-side query shapes: payouts for
 * a specific vendor, payouts derived from a specific source payment,
 * status-bucketed lookups for the operator dashboard, and a
 * `createFromPayment` convenience that wires up the source-payment
 * link in one call.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import type { Payment } from '../models/Payment.js';
import { Payout } from '../models/Payout.js';
import { PayoutStatus } from '../types/index.js';

export interface CreatePayoutFromPaymentArgs {
  /** Source Payment row */
  payment: Payment;
  /** Destination vendor id */
  vendorId: string;
  /** Operator fee in the payment's native currency */
  operatorFee: number;
  /** Backend that will send the payout — defaults to the payment's */
  backendId?: string;
  /** Optional initial notes */
  notes?: string;
}

export class PayoutCollection extends SmrtCollection<Payout> {
  static readonly _itemClass = Payout;

  /**
   * Build a `PENDING` payout linked to a source payment. The gross
   * defaults to the payment's `nativeAmount` (falling back to
   * `amount` if no backend rail was recorded), the currency defaults
   * to the payment's `nativeCurrency` (falling back to `currency`),
   * and `supplierNet` is computed as `gross - operatorFee`.
   *
   * The returned instance is initialized but not persisted. The caller
   * is still responsible for `await payout.save()` — keeping create /
   * save as separate steps lets callers stitch the payout into an
   * application-level transaction.
   */
  async createFromPayment(args: CreatePayoutFromPaymentArgs): Promise<Payout> {
    const { payment, vendorId, operatorFee } = args;
    const grossAmount = payment.nativeAmount || payment.amount || 0;
    const currency = payment.nativeCurrency || payment.currency || '';
    const backendId = args.backendId ?? payment.backendId ?? '';
    const payout = new Payout({
      ai: this.options.ai,
      db: this.db,
      _skipLoad: true,
      // Inherit the source payment's tenant. Payout is @TenantScoped, so when
      // this runs outside an active tenant context (e.g. a background payout
      // job iterating Payment rows), the interceptor's auto-populate can't
      // stamp a tenant — without carrying it explicitly the remittance would
      // save as global/null and drop out of tenant-filtered payout queries.
      tenantId: payment.tenantId,
      paymentId: payment.id ?? '',
      vendorId,
      grossAmount,
      operatorFee,
      supplierNet: grossAmount - operatorFee,
      currency,
      backendId,
      status: PayoutStatus.PENDING,
      notes: args.notes ?? '',
    });
    await payout.initialize();
    return payout;
  }

  async findByPayment(paymentId: string): Promise<Payout[]> {
    return this.list({
      where: { paymentId },
      orderBy: 'created_at DESC',
    });
  }

  async findByVendor(vendorId: string): Promise<Payout[]> {
    return this.list({
      where: { vendorId },
      orderBy: 'created_at DESC',
    });
  }

  async findByStatus(status: PayoutStatus): Promise<Payout[]> {
    return this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  async findPending(): Promise<Payout[]> {
    return this.findByStatus(PayoutStatus.PENDING);
  }

  async findFailed(): Promise<Payout[]> {
    return this.findByStatus(PayoutStatus.FAILED);
  }

  async findByBackendTxRef(backendTxRef: string): Promise<Payout | null> {
    if (!backendTxRef) return null;
    const results = await this.list({
      where: { backendTxRef },
      limit: 1,
    });
    return results[0] ?? null;
  }

  /**
   * Total funds delivered to a vendor in confirmed payouts. Useful for
   * a vendor-balance widget on the operator dashboard.
   */
  async getConfirmedTotalForVendor(vendorId: string): Promise<number> {
    const confirmed = await this.list({
      where: { vendorId, status: PayoutStatus.CONFIRMED },
    });
    return confirmed.reduce((sum, p) => sum + p.supplierNet, 0);
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  async findByTenant(tenantId: string): Promise<Payout[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global payouts (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<Payout[]> {
    return queryGlobal<Payout>(this);
  }

  /**
   * Find payouts for a tenant including global payouts.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   */
  async findWithGlobals(tenantId: string): Promise<Payout[]> {
    return queryWithGlobals<Payout>(this, tenantId, 'Payout.findWithGlobals');
  }
}
