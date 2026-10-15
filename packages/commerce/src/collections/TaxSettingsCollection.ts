import {
  isEmbeddedDatabase,
  SmrtCollection,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  lockDocumentMoneyParents,
  MONEY_MIGRATION_WRITE,
  withDocumentMoneyTransaction,
} from '../document-money-internal.js';
import { TaxSettings } from '../models/TaxSettings.js';
import { MoneyValidationError } from '../money.js';
import { createOrLoadTaxSeed, deterministicTaxId } from '../tax/identity.js';
import { lockTenantMoneyBootstrap } from '../tenant-money-default.js';

/**
 * @internal Create a tenant's missing settings row exactly once.
 *
 * `auto` lets the first save choose the money model from the tenant's stored
 * documents: none means `v2`, any means `legacy` (#4009). `legacy` is the
 * migration claim's starting point, so `smrt db:migrate-commerce-money` keeps
 * its contract for a tenant it sees first. Creation serializes on a tenant
 * advisory lock (PostgreSQL) or the embedded write queue and re-reads before
 * inserting, so racing first writers converge on one row and one model. An
 * existing row is never changed. A plain function, not a collection method,
 * so no generated surface can choose the model.
 */
export async function materializeTenantTaxSettings(
  db: DatabaseInterface,
  tenantId: string,
  initialMoneyModel: 'auto' | 'legacy',
): Promise<void> {
  const id = await deterministicTaxId(tenantId, 'settings', 'default');
  await withEmbeddedWriteTransaction(db, isEmbeddedDatabase(db), async (tx) => {
    await lockTenantMoneyBootstrap(tx, tenantId);
    const settings = await TaxSettingsCollection.create({ db: tx });
    if (await settings.getForTenant(tenantId)) return;
    await createOrLoadTaxSeed(
      () =>
        settings.create({
          id,
          tenantId,
          ...(initialMoneyModel === 'legacy'
            ? { moneyModel: 'legacy' as const }
            : {}),
        }),
      async () =>
        (await settings.list({ where: { tenantId }, limit: 1 }))[0] ?? null,
    );
  });
}

export class TaxSettingsCollection extends SmrtCollection<TaxSettings> {
  static readonly _itemClass = TaxSettings;

  /**
   * Load the tenant's settings row, creating it once when missing. A new row
   * starts on `v2` when the tenant has no stored Invoice or Contract rows and
   * on `legacy` otherwise (#4009); see {@link materializeTenantTaxSettings}.
   */
  async getOrCreateForTenant(tenantId: string): Promise<TaxSettings> {
    const existing = await this.getForTenant(tenantId);
    if (existing) return existing;
    await materializeTenantTaxSettings(this.db, tenantId, 'auto');
    const created = await this.getForTenant(tenantId);
    if (!created)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant money settings could not be materialized',
      );
    return created;
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
