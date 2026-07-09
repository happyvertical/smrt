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

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Collections
export {
  AccessRequestCollection,
  CliAuthRequestCollection,
  type CreateChildTenantOptions,
  type CreateSessionOptions,
  DEFAULT_ROLE_PERMISSION_PATTERNS,
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
  type RolePermissionPatternMatrix,
  type SeedRolePermissionsOptions,
  type SeedRolePermissionsResult,
  type SeedSystemRolesOptions,
  SessionCollection,
  TenantCollection,
  TenantHierarchyError,
  TenantIntegrationCollection,
  TenantPermissionOverrideCollection,
  type TenantPermissionOverrideResult,
  UserCollection,
  UsersCliAuthRequestCollection,
  UsersMagicLinkTokenCollection,
} from './collections/index.js';
// Models
export {
  AccessRequest,
  type AccessRequestOptions,
  CliAuthRequest,
  type CliAuthRequestStatus,
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
  TenantIntegration,
  type TenantIntegrationCheckSummary,
  type TenantIntegrationOptions,
  type TenantIntegrationProvider,
  type TenantIntegrationStatus,
  TenantPermissionOverride,
  User,
  UsersCliAuthRequest,
  UsersMagicLinkToken,
} from './models/index.js';

// Services
export {
  ACCESS_REQUEST_CAPABILITIES,
  type AccessRequestAuthorizationContext,
  type AccessRequestAuthorizer,
  type AccessRequestCapability,
  AccessRequestError,
  type AccessRequestErrorCode,
  type AccessRequestEvent,
  type AccessRequestEventHandler,
  type AccessRequestEventType,
  AccessRequestService,
  type AccessRequestServiceOptions,
  type ApproveAccessRequestOptions,
  type ApproveCliAuthRequestInput,
  applyPostgresPermissionPolicies,
  assertOperationPermission,
  type CancelAccessRequestOptions,
  type CliAuthStartResult,
  type CliAuthTokenResult,
  type CreateAccessRequestInput,
  type CreateAuthorizationUrlOptions,
  checkOperationPermission,
  DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS,
  DEFAULT_CLI_AUTH_REQUEST_TTL_SECONDS,
  DEFAULT_CLI_SESSION_TTL_SECONDS,
  type DeclineAccessRequestOptions,
  decodeOidcTransaction,
  deriveOperationPermissionCollectionName,
  deriveOperationPermissionSlug,
  type EnsureTenantResult,
  encodeOidcTransaction,
  type GeneratePostgresPermissionSqlResult,
  type GraduateAccessRequestOptions,
  type GraduateAccessRequestResult,
  type GraduateExistingTenantOption,
  type GraduateNewTenantOption,
  type GraduateTenantOption,
  generatePostgresPermissionSql,
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
  getUsersOidcConfig,
  hasOperationPermission,
  type ListAccessRequestsFilter,
  MagicLinkError,
  type MagicLinkResult,
  MagicLinkService,
  type MagicLinkServiceOptions,
  type MagicLinkVerifyResult,
  MobileAuthError,
  type MobileAuthErrorCode,
  MobileAuthService,
  type MobileAuthServiceOptions,
  type MobileBootstrapContext,
  type MobileLoginContext,
  type MobileLogoutResult,
  type MobileRequestMeta,
  type MobileResolvedUser,
  type MobileTenantContext,
  normalizeOperationPermissionAction,
  type OidcCallbackResult,
  OidcLoginError,
  type OidcLoginResult,
  OidcLoginService,
  type OidcLoginServiceOptions,
  type OidcProviderConfig,
  type OidcProviderKind,
  type OidcProviderMetadata,
  type OidcProviderResolution,
  type OidcProviderResolutionOptions,
  type OidcTokenEndpointAuthMethod,
  type OidcTokenSet,
  type OidcTransaction,
  type OperationPermissionAllowReason,
  type OperationPermissionCollectionInput,
  type OperationPermissionDecision,
  type OperationPermissionDenyReason,
  OperationPermissionError,
  type OperationPermissionOptions,
  type PermissionCatalog,
  PermissionCatalogService,
  type PermissionCatalogSource,
  type PermissionCatalogSyncResult,
  type PermissionDefinition,
  type PermissionResolutionOptions,
  type PermissionResolutionResult,
  PermissionResolver,
  type PostgresPermissionAction,
  type PostgresPermissionBinding,
  type PostgresPermissionPolicyReportItem,
  type PostgresPermissionPolicyTarget,
  type ResolvedOidcProviderConfig,
  type PrincipalPermissionRuntimeOptions,
  readMobileBearerToken,
  registerPermissionDefinitions,
  resolveOidcProviderConfig,
  type SessionContext,
  type SessionPermissionRuntimeContext,
  type SessionPermissionRuntimeOptions,
  SessionService,
  type SessionServiceOptions,
  type SwitchTenantResult,
  syncPermissionCatalog,
  type TenantPermissionInheritanceResult,
  TenantService,
  type TenantWithOwnershipResult,
  TerminalAuthError,
  TerminalAuthRateLimitError,
  TerminalAuthService,
  type TerminalAuthServiceOptions,
  type UsersConfig,
  type UsersOidcConfig,
  validateMobileRedirectUri,
  withPrincipalPermissionContext,
  withSessionPermissionContext,
} from './services/index.js';

// Types
export {
  AccessRequestStatus,
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
