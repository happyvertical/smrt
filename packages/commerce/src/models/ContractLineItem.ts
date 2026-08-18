/**
 * ContractLineItem model - individual items on a contract
 * @packageDocumentation
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ContractLineItemOptions } from '../types/index.js';

/**
 * ContractLineItem represents a single line item on a contract.
 *
 * Line items contain the details of what is being sold/purchased,
 * including quantity, pricing, and optional subscription details.
 *
 * @example
 * ```typescript
 * const lineItem = await lineItems.create({
 *   contractId: order.id,
 *   description: 'Widget Pro',
 *   quantity: 10,
 *   unitPrice: 4999, // $49.99 in cents
 *   taxRate: 0.08
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class ContractLineItem extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global line items
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Parent contract
   */
  @foreignKey('Contract')
  contractId: string = '';

  /**
   * Item description
   */
  description: string = '';

  /**
   * Quantity ordered. Decimal on purpose — contracts price fractional
   * quantities (hours, weight, bandwidth), unlike `InvoiceLineItem.quantity`.
   */
  quantity: number = 1.0;

  /**
   * Unit price before discount, in **integer minor units** (cents, satoshis).
   *
   * The `= 0` initializer is load-bearing: SMRT maps an integer literal to
   * INTEGER and a decimal literal to DECIMAL. Money is exact, so `$49.99` is
   * `4999` (#2401).
   */
  unitPrice: number = 0;

  /**
   * Discount amount (flat, not percentage), in integer minor units (#2401).
   */
  discount: number = 0;

  /**
   * Tax rate as decimal (e.g., 0.08 for 8%). A rate is inherently fractional,
   * so it stays DECIMAL — INTEGER would truncate every meaningful value.
   */
  taxRate: number = 0.0;

  /**
   * Calculated line amount (qty * price - discount + tax), in integer minor
   * units. Derived by {@link ContractLineItem.calculateAmount}, which rounds
   * the fractional tax to a whole minor unit (#2401).
   */
  amount: number = 0;

  /**
   * Optional product reference (cross-package, plain string)
   */
  @crossPackageRef('@happyvertical/smrt-products:Product')
  productId: string = '';

  /**
   * SKU or item code
   */
  sku: string = '';

  /**
   * Start date (for lease/subscription items)
   */
  startDate: Date | null = null;

  /**
   * End date (for lease/subscription items)
   */
  endDate: Date | null = null;

  /**
   * Billing period (for subscriptions: 'monthly', 'yearly', etc.)
   */
  billingPeriod: string = '';

  /**
   * Sort order within the contract
   */
  sortOrder: number = 0;

  constructor(options: ContractLineItemOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.contractId !== undefined) this.contractId = options.contractId;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.quantity !== undefined) this.quantity = options.quantity;
    if (options.unitPrice !== undefined) this.unitPrice = options.unitPrice;
    if (options.discount !== undefined) this.discount = options.discount;
    if (options.taxRate !== undefined) this.taxRate = options.taxRate;
    if (options.amount !== undefined) this.amount = options.amount;
    if (options.productId !== undefined) this.productId = options.productId;
    if (options.sku !== undefined) this.sku = options.sku;
    if (options.startDate !== undefined) this.startDate = options.startDate;
    if (options.endDate !== undefined) this.endDate = options.endDate;
    if (options.billingPeriod !== undefined)
      this.billingPeriod = options.billingPeriod;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }

  /**
   * Calculate the line amount, in integer minor units.
   *
   * `quantity` is decimal and `taxRate` is a fraction, so the product is not
   * generally a whole number of minor units. Rounding happens here — at the
   * one boundary where a rate meets money — so that every value that reaches a
   * money column is already exact and every downstream comparison can be a
   * plain `===` instead of an epsilon tolerance (#2401).
   */
  calculateAmount(): number {
    const subtotal = this.quantity * this.unitPrice - this.discount;
    const tax = subtotal * this.taxRate;
    return Math.round(subtotal + tax);
  }

  /**
   * Check if this is a subscription/recurring item
   */
  isRecurring(): boolean {
    return !!this.billingPeriod && !!this.startDate;
  }

  /**
   * Check if subscription is active
   */
  isSubscriptionActive(): boolean {
    if (!this.isRecurring()) return false;
    if (!this.startDate) return false;

    const now = new Date();
    if (now < this.startDate) return false;
    if (this.endDate && now > this.endDate) return false;

    return true;
  }
}

export default ContractLineItem;
