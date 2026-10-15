import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import {
  MONEY_MIGRATION_WRITE,
  type MoneyMigrationWriteCapability,
} from '../document-money-internal.js';
import { MoneyValidationError } from '../money.js';
import type { TaxSettingsOptions } from '../types/index.js';

/**
 * Instances whose caller chose `moneyModel`. Kept outside the instance so it
 * never becomes a column or round-trips through generated serialization.
 */
const explicitMoneyModel = new WeakSet<TaxSettings>();

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

  /**
   * Server-owned runtime semantics gate. Never exposed as a generated write.
   * The field default is the schema default; a tenant's first saved row
   * chooses `v2` or `legacy` from its stored documents (#4009).
   */
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
    if (options.moneyModel !== undefined) {
      this.moneyModel = options.moneyModel;
      explicitMoneyModel.add(this);
    }
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
      if (!allowMoneyModelWrite) {
        // A new instance upserts on the tenant_id natural key, so the marker
        // row may be found by tenant rather than by this instance's id. Lock
        // and re-read that row on this save transaction so a migration claim
        // cannot commit between this check and the natural-key upsert.
        const tenantKey = this.tenantId || getTenantId() || '';
        const { lockTenantMoneyBootstrap, initialTenantMoneyModel } =
          await import('../tenant-money-default.js');
        // A first insert decides the tenant money model below; serialize it
        // with every other first-marker decision for this tenant.
        if (tenantKey && !this.isPersisted)
          await lockTenantMoneyBootstrap(this.db, tenantKey);
        const { TaxSettingsCollection } = await import(
          '../collections/TaxSettingsCollection.js'
        );
        const persistedByTenant = tenantKey
          ? await (
              await TaxSettingsCollection.create({ db: this.db })
            ).lockForTenant(tenantKey, false)
          : null;
        const persistedById = this.id
          ? await this.db.get(this.tableName, { id: this.id })
          : null;
        if (
          (persistedByTenant &&
            (persistedByTenant.moneyModel !== this.moneyModel ||
              persistedByTenant.moneyMigrationId !== this.moneyMigrationId)) ||
          (persistedById &&
            (persistedById.money_model !== this.moneyModel ||
              (persistedById.money_migration_id ?? '') !==
                this.moneyMigrationId))
        )
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Tenant money model is server-managed',
          );
        // With no marker row to lock, a normal natural-key upsert could race
        // the migration's first marker insert and overwrite its claimed state.
        // Keep the first ordinary save insert-only so that collision refuses
        // the stale save instead of updating the newly committed marker.
        if (!persistedByTenant && !this.isPersisted) {
          this.requireInsertOnSave();
          // The tenant's first marker row: with no caller-chosen model, a
          // tenant with no stored Invoice or Contract rows starts on v2 and
          // one with documents stays legacy until migrated (#4009).
          if (tenantKey && !explicitMoneyModel.has(this))
            this.moneyModel = await initialTenantMoneyModel(this.db, tenantKey);
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
