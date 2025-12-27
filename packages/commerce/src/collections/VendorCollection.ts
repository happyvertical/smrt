/**
 * VendorCollection - Collection manager for Vendor objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Vendor } from '../models/Vendor.js';
import { VendorStatus } from '../types/index.js';

export class VendorCollection extends SmrtCollection<Vendor> {
  static readonly _itemClass = Vendor;

  /**
   * Find vendors by profile ID
   *
   * @param profileId - Profile ID from smrt-profiles
   * @returns Array of vendors linked to this profile
   */
  async findByProfile(profileId: string): Promise<Vendor[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active vendors
   *
   * @returns Array of active vendors
   */
  async findActive(): Promise<Vendor[]> {
    return await this.list({
      where: { status: VendorStatus.ACTIVE },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find vendors by status
   *
   * @param status - Vendor status
   * @returns Array of vendors
   */
  async findByStatus(status: VendorStatus): Promise<Vendor[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Get or create a vendor for a profile
   *
   * @param profileId - Profile ID
   * @param defaults - Default values if creating
   * @returns Vendor
   */
  async getOrCreateForProfile(
    profileId: string,
    defaults: Partial<{
      leadTimeDays: number;
      minimumOrderAmount: number;
      paymentTerms: string;
    }> = {},
  ): Promise<Vendor> {
    const existing = await this.findByProfile(profileId);
    if (existing.length > 0) {
      return existing[0];
    }

    const vendor = await this.create({
      profileId,
      leadTimeDays: defaults.leadTimeDays ?? 0,
      minimumOrderAmount: defaults.minimumOrderAmount ?? 0,
      paymentTerms: defaults.paymentTerms ?? '',
      status: VendorStatus.ACTIVE,
    });
    await vendor.save();
    return vendor;
  }
}
