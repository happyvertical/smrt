/**
 * Model exports for smrt-users
 * @packageDocumentation
 */

// Groups
export { Group } from './Group.js';
export { GroupMember } from './GroupMember.js';
export { GroupRole } from './GroupRole.js';
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
  isValidPermissionSlug,
  type ParsedPermissionSlug,
  Permission,
  parsePermissionSlug,
} from './Permission.js';
export { Role } from './Role.js';
// Roles and permissions
export { RolePermission } from './RolePermission.js';
// Sessions
export {
  DEFAULT_SESSION_TTL,
  generateSessionId,
  Session,
} from './Session.js';
export { MAX_TENANT_HIERARCHY_DEPTH, Tenant } from './Tenant.js';
export { TenantPermissionOverride } from './TenantPermissionOverride.js';
// Core entities
export { isValidEmail, normalizeEmail, User } from './User.js';
