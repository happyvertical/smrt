import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { TaxSettingsOptions } from '../types/index.js';

export interface TaxRegistration {
  taxComponentId: string;
  number: string;
  label: string;
}

/** Tenant-level defaults and registration numbers for tax determination. */
@TenantScoped({ mode: 'required' })
@smrt({
  conflictColumns: ['tenant_id'],
  api: {
    include: ['get', 'create', 'update'],
    writable: [
      'defaultSalesTaxCodeId',
      'defaultPurchaseTaxCodeId',
      'defaultLineAmountType',
      'taxRoundingScope',
      'taxRegistrations',
    ],
  },
  mcp: { include: ['get'] },
  cli: { skipApiCheck: true },
})
export class TaxSettings extends SmrtObject {
  @tenantId()
  tenantId = '';

  @foreignKey('TaxCode', {
    description: 'The default tax code for sales documents.',
  })
  defaultSalesTaxCodeId = '';

  @foreignKey('TaxCode', {
    description: 'The default tax code for purchase documents.',
  })
  defaultPurchaseTaxCodeId = '';

  @field({
    description:
      'Whether new document amounts are exclusive, inclusive or out of scope.',
  })
  defaultLineAmountType: 'exclusive' | 'inclusive' | 'none' = 'exclusive';

  @field({ description: 'Whether components round per line or per document.' })
  taxRoundingScope: 'line' | 'document' = 'line';

  /** Stored JSON is guarded through the typed accessor below. */
  taxRegistrationsJson = '[]';

  @field({
    sensitive: true,
    description:
      'Registration numbers by tax component, for issued-document snapshots.',
  })
  get taxRegistrations(): TaxRegistration[] {
    try {
      const value: unknown = JSON.parse(this.taxRegistrationsJson);
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry): entry is TaxRegistration =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as TaxRegistration).taxComponentId === 'string' &&
          typeof (entry as TaxRegistration).number === 'string' &&
          typeof (entry as TaxRegistration).label === 'string',
      );
    } catch {
      return [];
    }
  }

  set taxRegistrations(value: TaxRegistration[] | string) {
    this.taxRegistrationsJson =
      typeof value === 'string' ? value : JSON.stringify(value);
  }

  constructor(options: TaxSettingsOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.defaultSalesTaxCodeId !== undefined)
      this.defaultSalesTaxCodeId = options.defaultSalesTaxCodeId;
    if (options.defaultPurchaseTaxCodeId !== undefined)
      this.defaultPurchaseTaxCodeId = options.defaultPurchaseTaxCodeId;
    if (options.defaultLineAmountType !== undefined)
      this.defaultLineAmountType = options.defaultLineAmountType;
    if (options.taxRoundingScope !== undefined)
      this.taxRoundingScope = options.taxRoundingScope;
    if (options.taxRegistrations !== undefined)
      this.taxRegistrations = structuredClone(options.taxRegistrations);
  }

  override async save(): Promise<this> {
    if (
      !['exclusive', 'inclusive', 'none'].includes(this.defaultLineAmountType)
    )
      throw new Error('Tax settings defaultLineAmountType is invalid');
    if (!['line', 'document'].includes(this.taxRoundingScope))
      throw new Error('Tax settings taxRoundingScope is invalid');
    const registrations = this.parsedRegistrations();
    if (!registrations)
      throw new Error('Tax registrations must be a valid JSON array');
    if (
      registrations.some(
        (entry) =>
          !entry.taxComponentId || !entry.number.trim() || !entry.label.trim(),
      )
    )
      throw new Error('Tax registrations require component, number and label');
    return this.withTransaction(async () => {
      const { TaxCodeCollection } = await import(
        '../collections/TaxCodeCollection.js'
      );
      const { TaxComponentCollection } = await import(
        '../collections/TaxComponentCollection.js'
      );
      const codes = await TaxCodeCollection.create({ db: this.db });
      const components = await TaxComponentCollection.create({ db: this.db });
      for (const id of [
        this.defaultSalesTaxCodeId,
        this.defaultPurchaseTaxCodeId,
      ].filter(Boolean)) {
        const code = await codes.get({ id }, { cache: false });
        if (!code || code.tenantId !== this.tenantId)
          throw new Error(
            'Tax setting default codes must belong to its tenant',
          );
      }
      for (const registration of registrations) {
        const component = await components.get(
          { id: registration.taxComponentId },
          { cache: false },
        );
        if (!component || component.tenantId !== this.tenantId)
          throw new Error(
            'Tax setting registrations must belong to its tenant',
          );
      }
      return (await super.save()) as this;
    });
  }

  private parsedRegistrations(): TaxRegistration[] | null {
    try {
      const value: unknown = JSON.parse(this.taxRegistrationsJson);
      if (!Array.isArray(value)) return null;
      if (
        value.some(
          (entry) =>
            !entry ||
            typeof entry !== 'object' ||
            typeof (entry as TaxRegistration).taxComponentId !== 'string' ||
            typeof (entry as TaxRegistration).number !== 'string' ||
            typeof (entry as TaxRegistration).label !== 'string',
        )
      )
        return null;
      return value as TaxRegistration[];
    } catch {
      return null;
    }
  }
}
