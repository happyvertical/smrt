import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';
import { selectCleanTenantMoneyModel } from '../tenant-money-barrier.js';
import { applyCommerceCookbookSettings } from './cookbook.js';
import { ensureTenantTaxCodes } from './legacy.js';

export interface EnsureCommerceTenantOptions {
  /**
   * The application's validated cookbook. Its commerce policy rows set the
   * tenant's default tax code, `pricesIncludeTax` and `taxRounding` through
   * {@link applyCommerceCookbookSettings}. Omit it to seed only the standard
   * exempt, zero-rated and out-of-scope codes.
   */
  readonly cookbook?: Pick<Cookbook, 'policies'>;
  /**
   * The money model for a tenant with no documents. Defaults to `v2`. Pass
   * `legacy` for a billing seller tenant: billing period close cannot write
   * money-v2 invoices yet (#4013). `legacy` also returns an empty `v2`
   * tenant to `legacy`; a `v2` tenant with documents is refused.
   */
  readonly moneyModel?: 'legacy' | 'v2';
}

export interface CommerceTenantBootstrap {
  readonly tenantId: string;
  /**
   * `v2` for a tenant with no stored Invoice or Contract rows. `legacy` when
   * documents already exist: run `smrt db:migrate-commerce-money` for them.
   */
  readonly moneyModel: 'legacy' | 'v2';
}

/**
 * The one commerce call a host makes after it creates a tenant (#4009).
 *
 * Seeds the tenant's standard tax codes, applies the cookbook's commerce tax
 * settings when one is given, and moves a tenant with no stored documents to
 * the `v2` money model (or `options.moneyModel`). Every step is idempotent, so a retry after a partial
 * failure converges; re-running with a cookbook re-applies its defaults over
 * the tenant's current default codes, amount type and rounding scope.
 *
 * Requires installed commerce schema and a database with transactions. The
 * caller owns authority for `tenantId`; this function never derives it.
 */
export async function ensureCommerceTenant(
  db: DatabaseInterface,
  tenantId: string,
  options: EnsureCommerceTenantOptions = {},
): Promise<CommerceTenantBootstrap> {
  if (!tenantId.trim())
    throw new Error('Commerce tenant bootstrap requires a tenant');
  if (!db.transaction)
    throw new Error('Commerce tenant bootstrap requires transactions');
  await db.transaction((tx) => ensureTenantTaxCodes(tx, tenantId));
  if (options.cookbook)
    await applyCommerceCookbookSettings(db, tenantId, options.cookbook);
  const moneyModel = await withTenant({ tenantId }, () =>
    selectCleanTenantMoneyModel(db, tenantId, options.moneyModel ?? 'v2'),
  );
  return { tenantId, moneyModel };
}
