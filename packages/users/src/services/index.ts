/**
 * Service exports for smrt-users
 * @packageDocumentation
 */

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
  type CancelAccessRequestOptions,
  type CreateAccessRequestInput,
  type DeclineAccessRequestOptions,
  type GraduateAccessRequestOptions,
  type GraduateAccessRequestResult,
  type GraduateExistingTenantOption,
  type GraduateNewTenantOption,
  type GraduateTenantOption,
  type ListAccessRequestsFilter,
} from './AccessRequestService.js';
export {
  MagicLinkError,
  type MagicLinkResult,
  MagicLinkService,
  type MagicLinkServiceOptions,
  type MagicLinkVerifyResult,
} from './MagicLinkService.js';
export {
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
  readMobileBearerToken,
  validateMobileRedirectUri,
} from './MobileAuthService.js';
export {
  type CreateAuthorizationUrlOptions,
  decodeOidcTransaction,
  encodeOidcTransaction,
  getUsersOidcConfig,
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
  type ResolvedOidcProviderConfig,
  resolveOidcProviderConfig,
  type UsersOidcConfig,
} from './OidcLoginService.js';
export {
  assertOperationPermission,
  checkOperationPermission,
  hasOperationPermission,
  type OperationPermissionAllowReason,
  type OperationPermissionDecision,
  type OperationPermissionDenyReason,
  OperationPermissionError,
  type OperationPermissionOptions,
} from './OperationPermissionService.js';
export {
  deriveOperationPermissionCollectionName,
  deriveOperationPermissionSlug,
  normalizeOperationPermissionAction,
  type OperationPermissionCollectionInput,
  type PermissionCatalog,
  PermissionCatalogService,
  type PermissionCatalogSource,
  type PermissionCatalogSyncResult,
  type PermissionDefinition,
  type PostgresPermissionAction,
  type PostgresPermissionBinding,
  registerPermissionDefinitions,
  syncPermissionCatalog,
  type UsersConfig,
} from './PermissionCatalogService.js';
export {
  type PermissionResolutionOptions,
  type PermissionResolutionResult,
  PermissionResolver,
  type TenantPermissionInheritanceResult,
} from './PermissionResolver.js';
export {
  applyPostgresPermissionPolicies,
  type GeneratePostgresPermissionSqlResult,
  generatePostgresPermissionSql,
  type PostgresPermissionPolicyReportItem,
  type PostgresPermissionPolicyTarget,
} from './PostgresPermissionPolicies.js';
export {
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
  type PrincipalPermissionRuntimeOptions,
  type SessionPermissionRuntimeContext,
  type SessionPermissionRuntimeOptions,
  withPrincipalPermissionContext,
  withSessionPermissionContext,
} from './SessionPermissionContext.js';
export {
  type SessionContext,
  SessionService,
  type SessionServiceOptions,
  type SwitchTenantResult,
} from './SessionService.js';
export {
  type EnsureTenantResult,
  TenantService,
  type TenantWithOwnershipResult,
} from './TenantService.js';
export {
  type ApproveCliAuthRequestInput,
  type CliAuthStartResult,
  type CliAuthTokenResult,
  DEFAULT_CLI_AUTH_APPROVE_ATTEMPT_WINDOW_SECONDS,
  DEFAULT_CLI_AUTH_MAX_APPROVE_ATTEMPTS,
  DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS,
  DEFAULT_CLI_AUTH_REQUEST_TTL_SECONDS,
  DEFAULT_CLI_SESSION_TTL_SECONDS,
  TerminalAuthError,
  TerminalAuthRateLimitError,
  TerminalAuthService,
  type TerminalAuthServiceOptions,
} from './TerminalAuthService.js';
