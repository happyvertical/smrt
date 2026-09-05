/**
 * InvoiceLineItem model - individual items on an invoice
 * @packageDocumentation
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  AccountingLineItemInput,
  InvoiceLineItemOptions,
} from '../types/index.js';

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
 *   unitPrice: 1,     // 1 cent per impression (minor units)
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
  cli: { skipApiCheck: true },
})
export class InvoiceLineItem extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global invoice line items
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Parent invoice
   */
  @foreignKey('Invoice')
  invoiceId: string = '';

  /**
   * Item description
   */
  description: string = '';

  /**
   * SKU or item code
   */
  sku: string = '';

  /**
   * Quantity (e.g., impressions, hours, units).
   *
   * Left INTEGER: this package's own example is `quantity: 50000` impressions,
   * and nothing in it writes a fractional quantity, so whether fractional
   * quantities are intended here is unresolved. `ContractLineItem.quantity` is
   * decimal, which is the inconsistency to settle deliberately rather than by
   * changing a column type in passing (#2361).
   */
  quantity: number = 1;

  /**
   * Unit price before discount, in **integer minor units** (cents, satoshis).
   *
   * Money is exact, so it is stored as minor units and never as a float —
   * `$19.99` is `1999`. An integer literal is what maps this to an INTEGER
   * column (#2361).
   */
  unitPrice: number = 0;

  /**
   * Discount amount (flat, not percentage), in integer minor units (#2361).
   */
  discount: number = 0;

  /**
   * Tax rate as a decimal fraction (e.g., 0.05 for 5%).
   *
   * A genuine rate, not money: it is inherently fractional, so the `0.0`
   * initializer is load-bearing and maps it to a DECIMAL column. INTEGER would
   * truncate every rate to 0 (#2361).
   */
  taxRate: number = 0.0;

  /**
   * Calculated line amount, in integer minor units (#2361).
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
  @crossPackageRef('@happyvertical/smrt-ledgers:Account')
  revenueAccountId: string = '';

  /**
   * Sort order within the invoice
   */
  sortOrder: number = 0;

  constructor(options: InvoiceLineItemOptions = {}) {
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
   * Calculate the line amount, in integer minor units.
   *
   * Formula: `getSubtotal() + getTaxAmount()`, i.e.
   * `(quantity * unitPrice - discount) * (1 + taxRate)` with the tax rounded.
   *
   * Tax is calculated on the discounted subtotal. This follows the common
   * "discount before tax" approach used in most North American jurisdictions.
   * For jurisdictions requiring different tax calculation methods, override
   * this method or calculate amounts externally.
   */
  calculateAmount(): number {
    return this.getSubtotal() + this.getTaxAmount();
  }

  /**
   * Get subtotal (before tax), in integer minor units.
   *
   * `quantity` is an integer and `unitPrice` / `discount` are integer minor
   * units, so this is exact with no rounding.
   */
  getSubtotal(): number {
    return this.quantity * this.unitPrice - this.discount;
  }

  /**
   * Get tax amount, in integer minor units.
   *
   * `taxRate` is a genuine fraction, so this product is where a rate meets
   * money and the only place rounding is needed. Rounding here — rather than
   * letting a fractional tax leak into `Invoice.taxAmount` — is what lets the
   * invoice's guards compare integers exactly instead of tolerating an epsilon
   * (#2401).
   */
  getTaxAmount(): number {
    return Math.round(this.getSubtotal() * this.taxRate);
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
  toAccountingLineItem(): AccountingLineItemInput {
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
