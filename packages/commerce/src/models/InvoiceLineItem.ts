/**
 * InvoiceLineItem model - individual items on an invoice
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { Invoice } from './Invoice.js';

/**
 * InvoiceLineItem represents a single line item on an invoice.
 *
 * Line items contain details of what is being billed, including
 * quantity, pricing, and optional source tracking (e.g., from ad campaigns).
 *
 * @example
 * ```typescript
 * const lineItem = await lineItems.create({
 *   invoiceId: invoice.id,
 *   description: 'Display Advertising - Summer Campaign',
 *   quantity: 50000,  // impressions
 *   unitPrice: 0.01,  // per impression
 *   taxRate: 0.05,
 *   sourceType: 'campaign',
 *   sourceId: 'campaign-uuid',
 *   periodStart: new Date('2025-06-01'),
 *   periodEnd: new Date('2025-06-30')
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class InvoiceLineItem extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global invoice line items
   */
  @tenantId({ nullable: true })
  tenantId?: string;

  /**
   * Parent invoice
   */
  invoiceId = foreignKey(Invoice);

  /**
   * Item description
   */
  description: string = '';

  /**
   * SKU or item code
   */
  sku: string = '';

  /**
   * Quantity (e.g., impressions, hours, units)
   */
  quantity: number = 1;

  /**
   * Unit price before discount
   */
  unitPrice: number = 0;

  /**
   * Discount amount (flat, not percentage)
   */
  discount: number = 0;

  /**
   * Tax rate as decimal (e.g., 0.05 for 5%)
   */
  taxRate: number = 0;

  /**
   * Calculated line amount
   */
  amount: number = 0;

  // ============================================================================
  // Source Tracking
  // ============================================================================

  /**
   * Type of source ('campaign' | 'contract' | 'manual' | etc.)
   */
  sourceType: string = '';

  /**
   * ID of the source (e.g., campaign ID, contract ID)
   */
  sourceId: string = '';

  /**
   * Service period start (for time-based billing)
   */
  periodStart: Date | null = null;

  /**
   * Service period end (for time-based billing)
   */
  periodEnd: Date | null = null;

  // ============================================================================
  // Accounting
  // ============================================================================

  /**
   * Revenue account ID (cross-package ref to smrt-ledgers)
   * Used for revenue recognition to specific accounts
   */
  revenueAccountId: string = '';

  /**
   * Sort order within the invoice
   */
  sortOrder: number = 0;

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.invoiceId !== undefined) this.invoiceId = options.invoiceId;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.sku !== undefined) this.sku = options.sku;
    if (options.quantity !== undefined) this.quantity = options.quantity;
    if (options.unitPrice !== undefined) this.unitPrice = options.unitPrice;
    if (options.discount !== undefined) this.discount = options.discount;
    if (options.taxRate !== undefined) this.taxRate = options.taxRate;
    if (options.amount !== undefined) this.amount = options.amount;
    if (options.sourceType !== undefined) this.sourceType = options.sourceType;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.periodStart !== undefined)
      this.periodStart = options.periodStart;
    if (options.periodEnd !== undefined) this.periodEnd = options.periodEnd;
    if (options.revenueAccountId !== undefined)
      this.revenueAccountId = options.revenueAccountId;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }

  /**
   * Calculate the line amount.
   *
   * Formula: (quantity * unitPrice - discount) * (1 + taxRate)
   *
   * Tax is calculated on the discounted subtotal. This follows the common
   * "discount before tax" approach used in most North American jurisdictions.
   * For jurisdictions requiring different tax calculation methods, override
   * this method or calculate amounts externally.
   */
  calculateAmount(): number {
    const subtotal = this.quantity * this.unitPrice - this.discount;
    const tax = subtotal * this.taxRate;
    return subtotal + tax;
  }

  /**
   * Get subtotal (before tax)
   */
  getSubtotal(): number {
    return this.quantity * this.unitPrice - this.discount;
  }

  /**
   * Get tax amount
   */
  getTaxAmount(): number {
    return this.getSubtotal() * this.taxRate;
  }

  /**
   * Check if line item has source tracking
   */
  hasSource(): boolean {
    return !!this.sourceType && !!this.sourceId;
  }

  /**
   * Check if line item has a service period
   */
  hasPeriod(): boolean {
    return !!this.periodStart && !!this.periodEnd;
  }

  /**
   * Convert to line item format for SDK accounting provider
   */
  toAccountingLineItem(): any {
    return {
      description: this.description,
      sku: this.sku || undefined,
      quantity: this.quantity,
      unitPrice: this.unitPrice,
      discount: this.discount || undefined,
      taxRate: this.taxRate || undefined,
      amount: this.amount,
      periodStart: this.periodStart || undefined,
      periodEnd: this.periodEnd || undefined,
    };
  }
}

export default InvoiceLineItem;
