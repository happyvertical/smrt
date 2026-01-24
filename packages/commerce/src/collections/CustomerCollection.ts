/**
 * CustomerCollection - Collection manager for Customer objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Customer } from '../models/Customer.js';
import { CustomerStatus } from '../types/index.js';

export class CustomerCollection extends SmrtCollection<Customer> {
  static readonly _itemClass = Customer;

  /**
   * Find customers by profile ID
   *
   * @param profileId - Profile ID from smrt-profiles
   * @returns Array of customers linked to this profile
   */
  async findByProfile(profileId: string): Promise<Customer[]> {
    return await this.list({
      where: { profileId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active customers
   *
   * @returns Array of active customers
   */
  async findActive(): Promise<Customer[]> {
    return await this.list({
      where: { status: CustomerStatus.ACTIVE },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find customers by status
   *
   * @param status - Customer status
   * @returns Array of customers
   */
  async findByStatus(status: CustomerStatus): Promise<Customer[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Get or create a customer for a profile
   *
   * @param profileId - Profile ID
   * @param defaults - Default values if creating
   * @returns Customer
   */
  async getOrCreateForProfile(
    profileId: string,
    defaults: Partial<{
      creditLimit: number;
      paymentTerms: string;
    }> = {},
  ): Promise<Customer> {
    const existing = await this.findByProfile(profileId);
    if (existing.length > 0) {
      return existing[0];
    }

    const customer = await this.create({
      profileId,
      creditLimit: defaults.creditLimit ?? 0,
      paymentTerms: defaults.paymentTerms ?? '',
      status: CustomerStatus.ACTIVE,
    });
    await customer.save();
    return customer;
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all customers belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of customers for the tenant
   */
  async findByTenant(tenantId: string): Promise<Customer[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global customers (not associated with any tenant)
   *
   * @returns Array of global customers
   */
  async findGlobal(): Promise<Customer[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find customers for a tenant including global customers
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global customers
   */
  async findWithGlobals(tenantId: string): Promise<Customer[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
