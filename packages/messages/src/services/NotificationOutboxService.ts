import {
  isUniqueViolationError,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { AccountCollection } from '../collections/AccountCollection.js';
import { EmailCollection } from '../collections/EmailCollection.js';
import { MessageCollection } from '../collections/MessageCollection.js';
import { NotificationDeliveryCollection } from '../collections/NotificationDeliveryCollection.js';
import {
  normalizeIdentityEmail,
  readNotificationProfile,
  withSystemContext,
  withTenant,
} from '../host.js';
import { assertNotificationProfileRecipientSchema } from '../migrations/profileRecipients.js';
import { EmailAccount } from '../models/EmailAccount.js';
import type { Message } from '../models/Message.js';
import type {
  NotificationDelivery,
  NotificationDeliveryChannel,
  NotificationDeliveryTransition,
} from '../models/NotificationDelivery.js';
import { assertNotificationRecipientIdentity } from '../notification-recipient-identity.js';
import {
  assertMessagingPermission,
  type MessagingPrincipal,
  SEND_MESSAGES_PERMISSION,
} from '../permissions.js';
import {
  ProtectedNotificationHandoffError,
  protectedNotificationMetadata,
  withProtectedNotificationHandoff,
} from '../protected-notification-handoff.js';
import type { SendEmailAttachment, SendEmailOptions } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────
// Transport seam
// ─────────────────────────────────────────────────────────────────────────

/** What a transport knows about one provider handoff. */
export type NotificationTransportOutcome =
  | { status: 'accepted'; providerMessageId?: string }
  | { status: 'rejected'; error: string; retryable: boolean }
  | { status: 'unknown'; error: string };

/** What a transport can say about an earlier handoff during recovery. */
export type NotificationTransportReconciliation =
  | NotificationTransportOutcome
  | { status: 'not-sent' };

export interface NotificationTransportRequest {
  delivery: NotificationDelivery;
  /** The delivery's single outbound message (an `Email` for `email`). */
  message: Message;
  /** Stable per delivery; pass it to providers that dedupe on a key. */
  idempotencyKey: string;
  /** Host-authorized send-time bytes; never file paths or remote URLs. */
  attachments?: SendEmailAttachment[];
}

/**
 * Hands one outbound message to a provider. The default
 * ({@link messageSendTransport}) delivers through `Message.send()` and the
 * message's account sender; tests and hosts with their own provider inject
 * another.
 */
export interface NotificationTransport {
  readonly name: string;
  /**
   * True only when the provider deduplicates on `idempotencyKey`, so sending
   * again after an unknown outcome cannot deliver twice. Then an unknown
   * outcome is retried; otherwise it becomes `uncertain`.
   */
  readonly idempotent?: boolean;
  send(
    request: NotificationTransportRequest,
  ): Promise<NotificationTransportOutcome>;
  /**
   * After a crash or lease loss following a handoff, report what is known
   * from durable state. Omit when nothing can be known (outcome: uncertain).
   */
  reconcile?(
    request: NotificationTransportRequest,
  ): Promise<NotificationTransportReconciliation>;
}

/**
 * Delivers through the canonical `Message.send()` (account → provider sender)
 * and reconciles from the message's own `sendStatus`.
 *
 * SMTP and the SDK email providers take no idempotency key, so this
 * transport is not idempotent: a handoff whose outcome is lost stays
 * `uncertain` instead of risking a second email.
 */
export const messageSendTransport: NotificationTransport = {
  name: 'message-send',
  idempotent: false,
  async send({ message, attachments }) {
    const options: SendEmailOptions | undefined = attachments
      ? { attachments }
      : undefined;
    const result = await message.send(options);
    if (result.success) {
      return {
        status: 'accepted',
        ...(result.providerMessageId
          ? { providerMessageId: result.providerMessageId }
          : {}),
      };
    }
    // The provider may have taken it (a dropped connection or a thrown
    // sender), or send() refused because its own claim on the message
    // failed and another sender may be mid-flight: never retry blindly.
    if (
      result.outcomeUnknown ||
      message.sendStatus === 'sending' ||
      message.sendStatus === 'sent'
    ) {
      return {
        status: 'unknown',
        error: result.error ?? 'The provider did not confirm the outcome.',
      };
    }
    return {
      status: 'rejected',
      error: result.error ?? 'Send failed',
      retryable: true,
    };
  },
  async reconcile({ message }) {
    const messages = await MessageCollection.create({ db: message.db });
    const stored = message.id ? await messages.get({ id: message.id }) : null;
    switch (stored?.sendStatus) {
      case 'sent':
        return { status: 'accepted' };
      case 'failed':
        if (stored.isSendOutcomeUnknown()) {
          return {
            status: 'unknown',
            error:
              stored.sendError || 'The provider did not confirm the outcome.',
          };
        }
        return {
          status: 'rejected',
          error: stored.sendError || 'Send failed',
          retryable: true,
        };
      case 'draft':
      case 'pending':
      case 'scheduled':
        return { status: 'not-sent' };
      default:
        return {
          status: 'unknown',
          error: 'The provider handoff did not record an outcome.',
        };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Service contract
// ─────────────────────────────────────────────────────────────────────────

export type NotificationOutboxDenialReason =
  | 'permission'
  | 'recipient'
  | 'sender'
  | 'link';

/** Thrown when the host's policy refuses an enqueue; nothing is stored. */
export class NotificationOutboxDeniedError extends Error {
  constructor(
    readonly reason: NotificationOutboxDenialReason,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationOutboxDeniedError';
  }
}

export interface NotificationRecipientRequest {
  tenantId: string;
  recipientUserId: string;
  channel: NotificationDeliveryChannel;
}

export interface NotificationProfileRecipientRequest {
  tenantId: string;
  recipientProfileId: string;
  channel: 'email';
}

export interface NotificationRecipient {
  address: string;
  name?: string;
}

export interface NotificationSuppressionRequest
  extends NotificationRecipientRequest {
  kind: string;
  sourceRef: string;
}
export interface NotificationProfileSuppressionRequest
  extends NotificationProfileRecipientRequest {
  kind: string;
  sourceRef: string;
}

export interface NotificationOutboxOptions {
  db: SmrtClassOptions['db'];
  /**
   * Host authorization for recipients: the address of `recipientUserId` when
   * the host allows notifying them in `tenantId` (e.g. a member of that
   * tenant), otherwise null, which denies the enqueue. Callers never supply
   * an address.
   */
  resolveRecipient(
    request: NotificationRecipientRequest,
  ): Promise<NotificationRecipient | null> | NotificationRecipient | null;
  /** Resource-aware authorization for a current tenant-owned external contact. No address input. */
  resolveProfileRecipient?(
    request: NotificationProfileRecipientRequest,
  ): Promise<NotificationRecipient | null> | NotificationRecipient | null;
  /** The sending `EmailAccount` id for a tenant (deployment setup). */
  resolveSenderAccountId(request: {
    tenantId: string;
  }): Promise<string | null> | string | null;
  /** Absolute http(s) URL deep links are built on, e.g. `https://app.example.com`. */
  linkBaseUrl: string;
  /** Optional opt-out hook, checked at enqueue and again before handoff. */
  isSuppressed?(
    request: NotificationSuppressionRequest,
  ): Promise<boolean> | boolean;
  /** External contacts have their own opt-out policy; never infer a User preference or fabricate a User ID. */
  isProfileSuppressed?(
    request: NotificationProfileSuppressionRequest,
  ): Promise<boolean> | boolean;
  /** Provider seam; defaults to {@link messageSendTransport}. */
  transport?: NotificationTransport;
  /**
   * Resolve and authorize current immutable document bytes before each fresh
   * provider handoff. A failure is a pre-handoff rejection, never a silent
   * attachment omission. Reconciliation does not need document access.
   */
  resolveAttachments?(
    request: NotificationTransportRequest,
  ): Promise<SendEmailAttachment[]> | SendEmailAttachment[];
  /** Trusted server map. Protected rows cannot be dispatched without their exact policy. */
  dispatchPolicies?: Readonly<
    Record<
      string,
      {
        resolveAttachments(
          request: NotificationTransportRequest,
        ): Promise<SendEmailAttachment[]> | SendEmailAttachment[];
      }
    >
  >;
  /**
   * When set, enqueue, dispatch and reconcile require `messages.send` in the tenant.
   * Omit only for trusted system code that performs its own authorization.
   */
  principal?: MessagingPrincipal;
  /** Lease length; must exceed the slowest provider handoff (default 5 min). */
  leaseMs?: number;
  /** Lease budget per delivery (default 5). */
  maxAttempts?: number;
  /** Delay before attempt `n + 1` after `n` failed (default 1 min · 2ⁿ⁻¹, ≤ 1 h). */
  retryDelayMs?(attempts: number): number;
  /** Clock (tests). */
  now?(): Date;
}

export interface NotificationEmailInput {
  tenantId: string;
  /** Exactly one recipient reference is required. Existing User calls remain unchanged. */
  recipientUserId?: string;
  /** External contact; requires email, a trusted protected policy and explicit schema maintenance. */
  recipientProfileId?: string;
  /** Idempotency key for the event, e.g. `project-question:<id>:asked`. */
  sourceRef: string;
  /** Host-defined type, e.g. `project-question.asked`. */
  kind: string;
  /** One line; CR/LF are rejected. */
  subject: string;
  /** Plain-text body; the deep link is appended on its own line. */
  text: string;
  /** Host-relative path of the deep link (`/portal/...`). */
  path: string;
  /** Do not send before this time (default: now). */
  notBefore?: Date;
  /** Required trusted server policy; cannot be downgraded after enqueue. */
  requiredDispatchPolicy?: string;
  /** Host-approved immutable resource/version/digest and destination binding. */
  dispatchPolicyBinding?: Record<string, unknown>;
}

export interface NotificationEnqueueResult {
  delivery: NotificationDelivery;
  /** False when `sourceRef` matched an existing delivery (returned untouched). */
  created: boolean;
}

export type NotificationDispatchOutcome =
  | 'sent'
  | 'retry-scheduled'
  | 'failed'
  | 'uncertain'
  | 'cancelled'
  | 'blocked'
  | 'lease-lost';

export interface NotificationDispatchReport {
  /** Rows this call won a lease on. */
  leased: number;
  outcomes: Array<{
    deliveryId: string;
    tenantId: string;
    outcome: NotificationDispatchOutcome;
  }>;
}

export interface NotificationDispatchOptions {
  /** Tenants to dispatch; omit to discover due rows across all tenants. */
  tenantIds?: readonly string[];
  /** Exact delivery selection, applied before query limits and lease acquisition. Empty selects none. */
  deliveryIds?: readonly string[];
  /** Maximum rows to lease in this call (default 25, max 200). */
  limit?: number;
}

export type NotificationReconcileOutcome = 'sent' | 'retry' | 'failed';

/** Delivery ids are uuids; anything else can match no row. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function defaultRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`A notification ${name} is required.`);
  return text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The id of a delivery's one outbound message: a name-based uuid derived from
 * the delivery id, so every dispatcher computes the same identity.
 */
export async function notificationDeliveryMessageId(
  deliveryId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `smrt-messages:notification-delivery:${deliveryId}`,
    ),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5 (name-based)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ]
    .map((group) => group.join(''))
    .join('-');
}

/** The correlation id that ties a delivery to its one outbound message. */
export function notificationDeliveryCorrelationId(deliveryId: string): string {
  return `notification-delivery:${deliveryId}`;
}

/**
 * Build an absolute deep link from a host-relative `path` on `baseUrl`.
 *
 * The link always stays on the configured origin (no `//host`, backslash, or
 * scheme tricks) and never carries credentials: the destination is an
 * ordinary authenticated route, so the recipient signs in as themselves.
 */
export function buildNotificationLink(baseUrl: string, path: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('Notification link base URL must be an absolute URL.');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('Notification link base URL must use http or https.');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error(
      'Notification link base URL must not carry credentials, a query, or a fragment.',
    );
  }
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\\s]/u.test(path) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new NotificationOutboxDeniedError(
      'link',
      'Notification links must be a host-relative path such as /inbox/123.',
    );
  }
  const prefix = base.pathname.replace(/\/+$/u, '');
  const link = new URL(`${prefix}${path}`, base.origin);
  if (link.origin !== base.origin) {
    throw new NotificationOutboxDeniedError(
      'link',
      'Notification links must stay on the configured origin.',
    );
  }
  return link.toString();
}

/**
 * Source-keyed, durable notification email outbox.
 *
 * `enqueueEmail()` stores one `NotificationDelivery` per
 * `(tenant, recipient, email, sourceRef)` — a repeated event returns the
 * existing row — after the host has authorized the recipient and sender.
 * `dispatchDue()` leases due rows with a compare-and-set, creates the single
 * outbound `Email` under the lease, hands it to the transport, and records
 * the outcome; it is safe to run from several workers at once and to crash
 * at any point. See `packages/messages/agents/notification-outbox.md`.
 */
export class NotificationOutboxService {
  /** Additive dispatch contracts hosts can require before activating a sender. */
  static readonly capabilities = Object.freeze({
    deliverySelection: true,
    attachments: true,
    requiredPolicy: true,
    protectedCanonicalSend: true,
    profileRecipients: true,
  } as const);
  private readonly transport: NotificationTransport;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempts: number) => number;
  private readonly now: () => Date;

  constructor(private readonly options: NotificationOutboxOptions) {
    // Validate the configured origin eagerly so a bad deployment fails at boot.
    buildNotificationLink(options.linkBaseUrl, '/');
    this.transport = options.transport ?? messageSendTransport;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000) {
      throw new Error('Notification lease must be at least 1000 ms.');
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('Notification maxAttempts must be a positive integer.');
    }
  }

  private collection(): Promise<NotificationDeliveryCollection> {
    return NotificationDeliveryCollection.create({ db: this.options.db });
  }

  private authorize(tenantId: string): void {
    if (!this.options.principal) return;
    try {
      assertMessagingPermission(
        this.options.principal,
        tenantId,
        SEND_MESSAGES_PERMISSION,
      );
    } catch (error) {
      throw new NotificationOutboxDeniedError('permission', errorText(error));
    }
  }

  /** Store one email delivery for the event unless `sourceRef` already has one. */
  async enqueueEmail(
    input: NotificationEmailInput,
  ): Promise<NotificationEnqueueResult> {
    const tenantId = requireText(input.tenantId, 'tenant');
    if (
      input.kind?.startsWith('protected:') &&
      input.kind !== `protected:${input.requiredDispatchPolicy}`
    )
      throw new Error(
        'Protected notification kinds require their exact dispatch policy.',
      );
    const requiredDispatchPolicy =
      input.requiredDispatchPolicy === undefined
        ? ''
        : requireText(input.requiredDispatchPolicy, 'dispatch policy');
    if (
      requiredDispatchPolicy &&
      !this.dispatchPolicy(requiredDispatchPolicy)
    ) {
      throw new NotificationOutboxDeniedError(
        'permission',
        'Required notification dispatch policy is unavailable.',
      );
    }
    if (
      requiredDispatchPolicy &&
      (!input.dispatchPolicyBinding ||
        typeof input.dispatchPolicyBinding !== 'object' ||
        Array.isArray(input.dispatchPolicyBinding) ||
        !Object.keys(input.dispatchPolicyBinding).length)
    ) {
      throw new Error(
        'Protected notification requires an approved dispatch policy binding.',
      );
    }
    const dispatchPolicyBinding = JSON.stringify(
      input.dispatchPolicyBinding ?? {},
    );
    const profilePath = input.recipientProfileId !== undefined;
    if (profilePath === (input.recipientUserId !== undefined))
      throw new NotificationOutboxDeniedError(
        'recipient',
        'Choose exactly one typed recipient.',
      );
    const recipientUserId = profilePath
      ? null
      : requireText(input.recipientUserId, 'recipient');
    const recipientProfileId = profilePath
      ? requireText(input.recipientProfileId, 'profile recipient')
      : null;
    const recipientKind = profilePath ? 'profile' : 'user';
    assertNotificationRecipientIdentity({
      recipientKind,
      recipientUserId,
      recipientProfileId,
      channel: 'email',
      kind: input.kind,
      requiredDispatchPolicy,
    });

    const sourceRef = requireText(input.sourceRef, 'sourceRef');
    const kind = requireText(input.kind, 'kind');
    const subject = requireText(input.subject, 'subject');
    const text = requireText(input.text, 'text');
    if (/[\r\n]/u.test(subject)) {
      throw new Error('A notification subject must be a single line.');
    }
    const channel: NotificationDeliveryChannel = 'email';
    this.authorize(tenantId);
    if (profilePath)
      await assertNotificationProfileRecipientSchema(
        (await this.collection()).db,
      );
    const href = buildNotificationLink(this.options.linkBaseUrl, input.path);

    return withTenant({ tenantId }, async () => {
      const deliveries = await this.collection();
      const findExisting = async () =>
        (
          await deliveries.list({
            where: {
              tenantId,
              recipientKind,
              recipientUserId,
              recipientProfileId,
              channel,
              sourceRef,
            },
            limit: 1,
          })
        )[0];
      const existing = await findExisting();
      if (existing) {
        if (recipientProfileId) await this.validateProfileDelivery(existing);
        return { delivery: existing, created: false };
      }

      const recipient = recipientProfileId
        ? await this.resolveProfile({ tenantId, recipientProfileId, channel })
        : await this.options.resolveRecipient({
            tenantId,
            recipientUserId: recipientUserId as string,
            channel,
          });
      const address = recipient?.address?.trim();
      if (!address || /[\s,;<>]/u.test(address) || !address.includes('@')) {
        throw new NotificationOutboxDeniedError(
          'recipient',
          'The host did not authorize an email recipient for this user.',
        );
      }
      const accountId = await this.requireSenderAccount(tenantId);
      const suppressed = await this.isSuppressed({
        tenantId,
        ...(recipientUserId ? { recipientUserId } : {}),
        ...(recipientProfileId
          ? { recipientProfileId, recipientKind: 'profile' as const }
          : {}),
        channel,
        kind,
        sourceRef,
      });

      try {
        const delivery = await deliveries.create({
          _insertOnly: true,
          tenantId,
          recipientUserId,
          recipientProfileId,
          recipientKind,
          channel,
          sourceRef,
          kind,
          requiredDispatchPolicy,
          dispatchPolicyBinding,
          subject,
          textBody: text,
          href,
          recipientAddress: address,
          recipientName: recipient?.name?.trim() ?? '',
          accountId,
          messageId: null,
          status: suppressed ? 'cancelled' : 'pending',
          stateVersion: 0,
          transitionId: '',
          attempts: 0,
          maxAttempts: this.maxAttempts,
          nextAttemptAt: input.notBefore ?? this.now(),
          leaseToken: null,
          leaseExpiresAt: null,
          handedOffAt: null,
          deliveredAt: null,
          providerMessageId: '',
          lastError: suppressed ? 'Suppressed by recipient preference.' : '',
        });
        return { delivery, created: true };
      } catch (error) {
        if (!isUniqueViolationError(error)) throw error;
        const winner = await findExisting();
        if (!winner) throw error;
        return { delivery: winner, created: false };
      }
    });
  }

  /** Lease and deliver due rows; returns what happened to each leased row. */
  async dispatchDue(
    options: NotificationDispatchOptions = {},
  ): Promise<NotificationDispatchReport> {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        'Notification dispatch limit must be a positive integer.',
      );
    }
    let tenantIds = options.tenantIds;
    if (this.options.principal && tenantIds === undefined) {
      const tenantId = this.options.principal.tenantId;
      if (!tenantId) {
        throw new NotificationOutboxDeniedError(
          'permission',
          'A messaging principal must select explicit dispatch tenants.',
        );
      }
      tenantIds = [tenantId];
    }
    if (tenantIds !== undefined) {
      tenantIds = [
        ...new Set(tenantIds.map((id) => requireText(id, 'tenant'))),
      ];
      // Authorize every requested scope before discovering or leasing any row.
      for (const tenantId of tenantIds) this.authorize(tenantId);
    }
    const deliveryIds =
      options.deliveryIds === undefined
        ? undefined
        : [...new Set(options.deliveryIds)];
    if (
      deliveryIds?.some(
        (id) => typeof id !== 'string' || !UUID_PATTERN.test(id),
      )
    ) {
      throw new Error('Notification dispatch delivery ids must be UUIDs.');
    }
    const report: NotificationDispatchReport = { leased: 0, outcomes: [] };
    if (tenantIds?.length === 0 || deliveryIds?.length === 0) return report;
    for await (const candidate of this.findDue(tenantIds, limit, deliveryIds)) {
      if (report.leased >= limit) break;
      this.authorize(candidate.tenantId);
      if (
        (candidate.kind.startsWith('protected:') &&
          candidate.kind !== `protected:${candidate.requiredDispatchPolicy}`) ||
        (candidate.requiredDispatchPolicy &&
          !this.dispatchPolicy(candidate.requiredDispatchPolicy))
      ) {
        const lastError =
          'Blocked: required notification dispatch policy is unavailable.';
        if (candidate.lastError !== lastError)
          await withTenant({ tenantId: candidate.tenantId }, () =>
            candidate.transition({ lastError }),
          );
        report.outcomes.push({
          deliveryId: candidate.id as string,
          tenantId: candidate.tenantId,
          outcome: 'blocked',
        });
        continue;
      }
      try {
        await withTenant({ tenantId: candidate.tenantId }, () =>
          this.validateProfileDelivery(candidate),
        );
      } catch (cause) {
        const lastError = `Blocked: ${errorText(cause)}`;
        if (candidate.lastError !== lastError)
          await withTenant({ tenantId: candidate.tenantId }, () =>
            candidate.transition({ lastError }),
          );
        report.outcomes.push({
          deliveryId: candidate.id as string,
          tenantId: candidate.tenantId,
          outcome: 'blocked',
        });
        continue;
      }
      const outcome = await withTenant({ tenantId: candidate.tenantId }, () =>
        this.dispatchOne(candidate),
      );
      if (!outcome) continue;
      report.leased += 1;
      report.outcomes.push({
        deliveryId: candidate.id as string,
        tenantId: candidate.tenantId,
        outcome,
      });
    }
    return report;
  }

  /** Deliveries waiting for a reconciliation decision, oldest first. */
  async listUncertain(options: {
    tenantId: string;
    limit?: number;
  }): Promise<NotificationDelivery[]> {
    const tenantId = requireText(options.tenantId, 'tenant');
    this.authorize(tenantId);
    return withTenant({ tenantId }, async () =>
      (await this.collection()).list({
        where: { tenantId, status: 'uncertain' },
        orderBy: 'handedOffAt ASC',
        limit: Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
      }),
    );
  }

  /**
   * Settle an `uncertain` delivery after checking the provider out of band:
   * `sent` (it arrived), `failed` (give up), or `retry` (send again,
   * accepting the risk of a duplicate; a message left claimed by a dead
   * sender is released first). Returns false when the row is not uncertain
   * any more, or for `retry` when the message is recorded as sent.
   */
  async reconcile(input: {
    tenantId: string;
    deliveryId: string;
    outcome: NotificationReconcileOutcome;
    note?: string;
  }): Promise<boolean> {
    const tenantId = requireText(input.tenantId, 'tenant');
    this.authorize(tenantId);
    // Ids may come from requests; on a native uuid column (PostgreSQL) a
    // malformed one would fail the query (22P02) instead of matching nothing.
    if (!UUID_PATTERN.test(input.deliveryId ?? '')) return false;
    return withTenant({ tenantId }, async () => {
      const delivery = (
        await (
          await this.collection()
        ).list({
          where: { tenantId, id: input.deliveryId },
          limit: 1,
        })
      )[0];
      if (delivery?.status !== 'uncertain') return false;
      const note = input.note?.trim();
      const now = this.now();
      switch (input.outcome) {
        case 'sent':
          return delivery.transition({
            status: 'sent',
            deliveredAt: now,
            ...(note ? { lastError: note } : {}),
          });
        case 'failed':
          return delivery.transition({
            status: 'failed',
            lastError: note || delivery.lastError,
          });
        case 'retry': {
          // The canonical message must be sendable again: a crash can leave
          // it claimed ('sending') by a sender that no longer exists. The
          // delivery is uncertain, so no dispatcher holds it.
          const message = delivery.messageId
            ? await this.loadMessage(delivery.messageId)
            : null;
          if (message?.sendStatus === 'sent') return false;
          if (
            message?.sendStatus === 'sending' &&
            !(await message.abandonSendAttempt(
              note || 'Released for an operator-approved retry.',
            ))
          ) {
            return false;
          }
          return delivery.transition({
            status: 'pending',
            nextAttemptAt: now,
            handedOffAt: null,
            // One more lease, so a delivery already at its budget can retry.
            attempts: Math.min(delivery.attempts, delivery.maxAttempts - 1),
            ...(note ? { lastError: note } : {}),
          });
        }
        default:
          throw new Error(`Unknown reconcile outcome '${input.outcome}'.`);
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────

  private async requireSenderAccount(tenantId: string): Promise<string> {
    const accountId = (
      await this.options.resolveSenderAccountId({ tenantId })
    )?.trim();
    const account = accountId
      ? await (await AccountCollection.create({ db: this.options.db })).get({
          id: accountId,
        })
      : null;
    if (
      !account ||
      !(account instanceof EmailAccount) ||
      account.tenantId !== tenantId ||
      !account.isActive
    ) {
      throw new NotificationOutboxDeniedError(
        'sender',
        'No active email sender account is configured for this tenant.',
      );
    }
    return account.id as string;
  }

  private async isSuppressed(request: {
    tenantId: string;
    channel: NotificationDeliveryChannel;
    kind: string;
    sourceRef: string;
    recipientUserId?: string;
    recipientProfileId?: string;
    recipientKind?: 'profile';
  }): Promise<boolean> {
    if (request.recipientProfileId)
      return Boolean(
        await this.options.isProfileSuppressed?.({
          tenantId: request.tenantId,
          recipientProfileId: request.recipientProfileId,
          channel: 'email',
          kind: request.kind,
          sourceRef: request.sourceRef,
        }),
      );
    if (!request.recipientUserId)
      throw new NotificationOutboxDeniedError(
        'recipient',
        'Missing typed suppression recipient.',
      );
    return Boolean(
      await this.options.isSuppressed?.({
        tenantId: request.tenantId,
        recipientUserId: request.recipientUserId,
        channel: request.channel,
        kind: request.kind,
        sourceRef: request.sourceRef,
      }),
    );
  }

  private async resolveProfile(
    request: NotificationProfileRecipientRequest,
  ): Promise<NotificationRecipient> {
    const db = (await this.collection()).db;
    const profile = await readNotificationProfile(
      db,
      request.tenantId,
      request.recipientProfileId,
    );
    const resolved = await this.options.resolveProfileRecipient?.(request);
    const address = profile?.email ? normalizeIdentityEmail(profile.email) : '';
    if (
      !profile ||
      profile.tenantId !== request.tenantId ||
      !address ||
      containsControlCharacter(address) ||
      !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u.test(address) ||
      !resolved?.address ||
      normalizeIdentityEmail(resolved.address) !== address
    )
      throw new NotificationOutboxDeniedError(
        'recipient',
        'Current tenant-owned profile email is not authorized.',
      );
    if (resolved.name && containsControlCharacter(resolved.name))
      throw new NotificationOutboxDeniedError(
        'recipient',
        'Malformed profile recipient display name.',
      );
    return { address, name: resolved.name?.trim() ?? '' };
  }
  private async validateProfileDelivery(
    delivery: NotificationDelivery,
  ): Promise<void> {
    assertNotificationRecipientIdentity(delivery);
    if (delivery.recipientKind !== 'profile') return;
    await assertNotificationProfileRecipientSchema(
      (await this.collection()).db,
    );
    const current = await this.resolveProfile({
      tenantId: delivery.tenantId,
      recipientProfileId: delivery.recipientProfileId as string,
      channel: 'email',
    });
    if (
      current.address !== delivery.recipientAddress ||
      (current.name ?? '') !== delivery.recipientName
    )
      throw new NotificationOutboxDeniedError(
        'recipient',
        'Approved profile recipient changed; review again.',
      );
  }
  private dispatchPolicy(id: string) {
    const policies = this.options.dispatchPolicies;
    if (!policies || !Object.hasOwn(policies, id)) return undefined;
    const policy = policies[id];
    return typeof policy?.resolveAttachments === 'function'
      ? policy
      : undefined;
  }

  private async *findDue(
    tenantIds: readonly string[] | undefined,
    limit: number,
    deliveryIds?: readonly string[],
  ): AsyncGenerator<NotificationDelivery> {
    const now = this.now();
    const visited = new Set<string>();
    // Each page is bounded; a blocked prefix cannot consume the lease budget.
    // Expired leases precede pending rows, including across explicit scopes.
    for (const phase of [
      { status: 'sending', column: 'lease_expires_at' },
      { status: 'pending', column: 'next_attempt_at' },
    ] as const) {
      for (const tenantId of tenantIds ?? [undefined]) {
        let cursor: { id: string; cursor_at: string } | undefined;
        for (;;) {
          const read = async () => {
            const deliveries = await this.collection();
            const table = `"${deliveries.tableName.replaceAll('"', '""')}"`;
            const conditions = ['status = ?', `${phase.column} <= ?`];
            const values: unknown[] = [phase.status, now.toISOString()];
            if (tenantId !== undefined) {
              conditions.push('tenant_id = ?');
              values.push(tenantId);
            }
            if (deliveryIds) {
              conditions.push(
                `id IN (${deliveryIds.map(() => '?').join(',')})`,
              );
              values.push(...deliveryIds);
            }
            if (cursor) {
              conditions.push(
                `(${phase.column} > ? OR (${phase.column} = ? AND id > ?))`,
              );
              values.push(cursor.cursor_at, cursor.cursor_at, cursor.id);
            }
            // Capture the cursor in this same query, before hydration or writes.
            // PostgreSQL Date hydration loses microseconds; CAST preserves the
            // physical timestamp so equal/sub-ms rows cannot repeat forever.
            const result = await deliveries.db.query(
              `SELECT id, CAST(${phase.column} AS TEXT) AS cursor_at FROM ${table}
               WHERE ${conditions.join(' AND ')}
               ORDER BY ${phase.column} ASC, id ASC LIMIT ?`,
              ...values,
              limit,
            );
            const positions = result.rows as Array<{
              id: string;
              cursor_at: string;
            }>;
            if (
              positions.some(
                (row) =>
                  typeof row.id !== 'string' ||
                  !UUID_PATTERN.test(row.id) ||
                  typeof row.cursor_at !== 'string' ||
                  !row.cursor_at,
              )
            )
              throw new Error('Invalid notification dispatch cursor.');
            if (!positions.length) return { positions, rows: [] };
            const rows = await deliveries.list({
              where: {
                ...(tenantId === undefined ? {} : { tenantId }),
                id: positions.map((row) => row.id),
              },
              limit: positions.length,
            });
            const byId = new Map(rows.map((row) => [row.id, row]));
            return {
              positions,
              rows: positions.flatMap((row) => {
                const delivery = byId.get(row.id);
                return delivery ? [delivery] : [];
              }),
            };
          };
          const page =
            tenantId === undefined
              ? await withSystemContext(read)
              : await withTenant({ tenantId }, read);
          if (!page.positions.length) break;
          cursor = page.positions[page.positions.length - 1];
          for (const row of page.rows) {
            if (!row.id || visited.has(row.id)) continue;
            visited.add(row.id);
            yield row;
          }
          if (page.positions.length < limit) break;
        }
      }
    }
  }

  /** Lease one candidate and carry it to an outcome; null when not leased. */
  private async dispatchOne(
    candidate: NotificationDelivery,
  ): Promise<NotificationDispatchOutcome | null> {
    // Re-read under the tenant scope; the candidate may be stale.
    const delivery = (
      await (
        await this.collection()
      ).list({
        where: { tenantId: candidate.tenantId, id: candidate.id },
        limit: 1,
      })
    )[0];
    if (!delivery) return null;
    const now = this.now();

    const recovering =
      delivery.status === 'sending' &&
      delivery.leaseExpiresAt !== null &&
      delivery.leaseExpiresAt.getTime() <= now.getTime();
    const due =
      delivery.status === 'pending' &&
      delivery.nextAttemptAt.getTime() <= now.getTime();
    if (!recovering && !due) return null;

    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    // A lapsed lease whose attempt already reached the provider is a crash or
    // lease loss mid-handoff: learn what we can before anything is resent.
    const priorHandoff = recovering && delivery.handedOffAt !== null;
    const won = await delivery.transition({
      status: 'sending',
      leaseToken,
      leaseExpiresAt,
      attempts: priorHandoff ? delivery.attempts : delivery.attempts + 1,
      ...(priorHandoff ? {} : { handedOffAt: null }),
    });
    if (!won) return null;

    try {
      if (priorHandoff) {
        const resolved = await this.recoverHandoff(delivery, leaseToken);
        if (resolved) return resolved;
      }

      if (
        await this.isSuppressed({
          tenantId: delivery.tenantId,
          ...(delivery.recipientUserId
            ? { recipientUserId: delivery.recipientUserId }
            : {}),
          ...(delivery.recipientProfileId
            ? {
                recipientProfileId: delivery.recipientProfileId,
                recipientKind: 'profile' as const,
              }
            : {}),
          channel: delivery.channel,
          kind: delivery.kind,
          sourceRef: delivery.sourceRef,
        })
      ) {
        return this.settle(delivery, leaseToken, {
          status: 'cancelled',
          lastError: 'Suppressed by recipient preference.',
        });
      }

      await this.validateProfileDelivery(delivery);
      const message = await this.ensureMessage(delivery, leaseToken);
      if (!message) return 'lease-lost';
      const request: NotificationTransportRequest = {
        delivery,
        message,
        idempotencyKey: notificationDeliveryCorrelationId(
          delivery.id as string,
        ),
      };
      const resolver = delivery.requiredDispatchPolicy
        ? this.dispatchPolicy(delivery.requiredDispatchPolicy)
            ?.resolveAttachments
        : this.options.resolveAttachments;
      if (delivery.requiredDispatchPolicy && !resolver)
        throw new Error(
          'Required notification dispatch policy is unavailable.',
        );
      if (resolver) {
        const attachments = await resolver(request);
        if (
          !Array.isArray(attachments) ||
          (delivery.requiredDispatchPolicy && attachments.length === 0) ||
          attachments.some(
            (attachment) =>
              !attachment ||
              typeof attachment.filename !== 'string' ||
              !attachment.filename.trim() ||
              /[\r\n\0]/.test(attachment.filename) ||
              !(attachment.content instanceof Uint8Array) ||
              (attachment.contentType !== undefined &&
                (typeof attachment.contentType !== 'string' ||
                  !attachment.contentType.trim() ||
                  /[\r\n\0]/.test(attachment.contentType))) ||
              (attachment.contentId !== undefined &&
                (typeof attachment.contentId !== 'string' ||
                  /[\r\n\0]/.test(attachment.contentId))) ||
              (attachment.contentDisposition !== undefined &&
                !['attachment', 'inline'].includes(
                  attachment.contentDisposition,
                )),
          )
        )
          throw new Error(
            'Notification attachment resolver returned malformed bytes or metadata.',
          );
        request.attachments = attachments.map((attachment) => ({
          ...attachment,
          content: Uint8Array.from(attachment.content),
        }));
      }
      if (
        !(await delivery.transition(
          { handedOffAt: this.now() },
          { leaseToken },
        ))
      ) {
        return 'lease-lost';
      }

      let outcome: NotificationTransportOutcome;
      try {
        outcome = await withProtectedNotificationHandoff(
          request,
          this.now,
          async () => {
            await this.validateProfileDelivery(delivery);
            return this.transport.send(request);
          },
        );
      } catch (error) {
        // A throw after handoff says nothing about whether the provider
        // accepted the message.
        outcome =
          error instanceof ProtectedNotificationHandoffError
            ? { status: 'rejected', retryable: true, error: errorText(error) }
            : { status: 'unknown', error: errorText(error) };
      }
      return this.applyOutcome(delivery, leaseToken, outcome);
    } catch (error) {
      // A failure before handoff (message creation, suppression hook) is safe
      // to retry; one after handoff has already been mapped to an outcome.
      if (delivery.handedOffAt !== null) throw error;
      return this.applyOutcome(delivery, leaseToken, {
        status: 'rejected',
        error: errorText(error),
        retryable: true,
      });
    }
  }

  private async recoverHandoff(
    delivery: NotificationDelivery,
    leaseToken: string,
  ): Promise<NotificationDispatchOutcome | null> {
    const message = delivery.messageId
      ? await this.loadMessage(delivery.messageId)
      : null;
    let known: NotificationTransportReconciliation = {
      status: 'unknown',
      error: 'Lease lapsed after the provider handoff; outcome unknown.',
    };
    if (message && this.transport.reconcile) {
      try {
        known = await this.transport.reconcile({
          delivery,
          message,
          idempotencyKey: notificationDeliveryCorrelationId(
            delivery.id as string,
          ),
        });
      } catch (error) {
        known = { status: 'unknown', error: errorText(error) };
      }
    }
    if (known.status === 'not-sent') {
      // Nothing reached the provider; this lease becomes a fresh attempt.
      if (
        !(await delivery.transition(
          { handedOffAt: null, attempts: delivery.attempts + 1 },
          { leaseToken },
        ))
      ) {
        return 'lease-lost';
      }
      return null;
    }
    if (known.status === 'unknown' && this.transport.idempotent) {
      // The provider dedupes on the key: resending is the reconciliation.
      if (
        !(await delivery.transition(
          { handedOffAt: null, attempts: delivery.attempts + 1 },
          { leaseToken },
        ))
      ) {
        return 'lease-lost';
      }
      return null;
    }
    return this.applyOutcome(delivery, leaseToken, known);
  }

  private async applyOutcome(
    delivery: NotificationDelivery,
    leaseToken: string,
    outcome: NotificationTransportOutcome,
  ): Promise<NotificationDispatchOutcome> {
    if (outcome.status === 'accepted') {
      return this.settle(delivery, leaseToken, {
        status: 'sent',
        deliveredAt: this.now(),
        providerMessageId: outcome.providerMessageId ?? '',
        lastError: '',
      });
    }
    if (outcome.status === 'unknown') {
      if (
        this.transport.idempotent &&
        delivery.attempts < delivery.maxAttempts
      ) {
        return this.scheduleRetry(delivery, leaseToken, outcome.error);
      }
      return this.settle(delivery, leaseToken, {
        status: 'uncertain',
        lastError: outcome.error,
      });
    }
    if (outcome.retryable && delivery.attempts < delivery.maxAttempts) {
      return this.scheduleRetry(delivery, leaseToken, outcome.error);
    }
    return this.settle(delivery, leaseToken, {
      status: 'failed',
      lastError: outcome.error,
    });
  }

  private async scheduleRetry(
    delivery: NotificationDelivery,
    leaseToken: string,
    error: string,
  ): Promise<NotificationDispatchOutcome> {
    const delay = this.retryDelayMs(delivery.attempts);
    const won = await this.endLease(delivery, leaseToken, {
      status: 'pending',
      nextAttemptAt: new Date(this.now().getTime() + Math.max(0, delay)),
      handedOffAt: null,
      lastError: error,
    });
    return won ? 'retry-scheduled' : 'lease-lost';
  }

  /** End the lease in a terminal status; reports lease loss instead of overwriting. */
  private async settle(
    delivery: NotificationDelivery,
    leaseToken: string,
    changes: NotificationDeliveryTransition & {
      status: 'sent' | 'failed' | 'uncertain' | 'cancelled';
    },
  ): Promise<NotificationDispatchOutcome> {
    const won = await this.endLease(delivery, leaseToken, changes);
    return won ? changes.status : 'lease-lost';
  }

  private endLease(
    delivery: NotificationDelivery,
    leaseToken: string,
    changes: NotificationDeliveryTransition,
  ): Promise<boolean> {
    return delivery.transition(
      { ...changes, leaseToken: null, leaseExpiresAt: null },
      { leaseToken },
    );
  }

  private async loadMessage(messageId: string): Promise<Message | null> {
    const messages = await MessageCollection.create({ db: this.options.db });
    return (await messages.get({ id: messageId })) ?? null;
  }

  /**
   * The delivery's single outbound `Email`, created under the lease. Its id
   * is derived from the delivery id and inserted insert-only, so a stale
   * dispatcher that resumes after its lease was taken over hits the stored
   * row (a unique violation) instead of creating a second email.
   */
  private async ensureMessage(
    delivery: NotificationDelivery,
    leaseToken: string,
  ): Promise<Message | null> {
    if (delivery.messageId) {
      const message = await this.loadMessage(delivery.messageId);
      if (message) return this.protectCanonicalMessage(delivery, message);
    }
    const messageId = await notificationDeliveryMessageId(
      delivery.id as string,
    );
    let message = await this.loadMessage(messageId);
    if (!message) {
      const body = `${delivery.textBody}\n\n${delivery.href}\n`;
      const emails = await EmailCollection.create({ db: this.options.db });
      try {
        await emails.create({
          _insertOnly: true,
          id: messageId,
          tenantId: delivery.tenantId,
          accountId: delivery.accountId,
          correlationId: notificationDeliveryCorrelationId(
            delivery.id as string,
          ),
          subject: delivery.subject,
          body,
          textBody: body,
          toAddresses: JSON.stringify([
            {
              address: delivery.recipientAddress,
              ...(delivery.recipientName
                ? { name: delivery.recipientName }
                : {}),
            },
          ]),
          ...(delivery.requiredDispatchPolicy
            ? {
                metadata: protectedNotificationMetadata(
                  delivery.id!,
                  delivery.requiredDispatchPolicy,
                ),
              }
            : {}),
          sendStatus: 'pending',
          // Delivery is owned by the outbox's attempt budget, not the message's.
          maxRetries: 0,
        });
      } catch (error) {
        if (!isUniqueViolationError(error)) throw error;
      }
      // Reload so send()'s compare-and-set sees the stored revision.
      message = await this.loadMessage(messageId);
      if (!message) throw new Error('The outbound email could not be stored.');
    }
    if (delivery.messageId !== message.id) {
      if (
        !(await delivery.transition(
          { messageId: message.id as string },
          { leaseToken },
        ))
      ) {
        return null;
      }
    }
    return this.protectCanonicalMessage(delivery, message);
  }

  /** Backfill the non-authorizing durable marker on an existing protected canonical row. */
  private async protectCanonicalMessage(
    delivery: NotificationDelivery,
    message: Message,
  ): Promise<Message> {
    if (delivery.requiredDispatchPolicy) {
      const existing = message.getMetadata();
      const protectedMarker = JSON.parse(
        protectedNotificationMetadata(
          delivery.id!,
          delivery.requiredDispatchPolicy,
        ),
      );
      if (!existing.__smrtProtectedOutbox) {
        message.setMetadata({ ...existing, ...protectedMarker });
        await message.save();
      }
    }
    return message;
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) as number;
    return code < 32 || code === 127;
  });
}
