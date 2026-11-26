/**
 * TenantGuestGrantService - permission-gated writes for guest grants (#5196).
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';
import { TenantGuestGrant } from '../models/TenantGuestGrant.js';
import { withoutListBounds } from './authorization-read-options.js';
import {
  assertOperationPermission,
  type OperationPermissionOptions,
} from './OperationPermissionService.js';

/**
 * The acting principal. Every field of `OperationPermissionOptions` except
 * the operation and the tenant, which the service binds itself.
 */
export type TenantGuestGrantActor = Omit<
  OperationPermissionOptions,
  'collection' | 'action' | 'tenantId' | 'onDeny'
>;

/** Only `<collection>.read` and `<collection>.create` are storable. */
const STORABLE_GUEST_SLUG = /^[a-z][a-z0-9_-]*\.(read|create)$/;

/** True when `slug` has the storable guest shape. */
export function isStorableGuestPermissionSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && STORABLE_GUEST_SLUG.test(slug);
}

/**
 * Grants and revokes the permissions a tenant extends to guest callers.
 *
 * Authorization binds the grant's OWN tenant (never the caller's current
 * tenant), so managing one tenant confers nothing over another. Grant uses
 * `tenantguestgrants.create`, revoke `tenantguestgrants.delete`, list
 * `tenantguestgrants.read`; denial always throws.
 */
export class TenantGuestGrantService {
  constructor(private readonly options: SmrtClassOptions) {}

  private async assertAllowed(
    action: 'create' | 'delete' | 'read',
    tenantId: string,
    actor: TenantGuestGrantActor,
  ): Promise<void> {
    await assertOperationPermission({
      ...actor,
      ...this.options,
      collection: TenantGuestGrant,
      action,
      tenantId,
      onDeny: 'throw',
    });
  }

  private static assertSlug(permissionSlug: string): void {
    if (!isStorableGuestPermissionSlug(permissionSlug)) {
      throw new Error(
        `Guest grants accept only '<collection>.read' or '<collection>.create' slugs; got '${String(permissionSlug)}'.`,
      );
    }
  }

  /** Grant a slug to guests of `tenantId`. Idempotent. */
  async grant(
    tenantId: string,
    permissionSlug: string,
    actor: TenantGuestGrantActor,
  ): Promise<TenantGuestGrant> {
    TenantGuestGrantService.assertSlug(permissionSlug);
    await this.assertAllowed('create', tenantId, actor);
    const options = withoutListBounds(this.options);
    const tenants = await TenantCollection.create(options);
    if (!(await tenants.get({ id: tenantId }))) {
      throw new Error(`Tenant '${tenantId}' does not exist.`);
    }
    const grants = await TenantGuestGrantCollection.create(options);
    const existing = await grants.get({ tenantId, permissionSlug });
    if (existing) return existing;
    return await grants.create({
      tenantId,
      permissionSlug,
      grantedBy: actor.userId ?? undefined,
    });
  }

  /** Revoke a grant. Returns false when there was nothing to revoke. */
  async revoke(
    tenantId: string,
    permissionSlug: string,
    actor: TenantGuestGrantActor,
  ): Promise<boolean> {
    await this.assertAllowed('delete', tenantId, actor);
    const grants = await TenantGuestGrantCollection.create(
      withoutListBounds(this.options),
    );
    const existing = await grants.get({ tenantId, permissionSlug });
    if (!existing) return false;
    await existing.delete();
    return true;
  }

  /** List the grants of `tenantId`. */
  async list(
    tenantId: string,
    actor: TenantGuestGrantActor,
  ): Promise<TenantGuestGrant[]> {
    await this.assertAllowed('read', tenantId, actor);
    const grants = await TenantGuestGrantCollection.create(
      withoutListBounds(this.options),
    );
    return await grants.findByTenant(tenantId);
  }
}
