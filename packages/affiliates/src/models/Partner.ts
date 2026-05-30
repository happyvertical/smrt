/**
 * Partner model - Affiliate partner earning entity
 * @packageDocumentation
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { PartnerStatus, PartnerType, PayoutMethod } from '../types/index.js';

/**
 * Partner represents an entity that earns commissions from ad revenue.
 *
 * Partners can be:
 * - Publishers: Own sites that display ads (earn display commissions)
 * - Salespeople: Bring in advertisers (earn sales commissions)
 * - Referrers: Refer new publishers/partners (earn referral commissions)
 *
 * References:
 * - profileId: String reference to smrt-profiles Profile (cross-package)
 * - propertyId: String reference to smrt-properties Property (cross-package)
 * - parentPartnerId: Self-reference for site-attached salespeople
 *
 * @example
 * ```typescript
 * // Create a publisher partner
 * const publisher = await partners.create({
 *   profileId: 'profile-uuid',
 *   propertyId: 'property-uuid',
 *   partnerTypes: JSON.stringify([PartnerType.PUBLISHER]),
 *   displayCommissionRate: 0.50,
 *   status: PartnerStatus.ACTIVE
 * });
 *
 * // Create a salesperson attached to a publisher
 * const salesperson = await partners.create({
 *   profileId: 'salesperson-profile-uuid',
 *   parentPartnerId: publisher.id,
 *   partnerTypes: JSON.stringify([PartnerType.SALESPERSON]),
 *   salesCommissionRate: 0.10,
 *   parentCommissionShare: 0.20,
 *   status: PartnerStatus.ACTIVE
 * });
 * ```
 */
// Intentional exception to standards.md §7 (`@TenantScoped`):
// `Partner` is deliberately NOT tenant-scoped. A single partner (e.g. a
// publisher operating sites across multiple tenants) needs a stable identity
// for revenue aggregation, payout thresholds, and tax reporting; slicing
// identity per tenant would duplicate the row or hide payouts owed across
// tenants. See `packages/affiliates/CLAUDE.md` "Tenancy" section.
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Partner extends SmrtObject {
  /**
   * Profile ID (FK to smrt-profiles Profile, cross-package)
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  profileId: string = '';

  /**
   * Property ID (FK to smrt-properties Property, cross-package)
   * Only set for publisher partners
   */
  @crossPackageRef('@happyvertical/smrt-properties:Property')
  propertyId: string = '';

  /**
   * Partner types as JSON array (publisher, salesperson, referrer)
   * A partner can have multiple types
   */
  partnerTypes: string = '[]';

  /**
   * Parent partner ID (self-reference)
   * For site-attached salespeople, this is the publisher they work under
   */
  @foreignKey('Partner')
  parentPartnerId: string = '';

  /**
   * Referred by partner ID (self-reference)
   * Tracks who referred this partner for referral commission attribution
   */
  @foreignKey('Partner')
  referredById: string = '';

  /**
   * Share of commission that goes to parent partner (0-1)
   * e.g., 0.20 means 20% of this partner's sales commission goes to parent
   */
  parentCommissionShare: number = 0;

  /**
   * Commission rate for display (impression) revenue (0-1)
   * Default 50% - publisher earns half of ad impression revenue
   */
  displayCommissionRate: number = 0.5;

  /**
   * Commission rate for referral revenue (0-1)
   * Default 5% - referrer earns 5% of referred partner's first-year revenue
   */
  referralCommissionRate: number = 0.05;

  /**
   * Commission rate for sales revenue (0-1)
   * Default 10% - salesperson earns 10% of advertiser spend they brought in
   */
  salesCommissionRate: number = 0.1;

  /**
   * Minimum payout threshold in cents
   * Default $50 = 5000 cents
   */
  payoutThreshold: number = 5000;

  /**
   * Preferred payout method
   */
  payoutMethod: PayoutMethod = PayoutMethod.BANK_TRANSFER;

  /**
   * Currency code for all monetary values
   * Defaults to CAD, allows future multi-currency support
   */
  currency: string = 'CAD';

  /**
   * Partner status
   */
  status: PartnerStatus = PartnerStatus.PENDING;

  /**
   * Additional metadata as JSON string
   * (bank details, tax info, etc.)
   */
  metadata: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.propertyId !== undefined) this.propertyId = options.propertyId;
    if (options.partnerTypes !== undefined)
      this.partnerTypes = options.partnerTypes;
    if (options.parentPartnerId !== undefined)
      this.parentPartnerId = options.parentPartnerId;
    if (options.referredById !== undefined)
      this.referredById = options.referredById;
    if (options.parentCommissionShare !== undefined)
      this.parentCommissionShare = options.parentCommissionShare;
    if (options.displayCommissionRate !== undefined)
      this.displayCommissionRate = options.displayCommissionRate;
    if (options.referralCommissionRate !== undefined)
      this.referralCommissionRate = options.referralCommissionRate;
    if (options.salesCommissionRate !== undefined)
      this.salesCommissionRate = options.salesCommissionRate;
    if (options.payoutThreshold !== undefined)
      this.payoutThreshold = options.payoutThreshold;
    if (options.payoutMethod !== undefined)
      this.payoutMethod = options.payoutMethod;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Get partner types as array
   */
  getPartnerTypes(): PartnerType[] {
    if (!this.partnerTypes) return [];
    try {
      return JSON.parse(this.partnerTypes);
    } catch {
      return [];
    }
  }

  /**
   * Set partner types from array
   */
  setPartnerTypes(types: PartnerType[]): void {
    this.partnerTypes = JSON.stringify(types);
  }

  /**
   * Check if partner has a specific type
   */
  hasType(type: PartnerType): boolean {
    return this.getPartnerTypes().includes(type);
  }

  /**
   * Check if partner is a publisher
   */
  isPublisher(): boolean {
    return this.hasType(PartnerType.PUBLISHER);
  }

  /**
   * Check if partner is a salesperson
   */
  isSalesperson(): boolean {
    return this.hasType(PartnerType.SALESPERSON);
  }

  /**
   * Check if partner is a referrer
   */
  isReferrer(): boolean {
    return this.hasType(PartnerType.REFERRER);
  }

  /**
   * Check if partner is active
   */
  isActive(): boolean {
    return this.status === PartnerStatus.ACTIVE;
  }

  /**
   * Check if partner is pending approval
   */
  isPending(): boolean {
    return this.status === PartnerStatus.PENDING;
  }

  /**
   * Check if partner is suspended
   */
  isSuspended(): boolean {
    return this.status === PartnerStatus.SUSPENDED;
  }

  /**
   * Check if partner has a parent (site-attached)
   */
  hasParent(): boolean {
    return !!this.parentPartnerId;
  }

  /**
   * Check if partner was referred by another partner
   */
  wasReferred(): boolean {
    return !!this.referredById;
  }

  /**
   * Get metadata as object
   */
  getMetadata(): Record<string, any> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Calculate effective sales commission rate (after parent share)
   */
  getEffectiveSalesRate(): number {
    if (this.parentPartnerId && this.parentCommissionShare > 0) {
      return this.salesCommissionRate * (1 - this.parentCommissionShare);
    }
    return this.salesCommissionRate;
  }
}

export default Partner;
