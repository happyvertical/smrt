/**
 * TenantGuestGrant model - a permission a tenant grants to unauthenticated
 * (guest) callers (#5196).
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Constructor options for {@link TenantGuestGrant}.
 */
export interface TenantGuestGrantOptions extends SmrtObjectOptions {
  tenantId?: string;
  permissionSlug?: string;
  grantedBy?: string;
}

/**
 * One permission slug (for example `products.read`) a tenant grants to guest
 * callers. Deliberately separate from `TenantPermissionOverride` so existing
 * tenant grants are never reinterpreted as guest grants.
 *
 * The row carries no CHECK on `permissionSlug`: which slugs are storable and
 * which survive resolution is decided by the guest resolver's ceiling, so
 * widening that set later needs no migration. Writes go through a
 * permission-gated service, not generated CRUD, hence the read-only surface.
 */
@smrt({
  // #1400: read-only generated REST + MCP surface; mcp must be explicit
  // (an omitted mcp config generates the FULL tool surface).
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  // #3742: `cli` without `include` is full CRUD.
  cli: { include: ['list', 'get'] },
  // One grant per tenant/permission pair: natural-key writes are conflict
  // tolerant and the pair is unique.
  conflictColumns: ['tenant_id', 'permission_slug'],
})
export class TenantGuestGrant extends SmrtObject {
  /**
   * Foreign key to Tenant. NO ACTION (repo convention): deleting a tenant
   * must delete its grants explicitly, in the same transaction.
   */
  @foreignKey('Tenant', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'NO ACTION',
  })
  tenantId?: string;

  /** Granted permission slug, `<collection>.<action>`. */
  @field({ type: 'text', required: true, requiredFor: 'identity' })
  permissionSlug?: string;

  /** Id of the user (or service principal) that created the grant. */
  @field({ type: 'text' })
  grantedBy?: string;

  constructor(options: TenantGuestGrantOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.permissionSlug !== undefined)
      this.permissionSlug = options.permissionSlug;
    if (options.grantedBy !== undefined) this.grantedBy = options.grantedBy;
  }
}
