/**
 * Customer model - links to Profile with customer-specific data
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  method,
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
  writeThrough: {
    profileId: {
      fields: ['name', 'email'],
      virtualFields: {
        phone: {
          type: 'text',
          description: 'A phone number for reaching this person.',
          ui: { widget: 'phone' },
        },
      },
    },
  },
  display: {
    list: ['status', 'email', 'phone'],
    label: { via: 'profileId', field: 'name', fallback: 'Unnamed customer' },
  },
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
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
    description: 'Choose an existing contact, or enter a new name above.',
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
    default: 'active',
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
  /** Virtual fields owned by the linked Profile, never Customer columns. */

  protected override async writeThroughDefaults(
    via: string,
  ): Promise<Record<string, unknown>> {
    if (via !== 'profileId') return super.writeThroughDefaults(via);
    const { ProfileTypeCollection } = await import(
      '@happyvertical/smrt-profiles'
    );
    const types = await ProfileTypeCollection.create({ db: this.db });
    const person = await types.getOrCreateBySlug('person', {
      name: 'Person',
      description: 'Individual person profile',
    });
    return { typeId: person.id };
  }

  @method({ expose: false })
  static override async resolveWriteThroughVirtualProjection(
    via: string,
    options: import('@happyvertical/smrt-core').SmrtObjectOptions,
  ): Promise<Record<string, { sql: string; values: unknown[] }>> {
    if (via !== 'profileId')
      return super.resolveWriteThroughVirtualProjection(via, options);
    const { ProfileMetadataCollection, ProfileMetafieldCollection } =
      await import('@happyvertical/smrt-profiles');
    const metadata = await ProfileMetadataCollection.create(options);
    const metafields = await ProfileMetafieldCollection.create(options);
    // The public column projections validate field policy and run each owning
    // collection's authorization and tenant interceptors, without fetching rows.
    const fields = await metafields.buildProjectionQuery({
      where: { slug: 'phone' },
      select: ['id', 'tenantId'],
    });
    const rows = await metadata.buildProjectionQuery({
      select: ['profileId', 'metafieldId', 'tenantId', 'value'],
    });
    const fieldSql = fields.sql.replace(
      /\$(\d+)/g,
      (_, index: string) => `$${Number(index) + rows.values.length}`,
    );
    return {
      phone: {
        sql: `SELECT m."profileId" AS "id", m."tenantId", m."value" FROM (${rows.sql}) m JOIN (${fieldSql}) f ON f."id" = m."metafieldId" AND (f."tenantId" = m."tenantId" OR f."tenantId" IS NULL)`,
        values: [...rows.values, ...fields.values],
      },
    };
  }

  protected override async readWriteThroughVirtual(
    via: string,
    target: SmrtObject,
  ): Promise<Record<string, unknown>> {
    if (via !== 'profileId') return super.readWriteThroughVirtual(via, target);
    const profile = target as import('@happyvertical/smrt-profiles').Profile;
    return { phone: (await profile.getMetadata()).phone ?? '' };
  }

  protected override async saveWriteThroughVirtual(
    via: string,
    target: SmrtObject,
    values: Record<string, unknown>,
  ): Promise<void> {
    if (via !== 'profileId')
      return super.saveWriteThroughVirtual(via, target, values);
    if (!Object.hasOwn(values, 'phone')) return;
    if (typeof values.phone !== 'string') throw new Error('Phone must be text');
    const profile = target as import('@happyvertical/smrt-profiles').Profile;
    // Empty optional controls mean no phone. Metadata values remain required.
    if (!values.phone.trim()) {
      if (Object.hasOwn(await profile.getMetadata(), 'phone'))
        await profile.removeMetadata('phone');
      return;
    }
    const { ProfileMetafieldCollection } = await import(
      '@happyvertical/smrt-profiles'
    );
    const metafields = await ProfileMetafieldCollection.create({ db: this.db });
    await metafields.getOrUpsert(
      { slug: 'phone', tenantId: this.tenantId },
      {
        name: 'Phone',
        validation: { type: 'string' },
      },
    );
    await profile.addMetadata('phone', values.phone);
  }

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
