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
  // Grant records reveal resource/user authorization relationships. The public
  // surface is the permission-gated service, never generated CRUD or MCP.
  tenantScoped: true,
  api: { include: [] },
  mcp: { include: [] },
  // #3742: no generated CLI either — a `cli` config without `include` is full
  // CRUD, and even `include: []` exposes public custom methods.
  cli: false,
  indexes: [
    { name: 'resource_grants_lookup_idx', columns: ['tenantId', 'userId'] },
  ],
})
export class ResourceGrant extends SmrtObject {
  @foreignKey('Tenant', { required: true }) tenantId?: string;
  @field({
    description: 'The person receiving this record-specific access rule.',
  })
  @foreignKey('User', { required: true })
  userId?: string;
  @field({
    description: 'The kind of record this access rule applies to.',
    type: 'text',
  })
  resourceType: string = '';
  @field({
    description: 'The specific record covered by this access rule.',
    type: 'text',
  })
  resourceId: string = '';
  @field({
    description: 'The action this rule allows or denies for the record.',
    type: 'text',
  })
  permission: string = '';
  @field({
    description:
      'Whether this rule grants access or denies it. Denies take precedence.',
    type: 'text',
  })
  effect: ResourceGrantEffect = 'grant';
  @field({
    description:
      'Whether the recipient may pass this grant on to another person.',
  })
  canDelegate: boolean = false;
  @field({
    description: 'The earlier grant from which this access was delegated.',
  })
  @foreignKey('ResourceGrant')
  parentGrantId?: string | null;
  @field({
    description: 'When this access rule was revoked, if it has ended.',
    type: 'text',
  })
  revokedAt?: string | null;
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
