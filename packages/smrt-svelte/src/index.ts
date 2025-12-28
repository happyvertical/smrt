/**
 * @happyvertical/smrt-svelte
 *
 * Svelte 5 components for SMRT user management
 */

// Actions
export {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permission,
} from './actions/permission.js';
// Auth components
export { default as UserMenu } from './components/auth/UserMenu.svelte';
// Permission components
export { default as PermissionCheck } from './components/permissions/PermissionCheck.svelte';

// Role components
export { default as RoleBadge } from './components/roles/RoleBadge.svelte';
// Tenant components
export { default as TenantSwitcher } from './components/tenants/TenantSwitcher.svelte';
// User components
export { default as UserAvatar } from './components/users/UserAvatar.svelte';
