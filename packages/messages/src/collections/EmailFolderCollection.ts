/**
 * EmailFolderCollection - Collection manager for EmailFolder objects
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { EmailFolder } from '../models/EmailFolder';
import type { EmailFolderSearchFilters } from '../types';

export class EmailFolderCollection extends SmrtCollection<EmailFolder> {
  static readonly _itemClass = EmailFolder;

  /**
   * Get folder by path for an account
   */
  async getByPath(
    accountId: string,
    path: string,
  ): Promise<EmailFolder | null> {
    const folders = await this.list({ where: { accountId, path } });
    return folders[0] || null;
  }

  /**
   * Get folders by account
   */
  async getByAccount(accountId: string): Promise<EmailFolder[]> {
    return await this.list({ where: { accountId } });
  }

  /**
   * Get inbox folder for an account
   */
  async getInbox(accountId: string): Promise<EmailFolder | null> {
    const folders = await this.getByAccount(accountId);
    return folders.find((f) => f.isInbox()) || null;
  }

  /**
   * Get sent folder for an account
   */
  async getSent(accountId: string): Promise<EmailFolder | null> {
    const folders = await this.getByAccount(accountId);
    return folders.find((f) => f.isSent()) || null;
  }

  /**
   * Get drafts folder for an account
   */
  async getDrafts(accountId: string): Promise<EmailFolder | null> {
    const folders = await this.getByAccount(accountId);
    return folders.find((f) => f.isDrafts()) || null;
  }

  /**
   * Get trash folder for an account
   */
  async getTrash(accountId: string): Promise<EmailFolder | null> {
    const folders = await this.getByAccount(accountId);
    return folders.find((f) => f.isTrash()) || null;
  }

  /**
   * Get spam folder for an account
   */
  async getSpam(accountId: string): Promise<EmailFolder | null> {
    const folders = await this.getByAccount(accountId);
    return folders.find((f) => f.isSpam()) || null;
  }

  /**
   * Get system folders for an account
   */
  async getSystemFolders(accountId: string): Promise<EmailFolder[]> {
    const folders = await this.getByAccount(accountId);
    return folders.filter((f) => f.isSystemFolder());
  }

  /**
   * Get user-created folders for an account
   */
  async getUserFolders(accountId: string): Promise<EmailFolder[]> {
    const folders = await this.getByAccount(accountId);
    return folders.filter((f) => !f.isSystemFolder());
  }

  /**
   * Get subscribed folders
   */
  async getSubscribed(accountId?: string): Promise<EmailFolder[]> {
    const where: Record<string, any> = { subscribed: true };
    if (accountId) {
      where.accountId = accountId;
    }
    return await this.list({ where });
  }

  /**
   * Get folders with unread messages
   */
  async getWithUnread(accountId?: string): Promise<EmailFolder[]> {
    const folders = accountId
      ? await this.getByAccount(accountId)
      : await this.list({});

    return folders.filter((f) => f.unreadCount > 0);
  }

  /**
   * Search folders with filters
   */
  async search(
    query: string,
    filters?: EmailFolderSearchFilters,
  ): Promise<EmailFolder[]> {
    let folders = await this.list({});

    // Filter by query
    if (query) {
      const lowerQuery = query.toLowerCase();
      folders = folders.filter(
        (f) =>
          f.name?.toLowerCase().includes(lowerQuery) ||
          f.path?.toLowerCase().includes(lowerQuery),
      );
    }

    // Apply filters
    if (filters) {
      if (filters.accountId) {
        folders = folders.filter((f) => f.accountId === filters.accountId);
      }
      if (filters.specialUse) {
        folders = folders.filter((f) => f.specialUse === filters.specialUse);
      }
      if (filters.subscribed !== undefined) {
        folders = folders.filter((f) => f.subscribed === filters.subscribed);
      }
    }

    return folders;
  }

  /**
   * Refresh counts for all folders in an account
   */
  async refreshAllCounts(accountId: string): Promise<void> {
    const folders = await this.getByAccount(accountId);

    for (const folder of folders) {
      await folder.refreshCounts();
    }
  }

  /**
   * Get folder statistics for an account
   */
  async getAccountStats(accountId: string): Promise<{
    totalFolders: number;
    totalMessages: number;
    totalUnread: number;
    systemFolders: number;
    userFolders: number;
  }> {
    const folders = await this.getByAccount(accountId);

    return {
      totalFolders: folders.length,
      totalMessages: folders.reduce((sum, f) => sum + f.messageCount, 0),
      totalUnread: folders.reduce((sum, f) => sum + f.unreadCount, 0),
      systemFolders: folders.filter((f) => f.isSystemFolder()).length,
      userFolders: folders.filter((f) => !f.isSystemFolder()).length,
    };
  }

  /**
   * Create standard system folders for an account
   */
  async createSystemFolders(accountId: string): Promise<void> {
    const standardFolders = [
      { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
      { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
      { name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts' },
      { name: 'Trash', path: 'Trash', specialUse: '\\Trash' },
      { name: 'Spam', path: 'Spam', specialUse: '\\Junk' },
    ];

    for (const folderData of standardFolders) {
      const existing = await this.getByPath(accountId, folderData.path);
      if (!existing) {
        // Create through the collection so the DB connection is bound; a bare
        // `new EmailFolder(...)` + save() throws "Database accessed before
        // initialization" under per-instance DB injection.
        const folder = await this.create({
          accountId,
          ...folderData,
        });
        await folder.save();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Find all email folders belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<EmailFolder[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global email folders (no tenant).
   *
   * EmailFolder is @TenantScoped (CTI, own `email_folders` table). Under an
   * active tenant context list({ tenantId: null }) throws and unflagged raw SQL
   * is blocked (#1596); route through the raw helpers.
   */
  async findGlobal(): Promise<EmailFolder[]> {
    return queryGlobal<EmailFolder>(this);
  }

  /**
   * Find email folders for a tenant including global folders.
   */
  async findWithGlobals(tenantId: string): Promise<EmailFolder[]> {
    return queryWithGlobals<EmailFolder>(
      this,
      tenantId,
      'EmailFolder.findWithGlobals',
    );
  }
}
