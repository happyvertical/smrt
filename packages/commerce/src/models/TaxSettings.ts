import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  MONEY_MIGRATION_WRITE,
  type MoneyMigrationWriteCapability,
} from '../document-money-internal.js';
import { MoneyValidationError } from '../money.js';
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

  /** Server-owned runtime semantics gate. Never exposed as a generated write. */
  moneyModel: 'legacy' | 'migrating' | 'v2' = 'legacy';

  /** Opaque owner token while a tenant migration is in progress. */
  moneyMigrationId = '';

  @field({
    sensitive: true,
    transient: true,
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
    if (options.moneyModel !== undefined) this.moneyModel = options.moneyModel;
    if (options.moneyMigrationId !== undefined)
      this.moneyMigrationId = options.moneyMigrationId;
  }

  override async save(): Promise<this> {
    return this.saveValidated(false);
  }

  /** @internal Money migration owns marker transitions. */
  async saveMoneyModel(
    capability: MoneyMigrationWriteCapability,
  ): Promise<this> {
    if (capability !== MONEY_MIGRATION_WRITE) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Tenant money model requires the migration capability',
      );
    }
    return this.saveValidated(true);
  }

  /** @internal Caller already owns the transaction-bound migration barrier. */
  async saveMoneyModelOnTransaction(
    capability: MoneyMigrationWriteCapability,
  ): Promise<this> {
    if (capability !== MONEY_MIGRATION_WRITE) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Tenant money model requires the migration capability',
      );
    }
    return this.saveValidated(true, true);
  }

  private async saveValidated(
    allowMoneyModelWrite: boolean,
    transactionBound = false,
  ): Promise<this> {
    if (
      !['exclusive', 'inclusive', 'none'].includes(this.defaultLineAmountType)
    )
      throw new Error('Tax settings defaultLineAmountType is invalid');
    if (!['line', 'document'].includes(this.taxRoundingScope))
      throw new Error('Tax settings taxRoundingScope is invalid');
    if (!['legacy', 'migrating', 'v2'].includes(this.moneyModel))
      throw new Error('Tax settings moneyModel is invalid');
    if ((this.moneyModel === 'migrating') !== !!this.moneyMigrationId)
      throw new Error(
        'Tax settings migrating state requires exactly one migration owner',
      );
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
    const persist = async (): Promise<this> => {
      const { TaxCodeCollection } = await import(
        '../collections/TaxCodeCollection.js'
      );
      const { TaxComponentCollection } = await import(
        '../collections/TaxComponentCollection.js'
      );
      const codes = await TaxCodeCollection.create({ db: this.db });
      const components = await TaxComponentCollection.create({ db: this.db });
      if (!allowMoneyModelWrite && this.id) {
        const persisted = await this.db.get(this.tableName, { id: this.id });
        if (
          persisted &&
          (persisted.money_model !== this.moneyModel ||
            (persisted.money_migration_id ?? '') !== this.moneyMigrationId)
        ) {
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Tenant money model is server-managed',
          );
        }
      }
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
    };
    return transactionBound ? persist() : this.withTransaction(persist);
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
