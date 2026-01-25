/**
 * Email model - Core email message with AI methods
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { EmailOptions } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Email extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId?: string;

  accountId = '';
  messageId = ''; // RFC 822 Message-ID header
  threadId = '';
  inReplyTo = '';

  // Sender
  fromAddress = '';
  fromName = '';

  // Recipients (JSON arrays)
  toAddresses = ''; // JSON array of {address, name}
  ccAddresses = '';
  bccAddresses = '';
  replyToAddress = '';
  replyToName = '';

  // Content
  subject = '';
  date: Date | null = null;
  textBody = '';
  htmlBody = '';

  // Location
  folderId = '';
  folderPath = '';
  labels = ''; // JSON array (Gmail)
  flags = ''; // JSON array (IMAP)

  // Status flags
  isRead = false;
  isFlagged = false;
  isAnswered = false;
  isDraft = false;
  hasAttachments = false;

  // Metadata
  size = 0;
  rawMessage = '';
  headers = ''; // JSON object

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EmailOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId as any;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.messageId !== undefined) this.messageId = options.messageId;
    if (options.threadId !== undefined) this.threadId = options.threadId;
    if (options.inReplyTo !== undefined) this.inReplyTo = options.inReplyTo;
    if (options.fromAddress !== undefined)
      this.fromAddress = options.fromAddress;
    if (options.fromName !== undefined) this.fromName = options.fromName;
    if (options.toAddresses !== undefined)
      this.toAddresses = options.toAddresses;
    if (options.ccAddresses !== undefined)
      this.ccAddresses = options.ccAddresses;
    if (options.bccAddresses !== undefined)
      this.bccAddresses = options.bccAddresses;
    if (options.replyToAddress !== undefined)
      this.replyToAddress = options.replyToAddress;
    if (options.replyToName !== undefined)
      this.replyToName = options.replyToName;
    if (options.subject !== undefined) this.subject = options.subject;
    if (options.date !== undefined) this.date = options.date || null;
    if (options.textBody !== undefined) this.textBody = options.textBody;
    if (options.htmlBody !== undefined) this.htmlBody = options.htmlBody;
    if (options.folderId !== undefined) this.folderId = options.folderId;
    if (options.folderPath !== undefined) this.folderPath = options.folderPath;
    if (options.labels !== undefined) this.labels = options.labels;
    if (options.flags !== undefined) this.flags = options.flags;
    if (options.isRead !== undefined) this.isRead = options.isRead;
    if (options.isFlagged !== undefined) this.isFlagged = options.isFlagged;
    if (options.isAnswered !== undefined) this.isAnswered = options.isAnswered;
    if (options.isDraft !== undefined) this.isDraft = options.isDraft;
    if (options.hasAttachments !== undefined)
      this.hasAttachments = options.hasAttachments;
    if (options.size !== undefined) this.size = options.size;
    if (options.rawMessage !== undefined) this.rawMessage = options.rawMessage;
    if (options.headers !== undefined) this.headers = options.headers;
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
   * Get CC addresses as parsed array
   */
  getCcAddresses(): Array<{ address: string; name?: string }> {
    if (!this.ccAddresses) return [];
    try {
      return JSON.parse(this.ccAddresses);
    } catch {
      return [];
    }
  }

  /**
   * Get BCC addresses as parsed array
   */
  getBccAddresses(): Array<{ address: string; name?: string }> {
    if (!this.bccAddresses) return [];
    try {
      return JSON.parse(this.bccAddresses);
    } catch {
      return [];
    }
  }

  /**
   * Get labels as parsed array
   */
  getLabels(): string[] {
    if (!this.labels) return [];
    try {
      return JSON.parse(this.labels);
    } catch {
      return [];
    }
  }

  /**
   * Set labels from array
   */
  setLabels(labels: string[]): void {
    this.labels = JSON.stringify(labels);
  }

  /**
   * Get flags as parsed array
   */
  getFlags(): string[] {
    if (!this.flags) return [];
    try {
      return JSON.parse(this.flags);
    } catch {
      return [];
    }
  }

  /**
   * Set flags from array
   */
  setFlags(flags: string[]): void {
    this.flags = JSON.stringify(flags);
  }

  /**
   * Get headers as parsed object
   */
  getHeaders(): Record<string, string | string[]> {
    if (!this.headers) return {};
    try {
      return JSON.parse(this.headers);
    } catch {
      return {};
    }
  }

  /**
   * Set headers from object
   */
  setHeaders(headers: Record<string, string | string[]>): void {
    this.headers = JSON.stringify(headers);
  }

  /**
   * Mark email as read
   */
  async markRead(): Promise<void> {
    this.isRead = true;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Mark email as unread
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
   * Get the email account
   */
  async getAccount() {
    if (!this.accountId) return null;

    const { EmailAccountCollection } = await import(
      '../collections/EmailAccountCollection'
    );
    const collection = await (EmailAccountCollection as any).create(
      this.options,
    );

    return await collection.get({ id: this.accountId });
  }

  /**
   * Get the folder
   */
  async getFolder() {
    if (!this.folderId) return null;

    const { EmailFolderCollection } = await import(
      '../collections/EmailFolderCollection'
    );
    const collection = await (EmailFolderCollection as any).create(
      this.options,
    );

    return await collection.get({ id: this.folderId });
  }

  /**
   * Get attachments for this email
   */
  async getAttachments() {
    const { EmailAttachmentCollection } = await import(
      '../collections/EmailAttachmentCollection'
    );
    const collection = await (EmailAttachmentCollection as any).create(
      this.options,
    );

    return await collection.list({ where: { emailId: this.id } });
  }

  /**
   * Get emails in the same thread
   */
  async getThreadEmails(): Promise<Email[]> {
    if (!this.threadId) return [this];

    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    return await collection.list({ where: { threadId: this.threadId } });
  }

  /**
   * Check if email is unread
   */
  isUnread(): boolean {
    return !this.isRead;
  }

  /**
   * Get a short preview of the email body
   */
  getPreview(maxLength = 200): string {
    const body = this.textBody || this.htmlBody?.replace(/<[^>]*>/g, '') || '';
    if (body.length <= maxLength) return body;
    return `${body.slice(0, maxLength)}...`;
  }
}
