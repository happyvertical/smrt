/**
 * FulfillmentCollection - Collection manager for Fulfillment objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { Fulfillment } from '../models/Fulfillment.js';
import { FulfillmentStatus, type FulfillmentType } from '../types/index.js';

export class FulfillmentCollection extends SmrtCollection<Fulfillment> {
  static readonly _itemClass = Fulfillment;

  /**
   * Find fulfillments by contract
   *
   * @param contractId - Contract ID
   * @returns Array of fulfillments
   */
  async findByContract(contractId: string): Promise<Fulfillment[]> {
    return await this.list({
      where: { contractId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find fulfillments by status
   *
   * @param status - Fulfillment status
   * @returns Array of fulfillments
   */
  async findByStatus(status: FulfillmentStatus): Promise<Fulfillment[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find fulfillments by type
   *
   * @param fulfillmentType - Fulfillment type
   * @returns Array of fulfillments
   */
  async findByType(fulfillmentType: FulfillmentType): Promise<Fulfillment[]> {
    return await this.list({
      where: { fulfillmentType },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all pending fulfillments
   *
   * @returns Array of pending fulfillments
   */
  async findPending(): Promise<Fulfillment[]> {
    return await this.findByStatus(FulfillmentStatus.PENDING);
  }

  /**
   * Find all in-transit shipments
   *
   * @returns Array of shipped fulfillments
   */
  async findInTransit(): Promise<Fulfillment[]> {
    return await this.findByStatus(FulfillmentStatus.SHIPPED);
  }

  /**
   * Find by tracking number
   *
   * @param trackingNumber - Tracking number
   * @returns Fulfillment or null
   */
  async findByTracking(trackingNumber: string): Promise<Fulfillment | null> {
    const results = await this.list({
      where: { trackingNumber },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find fulfillments shipped in date range
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Array of fulfillments
   */
  async findShippedInRange(
    startDate: Date,
    endDate: Date,
  ): Promise<Fulfillment[]> {
    return await this.list({
      where: {
        'shippedAt >=': startDate.toISOString(),
        'shippedAt <=': endDate.toISOString(),
      },
      orderBy: 'shippedAt DESC',
    });
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all fulfillments belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of fulfillments for the tenant
   */
  async findByTenant(tenantId: string): Promise<Fulfillment[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global fulfillments (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global fulfillments
   */
  async findGlobal(): Promise<Fulfillment[]> {
    return queryGlobal<Fulfillment>(this);
  }

  /**
   * Find fulfillments for a tenant including global fulfillments.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global fulfillments
   */
  async findWithGlobals(tenantId: string): Promise<Fulfillment[]> {
    return queryWithGlobals<Fulfillment>(
      this,
      tenantId,
      'Fulfillment.findWithGlobals',
    );
  }
}
