/**
 * Collection exports for smrt-users
 * @packageDocumentation
 */

// Group collections
export { GroupCollection } from './GroupCollection.js';
export { GroupMemberCollection } from './GroupMemberCollection.js';
export { GroupRoleCollection } from './GroupRoleCollection.js';
// Membership collections
export { MembershipCollection } from './MembershipCollection.js';
export { MembershipOverrideCollection } from './MembershipOverrideCollection.js';
export { PermissionCollection } from './PermissionCollection.js';
export { RoleCollection } from './RoleCollection.js';
// Role-permission join
export { RolePermissionCollection } from './RolePermissionCollection.js';
export { TenantCollection } from './TenantCollection.js';
// Core collections
export {
  type GetOrCreateFromOidcOptions,
  type OidcClaims,
  type OidcIdentityResult,
  UserCollection,
} from './UserCollection.js';
