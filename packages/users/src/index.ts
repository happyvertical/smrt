/**
 * @happyvertical/smrt-users
 *
 * Multi-tenant user management for the SMRT framework.
 * Provides users, tenants, roles, permissions, and groups.
 *
 * @example
 * ```typescript
 * import {
 *   User,
 *   UserCollection,
 *   Tenant,
 *   TenantCollection,
 *   Role,
 *   RoleCollection,
 *   Permission,
 *   PermissionCollection,
 *   Membership,
 *   MembershipCollection,
 *   PermissionResolver,
 *   UserStatus,
 *   MembershipStatus,
 * } from '@happyvertical/smrt-users';
 *
 * // Create collections
 * const users = await UserCollection.create({
 *   persistence: { type: 'sql', url: 'app.db' }
 * });
 *
 * // Seed system roles
 * const roles = await RoleCollection.create({ persistence: { type: 'sql', url: 'app.db' } });
 * await roles.seedSystemRoles();
 *
 * // Resolve permissions
 * const resolver = await PermissionResolver.create({ persistence: { type: 'sql', url: 'app.db' } });
 * const hasAccess = await resolver.hasPermission(user.id, tenant.id, 'articles.create');
 * ```
 *
 * @packageDocumentation
 */

// Collections
export {
  type GetOrCreateFromOidcOptions,
  GroupCollection,
  GroupMemberCollection,
  GroupRoleCollection,
  MembershipCollection,
  MembershipOverrideCollection,
  type OidcClaims,
  type OidcIdentityResult,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  UserCollection,
} from './collections/index.js';
// Models
export {
  Group,
  GroupMember,
  GroupRole,
  Membership,
  MembershipOverride,
  Permission,
  Role,
  RolePermission,
  Tenant,
  User,
} from './models/index.js';

// Services
export {
  type EnsureTenantResult,
  type PermissionResolutionResult,
  PermissionResolver,
  TenantService,
  type TenantWithOwnershipResult,
} from './services/index.js';

// Types
export {
  DEFAULT_ROLE_SLUGS,
  DEFAULT_ROLES,
  DEFAULT_TENANT_POLICY,
  type DefaultRoleSlug,
  MembershipStatus,
  OverrideEffect,
  type TenantPolicy,
  type TenantPolicyMode,
  TenantStatus,
  UserStatus,
} from './types/index.js';
