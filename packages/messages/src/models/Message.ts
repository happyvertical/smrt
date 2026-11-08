import type { SmrtSaveOptions } from '@happyvertical/smrt-core';
import {
  assertProtectedNotificationDelete,
  assertProtectedNotificationRetry,
  assertProtectedNotificationSave,
  assertProtectedSenderHandoff,
  beginProtectedNotificationSend,
  ProtectedNotificationHandoffError,
  rememberNotificationOrigin,
} from '../protected-notification-handoff.js';
/**
 * Message model - Base class for all message types (STI)
 *
 * Common fields shared across email, tweets, slack messages, etc.
 */

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
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy/decorators';
import type {
  MessageOptions,
  MessageSendResult,
  SendMessageOptions,
  SendStatus,
} from '../types';

/** `metadata` key recording that the last failed send may have been accepted. */
export const SEND_OUTCOME_UNKNOWN_METADATA_KEY = 'sendOutcomeUnknown';

/**
 * The stored metadata JSON with the outcome-unknown marker set or cleared, or
 * undefined when it needs no change (or is not a JSON object to edit).
 */
function withSendOutcomeMarker(
  stored: unknown,
  outcomeUnknown: boolean,
): string | undefined {
  let bag: Record<string, unknown> = {};
  if (typeof stored === 'string' && stored.trim()) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
      }
      bag = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (Boolean(bag[SEND_OUTCOME_UNKNOWN_METADATA_KEY]) === outcomeUnknown) {
    return undefined;
  }
  if (outcomeUnknown) bag[SEND_OUTCOME_UNKNOWN_METADATA_KEY] = true;
  else delete bag[SEND_OUTCOME_UNKNOWN_METADATA_KEY];
  return JSON.stringify(bag);
}

// Only the canonical send/retry implementation can authorize its exact local
// lifecycle save. An active provider scope never grants arbitrary public saves.
const lifecycleSaves = new WeakMap<Message, string>();
function lifecycleSignature(message: Message): string {
  return JSON.stringify([
    message.sendStatus,
    message.retryCount,
    message.maxRetries,
    message.sendError,
    message.sentAt,
    message.scheduledSendAt,
    message.metadata,
  ]);
}
async function saveSendLifecycle(message: Message): Promise<void> {
  lifecycleSaves.set(message, lifecycleSignature(message));
  try {
    await message.save();
  } finally {
    lifecycleSaves.delete(message);
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Message extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Account')
  @field({
    description: 'The connected account used to receive or send this message.',
  })
  accountId = '';
  @crossPackageRef('@happyvertical/smrt-personas:AgentPersona', {
    nullable: true,
  })
  @field({
    description:
      'The assistant identity associated with this message, when one was used.',
  })
  personaId: string | null = null;
  @foreignKey('MessagingEndpoint')
  @field({ description: 'The saved destination used to deliver this message.' })
  endpointId: string | null = null;
  @field({
    description:
      'A tracking reference that connects this message to related activity.',
  })
  correlationId = '';
  @field({ description: 'The conversation this message belongs to.' })
  threadId = '';
  @field({ description: 'The subject shown in the message list.' })
  subject = '';
  @field({ description: 'The message content in plain text.' })
  body = ''; // Normalized plain text
  @field({ description: 'The address the message was sent from.' })
  fromAddress = '';
  @field({ description: 'The sender name shown beside their address.' })
  fromName = '';
  @field({ description: 'The people or addresses receiving this message.' })
  toAddresses = ''; // JSON array of {address, name}
  @field({ description: 'When the message was sent or received.' })
  date: Date | null = null;
  @field({ description: 'Whether this message has been marked as read.' })
  isRead = false;
  @field({ description: 'Whether this message is flagged for follow-up.' })
  isFlagged = false;
  @field({ description: 'Whether files are attached to this message.' })
  hasAttachments = false;
  @field({ description: 'The size of the message in bytes.' })
  size = 0;
  @field({
    description: 'Additional details supplied by the messaging connection.',
  })
  metadata = ''; // JSON extension bag

  // Send lifecycle fields
  @field({
    description:
      'The latest sending state: draft, sending, sent, or failed. Received mail may also show draft here.',
  })
  sendStatus: SendStatus = 'draft';
  @field({ description: 'When the message was successfully sent.' })
  sentAt: Date | null = null;
  @field({ description: 'The reason the latest send attempt failed.' })
  sendError = '';
  @field({ description: 'How many times delivery has been retried.' })
  retryCount = 0;
  @field({ description: 'The maximum number of delivery retries allowed.' })
  maxRetries = 3;
  @field({ description: 'When this message is scheduled to be sent.' })
  scheduledSendAt: Date | null = null;
  @foreignKey('Message')
  @field({ description: 'The earlier message this one replies to.' })
  inReplyToMessageId = '';

  // Timestamps
  @field({ description: 'When this message was recorded.' })
  createdAt = new Date();
  @field({ description: 'When this message was last changed.' })
  updatedAt = new Date();

  constructor(options: MessageOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.personaId !== undefined) this.personaId = options.personaId;
    if (options.endpointId !== undefined) this.endpointId = options.endpointId;
    if (options.correlationId !== undefined)
      this.correlationId = options.correlationId;
    if (options.threadId !== undefined) this.threadId = options.threadId;
    if (options.subject !== undefined) this.subject = options.subject;
    if (options.body !== undefined) this.body = options.body;
    if (options.fromAddress !== undefined)
      this.fromAddress = options.fromAddress;
    if (options.fromName !== undefined) this.fromName = options.fromName;
    if (options.toAddresses !== undefined)
      this.toAddresses = options.toAddresses;
    if (options.date !== undefined) this.date = options.date || null;
    if (options.isRead !== undefined) this.isRead = options.isRead;
    if (options.isFlagged !== undefined) this.isFlagged = options.isFlagged;
    if (options.hasAttachments !== undefined)
      this.hasAttachments = options.hasAttachments;
    if (options.size !== undefined) this.size = options.size;
    if (options.metadata !== undefined) this.metadata = options.metadata;
    if (options.sendStatus !== undefined) this.sendStatus = options.sendStatus;
    if (options.sentAt !== undefined) this.sentAt = options.sentAt || null;
    if (options.sendError !== undefined) this.sendError = options.sendError;
    if (options.retryCount !== undefined) this.retryCount = options.retryCount;
    if (options.maxRetries !== undefined) this.maxRetries = options.maxRetries;
    if (options.scheduledSendAt !== undefined)
      this.scheduledSendAt = options.scheduledSendAt || null;
    if (options.inReplyToMessageId !== undefined)
      this.inReplyToMessageId = options.inReplyToMessageId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
    rememberNotificationOrigin(this);
  }

  /** Ordinary saves preserve protected outbox provenance and approved content. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    const signature = lifecycleSaves.get(this);
    lifecycleSaves.delete(this);
    return this.withTransaction(async () => {
      const authorized =
        signature !== undefined && signature === lifecycleSignature(this);
      await assertProtectedNotificationSave(this, options, authorized);
      if (signature !== undefined && signature !== lifecycleSignature(this))
        throw new Error('Message lifecycle changed during its guarded save.');
      const result = await super.save(options);
      // Core may adopt a natural-key row that appeared during save. Verify
      // its resulting durable identity before this transaction can commit.
      await assertProtectedNotificationSave(this, options, authorized);
      if (signature !== undefined && signature !== lifecycleSignature(this))
        throw new Error('Message lifecycle changed during its guarded save.');
      rememberNotificationOrigin(this);
      return result;
    });
  }

  /** Protected outbound evidence is retained; ordinary message deletion remains unchanged. */
  override async delete(
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    await assertProtectedNotificationDelete(this);
    return super.delete(options);
  }

  private async finalizeSendLifecycle(
    result: MessageSendResult,
  ): Promise<void> {
    if (!this.id) throw new Error('Cannot finalize an unsaved message send');

    const sendStatus: SendStatus = result.success ? 'sent' : 'failed';
    const sendError = result.success ? '' : (result.error ?? 'Send failed');
    const useEmbeddedFallback = usesEmbeddedRevisionFallback(this.db);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let nextRevision: Date | undefined;
      await withEmbeddedWriteQueue(this.db, useEmbeddedFallback, async () => {
        const current = await this.getCanonicalPersistedRow({ id: this.id });
        if (current?.send_status !== 'sending') return;
        const currentRevision = current.updated_at;
        const currentRevisionMs = new Date(String(currentRevision)).getTime();
        if (!Number.isFinite(currentRevisionMs)) return;
        nextRevision = new Date(Math.max(Date.now(), currentRevisionMs + 1));
        // Record durably whether a failure may still have been accepted, so a
        // later reconciliation can tell it from a definite rejection.
        const metadata = withSendOutcomeMarker(
          current.metadata,
          !result.success && result.outcomeUnknown === true,
        );
        const values = {
          send_status: sendStatus,
          sent_at: result.success ? result.sentAt : null,
          send_error: sendError,
          updated_at: nextRevision,
          ...(metadata === undefined ? {} : { metadata }),
        };
        if (useEmbeddedFallback) {
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
            send_status: 'sending',
            updated_at:
              currentRevision instanceof Date
                ? currentRevision.toISOString()
                : currentRevision,
          },
          values,
        );
      });
      // DuckDB's generic update result reports one affected row even when the
      // predicate matched none. Verify the durable lifecycle value instead of
      // trusting adapter row-count metadata before declaring finalization.
      const verified = await this.getCanonicalPersistedRow({ id: this.id });
      if (verified?.send_status === sendStatus) {
        await this.completePersistedUpdate(verified);
        return;
      }
    }
    throw new Error('Cannot finalize: message revision kept changing');
  }

  /**
   * Get to addresses as parsed array
   */
  getToAddresses(): Array<{ address: string; name?: string }> {
    if (!this.toAddresses) return [];
    try {
      return JSON.parse(this.toAddresses);
    } catch {
      return [];
    }
  }

  /**
   * Set to addresses from array
   */
  setToAddresses(addresses: Array<{ address: string; name?: string }>): void {
    this.toAddresses = JSON.stringify(addresses);
  }

  /**
   * Get metadata as parsed object
   */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Mark message as read
   */
  async markRead(): Promise<void> {
    this.isRead = true;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Mark message as unread
   */
  async markUnread(): Promise<void> {
    this.isRead = false;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Toggle flagged status
   */
  async toggleFlagged(): Promise<void> {
    this.isFlagged = !this.isFlagged;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Check if message is unread
   */
  isUnread(): boolean {
    return !this.isRead;
  }

  /**
   * Get a short preview of the message body
   */
  getPreview(maxLength = 200): string {
    const text = this.body || '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  }

  /**
   * Get the account for this message
   */
  async getAccount() {
    if (!this.accountId) return null;

    const { AccountCollection } = await import(
      '../collections/AccountCollection'
    );
    const collection = await AccountCollection.create(this.options);

    return await collection.get({ id: this.accountId });
  }

  async getEndpoint() {
    if (!this.endpointId) return null;
    const { MessagingEndpointCollection } = await import(
      '../collections/MessagingEndpointCollection.js'
    );
    const collection = await MessagingEndpointCollection.create(this.options);
    return collection.get({ id: this.endpointId });
  }

  /**
   * Get messages in the same thread
   */
  async getThreadMessages(): Promise<Message[]> {
    if (!this.threadId) return [this];

    const { MessageCollection } = await import(
      '../collections/MessageCollection'
    );
    const collection = await MessageCollection.create(this.options);

    return await collection.list({ where: { threadId: this.threadId } });
  }

  /**
   * Get attachments for this message
   */
  async getAttachments() {
    const { AttachmentCollection } = await import(
      '../collections/AttachmentCollection'
    );
    const collection = await AttachmentCollection.create(this.options);

    return await collection.list({ where: { messageId: this.id } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Send Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send this message via its account's sender
   */
  async send(options?: SendMessageOptions): Promise<MessageSendResult> {
    try {
      await beginProtectedNotificationSend(this, options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sentAt: new Date(),
      };
    }
    // Entry guard: a message that is already in flight or delivered must not be
    // sent again. Catches same-instance double-clicks before any work happens.
    if (this.sendStatus === 'sending' || this.sendStatus === 'sent') {
      return {
        success: false,
        error: `Cannot send: message is already '${this.sendStatus}'`,
        sentAt: new Date(),
      };
    }

    // Resolve account
    const account = await this.getAccount();
    if (!account) {
      const result: MessageSendResult = {
        success: false,
        error: 'No account associated with this message',
        sentAt: new Date(),
      };
      this.sendStatus = 'failed';
      this.sendError = result.error ?? '';
      this.updatedAt = new Date();
      await saveSendLifecycle(this);
      return result;
    }

    if (!account.isActive) {
      const result: MessageSendResult = {
        success: false,
        error: 'Messaging account is inactive',
        sentAt: new Date(),
      };
      this.sendStatus = 'failed';
      this.sendError = result.error ?? '';
      this.updatedAt = new Date();
      await saveSendLifecycle(this);
      return result;
    }

    // Get sender from account
    let sender: Awaited<ReturnType<typeof account.createSender>>;
    try {
      sender = await account.createSender();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.sendStatus = 'failed';
      this.sendError = errorMessage;
      this.updatedAt = new Date();
      await saveSendLifecycle(this);
      return {
        success: false,
        error: errorMessage,
        sentAt: new Date(),
      };
    }

    // Claim the send. For a persisted row, do a compare-and-set so only one
    // concurrent sender wins: flip send_status to 'sending' atomically, gated on
    // the status we observed. If no row matched, another sender already claimed
    // it — abort without delivering (prevents duplicate sends). For an unsaved
    // draft there is no row yet, so the in-memory transition + save() (INSERT)
    // serves as the claim.
    const claimFromStatus = this.sendStatus;
    if (this.isPersisted && this.id) {
      const loadedRevision = this.updated_at;
      if (!loadedRevision) {
        return {
          success: false,
          error: 'Cannot send: persisted message has no loaded revision',
          sentAt: new Date(),
        };
      }
      const claimedRevision = new Date(
        Math.max(Date.now(), loadedRevision.getTime() + 1),
      );
      const useEmbeddedFallback = usesEmbeddedRevisionFallback(this.db);
      let claimed = false;
      await withEmbeddedWriteQueue(this.db, useEmbeddedFallback, async () => {
        if (useEmbeddedFallback) {
          const current = await this.getCanonicalPersistedRow({ id: this.id });
          const storedRevision = current?.updated_at;
          const currentRevision =
            storedRevision instanceof Date
              ? storedRevision.getTime()
              : typeof storedRevision === 'string'
                ? Date.parse(storedRevision)
                : Number.NaN;
          if (
            !current ||
            current.send_status !== claimFromStatus ||
            !Number.isFinite(currentRevision) ||
            currentRevision !== loadedRevision.getTime()
          )
            return;
          await this.db.upsert(this.tableName, ['id'], {
            ...current,
            send_status: 'sending',
            updated_at: claimedRevision,
          });
          claimed = true;
          return;
        }
        const claim = await this.db.update(
          this.tableName,
          {
            id: this.id,
            send_status: claimFromStatus,
            updated_at: loadedRevision.toISOString(),
          },
          { send_status: 'sending', updated_at: claimedRevision },
        );
        claimed = claim?.affected === 1;
      });
      if (!claimed) {
        return {
          success: false,
          error: 'Cannot send: message is already being sent',
          sentAt: new Date(),
        };
      }
      this.sendStatus = 'sending';
      this.updated_at = claimedRevision;
      this.updatedAt = new Date();
    } else {
      this.sendStatus = 'sending';
      this.updatedAt = new Date();
      await saveSendLifecycle(this);
    }

    let result: MessageSendResult;
    try {
      await assertProtectedSenderHandoff(this, options);
      result = await sender.send(this, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // A sender that throws mid-send says nothing about provider acceptance.
      result = {
        success: false,
        error: errorMessage,
        ...(error instanceof ProtectedNotificationHandoffError
          ? {}
          : { outcomeUnknown: true }),
        sentAt: new Date(),
      };
    }
    await this.finalizeSendLifecycle(result);
    return result;
  }

  /**
   * Whether the latest failed send may still have been accepted by the
   * provider (see `MessageSendResult.outcomeUnknown`).
   */
  isSendOutcomeUnknown(): boolean {
    return (
      this.sendStatus === 'failed' &&
      this.getMetadata()[SEND_OUTCOME_UNKNOWN_METADATA_KEY] === true
    );
  }

  /**
   * Release a send claim whose sender is gone (a crash or lost lease left the
   * row in `sending`): move it to `failed` with an unknown outcome so the
   * owner of the delivery decision can send it again. Returns false, changing
   * nothing, unless the stored row is still `sending`. Only for callers that
   * have established that no live sender holds the claim.
   */
  async abandonSendAttempt(reason: string): Promise<boolean> {
    if (!this.id) return false;
    const current = await this.getCanonicalPersistedRow({ id: this.id });
    if (current?.send_status !== 'sending') return false;
    try {
      await this.finalizeSendLifecycle({
        success: false,
        error: reason,
        outcomeUnknown: true,
        sentAt: new Date(),
      });
    } catch {
      return false;
    }
    return this.sendStatus === 'failed';
  }

  /**
   * Retry sending a failed message
   */
  async retrySend(options?: SendMessageOptions): Promise<MessageSendResult> {
    try {
      await assertProtectedNotificationRetry(this, options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sentAt: new Date(),
      };
    }
    if (this.sendStatus !== 'failed') {
      return {
        success: false,
        error: `Cannot retry: message status is '${this.sendStatus}', expected 'failed'`,
        sentAt: new Date(),
      };
    }

    if (this.retryCount >= this.maxRetries) {
      return {
        success: false,
        error: `Retry budget exhausted (${this.retryCount}/${this.maxRetries})`,
        sentAt: new Date(),
      };
    }

    this.retryCount++;
    this.updatedAt = new Date();
    await saveSendLifecycle(this);

    return this.send(options);
  }

  /**
   * Options for a derived draft (reply/forward) built from this message. Carries
   * the DB connection + tenant context from `this.options`, but strips this
   * message's own identity fields. When this message was hydrated from the DB,
   * `this.options` holds the row's `id`/`slug`/`context`/`_skipLoad`; spreading
   * those into a new draft would make `draft.save()` upsert onto the natural-key
   * conflict columns (`slug`/`context`/`_meta_type`) and overwrite the ORIGINAL
   * message instead of inserting a new row. See EmailAccount.childOptions().
   */
  protected draftOptions(): Record<string, unknown> {
    const rest = { ...(this.options as Record<string, unknown>) };
    delete rest.id;
    delete rest.slug;
    delete rest.context;
    delete rest._skipLoad;
    return rest;
  }

  /**
   * Create a reply to this message (returns unsaved draft)
   */
  createReply(_options?: { replyAll?: boolean }): Message {
    const reply = new (this.constructor as typeof Message)({
      ...this.draftOptions(),
      id: undefined,
      accountId: this.accountId,
      threadId: this.threadId || this.id || '',
      subject: this.subject.startsWith('Re:')
        ? this.subject
        : `Re: ${this.subject}`,
      toAddresses: JSON.stringify([
        { address: this.fromAddress, name: this.fromName },
      ]),
      fromAddress: '',
      fromName: '',
      body: this.buildQuotedBody(),
      inReplyToMessageId: this.id || '',
      sendStatus: 'draft',
      isRead: true,
      date: null,
      createdAt: undefined,
      updatedAt: undefined,
    });

    return reply;
  }

  /**
   * Create a forward of this message (returns unsaved draft)
   */
  createForward(): Message {
    const forward = new (this.constructor as typeof Message)({
      ...this.draftOptions(),
      id: undefined,
      accountId: this.accountId,
      threadId: '',
      subject: this.subject.startsWith('Fwd:')
        ? this.subject
        : `Fwd: ${this.subject}`,
      toAddresses: '[]',
      fromAddress: '',
      fromName: '',
      body: this.buildQuotedBody(),
      hasAttachments: this.hasAttachments,
      inReplyToMessageId: '',
      sendStatus: 'draft',
      isRead: true,
      date: null,
      createdAt: undefined,
      updatedAt: undefined,
    });

    return forward;
  }

  /**
   * Build quoted body for reply/forward
   */
  protected buildQuotedBody(): string {
    const dateStr = this.date ? this.date.toLocaleString() : 'unknown date';
    const from = this.fromName
      ? `${this.fromName} <${this.fromAddress}>`
      : this.fromAddress;

    const quotedLines = (this.body || '')
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');

    return `\n\nOn ${dateStr}, ${from} wrote:\n${quotedLines}`;
  }
}
