import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Membership } from './models/Membership.js';
import { Permission } from './models/Permission.js';
import { ResourceGrant } from './models/ResourceGrant.js';
import { Role } from './models/Role.js';
import { Session } from './models/Session.js';
import { User } from './models/User.js';

/** Sign in through an application-authorized password, link, OIDC, or passkey flow. */
export class UsersSignInRecipe extends SmrtRecipe {
  static id = 'users.sign-in';
  static label = 'Sign in';
  static summary =
    'Access an account through an application-authorized sign-in flow.';
  static synonyms = ['log in', 'authentication', 'single sign-on'];
  static models = [User, Session];
  static nav = [{ label: 'Security sessions', model: Session }];
  static help = './users-sign-in.recipe.md';
  static options = {
    Session: { exposure: { api: false, mcp: false, cli: false } },
  } as const;
}

/** Manage tenant roles, permission grants, memberships, and record sharing. */
export class UsersRolesAndPermissionsRecipe extends SmrtRecipe {
  static id = 'users.roles-and-permissions';
  static label = 'Roles and permissions';
  static summary =
    'Manage tenant roles, memberships, permissions, and controlled sharing.';
  static synonyms = ['access control', 'rbac', 'sharing'];
  static models = [Role, Permission, Membership, ResourceGrant];
  static nav = [
    { label: 'Roles', model: Role },
    { label: 'Permissions', model: Permission },
  ];
  static help = './users-roles-and-permissions.recipe.md';
  static options = {
    ResourceGrant: { exposure: { api: false, mcp: false, cli: false } },
  } as const;
}
