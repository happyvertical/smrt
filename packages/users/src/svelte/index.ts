/**
 * Users Module Svelte Components
 *
 * Optional Svelte UI components for user and tenant management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { USERS_MODULE_META } from '../ui.js';
import AccountSecurityPanel from './components/AccountSecurityPanel.svelte';
// Import components
import InviteUserModal from './components/InviteUserModal.svelte';
import MagicLinkForm from './components/MagicLinkForm.svelte';
import OidcProviderButtons from './components/OidcProviderButtons.svelte';
import PasskeySignInButton from './components/PasskeySignInButton.svelte';
import SignInForm from './components/SignInForm.svelte';
import SignUpForm from './components/SignUpForm.svelte';
import UserAvatar from './components/UserAvatar.svelte';
import UserCard from './components/UserCard.svelte';
import UserForm from './components/UserForm.svelte';
import UserList from './components/UserList.svelte';
import UserMenu from './components/UserMenu.svelte';

export type {
  AccountApiKey,
  AccountSession,
  OidcProviderButton,
  UsersAuthAdapter,
  UsersAuthEndpointOptions,
} from './auth.js';
export { createUsersAuthAdapter } from './auth.js';
// Export components
export {
  AccountSecurityPanel,
  InviteUserModal,
  MagicLinkForm,
  OidcProviderButtons,
  PasskeySignInButton,
  SignInForm,
  SignUpForm,
  UserAvatar,
  UserCard,
  UserForm,
  UserList,
  UserMenu,
};

// Export component prop types
export type InviteUserModalProps = ComponentProps<typeof InviteUserModal>;
export type UserAvatarProps = ComponentProps<typeof UserAvatar>;
export type UserCardProps = ComponentProps<typeof UserCard>;
export type UserFormProps = ComponentProps<typeof UserForm>;
export type UserListProps = ComponentProps<typeof UserList>;
export type UserMenuProps = ComponentProps<typeof UserMenu>;
export type AccountSecurityPanelProps = ComponentProps<
  typeof AccountSecurityPanel
>;
export type MagicLinkFormProps = ComponentProps<typeof MagicLinkForm>;
export type OidcProviderButtonsProps = ComponentProps<
  typeof OidcProviderButtons
>;
export type PasskeySignInButtonProps = ComponentProps<
  typeof PasskeySignInButton
>;
export type SignInFormProps = ComponentProps<typeof SignInForm>;
export type SignUpFormProps = ComponentProps<typeof SignUpForm>;

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
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'sign-in-form',
  SignInForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'sign-up-form',
  SignUpForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'magic-link-form',
  MagicLinkForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'oidc-provider-buttons',
  OidcProviderButtons,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'passkey-sign-in-button',
  PasskeySignInButton,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-users',
  'account-security-panel',
  AccountSecurityPanel,
);
