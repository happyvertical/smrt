/**
 * EmailCollection - Collection manager for Email objects
 *
 * Extends MessageCollection with email-specific query methods.
 * STI framework auto-filters to Email instances.
 */

import { Email } from '../models/Email';
import type { EmailSearchFilters } from '../types';
import { MessageCollection } from './MessageCollection';

export class EmailCollection extends MessageCollection {
  static override readonly _itemClass = Email;

  /**
   * Get email by RFC 822 Message-ID
   */
  async getByMessageId(
    accountId: string,
    messageId: string,
  ): Promise<Email | null> {
    const emails = await this.list({
      where: { accountId, messageId },
      limit: 1,
    });
    return (emails[0] as Email) || null;
  }

  /**
   * Get emails by account
   */
  async getByAccount(accountId: string): Promise<Email[]> {
    return (await this.list({ where: { accountId } })) as Email[];
  }

  /**
   * Get emails by folder
   */
  async getByFolder(folderId: string): Promise<Email[]> {
    return (await this.list({ where: { folderId } })) as Email[];
  }

  /**
   * Get emails by thread
   */
  override async getByThread(threadId: string): Promise<Email[]> {
    return (await this.list({ where: { threadId } })) as Email[];
  }

  /**
   * Get unread emails
   */
  override async getUnread(accountId?: string): Promise<Email[]> {
    const where: Record<string, any> = { isRead: false };
    if (accountId) {
      where.accountId = accountId;
    }
    return (await this.list({ where })) as Email[];
  }

  /**
   * Get flagged emails
   */
  override async getFlagged(accountId?: string): Promise<Email[]> {
    const where: Record<string, any> = { isFlagged: true };
    if (accountId) {
      where.accountId = accountId;
    }
    return (await this.list({ where })) as Email[];
  }

  /**
   * Get emails with attachments
   */
  async getWithAttachments(accountId?: string): Promise<Email[]> {
    const where: Record<string, any> = { hasAttachments: true };
    if (accountId) {
      where.accountId = accountId;
    }
    return (await this.list({ where })) as Email[];
  }

  /**
   * Get recent emails
   */
  override async getRecent(limit = 20, accountId?: string): Promise<Email[]> {
    const allEmails = (await this.list({
      where: accountId ? { accountId } : undefined,
    })) as Email[];

    return allEmails
      .sort((a, b) => {
        const dateA = a.date?.getTime() || 0;
        const dateB = b.date?.getTime() || 0;
        return dateB - dateA;
      })
      .slice(0, limit);
  }

  /**
   * Count emails in a folder
   */
  async countByFolder(folderId: string): Promise<number> {
    const emails = await this.list({ where: { folderId } });
    return emails.length;
  }

  /**
   * Count unread emails in a folder
   */
  async countUnreadByFolder(folderId: string): Promise<number> {
    const emails = await this.list({ where: { folderId, isRead: false } });
    return emails.length;
  }

  /**
   * Count unread emails for an account
   */
  async countUnreadByAccount(accountId: string): Promise<number> {
    const emails = await this.list({ where: { accountId, isRead: false } });
    return emails.length;
  }

  /**
   * Search emails with email-specific filters
   */
  async searchEmails(
    query: string,
    filters?: EmailSearchFilters,
  ): Promise<Email[]> {
    let emails = (await this.list({})) as Email[];

    // Filter by query
    if (query) {
      const lowerQuery = query.toLowerCase();
      emails = emails.filter(
        (e) =>
          e.subject?.toLowerCase().includes(lowerQuery) ||
          e.textBody?.toLowerCase().includes(lowerQuery) ||
          e.fromAddress?.toLowerCase().includes(lowerQuery) ||
          e.fromName?.toLowerCase().includes(lowerQuery),
      );
    }

    // Apply filters
    if (filters) {
      if (filters.accountId) {
        emails = emails.filter((e) => e.accountId === filters.accountId);
      }
      if (filters.folderId) {
        emails = emails.filter((e) => e.folderId === filters.folderId);
      }
      if (filters.threadId) {
        emails = emails.filter((e) => e.threadId === filters.threadId);
      }
      if (filters.from) {
        const fromLower = filters.from.toLowerCase();
        emails = emails.filter(
          (e) =>
            e.fromAddress?.toLowerCase().includes(fromLower) ||
            e.fromName?.toLowerCase().includes(fromLower),
        );
      }
      if (filters.to) {
        const toLower = filters.to.toLowerCase();
        emails = emails.filter((e) =>
          e.toAddresses?.toLowerCase().includes(toLower),
        );
      }
      if (filters.subject) {
        const subjectLower = filters.subject.toLowerCase();
        emails = emails.filter((e) =>
          e.subject?.toLowerCase().includes(subjectLower),
        );
      }
      if (filters.isRead !== undefined) {
        emails = emails.filter((e) => e.isRead === filters.isRead);
      }
      if (filters.isFlagged !== undefined) {
        emails = emails.filter((e) => e.isFlagged === filters.isFlagged);
      }
      if (filters.hasAttachments !== undefined) {
        emails = emails.filter(
          (e) => e.hasAttachments === filters.hasAttachments,
        );
      }
      if (filters.sincDate) {
        emails = emails.filter(
          (e) => e.date && e.date >= (filters.sincDate as Date),
        );
      }
      if (filters.beforeDate) {
        emails = emails.filter(
          (e) => e.date && e.date < (filters.beforeDate as Date),
        );
      }
    }

    return emails;
  }

  /**
   * Mark all emails in a folder as read
   */
  async markFolderRead(folderId: string): Promise<void> {
    const emails = (await this.getUnread()) as Email[];
    const folderEmails = emails.filter((e) => e.folderId === folderId);

    for (const email of folderEmails) {
      await email.markRead();
    }
  }

  /**
   * Delete emails by folder
   */
  async deleteByFolder(folderId: string): Promise<number> {
    const emails = await this.getByFolder(folderId);
    let count = 0;

    for (const email of emails) {
      await email.delete();
      count++;
    }

    return count;
  }

  /**
   * Get email statistics for an account
   */
  override async getAccountStats(accountId: string): Promise<{
    total: number;
    unread: number;
    flagged: number;
    withAttachments: number;
    byType: Record<string, number>;
  }> {
    const emails = await this.getByAccount(accountId);

    return {
      total: emails.length,
      unread: emails.filter((e) => !e.isRead).length,
      flagged: emails.filter((e) => e.isFlagged).length,
      withAttachments: emails.filter((e) => e.hasAttachments).length,
      byType: { Email: emails.length },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  override async findByTenant(tenantId: string): Promise<Email[]> {
    return this.list({ where: { tenantId } }) as Promise<Email[]>;
  }

  override async findGlobal(): Promise<Email[]> {
    return this.list({ where: { tenantId: null } }) as Promise<Email[]>;
  }

  override async findWithGlobals(tenantId: string): Promise<Email[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    ) as Promise<Email[]>;
  }
}
