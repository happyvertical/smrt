/**
 * Contract model with STI for different contract types
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
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
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Contract extends SmrtObject {
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
  customerId = foreignKey(Customer);

  /**
   * Vendor ID (for purchase contracts: PurchaseOrder)
   */
  vendorId = foreignKey(Vendor);

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
   * STI discriminator field
   */
  static readonly _stiField = 'contractType';

  constructor(options: any = {}) {
    super(options);
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

/**
 * Estimate - Quote or proposal for a customer
 */
@smrt()
export class Estimate extends Contract {
  override contractType = ContractType.ESTIMATE;
}

/**
 * Order - Customer purchase order
 */
@smrt()
export class Order extends Contract {
  override contractType = ContractType.ORDER;
}

/**
 * Lease - Rental or lease agreement
 */
@smrt()
export class Lease extends Contract {
  override contractType = ContractType.LEASE;
}

/**
 * Agreement - Service or maintenance agreement
 */
@smrt()
export class Agreement extends Contract {
  override contractType = ContractType.AGREEMENT;
}

/**
 * PurchaseOrder - Order sent to vendor/supplier
 */
@smrt()
export class PurchaseOrder extends Contract {
  override contractType = ContractType.PURCHASE_ORDER;
}

export default Contract;
