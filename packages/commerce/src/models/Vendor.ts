/**
 * Vendor model - links to Profile with vendor-specific data
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { VendorStatus } from '../types/index.js';

/**
 * Vendor represents the vendor/supplier role for a Profile.
 *
 * One Profile can have both Customer and Vendor records - e.g., a company
 * you both buy from and sell to.
 *
 * @example
 * ```typescript
 * const vendor = await vendors.create({
 *   profileId: 'profile-uuid',
 *   leadTimeDays: 14,
 *   minimumOrderAmount: 500,
 *   paymentTerms: 'Net 60'
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Vendor extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global vendors
   */
  @tenantId({ nullable: true })
  tenantId?: string;

  /**
   * Reference to smrt-profiles Profile
   * Plain string for cross-package reference
   */
  profileId: string = '';

  /**
   * Typical lead time in days for orders
   */
  leadTimeDays: number = 0;

  /**
   * Minimum order amount required
   */
  minimumOrderAmount: number = 0.0;

  /**
   * Payment terms for this vendor (e.g., "Net 60")
   */
  paymentTerms: string = '';

  /**
   * Default currency for transactions with this vendor
   */
  currency: string = 'USD';

  /**
   * Default contact email for orders
   */
  defaultContactEmail: string = '';

  /**
   * Default contact phone for orders
   */
  defaultContactPhone: string = '';

  /**
   * Vendor status
   */
  status: VendorStatus = VendorStatus.ACTIVE;

  /**
   * Internal notes about this vendor
   */
  notes: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.leadTimeDays !== undefined)
      this.leadTimeDays = options.leadTimeDays;
    if (options.minimumOrderAmount !== undefined)
      this.minimumOrderAmount = options.minimumOrderAmount;
    if (options.paymentTerms !== undefined)
      this.paymentTerms = options.paymentTerms;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.defaultContactEmail !== undefined)
      this.defaultContactEmail = options.defaultContactEmail;
    if (options.defaultContactPhone !== undefined)
      this.defaultContactPhone = options.defaultContactPhone;
    if (options.status !== undefined) this.status = options.status;
    if (options.notes !== undefined) this.notes = options.notes;
  }

  /**
   * Check if vendor is active
   */
  isActive(): boolean {
    return this.status === VendorStatus.ACTIVE;
  }

  /**
   * Check if order meets minimum requirements
   */
  meetsMinimumOrder(amount: number): boolean {
    return amount >= this.minimumOrderAmount;
  }

  /**
   * Get the profile ID for external lookup.
   *
   * To get the actual Profile object, use the ProfileCollection from smrt-profiles:
   * ```typescript
   * const profiles = await ProfileCollection.create(options);
   * const profile = await profiles.get({ id: vendor.profileId });
   * ```
   *
   * @returns The profile ID or empty string if not set
   */
  getProfileId(): string {
    return this.profileId;
  }
}

export default Vendor;
