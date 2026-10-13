/**
 * Collection exports for smrt-users
 * @packageDocumentation
 */

// Access requests (request access / waitlist)
export { AccessRequestCollection } from './AccessRequestCollection.js';
// CLI / terminal auth
export {
  type CliAuthApproveReservation,
  UsersCliAuthApproveLimitCollection,
} from './CliAuthApproveLimitCollection.js';
export {
  CliAuthRequestCollection,
  UsersCliAuthRequestCollection,
} from './CliAuthRequestCollection.js';
// Group collections
export { GroupCollection } from './GroupCollection.js';
export { GroupMemberCollection } from './GroupMemberCollection.js';
export { GroupRoleCollection } from './GroupRoleCollection.js';
// Login rate limiting, lockout and audit (#3273)
export {
  type LoginAttemptReservation,
  type RecordedLoginFailure,
  type RecordLoginFailureInput,
  type ReserveLoginAttemptInput,
  UsersLoginAttemptCollection,
} from './LoginAttemptCollection.js';
export { UsersLoginAuditEventCollection } from './LoginAuditEventCollection.js';
// Magic Link
export {
  MagicLinkTokenCollection,
  UsersMagicLinkTokenCollection,
} from './MagicLinkTokenCollection.js';
// Membership collections
export { MembershipCollection } from './MembershipCollection.js';
export { MembershipOverrideCollection } from './MembershipOverrideCollection.js';
export {
  UsersOAuthAccessTokenRevocationCollection,
  UsersOAuthAuthorizationCodeCollection,
  UsersOAuthAuthorizationCollection,
  UsersOAuthClientCollection,
  UsersOAuthRefreshFamilyCollection,
  UsersOAuthRefreshGrantCollection,
} from './OAuthAuthorizationCollection.js';
// Password credential (#3274)
export {
  type PasswordCredentialWrite,
  UsersPasswordCredentialCollection,
} from './PasswordCredentialCollection.js';
export { PermissionCollection } from './PermissionCollection.js';
// Per-person PIN on an enrolled device (#3276)
export {
  type PinCredentialWrite,
  UsersPinCredentialCollection,
} from './PinCredentialCollection.js';
export { ResourceGrantCollection } from './ResourceGrantCollection.js';
export {
  RoleCollection,
  type SeedSystemRolesOptions,
} from './RoleCollection.js';
// Role-permission join
export {
  DEFAULT_ROLE_PERMISSION_PATTERNS,
  RolePermissionCollection,
  type RolePermissionPatternMatrix,
  type SeedRolePermissionsOptions,
  type SeedRolePermissionsResult,
} from './RolePermissionCollection.js';
// Session collection
export {
  type CreateSessionOptions,
  SessionCollection,
} from './SessionCollection.js';
export {
  type CreateChildTenantOptions,
  TenantCollection,
  TenantHierarchyError,
} from './TenantCollection.js';
export { TenantIntegrationCollection } from './TenantIntegrationCollection.js';
export {
  TenantPermissionOverrideCollection,
  type TenantPermissionOverrideResult,
} from './TenantPermissionOverrideCollection.js';
// Core collections
export {
  type GetOrCreateFromOidcOptions,
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
  UserCollection,
} from './UserCollection.js';
