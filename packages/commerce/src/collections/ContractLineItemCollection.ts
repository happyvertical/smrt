/**
 * ContractLineItemCollection - Collection manager for ContractLineItem objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContractLineItem } from '../models/ContractLineItem.js';

export class ContractLineItemCollection extends SmrtCollection<ContractLineItem> {
  static readonly _itemClass = ContractLineItem;

  /**
   * Find contract line items by their parent contract.
   *
   * @param contractId - Contract ID
   * @returns Array of contract line items, sorted by sortOrder
   */
  async findByContract(contractId: string): Promise<ContractLineItem[]> {
    return await this.list({
      where: { contractId },
      orderBy: 'sortOrder ASC',
    });
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all contract line items belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of contract line items for the tenant
   */
  async findByTenant(tenantId: string): Promise<ContractLineItem[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global contract line items (not associated with any tenant)
   *
   * @returns Array of global contract line items
   */
  async findGlobal(): Promise<ContractLineItem[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find contract line items for a tenant including global line items
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global contract line items
   */
  async findWithGlobals(tenantId: string): Promise<ContractLineItem[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
