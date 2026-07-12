import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

export const SEND_MESSAGES_PERMISSION = 'messages.send';
export const MANAGE_MESSAGE_ROUTES_PERMISSION = 'messages.manage-routes';
export const MANAGE_MESSAGE_CREDENTIALS_PERMISSION =
  'messages.manage-credentials';

export const MESSAGING_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: SEND_MESSAGES_PERMISSION,
    category: 'messages',
    name: 'Send Messages',
    description: 'Allows send on messages',
  },
  {
    slug: MANAGE_MESSAGE_ROUTES_PERMISSION,
    category: 'messages',
    name: 'Manage Message Routes',
    description: 'Manage persona messaging endpoints and route bindings',
  },
  {
    slug: MANAGE_MESSAGE_CREDENTIALS_PERMISSION,
    category: 'messages',
    name: 'Manage Message Credentials',
    description: 'Create accounts and replace write-only provider credentials',
  },
];

export interface MessagingPrincipal {
  readonly id?: string;
  readonly tenantId?: string;
  can(slug: string): boolean;
}

export function messagingPrincipalFromPermissions(
  permissions: Iterable<string>,
  options: { id?: string; tenantId?: string } = {},
): MessagingPrincipal {
  const granted = new Set(permissions);
  return {
    ...options,
    can: (slug) => granted.has(slug),
  };
}

export function assertMessagingPermission(
  principal: MessagingPrincipal,
  tenantId: string,
  permission: string,
): void {
  if (principal.tenantId && principal.tenantId !== tenantId) {
    throw new Error('Messaging principal does not belong to this tenant.');
  }
  if (!principal.can(permission)) {
    throw new Error(`Missing required permission '${permission}'.`);
  }
}

let registered = false;

export function ensureMessagingPermissionsRegistered(): void {
  if (registered) return;
  registered = true;
  registerPermissionDefinitions(MESSAGING_PERMISSION_DEFINITIONS);
}
