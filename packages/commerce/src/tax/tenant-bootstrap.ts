import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';
import { activateCleanTenantMoneyV2 } from '../tenant-money-barrier.js';
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
 * the `v2` money model. Every step is idempotent, so a retry after a partial
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
    activateCleanTenantMoneyV2(db, tenantId),
  );
  return { tenantId, moneyModel };
}
