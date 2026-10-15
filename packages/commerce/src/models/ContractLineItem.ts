/**
 * ContractLineItem model - individual items on a contract
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  DOCUMENT_MONEY_READ_REBIND,
  DOCUMENT_MONEY_WRITE,
  type DocumentMoneyReadRebindCapability,
  type DocumentMoneyWriteCapability,
} from '../document-money-internal.js';
import type {
  ContractLineItemOptions,
  ContractTaxComponentSnapshot,
} from '../types/index.js';

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
  cli: { skipApiCheck: true },
})
export class ContractLineItem extends SmrtObject {
  /** @internal Collection read guard returns this snapshot on its root DB. */
  rebindMoneyRead(
    capability: DocumentMoneyReadRebindCapability,
    db: DatabaseInterface,
  ): this {
    if (capability !== DOCUMENT_MONEY_READ_REBIND)
      throw new Error(
        'Contract line read rebinding requires the owning capability',
      );
    this._db = db;
    this.options.db = db;
    return this;
  }

  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global line items
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Parent contract
   */
  @field({ description: 'The order, quote or agreement this line belongs to.' })
  @foreignKey('Contract', { role: 'items' })
  contractId: string = '';

  /**
   * Item description
   */
  @field({ description: 'What is being sold or bought on this line.' })
  description: string = '';

  /**
   * Quantity ordered. Decimal on purpose — contracts price fractional
   * quantities (hours, weight, bandwidth), as do invoice line items.
   */
  @field({ description: 'How many.' })
  quantity: number = 1.0;

  /**
   * Unit price before discount, in **integer minor units** (cents, satoshis).
   *
   * The `= 0` initializer is load-bearing: SMRT maps an integer literal to
   * INTEGER and a decimal literal to DECIMAL. Money is exact, so `$49.99` is
   * `4999` (#2401).
   */
  @field({
    description: 'The price of one, before tax.',
    ui: { format: 'money' },
  })
  unitPrice: number = 0;

  /**
   * Discount amount (flat, not percentage), in integer minor units (#2401).
   */
  @field({ ui: { format: 'money' } })
  discount: number = 0;

  discountType: 'none' | 'percent' | 'amount' = 'none';

  @field({ type: 'decimal' })
  discountRate = '0.0';

  /**
   * Tax rate as decimal (e.g., 0.08 for 8%). A rate is inherently fractional,
   * so it stays DECIMAL — INTEGER would truncate every meaningful value.
   */
  @field({
    description:
      'The stored fractional tax rate for this line (0.05 means 5%).',
  })
  taxRate: number = 0.0;

  taxMode: 'inherit' | 'override' = 'inherit';

  @foreignKey('TaxCode', { nullable: true })
  taxCodeId: string | null = null;

  taxCodeCode: string | null = null;

  taxCodeName: string | null = null;

  taxComponentsJson: string | null = null;

  get taxComponents(): ContractTaxComponentSnapshot[] {
    if (this.taxComponentsJson === null) return [];
    try {
      const value: unknown = JSON.parse(this.taxComponentsJson);
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry): entry is ContractTaxComponentSnapshot =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as ContractTaxComponentSnapshot).taxComponentId ===
            'string' &&
          typeof (entry as ContractTaxComponentSnapshot).name === 'string' &&
          typeof (entry as ContractTaxComponentSnapshot).percent === 'string' &&
          Number.isSafeInteger(
            (entry as ContractTaxComponentSnapshot).taxMinor,
          ),
      );
    } catch {
      return [];
    }
  }

  set taxComponents(value: ContractTaxComponentSnapshot[]) {
    this.taxComponentsJson = JSON.stringify(value);
  }

  /** Exact sum of frozen component taxes, in integer minor units. */
  @field({ ui: { format: 'money' } })
  taxAmount = 0;

  /**
   * @internal Pre-v2 amount preserved only by the migration path for
   * rollback; not a user-facing amount, so it carries no money hint.
   */
  @field({ nullable: true })
  legacyAmount: number | null = null;

  /** Stable issue/freeze identity, independent of lifecycle updated_at. */
  moneySnapshotId = '';

  /**
   * Calculated line amount (qty * price - discount + tax), in integer minor
   * units. Derived by {@link ContractLineItem.calculateAmount}, which rounds
   * the fractional tax to a whole minor unit (#2401).
   */
  @field({ description: 'The line total.', ui: { format: 'money' } })
  amount: number = 0;

  /**
   * Optional product reference (cross-package, plain string)
   */
  @field({
    description: 'The product this line is for, if it is one you list.',
  })
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
    if (options.discountType !== undefined)
      this.discountType = options.discountType;
    if (options.discountRate !== undefined)
      this.discountRate = options.discountRate;
    if (options.taxRate !== undefined) this.taxRate = options.taxRate;
    if (options.taxMode !== undefined) this.taxMode = options.taxMode;
    if (options.taxCodeId !== undefined) this.taxCodeId = options.taxCodeId;
    if (options.taxCodeCode !== undefined)
      this.taxCodeCode = options.taxCodeCode;
    if (options.taxCodeName !== undefined)
      this.taxCodeName = options.taxCodeName;
    if (options.taxComponentsJson !== undefined)
      this.taxComponentsJson = options.taxComponentsJson;
    if (options.taxComponents !== undefined)
      this.taxComponents = structuredClone(options.taxComponents);
    if (options.taxAmount !== undefined) this.taxAmount = options.taxAmount;
    if (options.legacyAmount !== undefined)
      this.legacyAmount = options.legacyAmount;
    if (options.moneySnapshotId !== undefined)
      this.moneySnapshotId = options.moneySnapshotId;
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

  override async save(): Promise<this> {
    const { saveContractLineItem } = await import('../contract-money.js');
    return (await saveContractLineItem(this)) as this;
  }

  /** @internal Contract aggregate persistence only. */
  async saveDerived(
    capability: DocumentMoneyWriteCapability,
    legacy: boolean,
  ): Promise<this> {
    if (capability !== DOCUMENT_MONEY_WRITE)
      throw new Error('Contract line money write capability is required');
    if (legacy) this.amount = this.calculateAmount();
    return (await super.save()) as this;
  }

  override async delete(
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    const { deleteContractLineItem } = await import('../contract-money.js');
    await deleteContractLineItem(this, options);
  }

  /** @internal Contract aggregate persistence only. */
  async deleteDerived(
    capability: DocumentMoneyWriteCapability,
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    if (capability !== DOCUMENT_MONEY_WRITE)
      throw new Error('Contract line money write capability is required');
    await super.delete(options);
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
