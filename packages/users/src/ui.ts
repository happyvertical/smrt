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
  'sign-in-form': {
    id: 'sign-in-form',
    label: 'Sign In Form',
    description: 'Accessible password sign-in form',
    icon: 'log-in',
    category: 'form',
    order: 0,
    propsInterface: 'SignInFormProps',
  },
  'sign-up-form': {
    id: 'sign-up-form',
    label: 'Sign Up Form',
    description: 'Accessible account creation form',
    icon: 'user-plus',
    category: 'form',
    order: 0,
    propsInterface: 'SignUpFormProps',
  },
  'magic-link-form': {
    id: 'magic-link-form',
    label: 'Magic Link Form',
    description: 'Magic-link request and confirmation form',
    icon: 'mail',
    category: 'form',
    order: 0,
    propsInterface: 'MagicLinkFormProps',
  },
  'oidc-provider-buttons': {
    id: 'oidc-provider-buttons',
    label: 'OIDC Provider Buttons',
    description: 'Configured single sign-on providers',
    icon: 'key',
    category: 'action',
    order: 0,
    propsInterface: 'OidcProviderButtonsProps',
  },
  'passkey-sign-in-button': {
    id: 'passkey-sign-in-button',
    label: 'Passkey Sign In',
    description: 'Capability-gated passkey sign-in button',
    icon: 'fingerprint',
    category: 'action',
    order: 0,
    propsInterface: 'PasskeySignInButtonProps',
  },
  'account-security-panel': {
    id: 'account-security-panel',
    label: 'Account Security Panel',
    description: 'Session and API-key revocation controls',
    icon: 'shield',
    category: 'display',
    order: 0,
    propsInterface: 'AccountSecurityPanelProps',
  },
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
    category: 'action',
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
