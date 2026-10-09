import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Membership } from './models/Membership.js';
import { Permission } from './models/Permission.js';
import { ResourceGrant } from './models/ResourceGrant.js';
import { Role } from './models/Role.js';
import { Session } from './models/Session.js';
import { User } from './models/User.js';

/** Sign in through an application-authorized password, link, OIDC, or passkey flow. */
export class UsersSignInRecipe extends SmrtRecipe {
  static group = {
    id: 'account-access',
    label: 'Account access',
    summary: 'Sign in and manage account sessions.',
  };
  static section = {
    id: 'account-security',
    label: 'Account security',
    icon: 'shield-check',
    description: 'Review account access and active sessions.',
  };
  static id = 'users.sign-in';
  static label = 'Sign in';
  static summary =
    'Access an account through an application-authorized sign-in flow.';
  static synonyms = ['log in', 'authentication', 'single sign-on'];
  static models = [User, Session];
  static providers = [
    {
      id: 'oidc',
      kind: 'oauth',
      options: ['oidc'],
      required: false,
    },
  ] as const;
  static surfaces = [
    {
      kind: 'settings-panel',
      export: '@happyvertical/smrt-users/svelte#AccountSecurityPanel',
      label: 'Account security',
    },
  ] as const;
  static nav = [
    {
      label: 'Security sessions',
      model: Session,
      icon: 'monitor-smartphone',
      description: 'Review active sessions and sign out unrecognized devices.',
      noun: 'security session',
    },
  ];
  static help = './users-sign-in.recipe.md';
  static options = {
    Session: { exposure: { api: false, mcp: false, cli: false } },
  } as const;
}

/** Manage tenant roles, permission grants, memberships, and record sharing. */
export class UsersRolesAndPermissionsRecipe extends SmrtRecipe {
  static group = {
    id: 'account-access',
    label: 'Account access',
    summary: 'Sign in and manage account sessions.',
  };
  static section = {
    id: 'access-control',
    label: 'Access control',
    icon: 'shield-keyhole',
    description: 'Manage tenant roles, permissions, and reviewed sharing.',
  };
  static id = 'users.roles-and-permissions';
  static label = 'Roles and permissions';
  static summary =
    'Manage tenant roles, memberships, permissions, and controlled sharing.';
  static synonyms = ['access control', 'rbac', 'sharing'];
  static models = [Role, Permission, Membership, ResourceGrant];
  static nav = [
    {
      label: 'Roles',
      model: Role,
      icon: 'badge-check',
      description: 'Define tenant permission bundles.',
      noun: 'role',
    },
    {
      label: 'Permissions',
      model: Permission,
      icon: 'key-round',
      description: 'Review operations available to roles.',
      noun: 'permission',
    },
  ];
  static help = './users-roles-and-permissions.recipe.md';
  static options = {
    ResourceGrant: { exposure: { api: false, mcp: false, cli: false } },
  } as const;
}
