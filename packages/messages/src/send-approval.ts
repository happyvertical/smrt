/**
 * Agent send policy and the held-send approval flow (smrt#5141, Epic I).
 *
 * An agent never sends mail as the account owner and, by default, never sends
 * at all without a person: when an agent principal calls `Message.send()` on a
 * mail account whose policy is `require_approval` (the default; null means
 * the same), the draft is held under a pending approval and nothing leaves
 * until a person holding `send` on that account approves it. `auto_send` is
 * the owner's explicit opt-in per account ({@link MailAccessService}
 * `setAgentSendPolicy`), or the host's per rule
 * ({@link MailSendApprovalConfig.resolveAgentSendPolicy}). Person sends, and
 * sends with no principal (sync, the notification outbox, unconfigured
 * hosts), are unaffected.
 *
 * Who is a person comes from the host: only `MailPrincipal.kind` `'person'`
 * or `'human'` counts (see {@link isPersonMailPrincipal}). Everything else,
 * including a missing label, is an agent.
 *
 * The approval itself lives in the generic approvals primitive
 * (`@happyvertical/smrt-approvals`). This package does not depend on it: the
 * host wires `createApprovalMailSendGate({ service })` from that package into
 * {@link configureMailSendApprovals}, which satisfies the structural
 * {@link MailSendApprovalGate} below. Without a gate, agent sends under
 * `require_approval` are refused (fail closed).
 *
 * Binding: a held send is bound to {@link mailSendBindingHash} of the stored
 * draft (recipients, sender, subject, bodies, threading headers, account and
 * the stored attachment rows). Any change after the request, including a new
 * attachment row, makes the approval unusable for the changed draft.
 *
 * @packageDocumentation
 */

import {
  getActiveAuditOptions,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  decideMailAccess,
  isPersonMailPrincipal,
  type MailPrincipal,
  resolveMailPrincipal,
  runWithMailSystemAccess,
  withoutListBounds,
} from './access.js';
import { AttachmentStorageError } from './attachment-storage.js';
import { notificationSha256, withTenant } from './host.js';
import type { Account } from './models/Account.js';
import type { Message } from './models/Message.js';
import type {
  AgentSendPolicy,
  MessageSendResult,
  SendMessageOptions,
} from './types.js';

// ───────────────────────────────────────────────────────────────────────────
// Structural gate (implemented by smrt-approvals' createApprovalMailSendGate)
// ───────────────────────────────────────────────────────────────────────────

/** An actor as the gate sees it. `id` is the smrt-users `User` id. */
export interface MailSendApprovalActor {
  id: string;
  /** Host label; only `person` or `human` can decide. */
  kind: string | null;
  /** Tenant permission slugs this package verified for the actor. */
  permissions?: readonly string[];
}

/** One held send as the gate reports it. */
export interface MailSendApprovalView {
  approvalId: string;
  messageId: string;
  status: string;
  bindingHash: string;
  requesterId: string;
  requesterType: string;
  consumed: boolean;
  live: boolean;
  /** Distinct person approvers of the bound revision. */
  approverIds: string[];
}

export type MailSendApprovalOutcome =
  | { ok: true; view: MailSendApprovalView }
  | { ok: false; reason: string; view?: MailSendApprovalView };

/**
 * `approved`: a person approved this revision and it waits for an approving
 * person to release it. `check` never consumes: the requester cannot send.
 */
export type MailSendApprovalCheckResult =
  | { state: 'approved'; approvalId: string; approverIds: string[] }
  | { state: 'pending'; approvalId: string; created: boolean }
  | { state: 'refused'; reason: string; approvalId?: string };

/** What a host must wire in; smrt-approvals provides it. */
export interface MailSendApprovalGate {
  check(request: {
    tenantId: string;
    messageId: string;
    bindingHash: string;
    requester: MailSendApprovalActor;
    summary: string;
  }): Promise<MailSendApprovalCheckResult>;
  get(
    tenantId: string,
    approvalId: string,
    reader: MailSendApprovalActor,
  ): Promise<MailSendApprovalView | null>;
  decide(input: {
    tenantId: string;
    approvalId: string;
    decider: MailSendApprovalActor;
    decision: 'approve' | 'reject';
    reason?: string;
    expectedBindingHash: string;
    revisedBindingHash?: string;
  }): Promise<MailSendApprovalOutcome>;
  consume(input: {
    tenantId: string;
    approvalId: string;
    consumer: MailSendApprovalActor;
    bindingHash: string;
    verifyApprovers(approverIds: string[]): Promise<boolean>;
  }): Promise<MailSendApprovalOutcome>;
}

/** Host hook context for a per-rule policy. */
export interface AgentSendPolicyContext {
  account: Account;
  message: Message;
  /** Null for a persona route sent without a signed-in principal. */
  principal: MailPrincipal | null;
}

export interface MailSendApprovalConfig {
  /** The approval gate. Without it, held agent sends are refused. */
  gate?: MailSendApprovalGate;
  /**
   * Per-rule override (for example a routing rule that opted in to
   * auto-send). Return a policy to use it, or null/undefined to fall back to
   * the account's `agentSendPolicy`. Host code only: never let a request
   * choose the result.
   */
  resolveAgentSendPolicy?: (
    context: AgentSendPolicyContext,
  ) =>
    | AgentSendPolicy
    | null
    | undefined
    | Promise<AgentSendPolicy | null | undefined>;
}

/** Tenant permission a person needs to approve a held send. */
export const APPROVE_HELD_SEND_PERMISSION = 'messages.send';

const STATE_KEY = Symbol.for('@happyvertical/smrt-messages:send-approval');

function state(): { config: MailSendApprovalConfig | null } {
  const holder = globalThis as Record<symbol, unknown>;
  let current = holder[STATE_KEY] as
    | { config: MailSendApprovalConfig | null }
    | undefined;
  if (!current) {
    current = { config: null };
    holder[STATE_KEY] = current;
  }
  return current;
}

/** Wire the approval gate and optional per-rule policy hook. Call at startup. */
export function configureMailSendApprovals(
  config: MailSendApprovalConfig,
): void {
  state().config = { ...config };
}

/** Remove the configuration (tests). Held agent sends are then refused. */
export function resetMailSendApprovals(): void {
  state().config = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Policy, binding and handled-by
// ───────────────────────────────────────────────────────────────────────────

/** Stamp who handled a message (not saved here). */
export function stampHandledBy(
  message: Message,
  principal: MailPrincipal | null,
  at: Date = new Date(),
): void {
  if (!principal) return;
  message.handledById = principal.userId;
  message.handledByKind = isPersonMailPrincipal(principal) ? 'person' : 'agent';
  message.handledAt = at;
}

/** Who handled a thread: the latest handler first, then the others. */
export function threadHandledBy(
  messages: ReadonlyArray<
    Pick<Message, 'handledById' | 'handledByKind' | 'handledAt'>
  >,
): Array<{ id: string; kind: string; at: Date | null }> {
  const latest = new Map<
    string,
    { id: string; kind: string; at: Date | null }
  >();
  for (const message of messages) {
    if (!message.handledById) continue;
    const at = message.handledAt ? new Date(message.handledAt) : null;
    const seen = latest.get(message.handledById);
    if (!seen || (at && (!seen.at || at.getTime() > seen.at.getTime()))) {
      latest.set(message.handledById, {
        id: message.handledById,
        kind: message.handledByKind || 'agent',
        at,
      });
    }
  }
  return [...latest.values()].sort(
    (a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0),
  );
}

/**
 * Record a mail action through the host's audit context
 * (`withAuditContext()` from smrt-core), when one is active: the host's
 * trusted actor id, the action (for example `messages.send.held`) and the
 * message. A writer failure propagates, so an unauditable action fails.
 * Mail models are not `audit: true`: that would demand a writer on every
 * sync and outbox write, which an app that does not audit mail never has.
 */
export async function auditMailAction(
  action: string,
  message: Message,
  changes: Record<string, { before: unknown; after: unknown }> = {},
): Promise<void> {
  const audit = getActiveAuditOptions();
  if (!audit?.writer || !audit.actorId?.trim()) return;
  await audit.writer(
    {
      actorId: audit.actorId,
      reason: audit.reason,
      source: audit.source,
      onBehalfOfId: audit.onBehalfOfId ?? null,
      action,
      resourceType: '@happyvertical/smrt-messages:Message',
      resourceId: String(message.id ?? ''),
      tenantId: message.tenantId ?? null,
      changes,
    },
    message.db,
  );
}

/**
 * The policy for one agent send: the host's per-rule answer if it gives
 * one, else the account's `agentSendPolicy`. Anything but an explicit
 * `auto_send` is `require_approval`. Accounts without the field (non-mail
 * channels) are not governed and return null.
 */
export async function effectiveAgentSendPolicy(
  account: Account,
  message: Message,
  principal: MailPrincipal | null,
): Promise<AgentSendPolicy | null> {
  if (!('agentSendPolicy' in account)) return null;
  const hook = state().config?.resolveAgentSendPolicy;
  if (hook) {
    const ruled = await hook({ account, message, principal });
    if (ruled === 'auto_send' || ruled === 'require_approval') return ruled;
  }
  return (account as Account & { agentSendPolicy?: string | null })
    .agentSendPolicy === 'auto_send'
    ? 'auto_send'
    : 'require_approval';
}

function readField(source: object, name: string): unknown {
  const value = (source as Record<string, unknown>)[name];
  // Storage normalizes an empty optional reference to null; so does the hash.
  return value === undefined || value === '' ? null : value;
}

type AttachmentRowLike = {
  id?: string | null;
  filename: string;
  contentType: string;
  size: number;
  contentId: string;
  contentDisposition: string;
  filePath: string;
  sourceUrl: string;
};

/** One attachment row and its bytes, as bound into a held send. */
function attachmentBinding(
  row: AttachmentRowLike,
  bytes: Uint8Array | null,
): unknown[] {
  let content: string | null = null;
  if (row.filePath) content = bytes ? notificationSha256(bytes) : 'unreadable';
  return [
    row.id,
    row.filename,
    row.contentType,
    row.size,
    row.contentId,
    row.contentDisposition,
    row.filePath,
    row.sourceUrl,
    content,
  ];
}

/** A refused path binds like an unreadable file: the send fails the same way. */
async function readBoundContent(row: {
  readContent(): Promise<Uint8Array | null>;
}): Promise<Uint8Array | null> {
  try {
    return await row.readContent();
  } catch (error) {
    if (error instanceof AttachmentStorageError) return null;
    throw error;
  }
}

function sortBindings(bound: unknown[][]): unknown[][] {
  return bound.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

// The attachment rows and bytes an approval released, per message instance,
// checked by `EmailSender` against exactly what it hands the transport.
const approvedAttachments = new WeakMap<Message, string>();

/**
 * Called by `EmailSender` with the stored rows and the bytes it is about to
 * transmit. For a send an approval released, refuses (throws) unless they
 * are exactly the approved rows and bytes. A no-op for other sends.
 */
export function assertApprovedAttachments(
  message: Message,
  sent: Array<{ row: AttachmentRowLike; content: Uint8Array | null }>,
): void {
  const expected = approvedAttachments.get(message);
  if (expected === undefined) return;
  approvedAttachments.delete(message);
  const actual = JSON.stringify(
    sortBindings(
      sent.map(({ row, content }) => attachmentBinding(row, content)),
    ),
  );
  if (actual !== expected) {
    throw new Error(
      'The attachments changed after the send was approved; nothing was sent.',
    );
  }
}

/**
 * Hash of everything a send transmits for `message`, from the given
 * instance's fields plus the stored attachment rows. Compare it only between
 * two reads of the same message.
 */
export async function mailSendBindingHash(
  message: Message,
  snapshot?: { attachments?: unknown[][] },
): Promise<string> {
  const fields = [
    'accountId',
    'fromAddress',
    'fromName',
    'toAddresses',
    'ccAddresses',
    'bccAddresses',
    'subject',
    'body',
    'textBody',
    'htmlBody',
    'inReplyTo',
    'inReplyToMessageId',
    'threadId',
    'headers',
  ].map((name) => [name, readField(message, name)]);
  const attachments = message.id
    ? await runWithMailSystemAccess(async () => {
        const { AttachmentCollection } = await import(
          './collections/AttachmentCollection.js'
        );
        const rows = await (
          await AttachmentCollection.create(
            withoutListBounds(message.options) as never,
          )
        ).list({ where: { messageId: message.id } });
        const bound: unknown[][] = [];
        for (const row of rows) {
          // Bind the bytes, not just the path: a file rewritten in place
          // after approval must not leave under the approval.
          bound.push(
            attachmentBinding(
              row,
              row.filePath ? await readBoundContent(row) : null,
            ),
          );
        }
        return sortBindings(bound);
      })
    : [];
  if (snapshot) snapshot.attachments = attachments;
  return notificationSha256(
    JSON.stringify({ v: 2, id: message.id ?? null, fields, attachments }),
  );
}

/** A fresh read of the stored message, bypassing the read policy. */
async function loadStored(
  options: SmrtClassOptions,
  messageId: string,
): Promise<Message | null> {
  return await runWithMailSystemAccess(async () => {
    const { MessageCollection } = await import(
      './collections/MessageCollection.js'
    );
    return (await (
      await MessageCollection.create(options as never)
    ).get({
      id: messageId,
    })) as Message | null;
  });
}

function actorOf(
  principal: MailPrincipal,
  permissions: readonly string[] = [],
): MailSendApprovalActor {
  return {
    id: principal.userId,
    kind: isPersonMailPrincipal(principal) ? 'person' : 'agent',
    permissions,
  };
}

/**
 * Whether `userId` holds the tenant `messages.send` permission (smrt-users
 * RBAC, no super-admin or system bypass). Needed on every account: an
 * unowned account's per-account decision ('unowned') checks no permission.
 */
async function holdsTenantSend(
  options: SmrtClassOptions,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { checkOperationPermission } = await import(
      '@happyvertical/smrt-users'
    );
    const decision = await checkOperationPermission({
      ...(withoutListBounds(options) as SmrtClassOptions),
      collection: 'messages',
      action: 'send',
      tenantId,
      userId,
      allowSuperAdminBypass: false,
      allowSystemContextBypass: false,
    } as never);
    return decision.allowed;
  } catch {
    return false;
  }
}

/**
 * Every counted approver must be a person who holds the tenant
 * `messages.send` permission and `send` on the account, now.
 */
function approverVerifier(account: Account, options: SmrtClassOptions) {
  return async (approverIds: string[]): Promise<boolean> => {
    if (approverIds.length === 0 || !account.tenantId) return false;
    for (const id of approverIds) {
      if (!(await holdsTenantSend(options, account.tenantId, id))) return false;
      const decision = await decideMailAccess(
        {
          id: account.id,
          tenantId: account.tenantId,
          ownerUserId: account.ownerUserId,
        },
        'send',
        {
          id,
          userId: id,
          tenantId: String(account.tenantId),
          kind: 'person',
        },
      );
      if (!decision.allowed) return false;
    }
    return true;
  };
}

// The binding an approval released, per message instance, re-checked by
// `Message.send()` after it claims the row and before the provider handoff.
const approvedBindings = new WeakMap<Message, string>();

/** Remember the approved binding for `message`'s next send. */
function markApprovedBinding(message: Message, bindingHash: string): void {
  approvedBindings.set(message, bindingHash);
}

/**
 * Called by `Message.send()` after its claim: true when this send was
 * released by an approval and the draft (fields or attachment rows) no longer
 * matches it. Clears the marker either way.
 */
export async function approvedDraftChanged(message: Message): Promise<boolean> {
  const expected = approvedBindings.get(message);
  if (expected === undefined) return false;
  approvedBindings.delete(message);
  const snapshot: { attachments?: unknown[][] } = {};
  if ((await mailSendBindingHash(message, snapshot)) !== expected) return true;
  approvedAttachments.set(message, JSON.stringify(snapshot.attachments ?? []));
  return false;
}

function refusedResult(error: string): MessageSendResult {
  return { success: false, error, sentAt: new Date() };
}

/**
 * Called by `Message.send()` after the `send` scope check. Returns null when
 * the send may go ahead, or the result to return instead (held or refused).
 * Never sends and never changes the draft's content.
 */
export async function holdAgentSend(
  message: Message,
  account: Account,
  options: SendMessageOptions | undefined,
  principal: MailPrincipal | null,
): Promise<MessageSendResult | null> {
  // An approving person's release (MailSendApprovalService) is re-checked
  // against the approved binding after the claim, never held again.
  if (approvedBindings.has(message)) return null;
  const gate = state().config?.gate;
  // A persona route is an agent send whoever invoked it.
  const persona = message.personaId ? String(message.personaId) : null;
  if (!persona && isPersonMailPrincipal(principal)) return null;
  // Without a principal and without a gate the host never opted in to
  // attributed mail (persona routes included): unchanged behaviour. Sync and
  // the outbox run under system access and never reach this.
  if (!principal && !gate) return null;
  const policy = await effectiveAgentSendPolicy(account, message, principal);
  if (policy === null || policy === 'auto_send') return null;

  if (!gate) {
    return refusedResult(
      "Agent sends from this mailbox need a person's approval, and no approval gate is configured.",
    );
  }
  if (!principal && !persona) {
    return refusedResult(
      'A send from this mailbox needs a signed-in person or agent.',
    );
  }
  const requester: MailSendApprovalActor = persona
    ? { id: `persona:${persona}`, kind: 'agent' }
    : { id: (principal as MailPrincipal).userId, kind: 'agent' };
  const tenantId = message.tenantId ?? account.tenantId;
  if (!tenantId || !message.id || !message.isPersisted) {
    return refusedResult(
      'Save the draft in a tenant before submitting it for approval.',
    );
  }
  if (
    (options as { attachments?: unknown[] } | undefined)?.attachments?.length
  ) {
    // Send-time bytes are not stored, so no person could review them and
    // nothing could bind them once this call returns. Store them as
    // Attachment rows on the message (bound byte for byte) instead.
    return refusedResult(
      'A held send cannot carry send-time attachments; store them as attachments on the message.',
    );
  }
  // Bind the stored draft, and refuse when the caller's copy differs from it:
  // a person approves what is stored, so nothing else may leave.
  const stored = await loadStored(
    message.options as SmrtClassOptions,
    message.id,
  );
  if (!stored || stored.tenantId !== message.tenantId) {
    return refusedResult('The draft was not found.');
  }
  const bindingHash = await mailSendBindingHash(stored);
  if ((await mailSendBindingHash(message)) !== bindingHash) {
    return refusedResult(
      'The draft has unsaved changes; save it before submitting it for approval.',
    );
  }
  // Approval rows are readable tenant-wide; never copy mail content into
  // them. A decider reads the draft through MailSendApprovalService.get().
  const summary = 'An agent asked to send an email.';
  const checked = await gate.check({
    tenantId,
    messageId: message.id,
    bindingHash,
    requester,
    summary,
  });
  if (checked.state === 'approved') {
    // Approved sends leave only when an approving person releases them.
    return {
      success: false,
      error: 'Approved; it is sent when the approving person releases it.',
      pendingApproval: { approvalId: checked.approvalId, created: false },
      sentAt: new Date(),
    };
  }
  if (checked.state === 'refused') {
    return refusedResult(`The send was not approved (${checked.reason}).`);
  }
  if (checked.created) {
    await auditMailAction('messages.send.held', message, {
      approval: { before: null, after: checked.approvalId },
    });
  }
  return {
    success: false,
    error: 'Waiting for a person to approve this send.',
    pendingApproval: {
      approvalId: checked.approvalId,
      created: checked.created,
    },
    sentAt: new Date(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The person's side: approve, edit-then-approve, reject
// ───────────────────────────────────────────────────────────────────────────

/** Edits a person makes before approving (edit-then-approve). */
export interface HeldSendEdits {
  subject?: string;
  body?: string;
  textBody?: string;
  htmlBody?: string;
  toAddresses?: Array<{ address: string; name?: string }>;
  ccAddresses?: Array<{ address: string; name?: string }>;
  bccAddresses?: Array<{ address: string; name?: string }>;
}

export type HeldSendDecisionResult =
  | { state: 'sent'; approvalId: string; result: MessageSendResult }
  | { state: 'pending'; approvalId: string }
  | { state: 'rejected'; approvalId: string }
  | { state: 'refused'; approvalId: string; reason: string };

export class HeldSendError extends Error {
  readonly status: number;
  constructor(
    readonly reason: string,
    message: string,
    status = 403,
  ) {
    super(message);
    this.name = 'HeldSendError';
    this.status = status;
  }
}

/**
 * The person's side of a held send. The acting principal comes from the
 * host's mail access resolver; it must be a person holding `read` and `send`
 * on the draft's account. Approving sends the draft as that person.
 */
export class MailSendApprovalService {
  constructor(private readonly options: SmrtClassOptions) {}

  private async context(approvalId: string) {
    const gate = state().config?.gate;
    if (!gate) {
      throw new HeldSendError(
        'not_configured',
        'No approval gate is configured.',
        409,
      );
    }
    const principal = await resolveMailPrincipal();
    if (!principal)
      throw new HeldSendError('no_principal', 'Sign in first.', 401);
    if (!isPersonMailPrincipal(principal)) {
      throw new HeldSendError(
        'not_person',
        'Only a person can decide a held send.',
      );
    }
    return await withTenant({ tenantId: principal.tenantId }, async () => {
      const view = await gate.get(
        principal.tenantId,
        approvalId,
        actorOf(principal),
      );
      if (!view)
        throw new HeldSendError('not_found', 'Held send not found.', 404);
      const message = await loadStored(this.options, view.messageId);
      if (!message || message.tenantId !== principal.tenantId) {
        throw new HeldSendError('not_found', 'Held send not found.', 404);
      }
      const account = await message.getAccount();
      if (!account || account.tenantId !== principal.tenantId) {
        throw new HeldSendError('not_found', 'Held send not found.', 404);
      }
      // Only an unsent draft (or a definitely failed send) can be decided:
      // edits must never rewrite a message that left or may have left.
      const retryable =
        message.sendStatus === 'failed' && !message.isSendOutcomeUnknown();
      if (message.sendStatus !== 'draft' && !retryable) {
        throw new HeldSendError(
          'not_a_draft',
          `The message is already ${message.sendStatus}.`,
          409,
        );
      }
      // The tenant permission is checked explicitly: on an unowned account
      // the per-account decision is 'unowned' and checks none.
      if (
        !(await holdsTenantSend(
          this.options,
          principal.tenantId,
          principal.userId,
        ))
      ) {
        throw new HeldSendError(
          'forbidden',
          "Deciding this send needs the 'messages.send' permission.",
        );
      }
      for (const scope of ['read', 'send'] as const) {
        const decision = await decideMailAccess(account, scope, principal);
        if (!decision.allowed) {
          throw new HeldSendError(
            'forbidden',
            `Deciding this send needs '${scope}' on the mailbox.`,
          );
        }
      }
      return { gate, principal, view, message, account };
    });
  }

  /** The held send and its draft, for a person who could decide it. */
  async get(approvalId: string) {
    const { view, message } = await this.context(approvalId);
    return { view, message };
  }

  /**
   * Approve (optionally with edits) and, once the approval is complete, send
   * the draft as the approving person. Edits are bound into the approval
   * (edit-then-approve) before they are saved, so nothing but the reviewed
   * revision can be released.
   */
  async approve(
    approvalId: string,
    input: { edits?: HeldSendEdits; reason?: string } = {},
  ): Promise<HeldSendDecisionResult> {
    const { gate, principal, view, message, account } =
      await this.context(approvalId);
    return await withTenant({ tenantId: principal.tenantId }, async () => {
      const tenantId = principal.tenantId;
      const requested = await mailSendBindingHash(message);
      if (requested !== view.bindingHash) {
        return {
          state: 'refused',
          approvalId,
          reason: 'draft_changed',
        } as const;
      }
      let revisedHash: string | undefined;
      if (input.edits && Object.keys(input.edits).length > 0) {
        applyEdits(message, input.edits);
        stampHandledBy(message, principal);
        revisedHash = await mailSendBindingHash(message);
        if (revisedHash === requested) revisedHash = undefined;
      }
      const decided = await gate.decide({
        tenantId,
        approvalId,
        decider: actorOf(principal, [APPROVE_HELD_SEND_PERMISSION]),
        decision: 'approve',
        reason: input.reason,
        expectedBindingHash: requested,
        ...(revisedHash ? { revisedBindingHash: revisedHash } : {}),
      });
      if (!decided.ok) {
        return {
          state: 'refused',
          approvalId,
          reason: decided.reason,
        } as const;
      }
      await auditMailAction(
        revisedHash
          ? 'messages.send.approved-with-edits'
          : 'messages.send.approved',
        message,
        { approval: { before: approvalId, after: decided.view.status } },
      );
      if (revisedHash) {
        // Persist exactly the revision that was approved. A concurrent write
        // to the draft makes the stored hash differ and consume refuses.
        await runWithMailSystemAccess(() => message.save());
      }
      if (decided.view.status !== 'approved') {
        return { state: 'pending', approvalId } as const;
      }
      return await this.releaseAs(
        gate,
        principal,
        account,
        approvalId,
        message,
      );
    });
  }

  /**
   * Send an already approved draft (for example approved through a generic
   * approvals inbox) as one of the people who approved it. Single use.
   */
  async release(approvalId: string): Promise<HeldSendDecisionResult> {
    const { gate, principal, view, message, account } =
      await this.context(approvalId);
    if (view.status !== 'approved' || view.consumed || !view.live) {
      return { state: 'refused', approvalId, reason: 'not_releasable' };
    }
    if (!view.approverIds.includes(principal.userId)) {
      return { state: 'refused', approvalId, reason: 'not_an_approver' };
    }
    return await withTenant({ tenantId: principal.tenantId }, () =>
      this.releaseAs(gate, principal, account, approvalId, message),
    );
  }

  /** Reject a held send. The draft stays a draft; the reason is audited. */
  async reject(
    approvalId: string,
    reason: string,
  ): Promise<HeldSendDecisionResult> {
    if (!reason?.trim()) {
      throw new HeldSendError('invalid', 'A rejection needs a reason.', 400);
    }
    const { gate, principal, view, message } = await this.context(approvalId);
    const decided = await gate.decide({
      tenantId: principal.tenantId,
      approvalId,
      decider: actorOf(principal, [APPROVE_HELD_SEND_PERMISSION]),
      decision: 'reject',
      reason,
      expectedBindingHash: view.bindingHash,
    });
    if (!decided.ok) {
      return { state: 'refused', approvalId, reason: decided.reason };
    }
    await auditMailAction('messages.send.rejected', message, {
      approval: { before: approvalId, after: 'rejected' },
    });
    return { state: 'rejected', approvalId };
  }

  /** Consume a complete approval and send the stored draft as the person. */
  private async releaseAs(
    gate: MailSendApprovalGate,
    principal: MailPrincipal,
    account: Account,
    approvalId: string,
    approved: Message,
  ): Promise<HeldSendDecisionResult> {
    if (!approved.id) {
      return { state: 'refused', approvalId, reason: 'not_found' };
    }
    const message = await loadStored(this.options, approved.id);
    if (!message) return { state: 'refused', approvalId, reason: 'not_found' };
    const bindingHash = await mailSendBindingHash(message);
    const used = await gate.consume({
      tenantId: principal.tenantId,
      approvalId,
      consumer: actorOf(principal),
      bindingHash,
      verifyApprovers: approverVerifier(account, this.options),
    });
    if (!used.ok) return { state: 'refused', approvalId, reason: used.reason };
    // The person sends: person sends are not held. `send()` claims the row
    // against the revision just hashed and re-checks the binding (attachment
    // rows included) after the claim, so a concurrent edit sends nothing.
    markApprovedBinding(message, bindingHash);
    const result = await message.send();
    return { state: 'sent', approvalId, result };
  }
}

function applyEdits(message: Message, edits: HeldSendEdits): void {
  const target = message as Message & Record<string, unknown>;
  if (edits.subject !== undefined) target.subject = edits.subject;
  if (edits.body !== undefined) {
    target.body = edits.body;
    // The sender transmits textBody before body: keep them together.
    if (edits.textBody === undefined && 'textBody' in target)
      target.textBody = edits.body;
  }
  if (edits.textBody !== undefined && 'textBody' in target)
    target.textBody = edits.textBody;
  if (edits.htmlBody !== undefined && 'htmlBody' in target)
    target.htmlBody = edits.htmlBody;
  if (edits.toAddresses !== undefined)
    target.toAddresses = JSON.stringify(edits.toAddresses);
  if (edits.ccAddresses !== undefined && 'ccAddresses' in target)
    target.ccAddresses = JSON.stringify(edits.ccAddresses);
  if (edits.bccAddresses !== undefined && 'bccAddresses' in target)
    target.bccAddresses = JSON.stringify(edits.bccAddresses);
  target.updatedAt = new Date();
}
