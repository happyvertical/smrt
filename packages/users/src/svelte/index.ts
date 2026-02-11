/**
 * Users Module Svelte Components
 *
 * Optional Svelte UI components for user and tenant management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
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
export type { Props as InviteUserModalProps } from './components/InviteUserModal.svelte';
export type { Props as UserAvatarProps } from './components/UserAvatar.svelte';
export type { Props as UserCardProps } from './components/UserCard.svelte';
export type { Props as UserFormProps } from './components/UserForm.svelte';
export type { Props as UserListProps } from './components/UserList.svelte';
export type { Props as UserMenuProps } from './components/UserMenu.svelte';

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
