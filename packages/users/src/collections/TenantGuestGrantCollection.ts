/**
 * TenantGuestGrantCollection - Collection manager for TenantGuestGrant objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { TenantGuestGrant } from '../models/TenantGuestGrant.js';

/**
 * Collection for {@link TenantGuestGrant}. Raw storage access only; grant and
 * revoke authorization belongs to the guest grant service.
 */
export class TenantGuestGrantCollection extends SmrtCollection<TenantGuestGrant> {
  static readonly _itemClass = TenantGuestGrant;

  /** Find every guest grant of a tenant. */
  async findByTenant(tenantId: string): Promise<TenantGuestGrant[]> {
    return await this.list({ where: { tenantId } });
  }

  /** Permission slugs a tenant grants to guests. */
  async getGrantedSlugs(tenantId: string): Promise<string[]> {
    const grants = await this.findByTenant(tenantId);
    return grants.map((grant) => grant.permissionSlug as string);
  }
}
