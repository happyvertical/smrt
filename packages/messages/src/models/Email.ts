/**
 * Email model - Email message extending the Message STI base
 *
 * Retains all email-specific fields (RFC 822 compliance, folders, etc.)
 * while inheriting common message fields from Message.
 */

import { smrt } from '@happyvertical/smrt-core';
import type { EmailOptions } from '../types';
import { Message } from './Message';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Email extends Message {
  // RFC 822 fields
  messageId = ''; // RFC 822 Message-ID header
  inReplyTo = '';

  // Additional recipients
  ccAddresses = '';
  bccAddresses = '';
  replyToAddress = '';
  replyToName = '';

  // Email-specific content
  textBody = '';
  htmlBody = '';

  // Location
  folderId = '';
  folderPath = '';
  labels = ''; // JSON array (Gmail)
  flags = ''; // JSON array (IMAP)

  // Email-specific status flags
  isAnswered = false;
  isDraft = false;

  // Raw data
  rawMessage = '';
  headers = ''; // JSON object

  constructor(options: EmailOptions = {}) {
    super(options);

    if (options.messageId !== undefined) this.messageId = options.messageId;
    if (options.inReplyTo !== undefined) this.inReplyTo = options.inReplyTo;
    if (options.ccAddresses !== undefined)
      this.ccAddresses = options.ccAddresses;
    if (options.bccAddresses !== undefined)
      this.bccAddresses = options.bccAddresses;
    if (options.replyToAddress !== undefined)
      this.replyToAddress = options.replyToAddress;
    if (options.replyToName !== undefined)
      this.replyToName = options.replyToName;
    if (options.textBody !== undefined) this.textBody = options.textBody;
    if (options.htmlBody !== undefined) this.htmlBody = options.htmlBody;
    if (options.folderId !== undefined) this.folderId = options.folderId;
    if (options.folderPath !== undefined) this.folderPath = options.folderPath;
    if (options.labels !== undefined) this.labels = options.labels;
    if (options.flags !== undefined) this.flags = options.flags;
    if (options.isAnswered !== undefined) this.isAnswered = options.isAnswered;
    if (options.isDraft !== undefined) this.isDraft = options.isDraft;
    if (options.rawMessage !== undefined) this.rawMessage = options.rawMessage;
    if (options.headers !== undefined) this.headers = options.headers;

    // Populate base body from textBody for unified access
    if (options.textBody && !options.body) {
      this.body = options.textBody;
    }
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
   * Get the email account (typed as EmailAccount)
   */
  override async getAccount() {
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
   * Get emails in the same thread
   */
  async getThreadEmails(): Promise<Email[]> {
    if (!this.threadId) return [this];

    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    return await collection.list({ where: { threadId: this.threadId } });
  }

  /**
   * Get a short preview of the email body
   */
  override getPreview(maxLength = 200): string {
    const body = this.textBody || this.htmlBody?.replace(/<[^>]*>/g, '') || '';
    if (body.length <= maxLength) return body;
    return `${body.slice(0, maxLength)}...`;
  }
}
