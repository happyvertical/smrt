import { SmrtCollection } from '@happyvertical/smrt-core';
import { ChatMessage } from '../models/ChatMessage.js';
import type { ChatMessageSearchFilters } from '../types.js';

export class ChatMessageCollection extends SmrtCollection<ChatMessage> {
  static readonly _itemClass = ChatMessage;

  /** Get messages for a room (newest first), excluding threads and deleted */
  async getByRoom(
    roomId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ChatMessage[]> {
    const messages = await this.list({
      where: { roomId, isDeleted: false },
    });

    // Filter out thread messages (only show root messages in room view)
    let filtered = messages.filter((m) => !m.threadId);

    // Cursor-based pagination: messages before a given ID
    if (options?.before) {
      const cursorMsg = filtered.find((m) => m.id === options.before);
      if (cursorMsg) {
        filtered = filtered.filter(
          (m) =>
            m.id !== cursorMsg.id &&
            new Date(m.created_at ?? 0) < new Date(cursorMsg.created_at ?? 0),
        );
      }
    }

    // Sort newest first
    filtered.sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() -
        new Date(a.created_at ?? 0).getTime(),
    );

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /** Get messages in a thread */
  async getByThread(threadId: string): Promise<ChatMessage[]> {
    return this.list({ where: { threadId, isDeleted: false } });
  }

  /** Get messages for an agent session */
  async getByAgentSession(agentSessionId: string): Promise<ChatMessage[]> {
    return this.list({ where: { agentSessionId, isDeleted: false } });
  }

  /** Search messages with filters */
  async search(filters: ChatMessageSearchFilters): Promise<ChatMessage[]> {
    const where: Record<string, unknown> = { isDeleted: false };
    if (filters.roomId) where.roomId = filters.roomId;
    if (filters.threadId) where.threadId = filters.threadId;
    if (filters.senderProfileId)
      where.senderProfileId = filters.senderProfileId;
    if (filters.messageType) where.messageType = filters.messageType;
    if (filters.role) where.role = filters.role;

    let messages = await this.list({ where });

    if (filters.query) {
      const lower = filters.query.toLowerCase();
      messages = messages.filter((m) =>
        m.content.toLowerCase().includes(lower),
      );
    }

    if (filters.sinceDate) {
      messages = messages.filter(
        (m) => new Date(m.created_at ?? 0) >= (filters.sinceDate as Date),
      );
    }

    if (filters.beforeDate) {
      messages = messages.filter(
        (m) => new Date(m.created_at ?? 0) < (filters.beforeDate as Date),
      );
    }

    if (filters.hasAttachments !== undefined) {
      messages = messages.filter(
        (m) => m.hasAttachments() === filters.hasAttachments,
      );
    }

    return messages;
  }

  /** Get unread count for a participant in a room (excludes thread replies) */
  async getUnreadCount(
    roomId: string,
    lastReadMessageId: string | null,
  ): Promise<number> {
    const allMessages = await this.list({
      where: { roomId, isDeleted: false },
    });

    // Only count root messages (not thread replies)
    const messages = allMessages.filter((m) => !m.threadId);

    if (!lastReadMessageId) return messages.length;

    const lastReadMsg = messages.find((m) => m.id === lastReadMessageId);
    if (!lastReadMsg) return messages.length;

    return messages.filter(
      (m) =>
        new Date(m.created_at ?? 0) > new Date(lastReadMsg.created_at ?? 0),
    ).length;
  }

  /** Get most recent message for each room (for room list preview) */
  async getLatestPerRoom(roomIds: string[]): Promise<Map<string, ChatMessage>> {
    const result = new Map<string, ChatMessage>();
    for (const roomId of roomIds) {
      const messages = await this.list({
        where: { roomId, isDeleted: false },
      });

      const rootMessages = messages.filter((m) => !m.threadId);
      rootMessages.sort(
        (a, b) =>
          new Date(b.created_at ?? 0).getTime() -
          new Date(a.created_at ?? 0).getTime(),
      );

      if (rootMessages.length > 0) {
        result.set(roomId, rootMessages[0]);
      }
    }
    return result;
  }
}
