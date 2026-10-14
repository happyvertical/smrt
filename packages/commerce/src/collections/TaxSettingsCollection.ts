import { SmrtCollection } from '@happyvertical/smrt-core';
import { MONEY_MIGRATION_WRITE } from '../document-money-internal.js';
import { TaxSettings } from '../models/TaxSettings.js';
import { MoneyValidationError } from '../money.js';
import { createOrLoadTaxSeed, deterministicTaxId } from '../tax/identity.js';

export class TaxSettingsCollection extends SmrtCollection<TaxSettings> {
  static readonly _itemClass = TaxSettings;

  async getOrCreateForTenant(tenantId: string): Promise<TaxSettings> {
    const existing = await this.getForTenant(tenantId);
    if (existing) return existing;
    const id = await deterministicTaxId(tenantId, 'settings', 'default');
    return createOrLoadTaxSeed(
      () => this.create({ id, tenantId }),
      async () =>
        (await this.list({ where: { tenantId }, limit: 1 }))[0] ?? null,
    );
  }

  async getForTenant(tenantId: string): Promise<TaxSettings | null> {
    const listed = (await this.list({ where: { tenantId }, limit: 1 }))[0];
    if (!listed?.id) return listed ?? null;
    return (await this.get({ id: listed.id }, { cache: false })) ?? null;
  }

  /** Claim exclusive runtime maintenance before any per-document rewrite. */
  async beginMoneyMigration(tenantId: string): Promise<string> {
    const current = await this.getOrCreateForTenant(tenantId);
    if (current.moneyModel === 'v2')
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Tenant money model is already v2',
      );
    if (current.moneyModel === 'migrating')
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Tenant money migration is already in progress',
      );
    const migrationId = crypto.randomUUID();
    current.moneyModel = 'migrating';
    current.moneyMigrationId = migrationId;
    await current.saveMoneyModel(MONEY_MIGRATION_WRITE);
    return migrationId;
  }

  async activateMoneyV2(tenantId: string, migrationId: string): Promise<void> {
    const current = await this.requireMigrationOwner(tenantId, migrationId);
    current.moneyModel = 'v2';
    current.moneyMigrationId = '';
    await current.saveMoneyModel(MONEY_MIGRATION_WRITE);
  }

  async restoreLegacyMoneyModel(
    tenantId: string,
    migrationId: string,
  ): Promise<void> {
    const current = await this.requireMigrationOwner(tenantId, migrationId);
    current.moneyModel = 'legacy';
    current.moneyMigrationId = '';
    await current.saveMoneyModel(MONEY_MIGRATION_WRITE);
  }

  private async requireMigrationOwner(
    tenantId: string,
    migrationId: string,
  ): Promise<TaxSettings> {
    const current = await this.getForTenant(tenantId);
    if (
      current?.moneyModel !== 'migrating' ||
      !migrationId ||
      current.moneyMigrationId !== migrationId
    ) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Tenant money migration owner does not match',
      );
    }
    return current;
  }
}
