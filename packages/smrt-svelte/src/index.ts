/**
 * @happyvertical/smrt-svelte
 *
 * Svelte 5 components for SMRT - Generic UI components that are not package-specific.
 *
 * Package-specific components have been moved to their respective packages:
 * - @happyvertical/smrt-agents/svelte
 * - @happyvertical/smrt-jobs/svelte
 * - @happyvertical/smrt-users/svelte (includes auth)
 * - @happyvertical/smrt-content/svelte
 * - @happyvertical/smrt-tenancy/svelte
 * - @happyvertical/smrt-browser-ai/svelte
 * - @happyvertical/smrt-events/svelte (meetings)
 * - @happyvertical/smrt-projects/svelte (time tracking)
 * - @happyvertical/smrt-commerce/svelte
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
// Calendar components
export * from './components/calendar/index.js';
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
// Theme components
export type { ThemeMode } from './components/theme/index.js';
// UI components
export * from './components/ui/index.js';
// Hooks
export * from './hooks/index.js';
// Core - App wrapper/provider
export { default as Provider } from './Provider.svelte';

// Module UI registry
export * from './registry/index.js';

// State management
export * from './state/index.js';

// Theme system
export * from './theme/index.js';

// Generic types (migrated from @happyvertical/svelte)
export type * from './types-generic.js';
