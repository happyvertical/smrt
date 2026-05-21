/**
 * Contract model with STI for different contract types
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { ContractStatus, ContractType } from '../types/index.js';
import { Customer } from './Customer.js';
import { Vendor } from './Vendor.js';

/**
 * Contract is the base class for all commercial agreements.
 *
 * Uses Single Table Inheritance (STI) to support different contract types:
 * - Estimate: Quote/proposal for customer
 * - Order: Customer purchase order
 * - Lease: Rental/lease agreement
 * - Agreement: Service/maintenance agreement
 * - PurchaseOrder: Order to vendor/supplier
 *
 * @example
 * ```typescript
 * // Create a customer order
 * const order = await contracts.create({
 *   _meta_type: 'Order',
 *   customerId: customer.id,
 *   totalAmount: 1500.00,
 *   status: ContractStatus.DRAFT
 * });
 *
 * // Create a purchase order to vendor
 * const po = await contracts.create({
 *   _meta_type: 'PurchaseOrder',
 *   vendorId: vendor.id,
 *   totalAmount: 5000.00,
 *   reference: 'PO-2024-001'
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Contract extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global contracts
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Contract type discriminator (STI)
   */
  contractType: ContractType = ContractType.ORDER;

  /**
   * Current status of the contract
   */
  status: ContractStatus = ContractStatus.DRAFT;

  /**
   * Customer ID (for sales contracts: Estimate, Order, Agreement)
   */
  @foreignKey(Customer)
  customerId: string = '';

  /**
   * Vendor ID (for purchase contracts: PurchaseOrder)
   */
  @foreignKey(Vendor)
  vendorId: string = '';

  /**
   * Subtotal before tax
   */
  subtotal: number = 0.0;

  /**
   * Tax amount
   */
  taxAmount: number = 0.0;

  /**
   * Total amount including tax
   */
  totalAmount: number = 0.0;

  /**
   * Currency code (ISO 4217)
   */
  currency: string = 'USD';

  /**
   * Date contract was issued
   */
  issueDate: Date = new Date();

  /**
   * Payment due date
   */
  dueDate: Date | null = null;

  /**
   * Expiry date (for estimates/quotes)
   */
  expiryDate: Date | null = null;

  /**
   * External reference number (PO number, quote number, etc.)
   */
  reference: string = '';

  /**
   * Internal notes
   */
  notes: string = '';

  /**
   * Terms and conditions
   */
  terms: string = '';

  /**
   * Sales channel that owns this contract.
   *
   * Plain string so consumers can model their own channels without an enum
   * change (e.g. `dtc-web`, `wholesale-b2b`, `pos-store-1`, `marketplace-faire`).
   * Empty string means "unattributed / legacy".
   */
  channelId: string = '';

  /**
   * STI discriminator field
   */
  static readonly _stiField = 'contractType';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.contractType !== undefined)
      this.contractType = options.contractType;
    if (options.status !== undefined) this.status = options.status;
    if (options.customerId !== undefined) this.customerId = options.customerId;
    if (options.vendorId !== undefined) this.vendorId = options.vendorId;
    if (options.subtotal !== undefined) this.subtotal = options.subtotal;
    if (options.taxAmount !== undefined) this.taxAmount = options.taxAmount;
    if (options.totalAmount !== undefined)
      this.totalAmount = options.totalAmount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.issueDate !== undefined) this.issueDate = options.issueDate;
    if (options.dueDate !== undefined) this.dueDate = options.dueDate;
    if (options.expiryDate !== undefined) this.expiryDate = options.expiryDate;
    if (options.reference !== undefined) this.reference = options.reference;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.terms !== undefined) this.terms = options.terms;
    if (options.channelId !== undefined) this.channelId = options.channelId;
  }

  /**
   * Check if contract is in draft state
   */
  isDraft(): boolean {
    return this.status === ContractStatus.DRAFT;
  }

  /**
   * Check if contract is accepted
   */
  isAccepted(): boolean {
    return this.status === ContractStatus.ACCEPTED;
  }

  /**
   * Check if contract is completed
   */
  isCompleted(): boolean {
    return this.status === ContractStatus.COMPLETED;
  }

  /**
   * Check if contract is expired (for estimates)
   */
  isExpired(): boolean {
    if (!this.expiryDate) return false;
    return new Date() > this.expiryDate;
  }

  /**
   * Check if contract is overdue
   */
  isOverdue(): boolean {
    if (!this.dueDate) return false;
    if (this.status === ContractStatus.COMPLETED) return false;
    return new Date() > this.dueDate;
  }

  /**
   * Calculate and update totals from line items
   */
  async recalculateTotals(): Promise<void> {
    // This would typically query ContractLineItems and sum them
    // For now, just ensure totalAmount = subtotal + taxAmount
    this.totalAmount = this.subtotal + this.taxAmount;
  }
}

// Every STI child below MUST repeat the `@TenantScoped` decoration. The
// tenancy registry keys off the concrete className passed by the
// collection, not the inheritance chain — `OrderCollection.list()` sends
// `'Order'` to the interceptor, which then misses the `'Contract'`
// registration and skips tenant auto-filter/auto-populate. Without an
// explicit `@TenantScoped` on each subclass, saves end up with
// `tenantId: null` (the row becomes global / invisible to tenant-scoped
// queries) and lists return rows across tenants.

/**
 * Estimate - Quote or proposal for a customer
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Estimate extends Contract {
  override contractType = ContractType.ESTIMATE;
}

/**
 * Order - Customer purchase order
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Order extends Contract {
  override contractType = ContractType.ORDER;
}

/**
 * Lease - Rental or lease agreement
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Lease extends Contract {
  override contractType = ContractType.LEASE;
}

/**
 * Agreement - Service or maintenance agreement
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Agreement extends Contract {
  override contractType = ContractType.AGREEMENT;
}

/**
 * PurchaseOrder - Order sent to vendor/supplier
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class PurchaseOrder extends Contract {
  override contractType = ContractType.PURCHASE_ORDER;
}

/**
 * WholesaleOrder - B2B order placed by a wholesale customer.
 *
 * Behaves like an Order but is conventionally created against a customer with
 * `customerType: 'wholesale'`, uses NET-30/60 payment terms, and is delivered
 * via the wholesale-portal channel rather than retail checkout.
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class WholesaleOrder extends Contract {
  override contractType = ContractType.WHOLESALE_ORDER;
}

/**
 * ProductionOrder - instruction to commission goods from an internal or
 * external factory.
 *
 * The manufacturing equivalent of a {@link PurchaseOrder} — but instead of
 * buying finished inventory, you're paying to *make* it. A ProductionOrder
 * consumes raw materials per a Bill of Materials (see
 * `@happyvertical/smrt-manufacturing`) and produces finished SKU stock when
 * posted (see `@happyvertical/smrt-inventory`).
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class ProductionOrder extends Contract {
  override contractType = ContractType.PRODUCTION_ORDER;
}

/**
 * Cart - transient order-in-progress for a shopper.
 *
 * Persisted as a Contract so it can hold the same line items, totals, and
 * customer reference as a real Order, then convert in place (the application
 * promotes the row from `_meta_type: Cart` to `_meta_type: Order` at checkout
 * rather than copying data between tables).
 *
 * A Cart starts in {@link ContractStatus.DRAFT} via the base `Contract.status`
 * default — the subclass doesn't need its own override. Application code
 * is responsible for promoting the row to `ContractStatus.PENDING` /
 * `ACCEPTED` at checkout time; the framework doesn't enforce a state
 * machine on the cart → order transition.
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Cart extends Contract {
  override contractType = ContractType.CART;
}

export default Contract;
