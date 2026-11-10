import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  SmrtCollection,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { lockDocumentMoneyParents } from '../document-money-internal.js';
import { TaxSettings } from '../models/TaxSettings.js';
import { MoneyValidationError } from '../money.js';
import { createOrLoadTaxSeed, deterministicTaxId } from '../tax/identity.js';
import { assertTenantMoneyCurrent } from '../upgrade/detect.js';

/**
 * Serialize settings-row creation for one tenant on PostgreSQL. The lock is
 * transaction-scoped; embedded engines are already single-writer through the
 * core embedded write queue that every model transaction enters.
 */
async function lockTenantSettingsCreation(
  db: DatabaseInterface,
  tenantId: string,
): Promise<void> {
  if (!isPostgresDatabase(db)) return;
  await db.query(
    'SELECT pg_advisory_xact_lock(hashtext(CAST(? AS TEXT)))',
    `smrt-commerce-tax-settings:${tenantId}`,
  );
}

/**
 * @internal Create a tenant's missing settings row exactly once, with the
 * model defaults. Creation serializes on a tenant advisory lock (PostgreSQL)
 * or the embedded write queue and re-reads before inserting, so racing first
 * writers converge on one row. An existing row is never changed.
 */
export async function materializeTenantTaxSettings(
  db: DatabaseInterface,
  tenantId: string,
): Promise<void> {
  const id = await deterministicTaxId(tenantId, 'settings', 'default');
  await withEmbeddedWriteTransaction(db, isEmbeddedDatabase(db), async (tx) => {
    await lockTenantSettingsCreation(tx, tenantId);
    const settings = await TaxSettingsCollection.create({ db: tx });
    if (await settings.getForTenant(tenantId)) return;
    await createOrLoadTaxSeed(
      () => settings.create({ id, tenantId }),
      async () =>
        (await settings.list({ where: { tenantId }, limit: 1 }))[0] ?? null,
    );
  });
}

export class TaxSettingsCollection extends SmrtCollection<TaxSettings> {
  static readonly _itemClass = TaxSettings;

  /**
   * Load the tenant's settings row, creating it once when missing. A tenant
   * whose stored documents predate tenant tax settings is refused with
   * `COMMERCE_DATA_NEEDS_UPGRADE` rather than given fresh defaults.
   */
  async getOrCreateForTenant(tenantId: string): Promise<TaxSettings> {
    await assertTenantMoneyCurrent(this.db, tenantId);
    const existing = await this.getForTenant(tenantId);
    if (existing) return existing;
    await materializeTenantTaxSettings(this.db, tenantId);
    const created = await this.getForTenant(tenantId);
    if (!created)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant tax settings could not be materialized',
      );
    return created;
  }

  async getForTenant(tenantId: string): Promise<TaxSettings | null> {
    const listed = (await this.list({ where: { tenantId }, limit: 1 }))[0];
    if (!listed?.id) return listed ?? null;
    return (await this.get({ id: listed.id }, { cache: false })) ?? null;
  }

  /** @internal Lock and re-read the tenant's settings row on this transaction. */
  async lockForTenant(tenantId: string): Promise<TaxSettings> {
    const first = await this.getOrCreateForTenant(tenantId);
    if (!first.id)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant tax settings have no identity',
      );
    await lockDocumentMoneyParents([
      { id: first.id, tenantId, collection: this },
    ]);
    const locked = await this.getForTenant(tenantId);
    if (!locked || locked.id !== first.id)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Tenant tax settings changed while acquiring the lock',
      );
    return locked;
  }
}
