/**
 * CommissionAdjustment — append-only correction against a Commission.
 *
 * Earned/paid Commissions are NEVER rewritten. A refund, credit,
 * chargeback, dispute outcome, or manual correction appends one of these
 * rows instead. `amountCents` is SIGNED — negative amounts claw earnings
 * back; positive amounts credit extra.
 *
 * Immutability contract: once persisted, an adjustment's substance
 * (`commissionId`, `earnerId`, `adjustmentKind`, `amountCents`, `currency`,
 * `reason`, `createdByProfileId`, `metadata`, `tenantId`) is frozen — the
 * save-time guard rejects any change via a WeakMap snapshot compare (the
 * commerce LicenseSale pattern). The ONLY post-create mutation allowed is
 * stamping/clearing `payoutId` when a settlement batch picks the row up.
 * A wrong adjustment is corrected by appending a counter-adjustment.
 *
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  CommissionAdjustmentKind,
  CommissionAdjustmentOptions,
} from '../types.js';

/**
 * Module-scoped record of the frozen-fields snapshot each persisted
 * adjustment was loaded with (or first saved as). WeakMap keeps it out of
 * the schema and GCs with the instance — commerce LicenseSale pattern.
 */
const frozenAdjustmentSnapshot = new WeakMap<CommissionAdjustment, string>();

@TenantScoped({ mode: 'optional' })
@smrt({
  // Append-only audit rows: create/list/get only — no generated update or
  // delete on any surface.
  api: { include: ['create', 'list', 'get'] },
  mcp: { include: ['list', 'create'] },
  cli: false,
})
export class CommissionAdjustment extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global rows). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The {@link Commission} this adjustment corrects. Required. */
  @foreignKey('Commission', { required: true })
  commissionId: string = '';

  /**
   * The {@link Earner} the adjustment applies to — denormalized from the
   * parent commission so balance queries never need a join. Required.
   */
  @foreignKey('Earner', { required: true })
  earnerId: string = '';

  /** What kind of correction this is. */
  adjustmentKind: CommissionAdjustmentKind = 'correction';

  /**
   * SIGNED amount in integer cents. Negative claws earnings back (refund,
   * chargeback); positive credits extra.
   */
  amountCents: number = 0;

  /** ISO 4217 currency — must match the parent commission's. */
  currency: string = 'USD';

  /** Human-readable justification. Required — audit rows explain themselves. */
  @field({ required: true })
  reason: string = '';

  /**
   * Profile of the operator/automation that created the adjustment
   * (cross-package string reference to smrt-profiles).
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  createdByProfileId: string = '';

  /**
   * The {@link CommissionPayout} batch that settled this adjustment. Empty
   * until stamped. This is the ONLY field mutable after creation.
   */
  @foreignKey('CommissionPayout')
  payoutId: string | null = null;

  /** Additional metadata as a JSON string. Frozen once persisted. */
  metadata: string = '{}';

  constructor(options: CommissionAdjustmentOptions = {}) {
    super(options);
    if ('operationId' in (options as unknown as Record<string, unknown>)) {
      throw new Error(
        'CommissionAdjustment has no public operationId field; use ' +
          'CommissionAdjustmentService.createAdjustment()',
      );
    }
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.commissionId !== undefined)
      this.commissionId = options.commissionId;
    if (options.earnerId !== undefined) this.earnerId = options.earnerId;
    if (options.adjustmentKind !== undefined)
      this.adjustmentKind = options.adjustmentKind;
    if (options.amountCents !== undefined)
      this.amountCents = options.amountCents;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.createdByProfileId !== undefined)
      this.createdByProfileId = options.createdByProfileId;
    if (options.payoutId !== undefined) this.payoutId = options.payoutId;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Capture the frozen-fields snapshot when the row was loaded from the
   * database — from that moment on, only {@link payoutId} may change.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      frozenAdjustmentSnapshot.set(this, this.serializeFrozenSnapshot());
    }
    return this;
  }

  /** `true` once a payout batch has stamped {@link payoutId}. */
  isSettled(): boolean {
    return !!this.payoutId;
  }

  /** Parse {@link metadata}; returns `{}` on empty/invalid JSON. */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      const parsed = JSON.parse(this.metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Serialize and store {@link metadata}. */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data ?? {});
  }

  /**
   * Save with the append-only guard: once the row has been persisted, every
   * field except `payoutId` must match the captured snapshot. Corrections
   * to a wrong adjustment are new counter-adjustments, never edits.
   */
  override async save(): Promise<this> {
    this.assertImmutableOncePersisted();
    const result = (await super.save()) as this;
    if (!frozenAdjustmentSnapshot.has(this)) {
      frozenAdjustmentSnapshot.set(this, this.serializeFrozenSnapshot());
    }
    return result;
  }

  private assertImmutableOncePersisted(): void {
    const captured = frozenAdjustmentSnapshot.get(this);
    if (!captured) return; // brand-new row — first save captures below
    const current = this.serializeFrozenSnapshot();
    if (captured !== current) {
      throw new Error(
        `CommissionAdjustment ${this.id ?? '<new>'}: adjustments are ` +
          'append-only — only payoutId may change after creation. Append a ' +
          'counter-adjustment instead of editing this one.',
      );
    }
  }

  /**
   * Serialize every field EXCEPT `payoutId` (the sole post-create mutable
   * field) with stable key ordering.
   */
  private serializeFrozenSnapshot(): string {
    return JSON.stringify({
      tenantId: this.tenantId,
      commissionId: this.commissionId,
      earnerId: this.earnerId,
      adjustmentKind: this.adjustmentKind,
      amountCents: this.amountCents,
      currency: this.currency,
      reason: this.reason,
      createdByProfileId: this.createdByProfileId,
      metadata: this.metadata,
    });
  }
}

export default CommissionAdjustment;
