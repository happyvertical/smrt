import { SmrtCollection } from '@happyvertical/smrt-core';
import { ChatMessage } from '../models/ChatMessage.js';
import type { ChatMessageSearchFilters } from '../types.js';

export class ChatMessageCollection extends SmrtCollection<ChatMessage> {
  static readonly _itemClass = ChatMessage;

  /**
   * Get messages for a room (newest first), excluding threads and deleted.
   *
   * Filtering, ordering and pagination are pushed into SQL rather than loading
   * the full room history into memory (S5 #1392, DoS hardening). Thread replies
   * are excluded via `threadId IS NULL` (the WHERE API maps a `null` value to
   * `IS NULL`).
   */
  async getByRoom(
    roomId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ChatMessage[]> {
    const where: Record<string, unknown> = {
      roomId,
      isDeleted: false,
      threadId: null,
    };

    // Cursor-based pagination: only messages older than the cursor message.
    if (options?.before) {
      const cursorMsg = await this.get({ id: options.before });
      if (cursorMsg?.created_at) {
        where['created_at <'] = cursorMsg.created_at;
      }
    }

    return this.list({
      where,
      orderBy: 'created_at DESC',
      limit: options?.limit,
    });
  }

  /** Get messages in a thread */
  async getByThread(threadId: string): Promise<ChatMessage[]> {
    return this.list({ where: { threadId, isDeleted: false } });
  }

  /** Get messages for an agent session */
  async getByAgentSession(agentSessionId: string): Promise<ChatMessage[]> {
    return this.list({ where: { agentSessionId, isDeleted: false } });
  }

  /**
   * Search messages with filters.
   *
   * All structural filters (room/thread/sender/type/role/date/text) are pushed
   * into SQL instead of loading the full message set and filtering in JS
   * (S5 #1392, DoS hardening). `hasAttachments` remains a post-filter since it
   * is a computed property on the model rather than a stored column.
   */
  async search(
    filters: ChatMessageSearchFilters & { limit?: number },
  ): Promise<ChatMessage[]> {
    const where: Record<string, unknown> = { isDeleted: false };
    if (filters.roomId) where.roomId = filters.roomId;
    if (filters.threadId) where.threadId = filters.threadId;
    if (filters.senderProfileId)
      where.senderProfileId = filters.senderProfileId;
    if (filters.messageType) where.messageType = filters.messageType;
    if (filters.role) where.role = filters.role;
    if (filters.query) where['content like'] = `%${filters.query}%`;
    if (filters.sinceDate) where['created_at >='] = filters.sinceDate;
    if (filters.beforeDate) where['created_at <'] = filters.beforeDate;

    let messages = await this.list({
      where,
      orderBy: 'created_at DESC',
      limit: filters.limit ?? 100,
    });

    if (filters.hasAttachments !== undefined) {
      messages = messages.filter(
        (m) => m.hasAttachments() === filters.hasAttachments,
      );
    }

    return messages;
  }

  /**
   * Get unread count for a participant in a room (excludes thread replies).
   *
   * Counting is pushed into SQL via `count()` rather than loading the whole
   * room history into memory (S5 #1392, DoS hardening).
   */
  async getUnreadCount(
    roomId: string,
    lastReadMessageId: string | null,
  ): Promise<number> {
    const base = { roomId, isDeleted: false, threadId: null };

    if (!lastReadMessageId) return this.count({ where: base });

    const lastReadMsg = await this.get({ id: lastReadMessageId });
    if (!lastReadMsg?.created_at) return this.count({ where: base });

    return this.count({
      where: { ...base, 'created_at >': lastReadMsg.created_at },
    });
  }

  /**
   * Get most recent root message for each room (for room list preview).
   *
   * Each room is fetched with `orderBy created_at DESC, limit 1` so we never
   * load the full per-room history into memory (S5 #1392, DoS hardening).
   */
  async getLatestPerRoom(roomIds: string[]): Promise<Map<string, ChatMessage>> {
    const result = new Map<string, ChatMessage>();
    for (const roomId of roomIds) {
      const latest = await this.list({
        where: { roomId, isDeleted: false, threadId: null },
        orderBy: 'created_at DESC',
        limit: 1,
      });
      if (latest.length > 0) {
        result.set(roomId, latest[0]);
      }
    }
    return result;
  }
}
