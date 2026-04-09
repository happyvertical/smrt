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
 *
 * // Sync manifest-derived permissions into the Permission table
 * const syncResult = await syncPermissionCatalog({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL! }
 * });
 * console.log(syncResult.created);
 *
 * // Generate or apply Postgres RLS policies
 * const sql = generatePostgresPermissionSql({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL! }
 * });
 * console.log(sql.targets);
 * await applyPostgresPermissionPolicies({
 *   db: { type: 'postgres', url: process.env.DATABASE_URL! }
 * });
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
  applyPostgresPermissionPolicies,
  type EnsureTenantResult,
  type GeneratePostgresPermissionSqlResult,
  generatePostgresPermissionSql,
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
  MagicLinkError,
  type MagicLinkResult,
  MagicLinkService,
  type MagicLinkServiceOptions,
  type MagicLinkVerifyResult,
  type PermissionCatalog,
  PermissionCatalogService,
  type PermissionCatalogSource,
  type PermissionCatalogSyncResult,
  type PermissionDefinition,
  type PermissionResolutionResult,
  PermissionResolver,
  type PostgresPermissionAction,
  type PostgresPermissionBinding,
  type PostgresPermissionPolicyReportItem,
  type PostgresPermissionPolicyTarget,
  registerPermissionDefinitions,
  type SessionContext,
  type SessionPermissionRuntimeContext,
  type SessionPermissionRuntimeOptions,
  SessionService,
  type SessionServiceOptions,
  syncPermissionCatalog,
  type TenantPermissionInheritanceResult,
  TenantService,
  type TenantWithOwnershipResult,
  type UsersConfig,
  withSessionPermissionContext,
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
