/**
 * @happyvertical/smrt-svelte
 *
 * Svelte 5 components for SMRT user management and AI features
 */

// Actions
export {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permission,
} from './actions/permission.js';
export { ripple } from './actions/ripple.js';

// Admin components
export * from './components/admin/index.js';
// AI Components
export * from './components/ai/index.js';
// Auth components
export { default as UserMenu } from './components/auth/UserMenu.svelte';
// Calendar components
export * from './components/calendar/index.js';
// Commerce components
export * from './components/commerce/index.js';
// Content components
export * from './components/content/index.js';
// Data Components
export * from './components/data/index.js';
// Display components
export * from './components/display/index.js';
// Feedback components
export * from './components/feedback/index.js';
// Form components
export * from './components/forms/index.js';
// Layout components
export * from './components/layout/index.js';
// Meeting components
export * from './components/meetings/index.js';
// Membership components
export { default as MembershipCard } from './components/memberships/MembershipCard.svelte';
export { default as MembershipList } from './components/memberships/MembershipList.svelte';
// Module components (for dynamic module UI rendering)
export * from './components/module/index.js';
// Navigation components
export * from './components/nav/index.js';
// Permission components
export { default as PermissionCheck } from './components/permissions/PermissionCheck.svelte';
// Role components
export { default as RoleBadge } from './components/roles/RoleBadge.svelte';
export { default as RoleSelector } from './components/roles/RoleSelector.svelte';
export { default as TenantCard } from './components/tenants/TenantCard.svelte';
// Tenant components
export { default as TenantSwitcher } from './components/tenants/TenantSwitcher.svelte';
// Theme components (selective - avoiding duplicate ThemeProvider export)
export type { ThemeMode } from './components/theme/index.js';
// Time tracking components
export * from './components/time/index.js';
// UI components
export * from './components/ui/index.js';
export { default as InviteUserModal } from './components/users/InviteUserModal.svelte';
// User components
export { default as UserAvatar } from './components/users/UserAvatar.svelte';
export { default as UserCard } from './components/users/UserCard.svelte';
export { default as UserForm } from './components/users/UserForm.svelte';
export { default as UserList } from './components/users/UserList.svelte';
// Hooks
export * from './hooks/index.js';
// Module UI registry
export * from './registry/index.js';
// State management
export * from './state/index.js';
// Theme system
export * from './theme/index.js';
// Generic types (migrated from @happyvertical/svelte)
export type * from './types-generic.js';
