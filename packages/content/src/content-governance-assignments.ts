import { SmrtCollection } from '@happyvertical/smrt-core';
import { buildContentGovernanceAssignmentKey } from './content-governance';
import { ContentGovernanceAssignment } from './content-governance-assignment';
import { getByTenantKey } from './tenant-keyed-lookup';

export class ContentGovernanceAssignmentCollection extends SmrtCollection<ContentGovernanceAssignment> {
  static readonly _itemClass = ContentGovernanceAssignment;

  /**
   * The effective assignment for `key`: the tenant's own row (`options.tenantId`,
   * else the active tenant context), else the global (NULL-tenant) default.
   * Keys are unique per tenant (#3305 M1), so this never returns another
   * tenant's row; without a tenant only a global row is returned.
   */
  async getByKey(
    key: string,
    options: { tenantId?: string | null } = {},
  ): Promise<ContentGovernanceAssignment | null> {
    return getByTenantKey(this, 'key', key, {
      tenantId: options.tenantId,
      globalFallback: true,
      label: 'ContentGovernanceAssignmentCollection.getByKey',
    });
  }

  async resolveForContent(options: {
    contentType: string;
    contentVariant?: string | null;
    tenantId?: string | null;
  }): Promise<ContentGovernanceAssignment | null> {
    const scope = { tenantId: options.tenantId };
    const exact = await this.getByKey(
      buildContentGovernanceAssignmentKey(
        options.contentType,
        options.contentVariant,
      ),
      scope,
    );

    if (exact) {
      return exact;
    }

    return this.getByKey(
      buildContentGovernanceAssignmentKey(options.contentType),
      scope,
    );
  }
}
