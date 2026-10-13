/**
 * Model exports for smrt-users
 * @packageDocumentation
 */

// Access requests (request access / waitlist)
export { AccessRequest, type AccessRequestOptions } from './AccessRequest.js';
// CLI / terminal auth (device code grant)
export { UsersCliAuthApproveLimit } from './CliAuthApproveLimit.js';
export {
  CliAuthRequest,
  type CliAuthRequestStatus,
  UsersCliAuthRequest,
} from './CliAuthRequest.js';
// Groups
export { Group } from './Group.js';
export { GroupMember } from './GroupMember.js';
export { GroupRole } from './GroupRole.js';
// Login rate limiting, lockout and audit (#3273)
export { type LoginAttemptScope, UsersLoginAttempt } from './LoginAttempt.js';
export {
  type LoginAuditOutcome,
  UsersLoginAuditEvent,
} from './LoginAuditEvent.js';
// Magic Link
export {
  DEFAULT_TOKEN_EXPIRY_SECONDS,
  MagicLinkToken,
  UsersMagicLinkToken,
} from './MagicLinkToken.js';
// Membership
export { Membership } from './Membership.js';
export { MembershipOverride } from './MembershipOverride.js';
export {
  type OAuthTokenClaims,
  UsersOAuthAccessTokenRevocation,
  UsersOAuthAuthorization,
  UsersOAuthAuthorizationCode,
  UsersOAuthClient,
  UsersOAuthRefreshFamily,
  UsersOAuthRefreshGrant,
} from './OAuthAuthorization.js';
// Password credential (#3274)
export { UsersPasswordCredential } from './PasswordCredential.js';
export {
  isValidPermissionSlug,
  type ParsedPermissionSlug,
  Permission,
  parsePermissionSlug,
} from './Permission.js';
// Per-person PIN on an enrolled device (#3276)
export { UsersPinCredential } from './PinCredential.js';
export {
  ResourceGrant,
  type ResourceGrantEffect,
  type ResourceGrantOptions,
} from './ResourceGrant.js';
export { Role } from './Role.js';
// Roles and permissions
export { RolePermission } from './RolePermission.js';
// Sessions
export {
  DEFAULT_SESSION_TTL,
  generateSessionId,
  SESSION_DATA_KEYS,
  Session,
  type SessionAuthMethod,
} from './Session.js';
export { MAX_TENANT_HIERARCHY_DEPTH, Tenant } from './Tenant.js';
export {
  TenantIntegration,
  type TenantIntegrationCheckSummary,
  type TenantIntegrationOptions,
  type TenantIntegrationProvider,
  type TenantIntegrationStatus,
} from './TenantIntegration.js';
export { TenantPermissionOverride } from './TenantPermissionOverride.js';
// Core entities
export { isValidEmail, normalizeEmail, User } from './User.js';
