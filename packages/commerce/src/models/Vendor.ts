/**
 * Vendor model - links to Profile with vendor-specific data
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { VendorStatus } from '../types/index.js';

/**
 * Vendor represents the vendor/supplier role for a Profile.
 *
 * One Profile can have both Customer and Vendor records - e.g., a company
 * you both buy from and sell to.
 *
 * @example
 * ```typescript
 * const vendor = await vendors.create({
 *   profileId: 'profile-uuid',
 *   leadTimeDays: 14,
 *   minimumOrderAmount: 500,
 *   paymentTerms: 'Net 60'
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Vendor extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global vendors
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Reference to smrt-profiles Profile
   * Plain string for cross-package reference
   */
  profileId: string = '';

  /**
   * Typical lead time in days for orders
   */
  leadTimeDays: number = 0;

  /**
   * Minimum order amount required
   */
  minimumOrderAmount: number = 0.0;

  /**
   * Payment terms for this vendor (e.g., "Net 60")
   */
  paymentTerms: string = '';

  /**
   * Default currency for transactions with this vendor
   */
  currency: string = 'USD';

  /**
   * Default contact email for orders
   */
  defaultContactEmail: string = '';

  /**
   * Default contact phone for orders
   */
  defaultContactPhone: string = '';

  /**
   * Vendor status
   */
  status: VendorStatus = VendorStatus.ACTIVE;

  /**
   * Internal notes about this vendor
   */
  notes: string = '';

  /**
   * Per-currency payout destinations for this vendor.
   *
   * Stored as a JSON column. Keys are payout-rail-qualified currency codes —
   * the code must encode both the asset and the rail (e.g. `USDC-base`,
   * `USDC-solana`, `BTC`, `USD-stripe`, `USD-wire`). Values are whatever the
   * receiving rail needs as a destination (EVM address, BTC address, Stripe
   * Connect account id, IBAN, etc.).
   *
   * MVP shape: a flat map on the vendor row. A vendor with no entry for a
   * given currency cannot be paid in that currency — filtering is the
   * consumer's responsibility (the upstream `PaymentIntent` builder filters
   * `paymentOptions` at quote time against this map).
   *
   * Use {@link getPayoutAddress} for a `Map.get`-style lookup that returns
   * `undefined` for missing entries; direct property access is also fine.
   */
  payoutAddresses: Record<string, string> = {};

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.leadTimeDays !== undefined)
      this.leadTimeDays = options.leadTimeDays;
    if (options.minimumOrderAmount !== undefined)
      this.minimumOrderAmount = options.minimumOrderAmount;
    if (options.paymentTerms !== undefined)
      this.paymentTerms = options.paymentTerms;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.defaultContactEmail !== undefined)
      this.defaultContactEmail = options.defaultContactEmail;
    if (options.defaultContactPhone !== undefined)
      this.defaultContactPhone = options.defaultContactPhone;
    if (options.status !== undefined) this.status = options.status;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.payoutAddresses !== undefined) {
      this.payoutAddresses = Vendor.normalizePayoutAddresses(
        options.payoutAddresses,
      );
    }
  }

  /**
   * The framework's {@link SmrtObject.initialize} re-applies `options` keys on
   * top of constructor-set values so option data always wins over field
   * initializers. That means our constructor's normalization runs *before*
   * `initializePropertiesFromOptions` overwrites `payoutAddresses` with the
   * raw cloned value. Re-normalize once super has finished so consumers
   * who pass a string, a partially-typed map, or `null` end up with a
   * clean `Record<string, string>` before any save / read happens.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.payoutAddresses = Vendor.normalizePayoutAddresses(
      this.payoutAddresses as unknown,
    );
    return this;
  }

  /**
   * Save with a final normalization pass so direct field assignments
   * (`vendor.payoutAddresses = somethingFunny`) can't smuggle non-string
   * values into the persisted row.
   */
  override async save(): Promise<this> {
    this.payoutAddresses = Vendor.normalizePayoutAddresses(
      this.payoutAddresses as unknown,
    );
    return super.save() as Promise<this>;
  }

  /**
   * Check if vendor is active
   */
  isActive(): boolean {
    return this.status === VendorStatus.ACTIVE;
  }

  /**
   * Check if order meets minimum requirements
   */
  meetsMinimumOrder(amount: number): boolean {
    return amount >= this.minimumOrderAmount;
  }

  /**
   * Get the profile ID for external lookup.
   *
   * To get the actual Profile object, use the ProfileCollection from smrt-profiles:
   * ```typescript
   * const profiles = await ProfileCollection.create(options);
   * const profile = await profiles.get({ id: vendor.profileId });
   * ```
   *
   * @returns The profile ID or empty string if not set
   */
  getProfileId(): string {
    return this.profileId;
  }

  /**
   * Look up the payout destination for a single currency. Returns
   * `undefined` if the vendor has no entry for that currency — caller's
   * job to decide whether that means "skip the option" or "raise a
   * configuration error". The lookup is case-sensitive; the contract is
   * that the currency code passed in matches exactly what was stored
   * (`USDC-base`, not `usdc-base`).
   */
  getPayoutAddress(currency: string): string | undefined {
    const map = this.payoutAddresses;
    if (!map || typeof map !== 'object') return undefined;
    const value = (map as Record<string, unknown>)[currency];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Set the payout destination for a single currency. Mutates the live
   * map and returns `this` for chaining. Use {@link clearPayoutAddress}
   * to remove a single entry.
   */
  setPayoutAddress(currency: string, destination: string): this {
    this.payoutAddresses = {
      ...(this.payoutAddresses ?? {}),
      [currency]: destination,
    };
    return this;
  }

  /**
   * Remove a single currency entry from the payout map. No-op if the
   * currency was already absent.
   */
  clearPayoutAddress(currency: string): this {
    if (!this.payoutAddresses || !(currency in this.payoutAddresses)) {
      return this;
    }
    const next = { ...this.payoutAddresses };
    delete next[currency];
    this.payoutAddresses = next;
    return this;
  }

  /**
   * Normalize an input value (object, pre-serialized JSON string, or
   * `null`/`undefined`) into a plain `Record<string, string>`. Used by
   * the constructor so consumers can pass either shape into
   * `VendorCollection.create({ payoutAddresses: ... })`.
   *
   * Non-string values inside an input object are silently dropped — a
   * `Record<string, string>` invariant is what consumers downstream
   * (`PaymentIntent` builders, payout SDK adapters) rely on.
   */
  private static normalizePayoutAddresses(
    value: unknown,
  ): Record<string, string> {
    if (value == null) return {};
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return {};
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[key] = v;
    }
    return out;
  }
}

export default Vendor;
