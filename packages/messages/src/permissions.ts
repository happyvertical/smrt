import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users/permission-registry';
import type { MailScope } from './access.js';

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
    name: 'Triage Messages',
    // Must equal the description generated for Email.triage(), like `send`
    // above: the catalog refuses two descriptions for one slug.
    description: 'Allows triage on messages',
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

/**
 * Tenant `messages.*` permissions for the built-in system roles. Per-account
 * mail access (grants, `MailAccessService`) is checked against smrt-users role
 * permissions, so a fresh app fails closed for everyone, owners included,
 * until these exist.
 *
 * - `owner`, `admin`: every mail scope plus `manage-credentials` and
 *   `manage-access`
 * - `member`: the four scope ceilings (read, triage, draft, send)
 * - `viewer`: read
 *
 * Tenant ceilings only: a non-owner still needs a per-account grant before
 * seeing any mail. `manage-routes` (persona routing) is not part of the mail
 * matrix.
 */
export const MESSAGES_ROLE_PERMISSION_MATRIX: Readonly<
  Record<'owner' | 'admin' | 'member' | 'viewer', readonly string[]>
> = Object.freeze({
  owner: Object.freeze([
    READ_MAIL_PERMISSION,
    TRIAGE_MAIL_PERMISSION,
    DRAFT_MAIL_PERMISSION,
    SEND_MESSAGES_PERMISSION,
    MANAGE_MESSAGE_CREDENTIALS_PERMISSION,
    MANAGE_MAIL_ACCESS_PERMISSION,
  ]),
  admin: Object.freeze([
    READ_MAIL_PERMISSION,
    TRIAGE_MAIL_PERMISSION,
    DRAFT_MAIL_PERMISSION,
    SEND_MESSAGES_PERMISSION,
    MANAGE_MESSAGE_CREDENTIALS_PERMISSION,
    MANAGE_MAIL_ACCESS_PERMISSION,
  ]),
  member: Object.freeze([
    READ_MAIL_PERMISSION,
    TRIAGE_MAIL_PERMISSION,
    DRAFT_MAIL_PERMISSION,
    SEND_MESSAGES_PERMISSION,
  ]),
  viewer: Object.freeze([READ_MAIL_PERMISSION]),
});

export interface SeedMessagesRolePermissionsResult {
  /** Slugs newly granted per system role; empty on a rerun. */
  added: Record<string, string[]>;
  /** Built-in roles absent from the database (not created here). */
  missingRoles: string[];
}

/**
 * Register the messaging permission catalog entries and grant
 * {@link MESSAGES_ROLE_PERMISSION_MATRIX} to the system roles. Idempotent and
 * additive: reruns add nothing, nothing is ever removed (`prune: false`), and
 * only system roles (no tenant, `isSystem`) are touched, so tenant-defined
 * roles keep whatever the tenant chose. Throws if a slug is not in the
 * catalog after sync.
 */
export async function seedMessagesRolePermissions(options: {
  db: unknown;
}): Promise<SeedMessagesRolePermissionsResult> {
  ensureMessagingPermissionsRegistered();
  const { RolePermissionCollection } = await import(
    '@happyvertical/smrt-users'
  );
  const grants = await RolePermissionCollection.create(options as never);
  const result = await grants.seedRolePermissions(
    MESSAGES_ROLE_PERMISSION_MATRIX as unknown as Record<string, string[]>,
    { prune: false, systemRolesOnly: true },
  );
  const missing = Object.entries(result.missingPermissions).filter(
    ([, slugs]) => slugs.length > 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `Messaging permissions missing from the catalog after sync: ${missing
        .map(([role, slugs]) => `${role}: ${slugs.join(', ')}`)
        .join('; ')}`,
    );
  }
  return {
    added: Object.fromEntries(
      Object.entries(result.added).filter(([, slugs]) => slugs.length > 0),
    ),
    missingRoles: result.missingRoles,
  };
}

export interface MessagingPrincipal {
  readonly id?: string;
  /**
   * The smrt-users `User` id that owns mail accounts. Defaults to `id`; set it
   * when the principal id is something else (an agent credential id).
   */
  readonly userId?: string;
  readonly tenantId?: string;
  /** Host ceiling on mail scopes (agent credential); omit for none. */
  readonly scopes?: readonly MailScope[];
  /** Host ceiling on mail account ids (agent allow-list); omit for none. */
  readonly accountIds?: readonly string[];
  can(slug: string): boolean;
}

export function messagingPrincipalFromPermissions(
  permissions: Iterable<string>,
  options: {
    id?: string;
    userId?: string;
    tenantId?: string;
    scopes?: readonly MailScope[];
    accountIds?: readonly string[];
  } = {},
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
