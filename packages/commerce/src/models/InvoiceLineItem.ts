/**
 * InvoiceLineItem model - individual items on an invoice
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
import { minorToMajorUnits } from '../billing/units.js';
import {
  calculateInvoiceMinorLine,
  type InvoiceCalculationContext,
  type InvoiceLineDraft,
  resolveInvoiceLineDraft,
} from '../svelte/invoices/calculations.js';
import type {
  AccountingLineItemInput,
  InvoiceLineEditorState,
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
  @field({ description: 'The invoice this line belongs to.' })
  @foreignKey('Invoice')
  invoiceId: string = '';

  /**
   * Item description
   */
  @field({ description: 'What is being billed on this line.' })
  description: string = '';

  /**
   * SKU or item code
   */
  sku: string = '';

  /** Nonnegative decimal quantity (hours, weight, units), up to six fractional digits. */
  @field({ description: 'How many.' })
  quantity: number = 1.0;

  /** Raw editor modes retained only while they resolve to the authoritative model fields. */
  invoiceEditorStateJson: string = '';

  /** Guarded editor metadata view; malformed stored JSON is treated as absent. */
  get invoiceEditorState(): InvoiceLineEditorState | null {
    try {
      const value: unknown = JSON.parse(this.invoiceEditorStateJson);
      if (
        !value ||
        typeof value !== 'object' ||
        !('draft' in value) ||
        !('context' in value) ||
        !value.draft ||
        typeof value.draft !== 'object' ||
        !value.context ||
        typeof value.context !== 'object'
      )
        return null;
      return value as InvoiceLineEditorState;
    } catch {
      return null;
    }
  }

  /** Store only this model's editor state, preserving unrelated metadata. */
  set invoiceEditorState(value: InvoiceLineEditorState | null) {
    this.invoiceEditorStateJson = value ? JSON.stringify(value) : '';
  }

  /**
   * Unit price before discount, in **integer minor units** (cents, satoshis).
   *
   * Money is exact, so it is stored as minor units and never as a float —
   * `$19.99` is `1999`. An integer literal is what maps this to an INTEGER
   * column (#2361).
   */
  @field({ description: 'The price of one, before tax.' })
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
  @field({
    description: 'The tax rate for this line, as a percentage (5 means 5%).',
  })
  taxRate: number = 0.0;

  /**
   * Calculated line amount, in integer minor units (#2361).
   */
  @field({ description: 'The line total.' })
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
    if (options.invoiceEditorStateJson !== undefined)
      this.invoiceEditorStateJson = options.invoiceEditorStateJson;
    if (options.invoiceEditorState !== undefined)
      this.invoiceEditorState = structuredClone(options.invoiceEditorState);
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

  /** Calculate exact safe integer-minor totals, rounding gross and tax ties toward positive infinity. */
  calculateAmount(): number {
    return calculateInvoiceMinorLine(this).totalMinor;
  }

  /** Rounded quantity times price, less the resolved flat minor-unit discount. */
  getSubtotal(): number {
    return calculateInvoiceMinorLine(this).subtotalMinor;
  }

  /** Tax on the rounded discounted subtotal, in safe integer minor units. */
  getTaxAmount(): number {
    return calculateInvoiceMinorLine(this).taxMinor;
  }

  /** Apply a server-validated draft without saving; authorization and transaction stay caller-owned. */
  applyEditorDraft(
    draft: InvoiceLineDraft,
    context: InvoiceCalculationContext,
  ): void {
    const resolved = resolveInvoiceLineDraft(draft, context);
    Object.assign(this, resolved);
    this.invoiceEditorState = structuredClone({ draft, context });
  }

  /** Recover original editing modes only when current authority and resolved model fields agree. */
  getEditorDraft(
    authorizedContext: InvoiceCalculationContext,
  ): InvoiceLineDraft | null {
    const state = this.invoiceEditorState;
    if (
      !state ||
      !authorizedContext ||
      state.context?.currency !== authorizedContext.currency ||
      state.context?.inheritedTaxRate !== authorizedContext.inheritedTaxRate
    )
      return null;
    try {
      const resolved = resolveInvoiceLineDraft(state.draft, authorizedContext);
      if (
        resolved.description !== this.description ||
        resolved.sku !== this.sku ||
        resolved.quantity !== this.quantity ||
        resolved.unitPrice !== this.unitPrice ||
        resolved.discount !== this.discount ||
        resolved.taxRate !== this.taxRate
      )
        return null;
      return structuredClone(state.draft);
    } catch {
      return null;
    }
  }

  /** Validate resolved fields and recompute amount before persistence; editor metadata never determines money. */
  override async save(): Promise<this> {
    this.amount = this.calculateAmount();
    const state = this.invoiceEditorState;
    if (
      this.invoiceEditorStateJson &&
      (!state || !this.getEditorDraft(state.context))
    )
      this.invoiceEditorState = null;
    return (await super.save()) as this;
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
   * Convert to line item format for SDK accounting provider.
   *
   * `@happyvertical/accounting` takes currency **major** units. Pass the
   * invoice currency to convert (as {@link Invoice.toAccountingInput} does);
   * without it, money stays in this package's integer minor units.
   */
  toAccountingLineItem(currency?: string): AccountingLineItemInput {
    const money = (value: number) =>
      currency ? minorToMajorUnits(value, currency) : value;
    return {
      description: this.description,
      sku: this.sku || undefined,
      quantity: this.quantity,
      unitPrice: money(this.unitPrice),
      discount: this.discount ? money(this.discount) : undefined,
      taxRate: this.taxRate,
      amount: money(this.amount),
      periodStart: this.periodStart || undefined,
      periodEnd: this.periodEnd || undefined,
    };
  }
}

export default InvoiceLineItem;
