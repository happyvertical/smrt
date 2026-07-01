/**
 * PaymentInstrument model - a reusable saved payment method ("card on file").
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type PaymentInstrumentOptions,
  PaymentInstrumentStatus,
} from '../types/index.js';

/**
 * PaymentInstrument stores a reusable payment method a customer has saved with
 * a payment backend (e.g. a card vaulted by Stripe), so it can be charged later
 * without the customer present.
 *
 * It holds only **references and non-sensitive display metadata** — the
 * provider customer id (`cus_...`), the provider payment-method id (`pm_...`),
 * and card display fields (brand / last4 / expiry). The actual card number is
 * vaulted by the payment backend and is never stored here.
 *
 * @example
 * ```typescript
 * const instrument = await instruments.create({
 *   customerId: customer.id,
 *   backendId: 'stripe',
 *   providerCustomerId: 'cus_123',
 *   providerPaymentMethodId: 'pm_123',
 *   brand: 'visa',
 *   last4: '4242',
 *   expMonth: 12,
 *   expYear: 2030,
 *   isDefault: true,
 * });
 * await instrument.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'],
    writable: [
      'customerId',
      'backendId',
      'providerCustomerId',
      'providerPaymentMethodId',
      'type',
      'brand',
      'last4',
      'expMonth',
      'expYear',
      'isDefault',
      'status',
    ],
  },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class PaymentInstrument extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation. Nullable to support both
   * tenant-scoped and global instruments.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Customer this saved method belongs to.
   */
  @foreignKey('Customer')
  customerId: string = '';

  /**
   * Stable identifier of the `PaymentBackend` adapter that vaulted the method —
   * e.g. `stripe`. Mirrors {@link Payment.backendId}.
   */
  backendId: string = '';

  /**
   * Provider customer reference (e.g. a Stripe `cus_...`). A reference, not
   * card data.
   */
  providerCustomerId: string = '';

  /**
   * Provider payment-method reference (e.g. a Stripe `pm_...`). Used, together
   * with {@link providerCustomerId}, to charge the saved method off-session. A
   * reference, not card data.
   */
  providerPaymentMethodId: string = '';

  /**
   * Instrument type as reported by the backend — e.g. `card`,
   * `us_bank_account`.
   */
  type: string = 'card';

  /**
   * Card brand for display (e.g. `visa`). Display-only, not PCI-sensitive.
   */
  brand: string = '';

  /**
   * Last four digits for display. Not the full card number.
   */
  last4: string = '';

  /**
   * Card expiry month (1–12). `0` when unknown / not a card.
   */
  expMonth: number = 0;

  /**
   * Card expiry year (four digits). `0` when unknown / not a card.
   */
  expYear: number = 0;

  /**
   * Whether this is the customer's default instrument. Use
   * {@link PaymentInstrumentCollection.setDefaultForCustomer} to flip the
   * default so only one instrument per customer is marked default.
   */
  isDefault: boolean = false;

  /**
   * Lifecycle status — `active` while chargeable, `expired` once the card has
   * lapsed, `removed` when the customer detaches it.
   */
  status: PaymentInstrumentStatus = PaymentInstrumentStatus.ACTIVE;

  constructor(options: PaymentInstrumentOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.customerId !== undefined) this.customerId = options.customerId;
    if (options.backendId !== undefined) this.backendId = options.backendId;
    if (options.providerCustomerId !== undefined)
      this.providerCustomerId = options.providerCustomerId;
    if (options.providerPaymentMethodId !== undefined)
      this.providerPaymentMethodId = options.providerPaymentMethodId;
    if (options.type !== undefined) this.type = options.type;
    if (options.brand !== undefined) this.brand = options.brand;
    if (options.last4 !== undefined) this.last4 = options.last4;
    if (options.expMonth !== undefined) this.expMonth = options.expMonth;
    if (options.expYear !== undefined) this.expYear = options.expYear;
    if (options.isDefault !== undefined) this.isDefault = options.isDefault;
    if (options.status !== undefined) this.status = options.status;
  }

  /**
   * True while the instrument is active (chargeable).
   */
  isActive(): boolean {
    return this.status === PaymentInstrumentStatus.ACTIVE;
  }

  /**
   * True once the instrument has been marked expired.
   */
  isExpired(): boolean {
    return this.status === PaymentInstrumentStatus.EXPIRED;
  }

  /**
   * True once the instrument has been removed/detached.
   */
  isRemoved(): boolean {
    return this.status === PaymentInstrumentStatus.REMOVED;
  }

  /**
   * Mark the instrument expired (e.g. the card lapsed). A removed instrument
   * is not revived by this.
   */
  markExpired(): void {
    if (this.status === PaymentInstrumentStatus.REMOVED) return;
    this.status = PaymentInstrumentStatus.EXPIRED;
  }

  /**
   * Mark the instrument removed/detached and clear its default flag.
   */
  markRemoved(): void {
    this.status = PaymentInstrumentStatus.REMOVED;
    this.isDefault = false;
  }
}

export default PaymentInstrument;
