import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  lockDocumentMoneyParents,
  MONEY_MIGRATION_WRITE,
  withDocumentMoneyTransaction,
} from '../document-money-internal.js';
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

  /** @internal Lock and re-read the one tenant marker on this transaction. */
  async lockForTenant(
    tenantId: string,
    create = true,
  ): Promise<TaxSettings | null> {
    const first = create
      ? await this.getOrCreateForTenant(tenantId)
      : await this.getForTenant(tenantId);
    if (!first?.id) return null;
    await lockDocumentMoneyParents([
      { id: first.id, tenantId, collection: this },
    ]);
    const locked = await this.getForTenant(tenantId);
    if (!locked || locked.id !== first.id)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant money settings changed while acquiring the barrier',
      );
    return locked;
  }

  /** Claim exclusive runtime maintenance before any per-document rewrite. */
  async beginMoneyMigration(
    tenantId: string,
    requestedMigrationId?: string,
  ): Promise<string> {
    if (
      requestedMigrationId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestedMigrationId,
      )
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Migration owner identity must be a UUID',
      );
    return withDocumentMoneyTransaction(this.db, async (tx) => {
      const { lockTenantMoneyMigrationClaim } = await import(
        '../tenant-money-barrier.js'
      );
      const current = await lockTenantMoneyMigrationClaim(tx, tenantId);
      const migrationId = requestedMigrationId ?? crypto.randomUUID();
      current.moneyModel = 'migrating';
      current.moneyMigrationId = migrationId;
      await current.saveMoneyModelOnTransaction(MONEY_MIGRATION_WRITE);
      return migrationId;
    });
  }

  async activateMoneyV2(tenantId: string, migrationId: string): Promise<void> {
    await withDocumentMoneyTransaction(this.db, async (tx) => {
      const { lockTenantMoneyMigrationOwner } = await import(
        '../tenant-money-barrier.js'
      );
      const current = await lockTenantMoneyMigrationOwner(
        tx,
        tenantId,
        migrationId,
      );
      current.moneyModel = 'v2';
      current.moneyMigrationId = '';
      await current.saveMoneyModelOnTransaction(MONEY_MIGRATION_WRITE);
    });
  }

  async restoreLegacyMoneyModel(
    tenantId: string,
    migrationId: string,
  ): Promise<void> {
    await withDocumentMoneyTransaction(this.db, async (tx) => {
      const { lockTenantMoneyMigrationOwner } = await import(
        '../tenant-money-barrier.js'
      );
      const current = await lockTenantMoneyMigrationOwner(
        tx,
        tenantId,
        migrationId,
      );
      current.moneyModel = 'legacy';
      current.moneyMigrationId = '';
      await current.saveMoneyModelOnTransaction(MONEY_MIGRATION_WRITE);
    });
  }

  /** Claim a previously completed migration for checksum-guarded rollback. */
  async beginMoneyRollback(
    tenantId: string,
    migrationId: string,
  ): Promise<void> {
    await withDocumentMoneyTransaction(this.db, async (tx) => {
      const current = await (
        await TaxSettingsCollection.create({ db: tx })
      ).lockForTenant(tenantId, false);
      if (current?.moneyModel !== 'v2')
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Money rollback requires an active v2 tenant marker',
        );
      current.moneyModel = 'migrating';
      current.moneyMigrationId = migrationId;
      await current.saveMoneyModelOnTransaction(MONEY_MIGRATION_WRITE);
    });
  }
}
