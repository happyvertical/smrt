/**
 * Users Module Svelte Components
 *
 * Optional Svelte UI components for user and tenant management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import type { ComponentProps } from 'svelte';
import { USERS_MODULE_META } from '../ui.js';

// Import components
import InviteUserModal from './components/InviteUserModal.svelte';
import UserAvatar from './components/UserAvatar.svelte';
import UserCard from './components/UserCard.svelte';
import UserForm from './components/UserForm.svelte';
import UserList from './components/UserList.svelte';
import UserMenu from './components/UserMenu.svelte';

// Export components
export { InviteUserModal, UserAvatar, UserCard, UserForm, UserList, UserMenu };

// Export component prop types
export type InviteUserModalProps = ComponentProps<typeof InviteUserModal>;
export type UserAvatarProps = ComponentProps<typeof UserAvatar>;
export type UserCardProps = ComponentProps<typeof UserCard>;
export type UserFormProps = ComponentProps<typeof UserForm>;
export type UserListProps = ComponentProps<typeof UserList>;
export type UserMenuProps = ComponentProps<typeof UserMenu>;

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(USERS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'invite-user-modal',
  InviteUserModal,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'user-avatar',
  UserAvatar,
);
ModuleUIRegistry.register('@happyvertical/smrt-users', 'user-card', UserCard);
ModuleUIRegistry.register('@happyvertical/smrt-users', 'user-form', UserForm);
ModuleUIRegistry.register('@happyvertical/smrt-users', 'user-list', UserList);
ModuleUIRegistry.register('@happyvertical/smrt-users', 'user-menu', UserMenu);
