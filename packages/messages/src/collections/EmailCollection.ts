/**
 * EmailCollection - Collection manager for Email objects
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Email } from '../models/Email';
import type { EmailSearchFilters } from '../types';

export class EmailCollection extends SmrtCollection<Email> {
  static readonly _itemClass = Email;

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
    return emails[0] || null;
  }

  /**
   * Get emails by account
   */
  async getByAccount(accountId: string): Promise<Email[]> {
    return await this.list({ where: { accountId } });
  }

  /**
   * Get emails by folder
   */
  async getByFolder(folderId: string): Promise<Email[]> {
    return await this.list({ where: { folderId } });
  }

  /**
   * Get emails by thread
   */
  async getByThread(threadId: string): Promise<Email[]> {
    return await this.list({ where: { threadId } });
  }

  /**
   * Get unread emails
   */
  async getUnread(accountId?: string): Promise<Email[]> {
    const where: Record<string, any> = { isRead: false };
    if (accountId) {
      where.accountId = accountId;
    }
    return await this.list({ where });
  }

  /**
   * Get flagged emails
   */
  async getFlagged(accountId?: string): Promise<Email[]> {
    const where: Record<string, any> = { isFlagged: true };
    if (accountId) {
      where.accountId = accountId;
    }
    return await this.list({ where });
  }

  /**
   * Get emails with attachments
   */
  async getWithAttachments(accountId?: string): Promise<Email[]> {
    const where: Record<string, any> = { hasAttachments: true };
    if (accountId) {
      where.accountId = accountId;
    }
    return await this.list({ where });
  }

  /**
   * Get recent emails
   */
  async getRecent(limit = 20, accountId?: string): Promise<Email[]> {
    const allEmails = await this.list({
      where: accountId ? { accountId } : undefined,
    });

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
   * Search emails with filters
   */
  async search(query: string, filters?: EmailSearchFilters): Promise<Email[]> {
    let emails = await this.list({});

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
   * Mark multiple emails as read
   */
  async markAllRead(emailIds: string[]): Promise<void> {
    for (const id of emailIds) {
      const email = await this.get({ id });
      if (email) {
        await email.markRead();
      }
    }
  }

  /**
   * Mark all emails in a folder as read
   */
  async markFolderRead(folderId: string): Promise<void> {
    const emails = await this.getUnread();
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
  async getAccountStats(accountId: string): Promise<{
    total: number;
    unread: number;
    flagged: number;
    withAttachments: number;
  }> {
    const emails = await this.getByAccount(accountId);

    return {
      total: emails.length,
      unread: emails.filter((e) => !e.isRead).length,
      flagged: emails.filter((e) => e.isFlagged).length,
      withAttachments: emails.filter((e) => e.hasAttachments).length,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Find all emails belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<Email[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global emails (no tenant)
   */
  async findGlobal(): Promise<Email[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find emails for a tenant including global emails
   */
  async findWithGlobals(tenantId: string): Promise<Email[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
