/**
 * Message model - Base class for all message types (STI)
 *
 * Common fields shared across email, tweets, slack messages, etc.
 */

import {
  crossPackageRef,
  foreignKey,
  recordInstanceChange,
  SmrtObject,
  smrt,
  usesEmbeddedRevisionFallback,
  withEmbeddedWriteQueue,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  MessageOptions,
  MessageSendResult,
  SendMessageOptions,
  SendStatus,
} from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Message extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Account')
  accountId = '';
  @crossPackageRef('@happyvertical/smrt-personas:AgentPersona', {
    nullable: true,
  })
  personaId: string | null = null;
  @foreignKey('MessagingEndpoint')
  endpointId: string | null = null;
  correlationId = '';
  threadId = '';
  subject = '';
  body = ''; // Normalized plain text
  fromAddress = '';
  fromName = '';
  toAddresses = ''; // JSON array of {address, name}
  date: Date | null = null;
  isRead = false;
  isFlagged = false;
  hasAttachments = false;
  size = 0;
  metadata = ''; // JSON extension bag

  // Send lifecycle fields
  sendStatus: SendStatus = 'draft';
  sentAt: Date | null = null;
  sendError = '';
  retryCount = 0;
  maxRetries = 3;
  scheduledSendAt: Date | null = null;
  @foreignKey('Message')
  inReplyToMessageId = '';

  // Timestamps
  createdAt = new Date();
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
        const current = await this.db.get(this.tableName, { id: this.id });
        if (current?.send_status !== 'sending') return;
        const currentRevision = current.updated_at;
        const currentRevisionMs = new Date(String(currentRevision)).getTime();
        if (!Number.isFinite(currentRevisionMs)) return;
        nextRevision = new Date(Math.max(Date.now(), currentRevisionMs + 1));
        const values = {
          send_status: sendStatus,
          sent_at: result.success ? result.sentAt : null,
          send_error: sendError,
          updated_at: nextRevision,
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
      const verified = await this.db.get(this.tableName, { id: this.id });
      if (verified?.send_status === sendStatus) {
        const verifiedRevision = new Date(String(verified.updated_at));
        this.sendStatus = sendStatus;
        this.sentAt = result.success ? result.sentAt : null;
        this.sendError = sendError;
        this.updated_at = Number.isFinite(verifiedRevision.getTime())
          ? verifiedRevision
          : nextRevision;
        this.updatedAt = new Date();
        await recordInstanceChange(this);
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
      await this.save();
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
      await this.save();
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
      await this.save();
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
          const current = await this.db.get(this.tableName, { id: this.id });
          const currentRevision = new Date(
            String(current?.updated_at),
          ).getTime();
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
      await this.save();
    }

    let result: MessageSendResult;
    try {
      result = await sender.send(this, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result = {
        success: false,
        error: errorMessage,
        sentAt: new Date(),
      };
    }
    await this.finalizeSendLifecycle(result);
    return result;
  }

  /**
   * Retry sending a failed message
   */
  async retrySend(options?: SendMessageOptions): Promise<MessageSendResult> {
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
    await this.save();

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
