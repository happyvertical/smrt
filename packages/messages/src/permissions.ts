import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users/permission-registry';

export const SEND_MESSAGES_PERMISSION = 'messages.send';
export const MANAGE_MESSAGE_ROUTES_PERMISSION = 'messages.manage-routes';
export const MANAGE_MESSAGE_CREDENTIALS_PERMISSION =
  'messages.manage-credentials';
/** Tenant-level ceilings for the per-account mail scopes (see `access.ts`). */
export const READ_MAIL_PERMISSION = 'messages.read';
export const TRIAGE_MAIL_PERMISSION = 'messages.triage';
export const DRAFT_MAIL_PERMISSION = 'messages.draft';
export const MANAGE_MAIL_ACCESS_PERMISSION = 'messages.manage-access';

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
  {
    slug: TRIAGE_MAIL_PERMISSION,
    category: 'messages',
    name: 'Triage Mail',
    description:
      'Archive, flag and file mail; a mail account grant narrows this per account',
  },
  {
    slug: DRAFT_MAIL_PERMISSION,
    category: 'messages',
    name: 'Draft Mail',
    description:
      'Write mail drafts; a mail account grant narrows this per account',
  },
  {
    slug: MANAGE_MAIL_ACCESS_PERMISSION,
    category: 'messages',
    name: 'Manage Mail Access',
    description:
      'Grant or revoke per-account mail access; only an account owner or a delegating grantee may use it on that account',
  },
];

export interface MessagingPrincipal {
  readonly id?: string;
  /**
   * The smrt-users `User` id that owns mail accounts. Defaults to `id`; set it
   * when the principal id is something else (an agent credential id).
   */
  readonly userId?: string;
  readonly tenantId?: string;
  can(slug: string): boolean;
}

export function messagingPrincipalFromPermissions(
  permissions: Iterable<string>,
  options: { id?: string; userId?: string; tenantId?: string } = {},
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
