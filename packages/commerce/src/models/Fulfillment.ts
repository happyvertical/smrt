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
import { Contract } from './Contract.js';

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
  tenantId?: string;

  /**
   * Parent contract being fulfilled
   */
  contractId = foreignKey(Contract);

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
   * Mark as shipped
   */
  markShipped(trackingNumber?: string, carrier?: string): void {
    this.status = FulfillmentStatus.SHIPPED;
    this.shippedAt = new Date();
    if (trackingNumber) this.trackingNumber = trackingNumber;
    if (carrier) this.carrier = carrier;
  }

  /**
   * Mark as delivered
   */
  markDelivered(): void {
    this.status = FulfillmentStatus.DELIVERED;
    this.deliveredAt = new Date();
  }

  /**
   * Cancel fulfillment
   */
  cancel(): void {
    this.status = FulfillmentStatus.CANCELLED;
  }
}

export default Fulfillment;
