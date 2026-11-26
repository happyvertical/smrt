/**
 * Per-account mail access: an optional owner plus grants (read, triage, draft,
 * send) for people and host-mapped agent accounts, on smrt-users
 * `ResourceGrant`.
 *
 * Optional by default: a mail account with no `ownerUserId` keeps today's
 * tenant-wide behavior. An app that wants private or shared mailboxes sets an
 * owner and calls {@link configureMailAccess} once at startup; from then on
 * reads of an owned account's emails, folders and attachments are limited to
 * the owner and read grantees (enforced in the collection layer by
 * `access-enforcement.ts`, never by UI), and sending through an owned account
 * needs the `send` scope.
 *
 * The acting principal comes from the host through `resolvePrincipal`, so
 * smrt never knows the host's credential model (a session cookie, an agent
 * bearer token). Fail closed: an owned account is invisible to a missing,
 * foreign-tenant or ceiling-excluded principal. There is no tenant-admin or
 * super-admin bypass on content; trusted server work (sync, outbox) opts in
 * explicitly with {@link runWithMailSystemAccess}.
 *
 * Grants live in `ResourceGrant` (resource type {@link MAIL_ACCOUNT_RESOURCE_TYPE},
 * permission `messages.<scope>`). smrt-users composes them after tenant RBAC:
 * the grantee must also hold the tenant-level `messages.<scope>` permission,
 * which acts as the tenant's ceiling; the exact grant then narrows it per
 * account. The owner implicitly holds every scope on their own accounts and
 * needs no grant.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { createHandoffContext, getCurrentTenant } from './host.js';
import {
  DRAFT_MAIL_PERMISSION,
  MANAGE_MAIL_ACCESS_PERMISSION,
  READ_MAIL_PERMISSION,
  TRIAGE_MAIL_PERMISSION,
} from './permissions.js';
import type { AgentSendPolicy } from './types.js';

export const MAIL_SCOPES = ['read', 'triage', 'draft', 'send'] as const;
export type MailScope = (typeof MAIL_SCOPES)[number];

/** `ResourceGrant.resourceType` for a mail account. */
export const MAIL_ACCOUNT_RESOURCE_TYPE = 'messages:account';

const SCOPE_PERMISSIONS: Record<MailScope, string> = {
  read: READ_MAIL_PERMISSION,
  triage: TRIAGE_MAIL_PERMISSION,
  draft: DRAFT_MAIL_PERMISSION,
  send: 'messages.send',
};

/** The tenant permission slug that is the ceiling for a mail scope. */
export function mailScopePermission(scope: MailScope): string {
  return SCOPE_PERMISSIONS[scope];
}

export function isMailScope(value: unknown): value is MailScope {
  return (MAIL_SCOPES as readonly unknown[]).includes(value);
}

/** The acting principal, as the host knows it. */
export interface MailPrincipal {
  /** Host identity recorded for audit (a user id, an agent credential id). */
  id: string;
  /** Tenant the principal authenticated into. Must equal the account's. */
  tenantId: string;
  /**
   * The smrt-users `User` id that owns accounts and holds `ResourceGrant`
   * rows. People are their own user; an agent account is a `User` row the host
   * maps its credential to.
   */
  userId: string;
  /**
   * `'person'` (or `'human'`) for a person; anything else, including no
   * label, is treated as an agent: its sends follow the account's agent send
   * policy and it can never approve a held send.
   */
  kind?: string;
  /**
   * Host ceiling on scopes (for example an agent credential's mail scopes).
   * Intersected with the owner/grant decision; omit for no ceiling. An empty
   * list grants nothing.
   */
  scopes?: readonly MailScope[];
  /**
   * Host ceiling on account ids (for example `allowedMailAccountIds`).
   * Intersected with the owner/grant decision; omit for no ceiling. An empty
   * list grants nothing.
   */
  accountIds?: readonly string[];
}

export interface MailAccessResolverContext {
  tenantId: string | null;
}

/** Returns the acting principal for the current request or job, or null. */
export type MailAccessResolver = (
  context: MailAccessResolverContext,
) =>
  | MailPrincipal
  | null
  | undefined
  | Promise<MailPrincipal | null | undefined>;

export interface MailAccessConfig {
  /** Database options used to read accounts and grants. Required. */
  options: SmrtClassOptions;
  /** The host's access-check hook. Without it every owned account is closed. */
  resolvePrincipal?: MailAccessResolver;
}

interface MailAccessState {
  config: MailAccessConfig | null;
  /** Database options seen on a mail row, used until the host configures. */
  learned: Map<unknown, SmrtClassOptions>;
  system: ReturnType<typeof createHandoffContext<true>>;
}

const STATE_KEY = Symbol.for('@happyvertical/smrt-messages:mail-access');

// Shared through globalThis: module-local state splits when a bundler or test
// runner loads this module twice, and a split would silently drop enforcement.
function state(): MailAccessState {
  const holder = globalThis as Record<symbol, unknown>;
  let current = holder[STATE_KEY] as MailAccessState | undefined;
  if (!current) {
    current = {
      config: null,
      learned: new Map(),
      system: createHandoffContext<true>(),
    };
    holder[STATE_KEY] = current;
  }
  return current;
}

/**
 * Turn on mail access enforcement for this process. Call once at startup,
 * after the database is available. Calling again replaces the configuration.
 */
export function configureMailAccess(config: MailAccessConfig): void {
  state().config = { ...config, options: withoutListBounds(config.options) };
}

/** Remove the configuration (tests). Owned accounts then fail closed. */
export function resetMailAccess(): void {
  state().config = null;
  state().learned.clear();
}

/**
 * Remember the database a mail row was read with. Until the host calls
 * {@link configureMailAccess}, this lets the policy still find owned accounts
 * and hide their mail (no principal resolver means no one is a principal).
 */
/**
 * The options with their list bounds removed. `create()` forwards
 * `defaultListLimit`/`maxListLimit` from any options bag, and an access
 * decision needs every account: a truncated read would leave owned accounts
 * out of the denied set and leak their mail.
 */
export function withoutListBounds<T extends object>(options: T): T {
  return { ...options, defaultListLimit: undefined, maxListLimit: undefined };
}

export function learnMailAccessOptions(
  options: SmrtClassOptions | undefined,
): void {
  const current = state();
  if (current.config || !options) return;
  // One entry per database, so a process with several keeps each of them.
  const key = options.db ?? options;
  current.learned.delete(key);
  current.learned.set(key, withoutListBounds(options));
  if (current.learned.size > 16) {
    const oldest = current.learned.keys().next().value;
    current.learned.delete(oldest);
  }
}

/** Every policy in force: the configured one, else one per learned database. */
export function getEffectiveMailAccessConfigs(): MailAccessConfig[] {
  const current = state();
  if (current.config) return [current.config];
  return [...current.learned.values()].map((options) => ({ options }));
}

/** The configured policy, else a closed one over the learned database. */
export function getEffectiveMailAccessConfig(): MailAccessConfig | null {
  const current = state();
  if (current.config) return current.config;
  const latest = [...current.learned.values()].pop();
  return latest ? { options: latest } : null;
}

export function getMailAccessConfig(): MailAccessConfig | null {
  return state().config;
}

/**
 * Run trusted server work (mailbox sync, the notification outbox) with the
 * per-account policy lifted. This is the only bypass; tenant-admin and
 * super-admin contexts do not lift it.
 */
export function runWithMailSystemAccess<T>(fn: () => T): T {
  return state().system.run(true, fn);
}

export function inMailSystemAccess(): boolean {
  return state().system.getStore() === true;
}

/** The minimal account shape the policy reads. */
export interface MailAccessSubject {
  id?: string | null;
  tenantId?: string | null;
  ownerUserId?: string | null;
}

export type MailAccessReason =
  | 'unowned'
  | 'system'
  | 'owner'
  | 'grant'
  | 'not_configured'
  | 'no_principal'
  | 'tenant_mismatch'
  | 'ceiling'
  | 'denied';

export interface MailAccessDecision {
  allowed: boolean;
  reason: MailAccessReason;
}

/** Thrown by {@link assertMailAccess}; carries a 403-class status. */
export class MailAccessError extends Error {
  readonly status = 403;
  constructor(
    readonly scope: MailScope,
    readonly reason: MailAccessReason,
  ) {
    super(`Mail access denied for scope '${scope}'.`);
    this.name = 'MailAccessError';
  }
}

async function resolvePrincipal(
  config: MailAccessConfig,
): Promise<MailPrincipal | null> {
  if (!config.resolvePrincipal) return null;
  const principal = await config.resolvePrincipal({
    tenantId: getCurrentTenant()?.tenantId ?? null,
  });
  if (
    !principal ||
    typeof principal.id !== 'string' ||
    !principal.id ||
    typeof principal.userId !== 'string' ||
    !principal.userId ||
    typeof principal.tenantId !== 'string' ||
    !principal.tenantId
  ) {
    return null;
  }
  return principal;
}

/**
 * The acting principal for the current request or job, as the host's
 * `resolvePrincipal` returns it, or null (nothing configured, no resolver, or
 * a malformed principal).
 */
export async function resolveMailPrincipal(): Promise<MailPrincipal | null> {
  const config = getEffectiveMailAccessConfig();
  return config ? await resolvePrincipal(config) : null;
}

/**
 * True only for a principal the host explicitly labels a person (`kind`
 * `'person'` or `'human'`). Fail closed: a missing or unknown label is an
 * agent, so it is held for approval and can never approve.
 */
export function isPersonMailPrincipal(
  principal: Pick<MailPrincipal, 'kind'> | null | undefined,
): boolean {
  return principal?.kind === 'person' || principal?.kind === 'human';
}

async function hasGrant(
  config: MailAccessConfig,
  principal: MailPrincipal,
  account: MailAccessSubject,
  scope: MailScope,
): Promise<boolean> {
  const { checkResourceOperationPermission } = await import(
    '@happyvertical/smrt-users'
  );
  const accountId = account.id ?? '';
  const tenantId = account.tenantId ?? '';
  if (!accountId || !tenantId) return false;
  const decision = await checkResourceOperationPermission({
    ...config.options,
    collection: 'messages',
    action: scope,
    tenantId,
    userId: principal.userId,
    // No tenant-admin or super-admin bypass on mail content, even for an
    // ambient system context: only an exact grant opens a shared account.
    allowSuperAdminBypass: false,
    allowSystemContextBypass: false,
    resource: {
      tenantId,
      resourceType: MAIL_ACCOUNT_RESOURCE_TYPE,
      resourceId: accountId,
    },
    verifyResource: (resource) =>
      resource.tenantId === tenantId &&
      resource.resourceType === MAIL_ACCOUNT_RESOURCE_TYPE &&
      resource.resourceId === accountId,
  });
  return decision.allowed;
}

/**
 * Decide whether the current principal holds `scope` on `account`. Never
 * throws for a denial; a lookup failure denies.
 */
export async function decideMailAccess(
  account: MailAccessSubject,
  scope: MailScope,
  principalOverride?: MailPrincipal | null,
): Promise<MailAccessDecision> {
  if (inMailSystemAccess()) return { allowed: true, reason: 'system' };
  const config = getEffectiveMailAccessConfig();
  const owned = Boolean(account.ownerUserId);
  if (!config) {
    // Nothing configured: unowned accounts keep the framework default
    // (tenant-wide); an owned account cannot be checked, so it is closed.
    return owned
      ? { allowed: false, reason: 'not_configured' }
      : { allowed: true, reason: 'unowned' };
  }
  const principal =
    principalOverride !== undefined
      ? principalOverride
      : await resolvePrincipal(config);
  if (!principal) {
    return owned
      ? { allowed: false, reason: 'no_principal' }
      : { allowed: true, reason: 'unowned' };
  }
  if (account.tenantId && principal.tenantId !== account.tenantId) {
    return { allowed: false, reason: 'tenant_mismatch' };
  }
  const currentTenant = getCurrentTenant()?.tenantId;
  if (currentTenant && currentTenant !== principal.tenantId) {
    return { allowed: false, reason: 'tenant_mismatch' };
  }
  if (principal.scopes && !principal.scopes.includes(scope)) {
    return { allowed: false, reason: 'ceiling' };
  }
  if (
    principal.accountIds &&
    (!account.id || !principal.accountIds.includes(account.id))
  ) {
    return { allowed: false, reason: 'ceiling' };
  }
  if (!owned) return { allowed: true, reason: 'unowned' };
  if (account.ownerUserId === principal.userId) {
    return { allowed: true, reason: 'owner' };
  }
  try {
    return (await hasGrant(config, principal, account, scope))
      ? { allowed: true, reason: 'grant' }
      : { allowed: false, reason: 'denied' };
  } catch {
    return { allowed: false, reason: 'denied' };
  }
}

export async function canAccessMailAccount(
  account: MailAccessSubject,
  scope: MailScope,
): Promise<boolean> {
  return (await decideMailAccess(account, scope)).allowed;
}

export async function assertMailAccess(
  account: MailAccessSubject,
  scope: MailScope,
): Promise<void> {
  const decision = await decideMailAccess(account, scope);
  if (!decision.allowed) throw new MailAccessError(scope, decision.reason);
}

/**
 * Ids of accounts in the current tenant context on which the current
 * principal lacks `scope`. Empty when nothing is configured or the call runs
 * in {@link runWithMailSystemAccess}.
 */
export async function deniedMailAccountIds(
  scope: MailScope,
): Promise<string[]> {
  if (inMailSystemAccess()) return [];
  const { AccountCollection } = await import(
    './collections/AccountCollection.js'
  );
  const denied = new Set<string>();
  // Without a configured policy every database a mail collection has opened
  // is checked: ids are unique, so a union never hides the wrong thing.
  for (const config of getEffectiveMailAccessConfigs()) {
    let accounts: Awaited<
      ReturnType<InstanceType<typeof AccountCollection>['list']>
    >;
    try {
      accounts = await runWithMailSystemAccess(async () =>
        (await AccountCollection.create(config.options)).list({}),
      );
    } catch (error) {
      // A learned database that has since been closed holds nothing to read
      // through it; forget it. Any other failure stays fail-closed.
      if (!state().config && /CLIENT_CLOSED/.test(String(error))) {
        state().learned.delete(config.options.db ?? config.options);
        continue;
      }
      throw error;
    }
    const principal = await resolvePrincipal(config);
    for (const account of accounts) {
      if (!account.id) continue;
      const decision = await decideMailAccess(
        {
          id: account.id,
          tenantId: account.tenantId,
          ownerUserId: account.ownerUserId,
        },
        scope,
        principal,
      );
      if (!decision.allowed) denied.add(account.id);
    }
  }
  return [...denied];
}

/** Whether the current principal may read mail of `accountId` (empty: yes). */
export async function accountReadable(
  accountId: string | null | undefined,
  options: SmrtClassOptions | undefined,
): Promise<boolean> {
  if (inMailSystemAccess()) return true;
  learnMailAccessOptions(options);
  if (!accountId) return true;
  const config = getEffectiveMailAccessConfig();
  if (!config) return true;
  const { AccountCollection } = await import(
    './collections/AccountCollection.js'
  );
  const account = await runWithMailSystemAccess(async () =>
    (await AccountCollection.create(config.options)).get({ id: accountId }),
  );
  // An account that cannot be found (deleted by another path, or outside this
  // tenant) must not turn its mail into tenant-wide mail: fail closed.
  if (!account) return false;
  return (
    await decideMailAccess(
      {
        id: account.id,
        tenantId: account.tenantId,
        ownerUserId: account.ownerUserId,
      },
      'read',
    )
  ).allowed;
}

const FALSE_FLAGS = new Set(['', '0', 'false']);

/**
 * One reading of a stored or caller-supplied boolean flag (`true`, `1`, `'1'`,
 * `'true'`, whatever a column or a generated route hands over). Anything that
 * is not plainly false counts as set, so an unusual form fails closed.
 */
export function mailFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0) return false;
  if (typeof value === 'string') {
    return !FALSE_FLAGS.has(value.trim().toLowerCase());
  }
  return true;
}

/**
 * Draft content: an email flagged `isDraft` that has not been sent. Every send
 * status but `sent` counts (`draft`, `pending`, `scheduled`, `sending`,
 * `failed`), so relabelling the status never takes a draft out of the gate.
 * Received mail is not flagged, whatever status it carries.
 */
export function isUnsentDraft(sendStatus: unknown, isDraft: unknown): boolean {
  return mailFlag(isDraft) && sendStatus !== 'sent';
}

/** Fields only a provider sync sets: they tie a row to mail that arrived. */
const PROVENANCE_FIELDS = [
  ['messageId', 'message_id'],
  ['folderId', 'folder_id'],
  ['tweetId', 'tweet_id'],
  ['slackTs', 'slack_ts'],
] as const;

/** Whether a row (instance or stored, any naming) carries a provider id. */
export function hasMailProvenance(row: Record<string, unknown>): boolean {
  return PROVENANCE_FIELDS.some(([camel, snake]) => {
    for (const value of [row[camel], row[snake]]) {
      if (value !== undefined && value !== null && value !== '') return true;
    }
    return false;
  });
}

/**
 * Received mail: a provider-tagged row that is neither flagged as a draft nor
 * in an outgoing status. A record of what arrived, so it is never sent.
 */
export function isReceivedMail(row: Record<string, unknown>): boolean {
  const status = row.sendStatus ?? row.send_status;
  if (status !== undefined && status !== null && status !== '') {
    if (status !== 'draft') return false;
  }
  return !mailFlag(row.isDraft ?? row.is_draft) && hasMailProvenance(row);
}

/**
 * Unsent outgoing mail: anything a later send would transmit. That is every
 * row that is not `sent` and not received mail ({@link isReceivedMail}):
 * flagged drafts, `draft` rows with no provider id, `pending`, `scheduled`,
 * `sending`, `failed` and any unknown status (which fails closed).
 */
export function isUnsentOutgoing(row: Record<string, unknown>): boolean {
  const status = row.sendStatus ?? row.send_status;
  if (status === 'sent') return false;
  return !isReceivedMail(row);
}

/**
 * Gate for writes that create, change or delete a draft: the principal needs
 * the `draft` scope on every listed account. Trusted system work
 * ({@link runWithMailSystemAccess}) and unowned accounts pass; an account that
 * cannot be found fails closed, like {@link accountReadable}.
 */
export function assertMailDraftWrite(
  accountIds: ReadonlyArray<string | null | undefined>,
  options: SmrtClassOptions | undefined,
): Promise<void> {
  return assertMailScopeOn(accountIds, 'draft', options);
}

/** {@link assertMailDraftWrite} for any scope. */
export async function assertMailScopeOn(
  accountIds: ReadonlyArray<string | null | undefined>,
  scope: MailScope,
  options: SmrtClassOptions | undefined,
  { allowMissing = false }: { allowMissing?: boolean } = {},
): Promise<void> {
  if (inMailSystemAccess()) return;
  learnMailAccessOptions(options);
  const ids = [...new Set(accountIds.filter((id): id is string => !!id))];
  if (!ids.length) return;
  const config = getEffectiveMailAccessConfig();
  if (!config) return;
  const { AccountCollection } = await import(
    './collections/AccountCollection.js'
  );
  for (const id of ids) {
    const account = await runWithMailSystemAccess(async () =>
      (await AccountCollection.create(config.options)).get({ id }),
    );
    if (!account) {
      if (allowMissing) continue;
      throw new MailAccessError(scope, 'denied');
    }
    await assertMailAccess(
      {
        id: account.id,
        tenantId: account.tenantId,
        ownerUserId: account.ownerUserId,
      },
      scope,
    );
  }
}

/**
 * Gate for direct hydration (`new Email({ id }).initialize()`,
 * `loadRelated('messageId')`), which bypasses collection read hooks: throws
 * when the loaded row belongs to an account closed to the principal.
 */
export async function assertHydratedMailAccess(row: {
  accountId?: string | null;
  messageId?: string | null;
  options?: unknown;
}): Promise<void> {
  if (inMailSystemAccess()) return;
  const options = row.options as SmrtClassOptions | undefined;
  let accountId = row.accountId || null;
  if (!accountId && row.messageId && options) {
    const { MessageCollection } = await import(
      './collections/MessageCollection.js'
    );
    const message = await runWithMailSystemAccess(async () =>
      (await MessageCollection.create(options)).get({ id: row.messageId }),
    );
    if (!message) throw new MailAccessError('read', 'denied');
    accountId = message.accountId || null;
  }
  if (!(await accountReadable(accountId, options))) {
    throw new MailAccessError('read', 'denied');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Grant administration
// ───────────────────────────────────────────────────────────────────────────

export interface MailAccessAdmin {
  /** The acting user (`MailPrincipal.userId`). */
  userId: string;
  tenantId: string;
  /**
   * The host's label for the actor (`MailPrincipal.kind`). Only a person may
   * change an account's agent send policy; other operations ignore it.
   */
  kind?: string;
}

export interface GrantMailAccessInput {
  accountId: string;
  /** The grantee's smrt-users `User` id (a person, or a host-mapped agent). */
  userId: string;
  scope: MailScope;
  effect?: 'grant' | 'deny';
  canDelegate?: boolean;
  /** For a delegated grant: the actor's own delegable grant. */
  parentGrantId?: string | null;
}

/**
 * Owner-controlled grant administration. Tenant RBAC (`messages.manage-access`)
 * is necessary but never sufficient: the actor must also own the account, or
 * delegate from their own delegable grant. A tenant administrator therefore
 * cannot read, grant themselves, or take over someone else's mailbox.
 */
export class MailAccessService {
  constructor(
    private readonly options: SmrtClassOptions,
    private readonly actor: MailAccessAdmin,
  ) {}

  private async account(accountId: string) {
    const { AccountCollection } = await import(
      './collections/AccountCollection.js'
    );
    const { withTenant } = await import('./host.js');
    return withTenant({ tenantId: this.actor.tenantId }, async () => {
      const collection = await AccountCollection.create(
        withoutListBounds(this.options),
      );
      const account = await collection.get({ id: accountId });
      if (!account || account.tenantId !== this.actor.tenantId) {
        throw new Error('Mail account was not found in this tenant.');
      }
      return account;
    });
  }

  /** Tenant RBAC ceiling for administering mail access (grants, owner). */
  private async assertManageAccess(): Promise<void> {
    const { assertOperationPermission } = await import(
      '@happyvertical/smrt-users'
    );
    await assertOperationPermission({
      ...this.options,
      collection: 'messages',
      action: 'manage-access',
      tenantId: this.actor.tenantId,
      userId: this.actor.userId,
      allowSuperAdminBypass: false,
      allowSystemContextBypass: false,
      onDeny: 'throw',
    });
  }

  /** The new owner must be a real, active member of this tenant. */
  private async assertTenantMember(userId: string): Promise<void> {
    const users = await import('@happyvertical/smrt-users');
    const memberships = await users.MembershipCollection.create(this.options);
    const rows = await memberships.list({
      where: { tenantId: this.actor.tenantId, userId, status: 'active' },
      limit: 1,
    });
    if (!rows.length) {
      throw new Error('The new owner must be an active member of this tenant.');
    }
  }

  private async inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const { withTenant } = await import('./host.js');
    return withTenant({ tenantId: this.actor.tenantId }, fn);
  }

  private resourceFor(accountId: string) {
    return {
      tenantId: this.actor.tenantId,
      resourceType: MAIL_ACCOUNT_RESOURCE_TYPE,
      resourceId: accountId,
    };
  }

  private async grantsApi() {
    const users = await import('@happyvertical/smrt-users');
    const verifyResource = (resource: {
      tenantId: string;
      resourceType: string;
      resourceId: string;
    }) =>
      resource.tenantId === this.actor.tenantId &&
      resource.resourceType === MAIL_ACCOUNT_RESOURCE_TYPE;
    return { users, verifyResource };
  }

  grant(input: GrantMailAccessInput) {
    return this.inTenant(() => this.grantImpl(input));
  }

  revoke(grantId: string): Promise<void> {
    return this.inTenant(() => this.revokeImpl(grantId));
  }

  list(accountId: string) {
    return this.inTenant(() => this.listImpl(accountId));
  }

  setOwner(accountId: string, ownerUserId: string): Promise<void> {
    return this.inTenant(() => this.setOwnerImpl(accountId, ownerUserId));
  }

  /**
   * Set what happens when an agent sends from this mail account (smrt#5141).
   * Owner only, person only, and the tenant `messages.manage-access` ceiling.
   * Lowering to `require_approval` is instant (a kill switch); raising to
   * `auto_send` needs `confirmAutoSend: true`, like smrt-social's public latch.
   */
  setAgentSendPolicy(
    accountId: string,
    policy: AgentSendPolicy,
    options: { confirmAutoSend?: boolean } = {},
  ): Promise<void> {
    return this.inTenant(() =>
      this.setAgentSendPolicyImpl(accountId, policy, options),
    );
  }

  private async setAgentSendPolicyImpl(
    accountId: string,
    policy: AgentSendPolicy,
    options: { confirmAutoSend?: boolean },
  ): Promise<void> {
    if (policy !== 'require_approval' && policy !== 'auto_send') {
      throw new Error('Unknown agent send policy.');
    }
    if (!isPersonMailPrincipal(this.actor)) {
      throw new Error('Only a person can change the agent send policy.');
    }
    const account = await this.account(accountId);
    if (!('agentSendPolicy' in account)) {
      throw new Error('The agent send policy applies to mail accounts only.');
    }
    if (!account.ownerUserId || account.ownerUserId !== this.actor.userId) {
      throw new Error(
        'Only the account owner can change the agent send policy.',
      );
    }
    await this.assertManageAccess();
    if (policy === 'auto_send' && options.confirmAutoSend !== true) {
      throw new Error(
        'Letting agents send without approval needs explicit confirmation (confirmAutoSend).',
      );
    }
    const mail = account as typeof account & {
      agentSendPolicy: AgentSendPolicy | null;
    };
    mail.agentSendPolicy = policy;
    mail.updatedAt = new Date();
    await mail.save();
  }

  private async grantImpl(input: GrantMailAccessInput) {
    if (!isMailScope(input.scope)) throw new Error('Unknown mail scope.');
    const account = await this.account(input.accountId);
    if (!account.ownerUserId) {
      throw new Error('Set an owner on this mail account before sharing it.');
    }
    if (input.userId === this.actor.userId && !input.parentGrantId) {
      // Self-grants are meaningless for the owner and an escalation for
      // anyone else.
      throw new Error('A mail grant must name another user.');
    }
    const isOwner = account.ownerUserId === this.actor.userId;
    if (!isOwner && !input.parentGrantId) {
      throw new Error('Only the account owner can grant mail access.');
    }
    if (isOwner && input.parentGrantId) {
      throw new Error('An owner grants directly, not by delegation.');
    }
    if (!isOwner && (input.effect === 'deny' || input.canDelegate === true)) {
      // A delegate passes access on; they never block others or widen the chain.
      throw new Error(
        'A delegate can only pass on a plain, non-delegable grant.',
      );
    }
    const { users, verifyResource } = await this.grantsApi();
    const service = new users.ResourceGrantService(this.options);
    return service.create({
      actor: {
        collection: 'messages',
        action: 'manage-access',
        tenantId: this.actor.tenantId,
        userId: this.actor.userId,
        allowSuperAdminBypass: false,
        allowSystemContextBypass: false,
      },
      authorization: {
        collection: 'messages',
        action: input.scope,
        tenantId: this.actor.tenantId,
        userId: this.actor.userId,
        allowSuperAdminBypass: false,
        allowSystemContextBypass: false,
        resource: this.resourceFor(input.accountId),
        verifyResource,
      },
      grant: {
        ...this.resourceFor(input.accountId),
        userId: input.userId,
        permission: mailScopePermission(input.scope),
        effect: input.effect ?? 'grant',
        canDelegate: input.canDelegate ?? false,
        parentGrantId: input.parentGrantId ?? null,
      },
    });
  }

  /** Revoke a grant. Delegated children stop working with their ancestor. */
  private async revokeImpl(grantId: string): Promise<void> {
    const { users, verifyResource } = await this.grantsApi();
    const grants = await users.ResourceGrantCollection.create(
      withoutListBounds(this.options),
    );
    const grant = await grants.get({ id: grantId });
    if (
      !grant ||
      grant.tenantId !== this.actor.tenantId ||
      grant.resourceType !== MAIL_ACCOUNT_RESOURCE_TYPE
    ) {
      throw new Error('Mail grant not found.');
    }
    const account = await this.account(grant.resourceId);
    if (account.ownerUserId !== this.actor.userId) {
      throw new Error('Only the account owner can revoke mail access.');
    }
    await new users.ResourceGrantService(this.options).revoke(grantId, {
      actor: {
        collection: 'messages',
        action: 'manage-access',
        tenantId: this.actor.tenantId,
        userId: this.actor.userId,
        allowSuperAdminBypass: false,
        allowSystemContextBypass: false,
      },
      verifyResource,
    });
  }

  /** Owner-only listing of who holds what on one account. */
  private async listImpl(accountId: string) {
    const account = await this.account(accountId);
    if (account.ownerUserId !== this.actor.userId) {
      throw new Error('Only the account owner can list mail access.');
    }
    await this.assertManageAccess();
    const { users } = await this.grantsApi();
    const grants = await users.ResourceGrantCollection.create(
      withoutListBounds(this.options),
    );
    const rows = await grants.list({
      where: {
        tenantId: this.actor.tenantId,
        resourceType: MAIL_ACCOUNT_RESOURCE_TYPE,
        resourceId: accountId,
      },
    });
    return rows.filter((grant) => grant.isActive());
  }

  /**
   * Set or change the owner. An owned account changes hands only by its
   * owner. An unowned account can be claimed by a tenant administrator
   * holding `messages.manage-credentials` (the migration path from
   * tenant-wide to owned).
   */
  private async setOwnerImpl(
    accountId: string,
    ownerUserId: string,
  ): Promise<void> {
    const account = await this.account(accountId);
    if (account.ownerUserId) {
      if (account.ownerUserId !== this.actor.userId) {
        throw new Error('Only the account owner can transfer ownership.');
      }
      await this.assertManageAccess();
    } else {
      const { assertOperationPermission } = await import(
        '@happyvertical/smrt-users'
      );
      await assertOperationPermission({
        ...this.options,
        collection: 'messages',
        action: 'manage-credentials',
        tenantId: this.actor.tenantId,
        userId: this.actor.userId,
        allowSuperAdminBypass: false,
        allowSystemContextBypass: false,
        onDeny: 'throw',
      });
    }
    await this.assertTenantMember(ownerUserId);
    // An opt-in to agent auto-send belongs to the owner who made it; a new
    // owner starts from the default (held for approval).
    if (account.ownerUserId !== ownerUserId && 'agentSendPolicy' in account) {
      (account as { agentSendPolicy: unknown }).agentSendPolicy = null;
    }
    account.ownerUserId = ownerUserId;
    account.updatedAt = new Date();
    await account.save();
  }
}

export { MANAGE_MAIL_ACCESS_PERMISSION };
