/**
 * FulfillmentLineItemCollection - Collection manager for FulfillmentLineItem objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { FulfillmentLineItem } from '../models/FulfillmentLineItem.js';

export class FulfillmentLineItemCollection extends SmrtCollection<FulfillmentLineItem> {
  static readonly _itemClass = FulfillmentLineItem;

  /**
   * Find fulfillment line items by their parent fulfillment.
   *
   * @param fulfillmentId - Fulfillment ID
   * @returns Array of fulfillment line items
   */
  async findByFulfillment(
    fulfillmentId: string,
  ): Promise<FulfillmentLineItem[]> {
    return await this.list({
      where: { fulfillmentId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find every fulfillment line item that fulfills a given contract line item,
   * across all fulfillments. Used by the over-fulfillment cap to sum how much
   * of an ordered line has already been fulfilled.
   *
   * @param contractLineItemId - Contract line item ID
   * @returns Array of fulfillment line items targeting that contract line
   */
  async findByContractLineItem(
    contractLineItemId: string,
  ): Promise<FulfillmentLineItem[]> {
    return await this.list({
      where: { contractLineItemId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Sum the quantity already fulfilled for a contract line item across all
   * fulfillments.
   *
   * @param contractLineItemId - Contract line item ID
   * @returns Total quantity fulfilled
   */
  async getTotalFulfilledForContractLine(
    contractLineItemId: string,
  ): Promise<number> {
    const items = await this.findByContractLineItem(contractLineItemId);
    return items.reduce((sum, item) => sum + item.quantityFulfilled, 0);
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all fulfillment line items belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of fulfillment line items for the tenant
   */
  async findByTenant(tenantId: string): Promise<FulfillmentLineItem[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global fulfillment line items (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global fulfillment line items
   */
  async findGlobal(): Promise<FulfillmentLineItem[]> {
    return queryGlobal<FulfillmentLineItem>(this);
  }

  /**
   * Find fulfillment line items for a tenant including global line items.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global fulfillment line items
   */
  async findWithGlobals(tenantId: string): Promise<FulfillmentLineItem[]> {
    return queryWithGlobals<FulfillmentLineItem>(
      this,
      tenantId,
      'FulfillmentLineItem.findWithGlobals',
    );
  }
}
