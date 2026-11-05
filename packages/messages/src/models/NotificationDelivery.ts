import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
  usesEmbeddedRevisionFallback,
  withEmbeddedWriteQueue,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Channels the notification outbox can deliver through. */
export type NotificationDeliveryChannel = 'email';

export const NOTIFICATION_DELIVERY_CHANNELS: readonly NotificationDeliveryChannel[] =
  ['email'];

/**
 * Where a delivery is in its lifecycle.
 *
 * - `pending`: waiting for `nextAttemptAt`.
 * - `sending`: leased by one dispatcher until `leaseExpiresAt`.
 * - `sent`: the provider accepted it (terminal).
 * - `failed`: rejected for good or out of attempts (terminal).
 * - `uncertain`: handed to a provider whose outcome is unknown; waits for
 *   reconciliation and is never resent automatically.
 * - `cancelled`: suppressed by the host before handoff (terminal).
 */
export type NotificationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'uncertain'
  | 'cancelled';

export interface NotificationDeliveryOptions extends SmrtObjectOptions {
  tenantId?: string;
  recipientUserId?: string;
  channel?: NotificationDeliveryChannel;
  sourceRef?: string;
  kind?: string;
  subject?: string;
  textBody?: string;
  href?: string;
  recipientAddress?: string;
  recipientName?: string;
  accountId?: string;
  messageId?: string | null;
  status?: NotificationDeliveryStatus;
  stateVersion?: number;
  transitionId?: string;
  attempts?: number;
  maxAttempts?: number;
  nextAttemptAt?: Date;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  handedOffAt?: Date | null;
  deliveredAt?: Date | null;
  providerMessageId?: string;
  lastError?: string;
}

/** Column values a lease transition may change (camelCase field names). */
export type NotificationDeliveryTransition = Partial<
  Pick<
    NotificationDelivery,
    | 'messageId'
    | 'status'
    | 'attempts'
    | 'nextAttemptAt'
    | 'leaseToken'
    | 'leaseExpiresAt'
    | 'handedOffAt'
    | 'deliveredAt'
    | 'providerMessageId'
    | 'lastError'
  >
>;

const TRANSITION_COLUMNS: Record<keyof NotificationDeliveryTransition, string> =
  {
    messageId: 'message_id',
    status: 'status',
    attempts: 'attempts',
    nextAttemptAt: 'next_attempt_at',
    leaseToken: 'lease_token',
    leaseExpiresAt: 'lease_expires_at',
    handedOffAt: 'handed_off_at',
    deliveredAt: 'delivered_at',
    providerMessageId: 'provider_message_id',
    lastError: 'last_error',
  };

/**
 * One durable, source-keyed notification delivery to one person over one
 * external channel (the outbox row behind `NotificationOutboxService`).
 *
 * `sourceRef` is the idempotency key: one row per
 * `(tenant, recipient, channel, sourceRef)` (the conflict identity), and that
 * row produces at most one outbound `Message`. The recipient address is a
 * snapshot taken from the host's recipient resolver at enqueue time, never a
 * caller-chosen address.
 *
 * Every state change after creation goes through {@link transition}, a
 * compare-and-set on `stateVersion`, so concurrent dispatchers cannot both
 * hold the lease or overwrite each other's outcome. Generated REST/MCP/CLI
 * are off: rows carry recipient addresses and are reached only through the
 * service.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'notification_deliveries',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['tenant_id', 'recipient_user_id', 'channel', 'source_ref'],
  indexes: [
    {
      name: 'notification_deliveries_due_idx',
      columns: ['status', 'nextAttemptAt'],
    },
    {
      name: 'notification_deliveries_lease_idx',
      columns: ['status', 'leaseExpiresAt'],
    },
  ],
})
export class NotificationDelivery extends SmrtObject {
  @tenantId()
  tenantId = '';

  /** The person being told (`smrt-users:User`, uuid). */
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  recipientUserId = '';

  /** Delivery channel; only `email` today. */
  @field({ required: true })
  channel: NotificationDeliveryChannel = 'email';

  /** Idempotency key for the underlying event (see class docs). */
  @field({ required: true })
  sourceRef = '';

  /** Host-defined type, e.g. `project-question.asked`. */
  @field({ required: true })
  kind = '';

  /** Email subject line. */
  @field({ required: true })
  subject = '';

  /** Plain-text body; the deep link is appended on its own line. */
  @field({ required: true })
  textBody = '';

  /** Absolute deep link on the host's configured origin (no credentials). */
  @field({ required: true })
  href = '';

  /** Address snapshot from the host recipient resolver. */
  @field({ required: true })
  recipientAddress = '';

  /** Display name snapshot from the host recipient resolver. */
  recipientName = '';

  /** Sender `EmailAccount` in the same tenant. */
  @foreignKey('Account')
  accountId = '';

  /** The single outbound `Message` (created under the first lease). */
  @foreignKey('Message')
  messageId: string | null = null;

  status: NotificationDeliveryStatus = 'pending';

  /** Compare-and-set counter; bumped by every transition. */
  stateVersion = 0;

  /** Unique id of the transition that wrote the current state. */
  transitionId = '';

  /** Leases acquired so far (provider handoffs are a subset). */
  attempts = 0;

  /** Lease budget before the delivery fails for good. */
  maxAttempts = 5;

  /** Earliest time a dispatcher may lease a `pending` row. */
  nextAttemptAt = new Date();

  /** Proof of the current lease holder; cleared when the lease ends. */
  leaseToken: string | null = null;

  /** When the current lease lapses and the row becomes recoverable. */
  leaseExpiresAt: Date | null = null;

  /** Set just before the current attempt reaches the provider. */
  handedOffAt: Date | null = null;

  /** When the provider accepted the message. */
  deliveredAt: Date | null = null;

  /** Provider message id, when the provider returns one. */
  providerMessageId = '';

  /** The latest failure or uncertainty reason. */
  lastError = '';

  constructor(options: NotificationDeliveryOptions = {}) {
    super(options);
    const assign = <K extends keyof NotificationDeliveryOptions>(key: K) => {
      if (options[key] !== undefined) {
        (this as unknown as Record<string, unknown>)[key as string] =
          options[key];
      }
    };
    for (const key of [
      'tenantId',
      'recipientUserId',
      'channel',
      'sourceRef',
      'kind',
      'subject',
      'textBody',
      'href',
      'recipientAddress',
      'recipientName',
      'accountId',
      'messageId',
      'status',
      'stateVersion',
      'transitionId',
      'attempts',
      'maxAttempts',
      'nextAttemptAt',
      'leaseToken',
      'leaseExpiresAt',
      'handedOffAt',
      'deliveredAt',
      'providerMessageId',
      'lastError',
    ] as const) {
      assign(key);
    }
  }

  /** Whether no further automatic work will happen on this row. */
  get isSettled(): boolean {
    return (
      this.status === 'sent' ||
      this.status === 'failed' ||
      this.status === 'cancelled' ||
      this.status === 'uncertain'
    );
  }

  /**
   * Apply `changes` only if the stored row is still at `stateVersion` (and,
   * when `leaseToken` is given, still held by that lease). Returns whether
   * this caller won; on success the instance reflects the stored row.
   *
   * PostgreSQL and remote LibSQL evaluate the guard in one conditional
   * UPDATE; local embedded engines use the process write queue, matching
   * `Message.send()`'s claim. The durable row is re-read either way, and the
   * write is recognised by its unique `transitionId`, because DuckDB's update
   * result over-reports affected rows.
   */
  async transition(
    changes: NotificationDeliveryTransition,
    expected: { leaseToken?: string } = {},
  ): Promise<boolean> {
    if (!this.id) throw new Error('Cannot transition an unsaved delivery.');
    const fromVersion = this.stateVersion;
    const nextVersion = fromVersion + 1;
    const transitionId = crypto.randomUUID();
    const values: Record<string, unknown> = {
      state_version: nextVersion,
      transition_id: transitionId,
      updated_at: new Date(),
    };
    for (const [key, value] of Object.entries(changes)) {
      const column =
        TRANSITION_COLUMNS[key as keyof NotificationDeliveryTransition];
      if (!column) throw new Error(`'${key}' is not a transition field.`);
      values[column] = value;
    }

    const matches = (row: Record<string, unknown> | null) =>
      row !== null &&
      Number(row.state_version) === fromVersion &&
      (expected.leaseToken === undefined ||
        row.lease_token === expected.leaseToken);

    const useEmbeddedFallback = usesEmbeddedRevisionFallback(this.db);
    await withEmbeddedWriteQueue(this.db, useEmbeddedFallback, async () => {
      if (useEmbeddedFallback) {
        const current = await this.getCanonicalPersistedRow({ id: this.id });
        if (!matches(current)) return;
        await this.db.upsert(this.tableName, ['id'], {
          ...current,
          ...values,
        });
        return;
      }
      await this.db.update(
        this.tableName,
        {
          id: this.id,
          tenant_id: this.tenantId,
          state_version: fromVersion,
          ...(expected.leaseToken === undefined
            ? {}
            : { lease_token: expected.leaseToken }),
        },
        values,
      );
    });

    const verified = await this.getCanonicalPersistedRow({ id: this.id });
    // The transition id, not the version, proves this caller's write won:
    // a losing caller would see the winner's identical next version.
    if (!verified || verified.transition_id !== transitionId) return false;
    await this.completePersistedUpdate(verified);
    return true;
  }
}
