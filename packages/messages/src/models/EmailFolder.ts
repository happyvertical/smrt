/**
 * EmailFolder model - Folder/label tracking
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { EmailFolderOptions } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class EmailFolder extends SmrtObject {
  accountId = '';
  name = '';
  path = '';
  delimiter = '/';
  specialUse = ''; // '\\Inbox', '\\Sent', '\\Drafts', etc.
  messageCount = 0;
  unreadCount = 0;
  subscribed = true;

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: EmailFolderOptions = {}) {
    super(options);

    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.name !== undefined) this.name = options.name;
    if (options.path !== undefined) this.path = options.path;
    if (options.delimiter !== undefined) this.delimiter = options.delimiter;
    if (options.specialUse !== undefined) this.specialUse = options.specialUse;
    if (options.messageCount !== undefined)
      this.messageCount = options.messageCount;
    if (options.unreadCount !== undefined)
      this.unreadCount = options.unreadCount;
    if (options.subscribed !== undefined) this.subscribed = options.subscribed;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
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
   * Get all emails in this folder
   */
  async getEmails(limit?: number) {
    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    const options: Record<string, any> = { where: { folderId: this.id } };
    if (limit) {
      options.limit = limit;
    }

    return await collection.list(options);
  }

  /**
   * Get unread emails in this folder
   */
  async getUnreadEmails(limit?: number) {
    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    const options: Record<string, any> = {
      where: { folderId: this.id, isRead: false },
    };
    if (limit) {
      options.limit = limit;
    }

    return await collection.list(options);
  }

  /**
   * Update message counts from database
   */
  async refreshCounts(): Promise<void> {
    const { EmailCollection } = await import('../collections/EmailCollection');
    const collection = await (EmailCollection as any).create(this.options);

    this.messageCount = await collection.countByFolder(this.id);
    this.unreadCount = await collection.countUnreadByFolder(this.id);
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Check if this is the inbox folder
   */
  isInbox(): boolean {
    return this.specialUse === '\\Inbox' || this.path.toLowerCase() === 'inbox';
  }

  /**
   * Check if this is the sent folder
   */
  isSent(): boolean {
    return this.specialUse === '\\Sent' || this.path.toLowerCase() === 'sent';
  }

  /**
   * Check if this is the drafts folder
   */
  isDrafts(): boolean {
    return (
      this.specialUse === '\\Drafts' || this.path.toLowerCase() === 'drafts'
    );
  }

  /**
   * Check if this is the trash folder
   */
  isTrash(): boolean {
    return this.specialUse === '\\Trash' || this.path.toLowerCase() === 'trash';
  }

  /**
   * Check if this is the spam/junk folder
   */
  isSpam(): boolean {
    return (
      this.specialUse === '\\Junk' ||
      this.path.toLowerCase() === 'spam' ||
      this.path.toLowerCase() === 'junk'
    );
  }

  /**
   * Check if this is a system folder
   */
  isSystemFolder(): boolean {
    return !!this.specialUse;
  }

  /**
   * Subscribe to folder
   */
  async subscribe(): Promise<void> {
    this.subscribed = true;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Unsubscribe from folder
   */
  async unsubscribe(): Promise<void> {
    this.subscribed = false;
    this.updatedAt = new Date();
    await this.save();
  }
}
