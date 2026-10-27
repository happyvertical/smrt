/**
 * Customer model - links to Profile with customer-specific data
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { normalizePartyContacts } from '../party-contacts.js';
import {
  type Address,
  type CustomerOptions,
  CustomerStatus,
  CustomerType,
  type PartyContact,
} from '../types/index.js';

/**
 * Customer represents the customer role for a Profile.
 *
 * One Profile can have multiple Customer records (e.g., different business contexts).
 * Customer stores customer-specific data like credit limits and payment terms.
 *
 * @example
 * ```typescript
 * const customer = await customers.create({
 *   profileId: 'profile-uuid',
 *   creditLimit: 10000,
 *   paymentTerms: 'Net 30'
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Customer extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global customers
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Reference to smrt-profiles Profile
   * Plain string for cross-package reference
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    description:
      'Links this customer to their profile record, where their name and contact details are kept.',
  })
  profileId: string = '';

  /**
   * Maximum credit extended to this customer, in **integer minor units**
   * (cents, satoshis).
   *
   * Converts with the rest of commerce because
   * {@link Customer.hasAvailableCredit} compares it directly against a money
   * amount; a dollars-vs-cents split there would approve every request off by
   * a factor of 100 (#2401).
   */
  @field({
    description:
      'The most this customer may owe you at one time. Leave it at zero if you do not set limits.',
    ui: { format: 'money' },
  })
  creditLimit: number = 0;

  /**
   * Payment terms (e.g., "Net 30", "Due on receipt", "2/10 Net 30")
   */
  @field({
    description:
      'How long the customer has to pay, written the way you would say it, for example "Net 30".',
  })
  paymentTerms: string = '';

  /**
   * Whether customer is exempt from tax
   */
  @field({
    description: 'Turn this on if you do not charge this customer sales tax.',
  })
  taxExempt: boolean = false;

  /**
   * Tax identification number
   *
   * Sensitive (#1540): PII excluded from generated API/MCP responses and
   * rejected as a `where` filter key.
   */
  @field({
    sensitive: true,
    description:
      'The tax or VAT number of the customer, kept on file for tax-exempt sales.',
  })
  taxId: string = '';

  /**
   * Tax code normally used for this customer's sales.
   *
   * An exempt customer always resolves to the tenant's exempt code before
   * this preference is considered.
   */
  @foreignKey('TaxCode', {
    description: 'The tax code normally used when selling to this customer.',
  })
  defaultTaxCodeId: string = '';

  /**
   * Default shipping address
   */
  @field({
    description:
      'Where you usually send goods to this customer, so you do not retype it on every order.',
  })
  defaultShippingAddress: Address = {};

  /**
   * Default billing address
   */
  @field({ description: 'Where you send invoices to this customer.' })
  defaultBillingAddress: Address = {};

  /**
   * Customer status
   */
  @field({
    description:
      'Whether you are still dealing with this customer: active, inactive or suspended.',
  })
  status: CustomerStatus = CustomerStatus.ACTIVE;

  /**
   * Customer classification — DTC, wholesale, or retail.
   *
   * Drives channel access (wholesale portal vs. storefront vs. POS), default
   * price tier, and credit terms. Defaults to DTC for backwards compatibility.
   */
  @field({
    description:
      'The kind of customer: a direct shopper, a wholesale buyer or a retail customer.',
  })
  customerType: CustomerType = CustomerType.DTC;

  /**
   * Internal notes about this customer
   */
  @field({
    description: 'Anything worth remembering about this customer.',
    ui: { widget: 'textarea' },
  })
  notes: string = '';

  /**
   * People to reach at this customer, stored as a JSON column (#3501). Write
   * form rows through `savePartyContacts()`; every save normalizes the shape.
   */
  @field({
    description:
      'The people you deal with at this customer, with their role and how to reach them.',
  })
  contacts: PartyContact[] = [];

  constructor(options: CustomerOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.creditLimit !== undefined)
      this.creditLimit = options.creditLimit;
    if (options.paymentTerms !== undefined)
      this.paymentTerms = options.paymentTerms;
    if (options.taxExempt !== undefined) this.taxExempt = options.taxExempt;
    if (options.taxId !== undefined) this.taxId = options.taxId;
    if (options.defaultTaxCodeId !== undefined)
      this.defaultTaxCodeId = options.defaultTaxCodeId;
    if (options.defaultShippingAddress !== undefined)
      this.defaultShippingAddress = options.defaultShippingAddress;
    if (options.defaultBillingAddress !== undefined)
      this.defaultBillingAddress = options.defaultBillingAddress;
    if (options.status !== undefined) this.status = options.status;
    // Treat `null` the same as `undefined` here. Customers loaded from
    // rows written before the `customer_type` column existed will
    // hydrate with the field as SQL `NULL`; without this guard the
    // SmrtObject loader would overwrite the `CustomerType.DTC`
    // initializer with `null`, breaking the documented
    // backwards-compatible default. Explicit string values (including
    // any future custom flavour) still take precedence.
    if (options.customerType !== undefined && options.customerType !== null) {
      this.customerType = options.customerType;
    }
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.contacts !== undefined)
      this.contacts = normalizePartyContacts(options.contacts);
  }

  /**
   * Re-normalize contacts after the framework's option-override pass, which
   * re-applies raw option values (including a stored JSON string).
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.contacts = normalizePartyContacts(this.contacts);
    return this;
  }

  /** Save with a final contacts normalization against direct assignment. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    this.contacts = normalizePartyContacts(this.contacts);
    return super.save(options) as Promise<this>;
  }

  /**
   * Convenience predicate: is this a wholesale customer?
   */
  isWholesale(): boolean {
    return this.customerType === CustomerType.WHOLESALE;
  }

  /**
   * Check if customer is active
   */
  isActive(): boolean {
    return this.status === CustomerStatus.ACTIVE;
  }

  /**
   * Check if customer has available credit
   */
  hasAvailableCredit(amount: number): boolean {
    // In a full implementation, this would check against outstanding balances
    return this.creditLimit >= amount;
  }

  /**
   * Get the profile ID for external lookup.
   *
   * To get the actual Profile object, use the ProfileCollection from smrt-profiles:
   * ```typescript
   * const profiles = await ProfileCollection.create(options);
   * const profile = await profiles.get({ id: customer.profileId });
   * ```
   *
   * @returns The profile ID or empty string if not set
   */
  getProfileId(): string {
    return this.profileId;
  }
}

export default Customer;
