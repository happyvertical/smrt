/**
 * Service exports for smrt-users
 * @packageDocumentation
 */

export {
  MagicLinkError,
  type MagicLinkResult,
  MagicLinkService,
  type MagicLinkServiceOptions,
  type MagicLinkVerifyResult,
} from './MagicLinkService.js';
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
  type SessionPermissionRuntimeContext,
  type SessionPermissionRuntimeOptions,
  withSessionPermissionContext,
} from './SessionPermissionContext.js';
export {
  type SessionContext,
  SessionService,
  type SessionServiceOptions,
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
  DEFAULT_CLI_AUTH_POLL_INTERVAL_SECONDS,
  DEFAULT_CLI_AUTH_REQUEST_TTL_SECONDS,
  DEFAULT_CLI_SESSION_TTL_SECONDS,
  TerminalAuthError,
  TerminalAuthService,
  type TerminalAuthServiceOptions,
} from './TerminalAuthService.js';
