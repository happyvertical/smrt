/**
 * Collection exports for smrt-users
 * @packageDocumentation
 */

// Access requests (request access / waitlist)
export { AccessRequestCollection } from './AccessRequestCollection.js';
// CLI / terminal auth
export {
  CliAuthRequestCollection,
  UsersCliAuthRequestCollection,
} from './CliAuthRequestCollection.js';
// Group collections
export { GroupCollection } from './GroupCollection.js';
export { GroupMemberCollection } from './GroupMemberCollection.js';
export { GroupRoleCollection } from './GroupRoleCollection.js';
// Magic Link
export {
  MagicLinkTokenCollection,
  UsersMagicLinkTokenCollection,
} from './MagicLinkTokenCollection.js';
// Membership collections
export { MembershipCollection } from './MembershipCollection.js';
export { MembershipOverrideCollection } from './MembershipOverrideCollection.js';
export { PermissionCollection } from './PermissionCollection.js';
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
export {
  TenantPermissionOverrideCollection,
  type TenantPermissionOverrideResult,
} from './TenantPermissionOverrideCollection.js';
// Core collections
export {
  type GetOrCreateFromOidcOptions,
  type OidcClaims,
  type OidcIdentityResult,
  UserCollection,
} from './UserCollection.js';
