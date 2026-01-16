/**
 * PartnerCollection - Collection manager for Partner objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Partner } from '../models/Partner.js';
import { PartnerStatus, PartnerType } from '../types/index.js';

export class PartnerCollection extends SmrtCollection<Partner> {
  static readonly _itemClass = Partner;

  /**
   * Find partners by profile ID
   *
   * @param profileId - Profile ID
   * @returns Array of partners
   */
  async findByProfile(profileId: string): Promise<Partner[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find partner by property ID (publishers)
   *
   * @param propertyId - Property ID
   * @returns Partner or null
   */
  async findByProperty(propertyId: string): Promise<Partner | null> {
    const results = await this.list({
      where: { propertyId },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find partners by parent partner ID
   *
   * @param parentPartnerId - Parent partner ID
   * @returns Array of child partners
   */
  async findByParent(parentPartnerId: string): Promise<Partner[]> {
    return await this.list({
      where: { parentPartnerId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find partners referred by a specific partner
   *
   * @param referredById - Referrer partner ID
   * @returns Array of referred partners
   */
  async findByReferrer(referredById: string): Promise<Partner[]> {
    return await this.list({
      where: { referredById },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find partners by status
   *
   * @param status - Partner status
   * @returns Array of partners
   */
  async findByStatus(status: PartnerStatus): Promise<Partner[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active partners
   */
  async findActive(): Promise<Partner[]> {
    return await this.findByStatus(PartnerStatus.ACTIVE);
  }

  /**
   * Find all pending partners (awaiting approval)
   */
  async findPending(): Promise<Partner[]> {
    return await this.findByStatus(PartnerStatus.PENDING);
  }

  /**
   * Find all suspended partners
   */
  async findSuspended(): Promise<Partner[]> {
    return await this.findByStatus(PartnerStatus.SUSPENDED);
  }

  /**
   * Find partners by type (requires in-memory filtering for JSON field)
   *
   * @param type - Partner type to filter by
   * @returns Array of partners with that type
   */
  async findByType(type: PartnerType): Promise<Partner[]> {
    const all = await this.list({});
    return all.filter((partner) => partner.hasType(type));
  }

  /**
   * Find all publisher partners
   */
  async findPublishers(): Promise<Partner[]> {
    return await this.findByType(PartnerType.PUBLISHER);
  }

  /**
   * Find all salesperson partners
   */
  async findSalespeople(): Promise<Partner[]> {
    return await this.findByType(PartnerType.SALESPERSON);
  }

  /**
   * Find all referrer partners
   */
  async findReferrers(): Promise<Partner[]> {
    return await this.findByType(PartnerType.REFERRER);
  }

  /**
   * Find active publishers (for ad serving)
   */
  async findActivePublishers(): Promise<Partner[]> {
    const publishers = await this.findPublishers();
    return publishers.filter((p) => p.isActive());
  }

  /**
   * Find partner for ad serving by property ID
   * Returns active publisher partner for the property
   *
   * @param propertyId - Property ID
   * @returns Active publisher partner or null
   */
  async findActiveByProperty(propertyId: string): Promise<Partner | null> {
    const partner = await this.findByProperty(propertyId);
    if (partner?.isActive() && partner.isPublisher()) {
      return partner;
    }
    return null;
  }

  /**
   * Find partners eligible for payout
   * (active partners with pending commissions above threshold)
   * Note: Actual threshold check requires joining with commissions
   */
  async findEligibleForPayout(): Promise<Partner[]> {
    const active = await this.findActive();
    // Actual eligibility check happens in payout service
    // which sums pending commissions per partner
    return active;
  }
}
