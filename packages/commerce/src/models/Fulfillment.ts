/**
 * Fulfillment model - tracks delivery of contract items
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type Address,
  FulfillmentStatus,
  FulfillmentType,
} from '../types/index.js';

/**
 * Legal status transitions for a Fulfillment, keyed by the prior persisted
 * status. A status re-saved unchanged (no-op) and a brand-new row are always
 * permitted; this map governs *changes* only.
 *
 * Forward order: PENDING → PROCESSING → SHIPPED → DELIVERED, but progress may
 * SKIP intermediate states — not every order has a PROCESSING step, so
 * PENDING → SHIPPED and PENDING/PROCESSING → DELIVERED are deliberately legal.
 * The map only forbids moving BACKWARD (e.g. SHIPPED → PENDING) and leaving a
 * terminal state. CANCELLED is reachable from any non-terminal state.
 * DELIVERED and CANCELLED are terminal. This guards against raw mass-assignment
 * (the open `api:{create,update}` surface, or a stale caller) forcing, e.g., a
 * DELIVERED shipment back to PENDING or a CANCELLED one back into SHIPPED.
 * Mirrors the Contract/Payment/Payout guards added in S5 audit #1390 —
 * Fulfillment was the one money/state model missed.
 */
const FULFILLMENT_STATUS_TRANSITIONS: Record<
  FulfillmentStatus,
  FulfillmentStatus[]
> = {
  [FulfillmentStatus.PENDING]: [
    FulfillmentStatus.PROCESSING,
    FulfillmentStatus.SHIPPED,
    FulfillmentStatus.DELIVERED,
    FulfillmentStatus.CANCELLED,
  ],
  [FulfillmentStatus.PROCESSING]: [
    FulfillmentStatus.SHIPPED,
    FulfillmentStatus.DELIVERED,
    FulfillmentStatus.CANCELLED,
  ],
  [FulfillmentStatus.SHIPPED]: [
    FulfillmentStatus.DELIVERED,
    FulfillmentStatus.CANCELLED,
  ],
  // Terminal states: no outbound transitions.
  [FulfillmentStatus.DELIVERED]: [],
  [FulfillmentStatus.CANCELLED]: [],
};

/**
 * Module-scoped record of the status each Fulfillment instance was loaded with,
 * for the save-time transition guard. A WeakMap keeps it out of the schema and
 * GCs with the instance — same pattern as the other commerce models.
 */
const loadedFulfillmentStatus = new WeakMap<Fulfillment, FulfillmentStatus>();

/**
 * Fulfillment tracks the delivery or completion of contract items.
 *
 * A contract can have multiple fulfillments (e.g., partial shipments).
 * Each fulfillment tracks what was delivered and when.
 *
 * @example
 * ```typescript
 * const fulfillment = await fulfillments.create({
 *   contractId: order.id,
 *   fulfillmentType: FulfillmentType.SHIPMENT,
 *   trackingNumber: 'UPS-123456789',
 *   carrier: 'UPS',
 *   shippingAddress: {
 *     street1: '123 Main St',
 *     city: 'Anytown',
 *     state: 'CA',
 *     postalCode: '90210',
 *     country: 'US'
 *   }
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Fulfillment extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global fulfillments
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Parent contract being fulfilled
   */
  @foreignKey('Contract')
  contractId: string = '';

  /**
   * Type of fulfillment
   */
  fulfillmentType: FulfillmentType = FulfillmentType.SHIPMENT;

  /**
   * Current fulfillment status
   */
  status: FulfillmentStatus = FulfillmentStatus.PENDING;

  /**
   * Tracking number from carrier
   */
  trackingNumber: string = '';

  /**
   * Shipping carrier name
   */
  carrier: string = '';

  /**
   * Shipping destination address
   */
  shippingAddress: Address = {};

  /**
   * When the shipment was sent
   */
  shippedAt: Date | null = null;

  /**
   * When the shipment was delivered
   */
  deliveredAt: Date | null = null;

  /**
   * Estimated delivery date
   */
  estimatedDelivery: Date | null = null;

  /**
   * Notes about this fulfillment
   */
  notes: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.contractId !== undefined) this.contractId = options.contractId;
    if (options.fulfillmentType !== undefined)
      this.fulfillmentType = options.fulfillmentType;
    if (options.status !== undefined) this.status = options.status;
    if (options.trackingNumber !== undefined)
      this.trackingNumber = options.trackingNumber;
    if (options.carrier !== undefined) this.carrier = options.carrier;
    if (options.shippingAddress !== undefined)
      this.shippingAddress = options.shippingAddress;
    if (options.shippedAt !== undefined) this.shippedAt = options.shippedAt;
    if (options.deliveredAt !== undefined)
      this.deliveredAt = options.deliveredAt;
    if (options.estimatedDelivery !== undefined)
      this.estimatedDelivery = options.estimatedDelivery;
    if (options.notes !== undefined) this.notes = options.notes;
  }

  /**
   * Capture the status the row was loaded with so the save-time transition
   * guard can reject illegal status flips made via raw field assignment
   * (mass-assignment on the generated update route, a stale caller, etc.).
   * Only persisted rows carry a prior status.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedFulfillmentStatus.set(this, this.status);
    }
    return this;
  }

  /**
   * Validate the status transition before persisting, then save. Blocks a
   * forged `status` written via raw mass-assignment on the open
   * `api:{create,update}` surface. See S5 audit #1390 follow-up.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    const result = (await super.save()) as this;
    loadedFulfillmentStatus.set(this, this.status);
    return result;
  }

  /**
   * Reject an illegal status flip done via raw assignment. No-op transitions
   * and brand-new rows are always allowed.
   */
  private assertStatusTransition(prior: FulfillmentStatus | undefined): void {
    if (prior === undefined) return; // new row — any starting status is fine
    if (prior === this.status) return; // no-op re-save
    const allowed = FULFILLMENT_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Fulfillment ${this.trackingNumber || this.id}: illegal status ` +
          `transition '${prior}' → '${this.status}'. Use the guarded helpers ` +
          '(markShipped / markDelivered / cancel).',
      );
    }
  }

  /**
   * Resolve the AUTHORITATIVE prior status. The WeakMap is only populated when
   * {@link initialize} loaded the row; it is empty for an instance built via
   * `collection.create({ id: <existing>, _skipLoad: true })` (the upsert path
   * that writes onto an existing row without hydrating it). Trusting an empty
   * WeakMap there would treat the write as a brand-new row and skip the guard.
   * So when this instance carries an `id`, read the persisted row straight from
   * the DB and treat its `status` as the prior. `undefined` = genuinely new.
   * Mirrors the authoritative-prior-load on Contract/Payment/Invoice/Payout.
   */
  private async resolvePriorStatus(): Promise<FulfillmentStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as FulfillmentStatus;
        }
      } catch {
        // DB not ready / table absent — fall through to the in-memory record.
      }
    }
    return loadedFulfillmentStatus.get(this);
  }

  /**
   * Check if fulfillment is complete
   */
  isDelivered(): boolean {
    return this.status === FulfillmentStatus.DELIVERED;
  }

  /**
   * Check if fulfillment is in transit
   */
  isInTransit(): boolean {
    return this.status === FulfillmentStatus.SHIPPED;
  }

  /**
   * Check if fulfillment is pending
   */
  isPending(): boolean {
    return this.status === FulfillmentStatus.PENDING;
  }

  /**
   * Assert the current in-memory status may legally transition to `next`,
   * surfacing the illegal-transition error at the mutation call site rather
   * than deferring it to save(). A no-op (already in `next`) is allowed.
   */
  private assertCanTransitionTo(next: FulfillmentStatus): void {
    if (this.status === next) return;
    const allowed = FULFILLMENT_STATUS_TRANSITIONS[this.status] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(
        `Fulfillment ${this.trackingNumber || this.id || '<new>'}: cannot move ` +
          `from '${this.status}' to '${next}'.`,
      );
    }
  }

  /**
   * Mark as shipped. Rejected from a terminal state (DELIVERED / CANCELLED).
   */
  markShipped(trackingNumber?: string, carrier?: string): void {
    this.assertCanTransitionTo(FulfillmentStatus.SHIPPED);
    this.status = FulfillmentStatus.SHIPPED;
    this.shippedAt = new Date();
    if (trackingNumber) this.trackingNumber = trackingNumber;
    if (carrier) this.carrier = carrier;
  }

  /**
   * Mark as delivered. Rejected from CANCELLED (a cancelled shipment can't be
   * delivered).
   */
  markDelivered(): void {
    this.assertCanTransitionTo(FulfillmentStatus.DELIVERED);
    this.status = FulfillmentStatus.DELIVERED;
    this.deliveredAt = new Date();
  }

  /**
   * Cancel fulfillment. Rejected once DELIVERED (a delivered shipment can't be
   * cancelled — model a return/refund elsewhere instead).
   */
  cancel(): void {
    this.assertCanTransitionTo(FulfillmentStatus.CANCELLED);
    this.status = FulfillmentStatus.CANCELLED;
  }
}

export default Fulfillment;
