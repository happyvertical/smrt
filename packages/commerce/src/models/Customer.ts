/**
 * Customer model - links to Profile with customer-specific data
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { type Address, CustomerStatus } from '../types/index.js';

/**
 * Customer represents the customer role for a Profile.
 *
 * One Profile can have multiple Customer records (e.g., different business contexts).
 * Customer stores customer-specific data like credit limits and payment terms.
 *
 * @example
 * ```typescript
 * const customer = await customers.create({
 *   profileId: 'profile-uuid',
 *   creditLimit: 10000,
 *   paymentTerms: 'Net 30'
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Customer extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global customers
   */
  tenantId = tenantId({ nullable: true });
  /**
   * Reference to smrt-profiles Profile
   * Plain string for cross-package reference
   */
  profileId: string = '';

  /**
   * Maximum credit extended to this customer
   */
  creditLimit: number = 0.0;

  /**
   * Payment terms (e.g., "Net 30", "Due on receipt", "2/10 Net 30")
   */
  paymentTerms: string = '';

  /**
   * Whether customer is exempt from tax
   */
  taxExempt: boolean = false;

  /**
   * Tax identification number
   */
  taxId: string = '';

  /**
   * Default shipping address
   */
  defaultShippingAddress: Address = {};

  /**
   * Default billing address
   */
  defaultBillingAddress: Address = {};

  /**
   * Customer status
   */
  status: CustomerStatus = CustomerStatus.ACTIVE;

  /**
   * Internal notes about this customer
   */
  notes: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.creditLimit !== undefined)
      this.creditLimit = options.creditLimit;
    if (options.paymentTerms !== undefined)
      this.paymentTerms = options.paymentTerms;
    if (options.taxExempt !== undefined) this.taxExempt = options.taxExempt;
    if (options.taxId !== undefined) this.taxId = options.taxId;
    if (options.defaultShippingAddress !== undefined)
      this.defaultShippingAddress = options.defaultShippingAddress;
    if (options.defaultBillingAddress !== undefined)
      this.defaultBillingAddress = options.defaultBillingAddress;
    if (options.status !== undefined) this.status = options.status;
    if (options.notes !== undefined) this.notes = options.notes;
  }

  /**
   * Check if customer is active
   */
  isActive(): boolean {
    return this.status === CustomerStatus.ACTIVE;
  }

  /**
   * Check if customer has available credit
   */
  hasAvailableCredit(amount: number): boolean {
    // In a full implementation, this would check against outstanding balances
    return this.creditLimit >= amount;
  }

  /**
   * Get the profile ID for external lookup.
   *
   * To get the actual Profile object, use the ProfileCollection from smrt-profiles:
   * ```typescript
   * const profiles = await ProfileCollection.create(options);
   * const profile = await profiles.get({ id: customer.profileId });
   * ```
   *
   * @returns The profile ID or empty string if not set
   */
  getProfileId(): string {
    return this.profileId;
  }
}

export default Customer;
