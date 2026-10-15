import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { materializeTenantTaxSettings } from '../../collections/TaxSettingsCollection.js';

/**
 * Put a tenant on the legacy money model before it has any documents, the
 * state every tenant started in before clean tenants defaulted to v2 (#4009).
 * Suites that exercise legacy line semantics or the tenant migration call it
 * first; an existing marker row is never changed.
 */
export async function seedLegacyMoneyTenant(
  db: DatabaseInterface,
  ...tenantIds: string[]
): Promise<void> {
  for (const tenantId of tenantIds)
    await withTenant({ tenantId }, () =>
      materializeTenantTaxSettings(db, tenantId, 'legacy'),
    );
}
