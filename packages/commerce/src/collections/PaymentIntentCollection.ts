/**
 * PaymentIntentCollection — collection manager for {@link PaymentIntent}.
 *
 * Adds helpers for the common query shapes (find by idempotency key,
 * find still-open intents, find by licensee email, find expired) and a
 * `getOrCreateByIdempotencyKey` helper that callers use to implement
 * safe at-least-once retries from the marketplace's PaymentIntent
 * issuance handler.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { PaymentIntent } from '../models/PaymentIntent.js';
import { PaymentIntentStatus, type PaymentOption } from '../types/index.js';

export interface PaymentIntentIdempotencyArgs {
  /** Caller-supplied scope (Sku id / tier id / etc.) */
  offeringRef: string;
  /** Buyer email — second factor of the natural key */
  licenseeEmail: string;
  /** Caller-supplied idempotency key */
  idempotencyKey: string;
  /** Optional tenant scope, when called outside an active tenant context */
  tenantId?: string | null;
}

export interface PaymentIntentSeed
  extends Partial<Omit<PaymentIntentIdempotencyArgs, 'tenantId'>> {
  tenantId?: string | null;
  skuId?: string;
  customerId?: string;
  paymentOptions: PaymentOption[];
  usdPriceLocked: number;
  priceLockWindowMs?: number;
}

export class PaymentIntentCollection extends SmrtCollection<PaymentIntent> {
  static readonly _itemClass = PaymentIntent;

  /**
   * Look up an existing intent by its natural key. Returns `null` when
   * any of the three components are empty — empty natural-key inputs
   * disable dedup by design, so a `null` return tells the caller to
   * fall through to a fresh `create`.
   */
  async findByIdempotencyKey(
    args: PaymentIntentIdempotencyArgs,
  ): Promise<PaymentIntent | null> {
    if (!args.offeringRef || !args.licenseeEmail || !args.idempotencyKey) {
      return null;
    }
    const where: Record<string, unknown> = {
      offeringRef: args.offeringRef,
      licenseeEmail: args.licenseeEmail,
      idempotencyKey: args.idempotencyKey,
    };
    if (args.tenantId !== undefined) {
      where.tenantId = args.tenantId;
    }
    const results = await this.list({ where, limit: 1 });
    return results[0] ?? null;
  }

  /**
   * Idempotency-aware create. If an intent already exists with the
   * same `(tenantId, offeringRef, licenseeEmail, idempotencyKey)`
   * tuple, returns the existing row. Otherwise creates a new one
   * with the supplied seed.
   *
   * Returns a `{ intent, created }` pair so callers can branch on
   * whether they're handling a fresh quote or a replay (e.g. to
   * skip a duplicate "intent created" webhook emission).
   */
  async getOrCreateByIdempotencyKey(
    seed: PaymentIntentSeed,
  ): Promise<{ intent: PaymentIntent; created: boolean }> {
    const existing = await this.findByIdempotencyKey({
      offeringRef: seed.offeringRef ?? '',
      licenseeEmail: seed.licenseeEmail ?? '',
      idempotencyKey: seed.idempotencyKey ?? '',
      tenantId: seed.tenantId,
    });
    if (existing) {
      return { intent: existing, created: false };
    }
    return { intent: await this.create(seed as any), created: true };
  }

  /**
   * Open intents — `AWAITING_PAYMENT` and not yet past the price-
   * lock window. The price-lock check is `Date.now()`-based, so a
   * stale-but-not-yet-marked-EXPIRED row drops out of this list even
   * before a cleanup job advances its status.
   */
  async findOpen(): Promise<PaymentIntent[]> {
    const open = await this.list({
      where: { status: PaymentIntentStatus.AWAITING_PAYMENT },
      orderBy: 'created_at DESC',
    });
    const now = Date.now();
    return open.filter((p) => {
      if (!p.priceLockExpiresAt) return true;
      return p.priceLockExpiresAt.getTime() > now;
    });
  }

  /**
   * `AWAITING_PAYMENT` intents whose price-lock window has already
   * passed. The expected use is a periodic cleanup job that loads
   * this list, calls `intent.expire(); await intent.save()` on each,
   * and emits whatever downstream signal the application needs.
   */
  async findStale(): Promise<PaymentIntent[]> {
    const open = await this.list({
      where: { status: PaymentIntentStatus.AWAITING_PAYMENT },
    });
    const now = Date.now();
    return open.filter((p) => {
      if (!p.priceLockExpiresAt) return false;
      return p.priceLockExpiresAt.getTime() <= now;
    });
  }

  async findByLicenseeEmail(email: string): Promise<PaymentIntent[]> {
    return this.list({
      where: { licenseeEmail: email },
      orderBy: 'created_at DESC',
    });
  }

  async findByOfferingRef(offeringRef: string): Promise<PaymentIntent[]> {
    return this.list({
      where: { offeringRef },
      orderBy: 'created_at DESC',
    });
  }

  async findByStatus(status: PaymentIntentStatus): Promise<PaymentIntent[]> {
    return this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  async findByTenant(tenantId: string): Promise<PaymentIntent[]> {
    return this.list({ where: { tenantId } });
  }

  async findGlobal(): Promise<PaymentIntent[]> {
    return this.list({ where: { tenantId: null } });
  }

  async findWithGlobals(tenantId: string): Promise<PaymentIntent[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
