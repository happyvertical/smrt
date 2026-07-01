/**
 * PaymentInstrumentCollection - Collection manager for PaymentInstrument objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { PaymentInstrument } from '../models/PaymentInstrument.js';
import { PaymentInstrumentStatus } from '../types/index.js';

export class PaymentInstrumentCollection extends SmrtCollection<PaymentInstrument> {
  static readonly _itemClass = PaymentInstrument;

  /**
   * Find all instruments saved by a customer, newest first.
   *
   * @param customerId - Customer ID
   * @returns Array of instruments
   */
  async findByCustomer(customerId: string): Promise<PaymentInstrument[]> {
    return await this.list({
      where: { customerId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find a customer's active instruments, newest first.
   *
   * @param customerId - Customer ID
   * @returns Array of active instruments
   */
  async findActiveByCustomer(customerId: string): Promise<PaymentInstrument[]> {
    return await this.list({
      where: { customerId, status: PaymentInstrumentStatus.ACTIVE },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find a customer's default instrument, or null if none is set.
   *
   * @param customerId - Customer ID
   * @returns The default instrument or null
   */
  async findDefaultForCustomer(
    customerId: string,
  ): Promise<PaymentInstrument | null> {
    const results = await this.list({
      where: { customerId, isDefault: true },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find an instrument by its provider payment-method reference (e.g. a Stripe
   * `pm_...`).
   *
   * @param providerPaymentMethodId - Provider payment-method id
   * @returns The instrument or null
   */
  async findByProviderPaymentMethodId(
    providerPaymentMethodId: string,
  ): Promise<PaymentInstrument | null> {
    const results = await this.list({
      where: { providerPaymentMethodId },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Make one of a customer's instruments the default, clearing the flag on the
   * others so only a single default is ever set. Only rows whose flag actually
   * changes are re-saved.
   *
   * @param customerId - Customer ID
   * @param instrumentId - The instrument to make default
   */
  async setDefaultForCustomer(
    customerId: string,
    instrumentId: string,
  ): Promise<void> {
    const instruments = await this.findByCustomer(customerId);
    for (const instrument of instruments) {
      const shouldBeDefault = instrument.id === instrumentId;
      if (instrument.isDefault !== shouldBeDefault) {
        instrument.isDefault = shouldBeDefault;
        await instrument.save();
      }
    }
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all instruments belonging to a specific tenant.
   *
   * @param tenantId - Tenant ID
   * @returns Array of instruments for the tenant
   */
  async findByTenant(tenantId: string): Promise<PaymentInstrument[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global instruments (not associated with any tenant). Routes
   * through the shared tenant-global helper so it does not throw under an
   * active tenant context. (#1600)
   *
   * @returns Array of global instruments
   */
  async findGlobal(): Promise<PaymentInstrument[]> {
    return queryGlobal<PaymentInstrument>(this);
  }

  /**
   * Find instruments for a tenant including global instruments. Fails closed if
   * an active tenant context requests a different tenant's rows. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global instruments
   */
  async findWithGlobals(tenantId: string): Promise<PaymentInstrument[]> {
    return queryWithGlobals<PaymentInstrument>(
      this,
      tenantId,
      'PaymentInstrument.findWithGlobals',
    );
  }
}
