/**
 * Users Module UI Slot Declarations
 *
 * This file defines the UI extension points for the users module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Users module UI slots
 */
export const USERS_UI_SLOTS: Record<string, ModuleUISlot> = {
  'user-card': {
    id: 'user-card',
    label: 'User Card',
    description: 'Compact user information display',
    icon: 'user',
    category: 'display',
    order: 1,
    propsInterface: 'UserCardProps',
  },
  'user-list': {
    id: 'user-list',
    label: 'User List',
    description: 'List of users with selection support',
    icon: 'users',
    category: 'list',
    order: 2,
    propsInterface: 'UserListProps',
  },
  'user-form': {
    id: 'user-form',
    label: 'User Form',
    description: 'Form for creating or editing users',
    icon: 'edit',
    category: 'form',
    order: 3,
    propsInterface: 'UserFormProps',
  },
  'user-avatar': {
    id: 'user-avatar',
    label: 'User Avatar',
    description: 'User profile image or initials display',
    icon: 'image',
    category: 'display',
    order: 4,
    propsInterface: 'UserAvatarProps',
  },
  'invite-user-modal': {
    id: 'invite-user-modal',
    label: 'Invite User Modal',
    description: 'Modal for inviting new users',
    icon: 'user-plus',
    category: 'form',
    order: 5,
    propsInterface: 'InviteUserModalProps',
  },
  'user-menu': {
    id: 'user-menu',
    label: 'User Menu',
    description: 'User profile menu dropdown',
    icon: 'menu',
    category: 'navigation',
    order: 6,
    propsInterface: 'UserMenuProps',
  },
};

/**
 * Users module metadata
 */
export const USERS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-users',
  displayName: 'Users',
  description: 'Multi-tenant user management with roles and permissions',
  uiSlots: USERS_UI_SLOTS,
  models: ['User', 'Tenant', 'Role', 'Permission', 'Group'],
  collections: [
    'UserCollection',
    'TenantCollection',
    'RoleCollection',
    'PermissionCollection',
    'GroupCollection',
  ],
};
