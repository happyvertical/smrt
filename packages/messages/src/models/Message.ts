/**
 * Message model - Base class for all message types (STI)
 *
 * Common fields shared across email, tweets, slack messages, etc.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { MessageOptions } from '../types';

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

  accountId = '';
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

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: MessageOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId as any;
    if (options.accountId !== undefined) this.accountId = options.accountId;
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
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
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
  getMetadata(): Record<string, any> {
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
  setMetadata(data: Record<string, any>): void {
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
    const collection = await (AccountCollection as any).create(this.options);

    return await collection.get({ id: this.accountId });
  }

  /**
   * Get messages in the same thread
   */
  async getThreadMessages(): Promise<Message[]> {
    if (!this.threadId) return [this];

    const { MessageCollection } = await import(
      '../collections/MessageCollection'
    );
    const collection = await (MessageCollection as any).create(this.options);

    return await collection.list({ where: { threadId: this.threadId } });
  }

  /**
   * Get attachments for this message
   */
  async getAttachments() {
    const { AttachmentCollection } = await import(
      '../collections/AttachmentCollection'
    );
    const collection = await (AttachmentCollection as any).create(this.options);

    return await collection.list({ where: { messageId: this.id } });
  }
}
