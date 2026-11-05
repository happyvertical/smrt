import {
  isUniqueViolationError,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { AccountCollection } from '../collections/AccountCollection.js';
import { MessageCollection } from '../collections/MessageCollection.js';
import { NotificationDeliveryCollection } from '../collections/NotificationDeliveryCollection.js';
import { Email } from '../models/Email.js';
import { EmailAccount } from '../models/EmailAccount.js';
import type { Message } from '../models/Message.js';
import type {
  NotificationDelivery,
  NotificationDeliveryChannel,
  NotificationDeliveryTransition,
} from '../models/NotificationDelivery.js';
import {
  assertMessagingPermission,
  type MessagingPrincipal,
  SEND_MESSAGES_PERMISSION,
} from '../permissions.js';

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
  async send({ message }) {
    const result = await message.send();
    if (result.success) {
      return {
        status: 'accepted',
        ...(result.providerMessageId
          ? { providerMessageId: result.providerMessageId }
          : {}),
      };
    }
    // send() refuses without contacting the provider when its own claim on
    // the message fails; another sender may be mid-flight, so do not retry.
    if (message.sendStatus === 'sending' || message.sendStatus === 'sent') {
      return {
        status: 'unknown',
        error: result.error ?? 'Message is already being sent.',
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

export interface NotificationRecipient {
  address: string;
  name?: string;
}

export interface NotificationSuppressionRequest
  extends NotificationRecipientRequest {
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
  /** Provider seam; defaults to {@link messageSendTransport}. */
  transport?: NotificationTransport;
  /**
   * When set, enqueue and reconcile require `messages.send` in the tenant.
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
  recipientUserId: string;
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
    const recipientUserId = requireText(input.recipientUserId, 'recipient');
    const sourceRef = requireText(input.sourceRef, 'sourceRef');
    const kind = requireText(input.kind, 'kind');
    const subject = requireText(input.subject, 'subject');
    const text = requireText(input.text, 'text');
    if (/[\r\n]/u.test(subject)) {
      throw new Error('A notification subject must be a single line.');
    }
    const channel: NotificationDeliveryChannel = 'email';
    this.authorize(tenantId);
    const href = buildNotificationLink(this.options.linkBaseUrl, input.path);

    return withTenant({ tenantId }, async () => {
      const deliveries = await this.collection();
      const findExisting = async () =>
        (
          await deliveries.list({
            where: { tenantId, recipientUserId, channel, sourceRef },
            limit: 1,
          })
        )[0];
      const existing = await findExisting();
      if (existing) return { delivery: existing, created: false };

      const recipient = await this.options.resolveRecipient({
        tenantId,
        recipientUserId,
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
        recipientUserId,
        channel,
        kind,
        sourceRef,
      });

      try {
        const delivery = await deliveries.create({
          _insertOnly: true,
          tenantId,
          recipientUserId,
          channel,
          sourceRef,
          kind,
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
    const candidates = await this.findDue(options.tenantIds, limit);
    const report: NotificationDispatchReport = { leased: 0, outcomes: [] };
    for (const candidate of candidates) {
      if (report.leased >= limit) break;
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
   * accepting the risk of a duplicate). Returns false when the row is not
   * uncertain any more.
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
        case 'retry':
          return delivery.transition({
            status: 'pending',
            nextAttemptAt: now,
            handedOffAt: null,
            // One more lease, so a delivery already at its budget can retry.
            attempts: Math.min(delivery.attempts, delivery.maxAttempts - 1),
            ...(note ? { lastError: note } : {}),
          });
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

  private async isSuppressed(
    request: NotificationSuppressionRequest,
  ): Promise<boolean> {
    return Boolean(await this.options.isSuppressed?.(request));
  }

  private async findDue(
    tenantIds: readonly string[] | undefined,
    limit: number,
  ): Promise<NotificationDelivery[]> {
    const now = this.now();
    const read = async (tenantFilter: { tenantId?: string }) => {
      const deliveries = await this.collection();
      const [due, expired] = await Promise.all([
        deliveries.list({
          where: {
            ...tenantFilter,
            status: 'pending',
            'nextAttemptAt <=': now,
          },
          orderBy: 'nextAttemptAt ASC',
          limit,
        }),
        deliveries.list({
          where: {
            ...tenantFilter,
            status: 'sending',
            'leaseExpiresAt <=': now,
          },
          orderBy: 'leaseExpiresAt ASC',
          limit,
        }),
      ]);
      return [...expired, ...due];
    };

    const rows =
      tenantIds === undefined
        ? await withSystemContext(() => read({}))
        : (
            await Promise.all(
              [...new Set(tenantIds.filter(Boolean))].map((tenantId) =>
                withTenant({ tenantId }, () => read({ tenantId })),
              ),
            )
          ).flat();
    // Recover lapsed leases first, then oldest due.
    return rows.slice(0, limit * 2);
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
          recipientUserId: delivery.recipientUserId,
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

      const message = await this.ensureMessage(delivery, leaseToken);
      if (!message) return 'lease-lost';
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
        outcome = await this.transport.send({
          delivery,
          message,
          idempotencyKey: notificationDeliveryCorrelationId(
            delivery.id as string,
          ),
        });
      } catch (error) {
        // A throw after handoff says nothing about whether the provider
        // accepted the message.
        outcome = { status: 'unknown', error: errorText(error) };
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
   * The delivery's single outbound `Email`, created under the lease. A
   * message left behind by a crash before its id was recorded is found again
   * by its correlation id instead of being created twice.
   */
  private async ensureMessage(
    delivery: NotificationDelivery,
    leaseToken: string,
  ): Promise<Message | null> {
    if (delivery.messageId) {
      const message = await this.loadMessage(delivery.messageId);
      if (message) return message;
    }
    const correlationId = notificationDeliveryCorrelationId(
      delivery.id as string,
    );
    const messages = await MessageCollection.create({ db: this.options.db });
    let message: Message | undefined = (
      await messages.list({
        where: { tenantId: delivery.tenantId, correlationId },
        limit: 1,
      })
    )[0];
    if (!message) {
      const body = `${delivery.textBody}\n\n${delivery.href}\n`;
      const email = new Email({
        db: this.options.db,
        tenantId: delivery.tenantId,
        accountId: delivery.accountId,
        correlationId,
        subject: delivery.subject,
        body,
        textBody: body,
        sendStatus: 'pending',
        // Delivery is owned by the outbox's attempt budget, not the message's.
        maxRetries: 0,
      });
      email.setToAddresses([
        {
          address: delivery.recipientAddress,
          ...(delivery.recipientName ? { name: delivery.recipientName } : {}),
        },
      ]);
      await email.initialize();
      await email.save();
      // Reload so send()'s compare-and-set sees the stored revision.
      message = (await this.loadMessage(email.id as string)) ?? email;
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
    return message;
  }
}
