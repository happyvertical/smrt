import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentGovernanceProfile } from './content-governance-profile';
import { getByTenantKey } from './tenant-keyed-lookup';

export class ContentGovernanceProfileCollection extends SmrtCollection<ContentGovernanceProfile> {
  static readonly _itemClass = ContentGovernanceProfile;

  /**
   * The effective profile for `key`: the tenant's own row (`options.tenantId`,
   * else the active tenant context), else the global (NULL-tenant) default.
   * Keys are unique per tenant (#3305 M1), so this never returns another
   * tenant's row; without a tenant only a global row is returned.
   */
  async getByKey(
    key: string,
    options: { tenantId?: string | null } = {},
  ): Promise<ContentGovernanceProfile | null> {
    return getByTenantKey(this, 'key', key, {
      tenantId: options.tenantId,
      globalFallback: true,
      label: 'ContentGovernanceProfileCollection.getByKey',
    });
  }
}
