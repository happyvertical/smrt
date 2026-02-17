/**
 * MessageCollection - Unified collection for polymorphic message queries
 *
 * Queries the messages table with STI, returning correct subclass instances.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Message } from '../models/Message';
import type { MessageSearchFilters } from '../types';

export class MessageCollection extends SmrtCollection<Message> {
  static readonly _itemClass = Message;

  /**
   * Search messages with filters
   */
  async search(
    query: string,
    filters?: MessageSearchFilters,
  ): Promise<Message[]> {
    let messages = await this.list({});

    // Filter by query
    if (query) {
      const lowerQuery = query.toLowerCase();
      messages = messages.filter(
        (m) =>
          m.subject?.toLowerCase().includes(lowerQuery) ||
          m.body?.toLowerCase().includes(lowerQuery) ||
          m.fromAddress?.toLowerCase().includes(lowerQuery) ||
          m.fromName?.toLowerCase().includes(lowerQuery),
      );
    }

    // Apply filters
    if (filters) {
      if (filters.accountIds && filters.accountIds.length > 0) {
        messages = messages.filter((m) =>
          filters.accountIds?.includes(m.accountId),
        );
      }
      if (filters.messageType) {
        messages = messages.filter((m) => {
          const metaType = (m as any)._meta_type || '';
          return metaType.includes(filters.messageType as string);
        });
      }
      if (filters.from) {
        const fromLower = filters.from.toLowerCase();
        messages = messages.filter(
          (m) =>
            m.fromAddress?.toLowerCase().includes(fromLower) ||
            m.fromName?.toLowerCase().includes(fromLower),
        );
      }
      if (filters.to) {
        const toLower = filters.to.toLowerCase();
        messages = messages.filter((m) =>
          m.toAddresses?.toLowerCase().includes(toLower),
        );
      }
      if (filters.isRead !== undefined) {
        messages = messages.filter((m) => m.isRead === filters.isRead);
      }
      if (filters.isFlagged !== undefined) {
        messages = messages.filter((m) => m.isFlagged === filters.isFlagged);
      }
      if (filters.sinceDate) {
        messages = messages.filter(
          (m) => m.date && m.date >= (filters.sinceDate as Date),
        );
      }
      if (filters.beforeDate) {
        messages = messages.filter(
          (m) => m.date && m.date < (filters.beforeDate as Date),
        );
      }
      if (filters.query) {
        const q = filters.query.toLowerCase();
        messages = messages.filter(
          (m) =>
            m.subject?.toLowerCase().includes(q) ||
            m.body?.toLowerCase().includes(q),
        );
      }
    }

    return messages;
  }

  /**
   * Get messages by multiple accounts
   */
  async getByAccounts(accountIds: string[]): Promise<Message[]> {
    const allMessages = await this.list({});
    return allMessages.filter((m) => accountIds.includes(m.accountId));
  }

  /**
   * Get messages by STI type
   */
  async getByType(messageType: string): Promise<Message[]> {
    return await this.list({ where: { _meta_type: messageType } });
  }

  /**
   * Get unread messages
   */
  async getUnread(accountId?: string): Promise<Message[]> {
    const where: Record<string, any> = { isRead: false };
    if (accountId) {
      where.accountId = accountId;
    }
    return await this.list({ where });
  }

  /**
   * Get flagged messages
   */
  async getFlagged(accountId?: string): Promise<Message[]> {
    const where: Record<string, any> = { isFlagged: true };
    if (accountId) {
      where.accountId = accountId;
    }
    return await this.list({ where });
  }

  /**
   * Get recent messages
   */
  async getRecent(limit = 20, accountId?: string): Promise<Message[]> {
    const allMessages = await this.list({
      where: accountId ? { accountId } : undefined,
    });

    return allMessages
      .sort((a, b) => {
        const dateA = a.date?.getTime() || 0;
        const dateB = b.date?.getTime() || 0;
        return dateB - dateA;
      })
      .slice(0, limit);
  }

  /**
   * Get messages by thread
   */
  async getByThread(threadId: string): Promise<Message[]> {
    return await this.list({ where: { threadId } });
  }

  /**
   * Mark multiple messages as read
   */
  async markAllRead(messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      const message = await this.get({ id });
      if (message) {
        await message.markRead();
      }
    }
  }

  /**
   * Get message statistics for an account
   */
  async getAccountStats(accountId: string): Promise<{
    total: number;
    unread: number;
    flagged: number;
    byType: Record<string, number>;
  }> {
    const messages = await this.list({ where: { accountId } });
    const byType: Record<string, number> = {};

    for (const msg of messages) {
      const metaType = (msg as any)._meta_type || 'Unknown';
      const shortType = metaType.split(':').pop() || metaType;
      byType[shortType] = (byType[shortType] || 0) + 1;
    }

    return {
      total: messages.length,
      unread: messages.filter((m) => !m.isRead).length,
      flagged: messages.filter((m) => m.isFlagged).length,
      byType,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Send / Draft Queries
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get draft messages
   */
  async getDrafts(accountId?: string): Promise<Message[]> {
    const where: Record<string, any> = { sendStatus: 'draft' };
    if (accountId) where.accountId = accountId;
    return await this.list({ where });
  }

  /**
   * Get sent messages
   */
  async getSent(accountId?: string): Promise<Message[]> {
    const where: Record<string, any> = { sendStatus: 'sent' };
    if (accountId) where.accountId = accountId;
    return await this.list({ where });
  }

  /**
   * Get scheduled messages
   */
  async getScheduled(accountId?: string): Promise<Message[]> {
    const where: Record<string, any> = { sendStatus: 'scheduled' };
    if (accountId) where.accountId = accountId;
    return await this.list({ where });
  }

  /**
   * Get messages that failed to send
   */
  async getFailedSends(accountId?: string): Promise<Message[]> {
    const where: Record<string, any> = { sendStatus: 'failed' };
    if (accountId) where.accountId = accountId;
    return await this.list({ where });
  }

  /**
   * Get outbox (pending + sending + scheduled)
   */
  async getOutbox(accountId?: string): Promise<Message[]> {
    const allMessages = await this.list({
      where: accountId ? { accountId } : undefined,
    });
    return allMessages.filter(
      (m) =>
        m.sendStatus === 'pending' ||
        m.sendStatus === 'sending' ||
        m.sendStatus === 'scheduled',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  async findByTenant(tenantId: string): Promise<Message[]> {
    return this.list({ where: { tenantId } });
  }

  async findGlobal(): Promise<Message[]> {
    return this.list({ where: { tenantId: null } });
  }

  async findWithGlobals(tenantId: string): Promise<Message[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
