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
}
