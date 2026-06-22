/**
 * @happyvertical/smrt-ui
 *
 * Domain-agnostic Svelte 5 UI runtime for SMRT: generic primitives, the i18n
 * client, the theme system, and the module UI registry. Depends only on
 * `svelte` (peer) and `@happyvertical/smrt-types` — no smrt domain package — so
 * domain packages can consume the UI runtime without taking a dependency on the
 * top-level `@happyvertical/smrt-svelte` integration layer.
 */

// Actions
export {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permission,
} from './actions/permission.js';
export { ripple } from './actions/ripple.js';
// Calendar components
export * from './components/calendar/index.js';
// Data components
export * from './components/data/index.js';
// Display components
export * from './components/display/index.js';
// Feedback components
export * from './components/feedback/index.js';
// Layout components
export * from './components/layout/index.js';
// Membership components (domain-agnostic — typed against smrt-types contracts)
export { default as MembershipCard } from './components/memberships/MembershipCard.svelte';
export { default as MembershipList } from './components/memberships/MembershipList.svelte';
// Navigation components
export * from './components/nav/index.js';
// Permission components
export { default as PermissionCheck } from './components/permissions/PermissionCheck.svelte';
// Role components (domain-agnostic — typed against smrt-types contracts)
export { default as RoleBadge } from './components/roles/RoleBadge.svelte';
export { default as RoleSelector } from './components/roles/RoleSelector.svelte';
// Theme components
export type { ThemeMode } from './components/theme/index.js';
// UI components
export * from './components/ui/index.js';
// Module UI registry
export * from './registry/index.js';
// Theme system
export * from './theme/index.js';
// Generic Svelte types (migrated from @happyvertical/svelte)
export type * from './types-generic.js';
