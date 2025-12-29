/**
 * ContractLineItem model - individual items on a contract
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { Contract } from './Contract.js';

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
 *   unitPrice: 49.99,
 *   taxRate: 0.08
 * });
 * ```
 */
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class ContractLineItem extends SmrtObject {
  /**
   * Parent contract
   */
  contractId = foreignKey(Contract);

  /**
   * Item description
   */
  description: string = '';

  /**
   * Quantity ordered
   */
  quantity: number = 1.0;

  /**
   * Unit price before discount
   */
  unitPrice: number = 0.0;

  /**
   * Discount amount (flat, not percentage)
   */
  discount: number = 0.0;

  /**
   * Tax rate as decimal (e.g., 0.08 for 8%)
   */
  taxRate: number = 0.0;

  /**
   * Calculated line amount (qty * price - discount + tax)
   */
  amount: number = 0.0;

  /**
   * Optional product reference (cross-package, plain string)
   */
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

  constructor(options: any = {}) {
    super(options);
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
   * Calculate the line amount
   */
  calculateAmount(): number {
    const subtotal = this.quantity * this.unitPrice - this.discount;
    const tax = subtotal * this.taxRate;
    return subtotal + tax;
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
