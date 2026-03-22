import { USERS_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleTenant = {
  id: 'tenant-riverstone',
  name: 'Riverstone Newsroom',
  slug: 'riverstone-newsroom',
  status: 'active',
};

const sampleRoles = [
  {
    id: 'role-member',
    slug: 'member',
    name: 'Member',
    description: 'Can collaborate on editorial work.',
  },
  {
    id: 'role-editor',
    slug: 'editor',
    name: 'Editor',
    description: 'Can approve and publish content.',
  },
];

const sampleUsers = [
  {
    user: {
      id: 'user-taylor',
      email: 'taylor@example.com',
      status: 'active',
    },
    profile: {
      id: 'profile-taylor',
      name: 'Taylor Rowan',
      email: 'taylor@example.com',
    },
    role: 'Editor',
  },
  {
    user: {
      id: 'user-jordan',
      email: 'jordan@example.com',
      status: 'pending',
    },
    profile: {
      id: 'profile-jordan',
      name: 'Jordan Lee',
      email: 'jordan@example.com',
    },
    role: 'Contributor',
  },
];

const loadInviteUserModal = () => import('./components/InviteUserModal.svelte');
const loadUserForm = () => import('./components/UserForm.svelte');
const loadUserList = () => import('./components/UserList.svelte');
const loadUserMenu = () => import('./components/UserMenu.svelte');

export default {
  packageName: '@happyvertical/smrt-users',
  displayName: USERS_MODULE_META.displayName,
  description: USERS_MODULE_META.description,
  moduleMeta: USERS_MODULE_META,
  entries: [
    {
      id: 'user-list',
      title: 'User List',
      description:
        'Role-aware list of users with selection and profile display.',
      loadComponent: loadUserList,
      order: 1,
      props: {
        users: sampleUsers,
        selectedId: 'user-taylor',
        onselect: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'user-form',
      title: 'User Form',
      description: 'Create and edit form for user records and account status.',
      loadComponent: loadUserForm,
      order: 2,
      props: {
        user: sampleUsers[0].user,
        profile: sampleUsers[0].profile,
        onsubmit: noop,
        oncancel: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'invite-user-modal',
      title: 'Invite User Modal',
      description:
        'Invitation flow for adding a tenant member with a role assignment.',
      loadComponent: loadInviteUserModal,
      order: 3,
      props: {
        open: false,
        tenant: sampleTenant,
        roles: sampleRoles,
        onsubmit: noop,
        onclose: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'user-menu',
      title: 'User Menu',
      description:
        'Authenticated account menu for profile, settings, and sign-out actions.',
      loadComponent: loadUserMenu,
      order: 4,
      props: {
        profile: sampleUsers[0].profile,
        profileUrl: '/settings/profile',
        settingsUrl: '/settings',
        signoutUrl: '/auth/signout',
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
