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

export {
  UsersRolesAndPermissionsRecipe,
  UsersSignInRecipe,
} from './recipes.js';

// Contribute expired-credential retention to the framework sweep as soon as
// this package is loaded (#2375), so `smrt db:prune` and any host process see
// the tasks without an app-level wiring step. Registering is not scheduling:
// nothing is deleted until something runs a sweep, and the policy can still
// disable any task by name.
import { registerUserRetentionTasks } from './retention.js';

registerUserRetentionTasks();

// Collections
export {
  AccessRequestCollection,
  type CliAuthApproveReservation,
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
  type NormalizedOidcClaims,
  type OidcClaims,
  type OidcIdentityResult,
  type OidcProfileOwnerAuthorization,
  type OidcProfileOwnerAuthorizer,
  type OidcProfileOwnerAuthorizerContext,
  type OidcProfileResolver,
  type OidcProfileResolverContext,
  OidcProvisioningError,
  type OidcProvisioningErrorCode,
  type PasswordCredentialWrite,
  PermissionCollection,
  ResourceGrantCollection,
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
  UsersCliAuthApproveLimitCollection,
  UsersCliAuthRequestCollection,
  UsersLoginAttemptCollection,
  UsersLoginAuditEventCollection,
  UsersMagicLinkTokenCollection,
  UsersPasswordCredentialCollection,
  UsersPinCredentialCollection,
} from './collections/index.js';
// Deploy-time data migrations
export {
  type BackfillLegacyUserProfilesResult,
  backfillLegacyUserProfiles,
  LEGACY_USER_PROFILE_BACKFILL_NAME,
  LegacyUserProfileBackfillError,
  type LegacyUserProfileBackfillErrorCode,
} from './migrations/backfillLegacyUserProfiles.js';
export {
  type BackfillUserEmailKeysResult,
  backfillUserEmailKeys,
  type DuplicateUserEmailKey,
  UserEmailKeyBackfillError,
  type UserEmailKeyBackfillErrorCode,
} from './migrations/backfillUserEmailKeys.js';
export {
  type DeduplicateRolePermissionsOptions,
  type DeduplicateRolePermissionsResult,
  deduplicateRolePermissions,
} from './migrations/deduplicateRolePermissions.js';
export {
  type MaterializeTenantHierarchyOptions,
  type MaterializeTenantHierarchyResult,
  materializeTenantHierarchy,
  TenantHierarchyMaterializationError,
} from './migrations/materializeTenantHierarchy.js';
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
  ResourceGrant,
  type ResourceGrantEffect,
  type ResourceGrantOptions,
  Role,
  RolePermission,
  SESSION_DATA_KEYS,
  Session,
  type SessionAuthMethod,
  Tenant,
  TenantIntegration,
  type TenantIntegrationCheckSummary,
  type TenantIntegrationOptions,
  type TenantIntegrationProvider,
  type TenantIntegrationStatus,
  TenantPermissionOverride,
  User,
  UsersCliAuthApproveLimit,
  UsersCliAuthRequest,
  UsersLoginAttempt,
  UsersLoginAuditEvent,
  UsersMagicLinkToken,
  UsersPasswordCredential,
  UsersPinCredential,
} from './models/index.js';
export {
  planTenantHierarchy,
  type TenantHierarchyChange,
  type TenantHierarchyErrorCode,
  type TenantHierarchyPlan,
  type TenantHierarchyProblem,
  type TenantHierarchyRow,
} from './models/tenant-hierarchy.js';
// Credential retention — expired sessions and tokens (#2375)
export {
  CLI_AUTH_RETENTION_TASK,
  DEFAULT_LOGIN_AUDIT_RETENTION_DAYS,
  LOGIN_ATTEMPTS_RETENTION_TASK,
  LOGIN_AUDIT_RETENTION_TASK,
  MAGIC_LINK_RETENTION_TASK,
  registerUserRetentionTasks,
  SESSIONS_RETENTION_TASK,
  USER_RETENTION_TASKS,
  unregisterUserRetentionTasks,
} from './retention.js';

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
  ANCESTOR_READ_ACTION,
  type AncestorReadPackageConfig,
  type AncestorReadPolicy,
  type ApproveAccessRequestOptions,
  type ApproveCliAuthRequestInput,
  applyPostgresPermissionPolicies,
  assertOperationPermission,
  type CancelAccessRequestOptions,
  type ChangePasswordInput,
  type ClearPasswordInput,
  type ClearPinInput,
  type CliAuthStartResult,
  type CliAuthTokenResult,
  type CreateAccessRequestInput,
  type CreateAuthorizationUrlOptions,
  type CreateResourceGrantOptions,
  checkOperationPermission,
  checkResourceOperationPermission,
  DEFAULT_ANCESTOR_READ_MAX_DEPTH,
  DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS,
  DEFAULT_CLI_AUTH_REQUEST_TTL_SECONDS,
  DEFAULT_CLI_SESSION_TTL_SECONDS,
  DEFAULT_DEVICE_PERSON_IDLE_SECONDS,
  DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS,
  DEFAULT_LOGIN_LOCKOUT_BASE_SECONDS,
  DEFAULT_LOGIN_LOCKOUT_FACTOR,
  DEFAULT_LOGIN_LOCKOUT_MAX_SECONDS,
  DEFAULT_LOGIN_MAX_ATTEMPTS,
  DEFAULT_PASSWORD_DENYLIST,
  DEFAULT_PASSWORD_MANAGE_PERMISSION,
  DEFAULT_PASSWORD_MAX_LENGTH,
  DEFAULT_PASSWORD_MIN_LENGTH,
  DEFAULT_PIN_MANAGE_PERMISSION,
  type DeclineAccessRequestOptions,
  DeviceCredentialError,
  DeviceCredentialForbiddenError,
  DeviceCredentialPolicyError,
  DeviceCredentialService,
  type DeviceCredentialServiceOptions,
  type DeviceCredentialVerification,
  type DeviceCredentialVerifier,
  type DeviceSignInContext,
  type DeviceSignInInput,
  type DeviceSignInResult,
  DurableLoginAuditSink,
  decodeOidcTransaction,
  deriveOperationPermissionCollectionName,
  deriveOperationPermissionSlug,
  type EnsureTenantResult,
  encodeOidcTransaction,
  ensurePasswordPermissionsRegistered,
  ensurePinPermissionsRegistered,
  type GeneratePostgresPermissionSqlResult,
  type GraduateAccessRequestOptions,
  type GraduateAccessRequestResult,
  type GraduateExistingTenantOption,
  type GraduateNewTenantOption,
  type GraduateTenantOption,
  generatePostgresPermissionSql,
  getConfiguredAncestorReadPolicy,
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
  getUsersOidcConfig,
  hasOperationPermission,
  InvalidCredentialsError,
  isAncestorReadableSlug,
  type ListAccessRequestsFilter,
  type LoginAttemptDecision,
  type LoginAttemptDenied,
  type LoginAttemptLease,
  LoginAttemptLimiter,
  type LoginAttemptLimiterOptions,
  type LoginAuditEntry,
  type LoginAuditSink,
  type LoginFailureOutcome,
  type LoginLockoutOptions,
  LoginRateLimitError,
  MAX_RESOURCE_GRANT_DELEGATION_DEPTH,
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
  type NormalizedAncestorReadPolicy,
  normalizeAncestorReadPolicy,
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
  PASSWORD_LOGIN_KIND,
  PASSWORD_MAX_LENGTH_CEILING,
  PASSWORD_PERMISSION_DEFINITIONS,
  PasswordCredentialError,
  PasswordCredentialForbiddenError,
  PasswordCredentialService,
  type PasswordCredentialServiceOptions,
  type PasswordPolicyContext,
  PasswordPolicyError,
  type PasswordPolicyOptions,
  type PasswordSignInInput,
  type PasswordSignInResult,
  type PermissionCatalog,
  PermissionCatalogService,
  type PermissionCatalogSource,
  type PermissionCatalogSyncResult,
  type PermissionDefinition,
  type PermissionResolutionOptions,
  type PermissionResolutionResult,
  PermissionResolver,
  type PermissionResolverOptions,
  PIN_LOGIN_KIND,
  PIN_PERMISSION_DEFINITIONS,
  type PinPolicyOptions,
  type PinSignInInput,
  PinVerifier,
  type PostgresPermissionAction,
  type PostgresPermissionBinding,
  type PostgresPermissionPolicyReportItem,
  type PostgresPermissionPolicyTarget,
  type PrincipalPermissionRuntimeOptions,
  type ReserveLoginAttemptOptions,
  type ResetPasswordInput,
  type ResetPinInput,
  type ResolvedOidcProviderConfig,
  type ResourceGrantDecision,
  ResourceGrantService,
  type ResourceIdentity,
  type ResourceIdentityVerifier,
  type ResourceOperationPermissionOptions,
  type RevokeResourceGrantOptions,
  readMobileBearerToken,
  registerPermissionDefinitions,
  resolveOidcProviderConfig,
  type SessionContext,
  type SessionParentContext,
  type SessionPermissionRuntimeContext,
  type SessionPermissionRuntimeOptions,
  SessionService,
  type SessionServiceOptions,
  type SetPasswordInput,
  type SetPinInput,
  type SwitchTenantResult,
  syncPermissionCatalog,
  TERMINAL_APPROVE_LOGIN_KIND,
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
