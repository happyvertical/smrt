/** Resource-scoped authorization grants. @packageDocumentation */
import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

export type ResourceGrantEffect = 'grant' | 'deny';

export interface ResourceGrantOptions extends SmrtObjectOptions {
  tenantId?: string;
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  permission?: string;
  effect?: ResourceGrantEffect;
  canDelegate?: boolean;
  parentGrantId?: string | null;
  revokedAt?: string | null;
}

/**
 * An exact tenant/resource/user/permission decision. This deliberately does
 * not replace tenant RBAC: ResourceGrantResolver only allows after the normal
 * operation guard has allowed the same permission.
 */
@smrt({
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
  indexes: [
    { name: 'resource_grants_lookup_idx', columns: ['tenantId', 'userId'] },
  ],
})
export class ResourceGrant extends SmrtObject {
  @foreignKey('Tenant', { required: true }) tenantId?: string;
  @foreignKey('User', { required: true }) userId?: string;
  @field({ type: 'text' }) resourceType: string = '';
  @field({ type: 'text' }) resourceId: string = '';
  @field({ type: 'text' }) permission: string = '';
  @field({ type: 'text' }) effect: ResourceGrantEffect = 'grant';
  canDelegate: boolean = false;
  @foreignKey('ResourceGrant') parentGrantId?: string | null;
  @field({ type: 'text' }) revokedAt?: string | null;
  constructor(options: ResourceGrantOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.resourceType !== undefined)
      this.resourceType = options.resourceType;
    if (options.resourceId !== undefined) this.resourceId = options.resourceId;
    if (options.permission !== undefined) this.permission = options.permission;
    if (options.effect !== undefined) this.effect = options.effect;
    if (options.canDelegate !== undefined)
      this.canDelegate = options.canDelegate;
    if (options.parentGrantId !== undefined)
      this.parentGrantId = options.parentGrantId;
    if (options.revokedAt !== undefined) this.revokedAt = options.revokedAt;
  }
  isActive(): boolean {
    return !this.revokedAt;
  }
}
