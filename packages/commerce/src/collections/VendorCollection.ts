/**
 * VendorCollection - Collection manager for Vendor objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
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

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all vendors belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of vendors for the tenant
   */
  async findByTenant(tenantId: string): Promise<Vendor[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global vendors (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global vendors
   */
  async findGlobal(): Promise<Vendor[]> {
    return queryGlobal<Vendor>(this);
  }

  /**
   * Find vendors for a tenant including global vendors.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global vendors
   */
  async findWithGlobals(tenantId: string): Promise<Vendor[]> {
    return queryWithGlobals<Vendor>(this, tenantId, 'Vendor.findWithGlobals');
  }
}
