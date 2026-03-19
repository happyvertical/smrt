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
  type CreateChildTenantOptions,
  type CreateSessionOptions,
  type GetOrCreateFromOidcOptions,
  GroupCollection,
  GroupMemberCollection,
  GroupRoleCollection,
  MagicLinkTokenCollection,
  MembershipCollection,
  MembershipOverrideCollection,
  type OidcClaims,
  type OidcIdentityResult,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  SessionCollection,
  TenantCollection,
  TenantHierarchyError,
  TenantPermissionOverrideCollection,
  type TenantPermissionOverrideResult,
  UserCollection,
  UsersMagicLinkTokenCollection,
} from './collections/index.js';
// Models
export {
  DEFAULT_SESSION_TTL,
  DEFAULT_TOKEN_EXPIRY_SECONDS,
  Group,
  GroupMember,
  GroupRole,
  generateSessionId,
  MAX_TENANT_HIERARCHY_DEPTH,
  MagicLinkToken,
  Membership,
  MembershipOverride,
  Permission,
  Role,
  RolePermission,
  Session,
  Tenant,
  TenantPermissionOverride,
  User,
  UsersMagicLinkToken,
} from './models/index.js';

// Services
export {
  type EnsureTenantResult,
  MagicLinkError,
  type MagicLinkResult,
  MagicLinkService,
  type MagicLinkServiceOptions,
  type MagicLinkVerifyResult,
  type PermissionResolutionResult,
  PermissionResolver,
  type SessionContext,
  SessionService,
  type SessionServiceOptions,
  type TenantPermissionInheritanceResult,
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
  SessionStatus,
  TenantPermissionEffect,
  type TenantPolicy,
  type TenantPolicyMode,
  TenantStatus,
  UserStatus,
} from './types/index.js';
