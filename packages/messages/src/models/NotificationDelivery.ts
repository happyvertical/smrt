import type {
  SmrtObjectOptions,
  SmrtSaveOptions,
} from '@happyvertical/smrt-core';
import { isDeepStrictEqual } from '../host.js';
import { assertNotificationRecipientIdentity } from '../notification-recipient-identity.js';
// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import {
  type CollectionInterceptor,
  crossPackageRef,
  field,
  foreignKey,
  GlobalInterceptors,
  SmrtObject,
  smrt,
  usesEmbeddedRevisionFallback,
  withEmbeddedWriteQueue,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy/decorators';

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
  recipientUserId?: string | null;
  recipientProfileId?: string | null;
  recipientKind?: 'user' | 'profile';
  channel?: NotificationDeliveryChannel;
  sourceRef?: string;
  kind?: string;
  requiredDispatchPolicy?: string;
  dispatchPolicyBinding?: string;
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

// Private owning-policy snapshots reach Core's final INSERT/UPDATE predicate.
// An unnamed interceptor is retained by reference: reloaded module instances
// cannot replace another active save's lexical WeakMap with a fresh empty map.
const saveGuards = new WeakMap<SmrtObject, Record<string, unknown>>();
const activeSaves = new WeakSet<SmrtObject>();
const saveGuardInterceptor: CollectionInterceptor = {
  writeGuard: (instance) => saveGuards.get(instance),
  bulkMutation: {
    compatible: (className) =>
      className !== 'NotificationDelivery' &&
      className !== '@happyvertical/smrt-messages:NotificationDelivery',
  },
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
  conflictColumns: [
    'tenant_id',
    'recipient_kind',
    'recipient_user_id',
    'recipient_profile_id',
    'channel',
    'source_ref',
  ],
  indexes: [
    {
      name: 'notification_deliveries_user_identity',
      columns: ['tenantId', 'recipientUserId', 'channel', 'sourceRef'],
      unique: true,
    },
    {
      name: 'notification_deliveries_profile_identity',
      columns: ['tenantId', 'recipientProfileId', 'channel', 'sourceRef'],
      unique: true,
    },
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
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  recipientUserId: string | null = null;

  /** Stable external contact identity; never a fabricated auth account. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  recipientProfileId: string | null = null;

  /**
   * Exactly one of `recipientUserId` and `recipientProfileId` is set, and this
   * says which. Neither column is required alone: the either/or rule is a
   * cross-field check (`assertNotificationRecipientIdentity`, run on every
   * save). Legacy rows remain users.
   */
  @field({ required: true, requiredFor: 'identity' })
  recipientKind: 'user' | 'profile' = 'user';

  /** Delivery channel; only `email` today. */
  @field({ required: true, requiredFor: 'identity' })
  channel: NotificationDeliveryChannel = 'email';

  /** Idempotency key for the underlying event (see class docs). */
  @field({ required: true, requiredFor: 'idempotency' })
  sourceRef = '';

  /** Host-defined type, e.g. `project-question.asked`. */
  @field({ required: true, requiredFor: 'identity' })
  kind = '';

  /** Trusted host policy required at every provider handoff; empty is legacy ordinary mail. */
  requiredDispatchPolicy = '';

  /** Immutable host-approved resource/version/digest binding, serialized JSON. */
  @field({ type: 'json' })
  dispatchPolicyBinding = '{}';

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
  @field({ required: true, requiredFor: 'identity' })
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
      'recipientProfileId',
      'recipientKind',
      'channel',
      'sourceRef',
      'kind',
      'requiredDispatchPolicy',
      'dispatchPolicyBinding',
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

  /** Protected consent and document bindings cannot be downgraded by ordinary saves. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (activeSaves.has(this))
      throw new Error(
        'Concurrent saves of one notification delivery are not supported.',
      );
    activeSaves.add(this);
    try {
      return await this.saveWithGuard(options);
    } finally {
      saveGuards.delete(this);
      activeSaves.delete(this);
    }
  }

  private async saveWithGuard(options?: SmrtSaveOptions): Promise<this> {
    assertNotificationRecipientIdentity(this);

    if (
      this.kind.startsWith('protected:') &&
      (!this.requiredDispatchPolicy ||
        this.kind !== `protected:${this.requiredDispatchPolicy}`)
    ) {
      throw new Error(
        'Protected notification kinds require their exact dispatch policy.',
      );
    }
    // Use Core's existing missing-schema contract before any protection query.
    // Initialization defers table verification and must not load over patches.
    await this.verifyStorageReady();
    let stored: Record<string, unknown> | undefined;
    if (this.id) {
      const { rows } = await this.db.query(
        'SELECT tenant_id, required_dispatch_policy, dispatch_policy_binding, source_ref, recipient_user_id, recipient_profile_id, recipient_kind, recipient_address, account_id, kind, subject, text_body, href, recipient_name, channel, status, state_version, transition_id, attempts, max_attempts, next_attempt_at, lease_token, lease_expires_at, handed_off_at, delivered_at, provider_message_id, last_error, message_id FROM notification_deliveries WHERE id = ?',
        this.id,
      );
      stored = rows[0] as Record<string, unknown> | undefined;
    }
    if (!stored) {
      // A new-ID clone can still upsert the same natural identity. Authorize against that row too.
      const existing = await this.db.query(
        'SELECT * FROM notification_deliveries WHERE tenant_id=? AND recipient_kind=? AND recipient_user_id IS NOT DISTINCT FROM ? AND recipient_profile_id IS NOT DISTINCT FROM ? AND channel=? AND source_ref=?',
        this.tenantId,
        this.recipientKind,
        this.recipientUserId,
        this.recipientProfileId,
        this.channel,
        this.sourceRef,
      );
      stored = existing.rows[0] as Record<string, unknown> | undefined;
    }
    if (
      stored &&
      (stored.required_dispatch_policy || this.requiredDispatchPolicy)
    ) {
      const binding = (value: unknown) =>
        typeof value === 'string' ? JSON.parse(value) : value;
      const instant = (value: unknown) =>
        value == null ? null : new Date(value as string | Date).getTime();
      if (
        stored.status !== this.status ||
        Number(stored.state_version) !== this.stateVersion ||
        stored.transition_id !== this.transitionId ||
        Number(stored.attempts) !== this.attempts ||
        Number(stored.max_attempts) !== this.maxAttempts ||
        stored.lease_token !== this.leaseToken ||
        stored.message_id !== this.messageId ||
        stored.provider_message_id !== this.providerMessageId ||
        stored.last_error !== this.lastError ||
        instant(stored.next_attempt_at) !== instant(this.nextAttemptAt) ||
        instant(stored.lease_expires_at) !== instant(this.leaseExpiresAt) ||
        instant(stored.handed_off_at) !== instant(this.handedOffAt) ||
        instant(stored.delivered_at) !== instant(this.deliveredAt)
      ) {
        throw new Error(
          'Protected notification lifecycle changes require a guarded transition.',
        );
      }

      if (
        stored.tenant_id !== this.tenantId ||
        stored.required_dispatch_policy !== this.requiredDispatchPolicy ||
        !isDeepStrictEqual(
          binding(stored.dispatch_policy_binding),
          binding(this.dispatchPolicyBinding),
        ) ||
        stored.source_ref !== this.sourceRef ||
        stored.recipient_user_id !== this.recipientUserId ||
        stored.recipient_profile_id !== this.recipientProfileId ||
        stored.recipient_kind !== this.recipientKind ||
        stored.recipient_address !== this.recipientAddress ||
        stored.account_id !== this.accountId ||
        stored.channel !== this.channel ||
        stored.recipient_name !== this.recipientName ||
        stored.kind !== this.kind ||
        stored.subject !== this.subject ||
        stored.text_body !== this.textBody ||
        stored.href !== this.href
      ) {
        throw new Error(
          'Protected notification consent and dispatch policy are immutable.',
        );
      }
    }
    const guard =
      stored?.required_dispatch_policy || this.requiredDispatchPolicy
        ? Object.fromEntries(
            [
              'tenant_id',
              'required_dispatch_policy',
              'dispatch_policy_binding',
              'source_ref',
              'recipient_user_id',
              'recipient_profile_id',
              'recipient_kind',
              'recipient_address',
              'recipient_name',
              'account_id',
              'kind',
              'channel',
              'subject',
              'text_body',
              'href',
              'status',
              'state_version',
              'transition_id',
              'attempts',
              'max_attempts',
              'lease_token',
              'message_id',
              'provider_message_id',
              'last_error',
            ].map((column) => [
              column,
              stored
                ? stored[column]
                : (this as unknown as Record<string, unknown>)[
                    column.replace(/_([a-z])/g, (_, letter: string) =>
                      letter.toUpperCase(),
                    )
                  ],
            ]),
          )
        : {
            // Bind the observed legacy NULL exactly; a new ordinary row uses ''.
            required_dispatch_policy: stored
              ? stored.required_dispatch_policy
              : '',
            kind: stored ? stored.kind : this.kind,
          };
    if (!stored && this.requiredDispatchPolicy) this.requireInsertOnSave();
    saveGuards.set(this, guard);
    if (!GlobalInterceptors.getAll().includes(saveGuardInterceptor))
      GlobalInterceptors.register(saveGuardInterceptor);
    // Core preserves supplied options/revision guards and applies this mandatory
    // predicate at the final write. State/version covers lifecycle dates without
    // comparing lossy hydrated PostgreSQL timestamps.
    return super.save(options);
  }

  /** Protected history must survive mutable caller flags and uncertain outcomes. */
  override async delete(): Promise<void> {
    const stored = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (
      stored?.required_dispatch_policy ||
      String(stored?.kind ?? '').startsWith('protected:')
    )
      throw new Error(
        'Protected notification delivery history cannot be deleted.',
      );
    return super.delete();
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
