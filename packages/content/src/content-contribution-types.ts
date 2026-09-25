import { SmrtCollection } from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { ContentContributionType } from './content-contribution-type';

export class ContentContributionTypeCollection extends SmrtCollection<ContentContributionType> {
  static readonly _itemClass = ContentContributionType;

  /**
   * The effective type for `key` in the current tenant context: the tenant's
   * own row, else the global (NULL-tenant) default. Keys are unique per
   * tenant (#3126), so without a tenant context only a global row is
   * returned, never another tenant's. The tenant is never caller-supplied.
   */
  async getByKey(key: string): Promise<ContentContributionType | null> {
    const tenantId = getCurrentTenant()?.tenantId ?? null;
    const rows = (await this.query(
      tenantId
        ? `SELECT * FROM ${this.tableName} WHERE key = ? AND (tenant_id = ? OR tenant_id IS NULL)`
        : `SELECT * FROM ${this.tableName} WHERE key = ? AND tenant_id IS NULL`,
      tenantId ? [key, tenantId] : [key],
      { allowRawOnTenantScoped: true },
    )) as ContentContributionType[];
    return (
      rows.find((row) => tenantId && row.tenantId === tenantId) ??
      rows.find((row) => !row.tenantId) ??
      null
    );
  }
}
