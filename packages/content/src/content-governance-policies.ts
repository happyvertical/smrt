import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentGovernancePolicy } from './content-governance-policy';
import { getByTenantKey } from './tenant-keyed-lookup';

export class ContentGovernancePolicyCollection extends SmrtCollection<ContentGovernancePolicy> {
  static readonly _itemClass = ContentGovernancePolicy;

  /**
   * The effective policy for `key`: the tenant's own row (`options.tenantId`,
   * else the active tenant context), else the global (NULL-tenant) default.
   * Keys are unique per tenant (#3305 M1), so this never returns another
   * tenant's row; without a tenant only a global row is returned.
   */
  async getByKey(
    key: string,
    options: { tenantId?: string | null } = {},
  ): Promise<ContentGovernancePolicy | null> {
    return getByTenantKey(this, 'key', key, {
      tenantId: options.tenantId,
      globalFallback: true,
      label: 'ContentGovernancePolicyCollection.getByKey',
    });
  }
}
