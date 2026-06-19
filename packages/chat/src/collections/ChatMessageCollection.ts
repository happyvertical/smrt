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
   *
   * `tenantId` is REQUIRED and bound into BOTH the message window AND the cursor
   * lookup (S5 #1392): room ids are not globally unique, so a roomId-only read
   * could surface another tenant's messages for a same-id room. The caller's
   * membership gate is tenant-scoped, so the read MUST be too.
   */
  async getByRoom(
    roomId: string,
    tenantId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ChatMessage[]> {
    const where: Record<string, unknown> = {
      roomId,
      tenantId,
      isDeleted: false,
      threadId: null,
    };

    // Cursor-based pagination: only messages older than the cursor message.
    // The cursor must belong to the SAME root-message set of the SAME room AND
    // tenant (S5 #1392); a cursor id from another room/thread/tenant is silently
    // ignored rather than allowing it to influence this room's window.
    if (options?.before) {
      const cursorMsg = await this.get({
        id: options.before,
        roomId,
        tenantId,
        isDeleted: false,
        threadId: null,
      });
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

  /**
   * Get messages in a thread, tenant-bound (S5 #1392).
   *
   * `tenantId` is bound into the query so a thread id from another tenant can
   * never surface that tenant's thread history.
   */
  async getByThread(
    threadId: string,
    tenantId: string,
  ): Promise<ChatMessage[]> {
    return this.list({ where: { threadId, tenantId, isDeleted: false } });
  }

  /**
   * Get messages for an agent session, tenant-bound (S5 #1392).
   *
   * `tenantId` is bound into the query so a session id from another tenant can
   * never surface that tenant's session messages.
   */
  async getByAgentSession(
    agentSessionId: string,
    tenantId: string,
  ): Promise<ChatMessage[]> {
    return this.list({ where: { agentSessionId, tenantId, isDeleted: false } });
  }

  /**
   * Search messages with filters.
   *
   * All structural filters (tenant/room/thread/sender/type/role/date/text) are
   * pushed into SQL instead of loading the full message set and filtering in JS
   * (S5 #1392, DoS hardening). `tenantId` is REQUIRED and always bound so the
   * search can never cross a tenant boundary. `hasAttachments` remains a
   * post-filter since it is a computed property on the model rather than a
   * stored column.
   */
  async search(
    filters: ChatMessageSearchFilters & { tenantId: string; limit?: number },
  ): Promise<ChatMessage[]> {
    const where: Record<string, unknown> = {
      tenantId: filters.tenantId,
      isDeleted: false,
    };
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
   * room history into memory (S5 #1392, DoS hardening). `tenantId` is REQUIRED
   * and bound into both the count and the read-cursor lookup so the count can
   * never include another tenant's messages for a same-id room.
   */
  async getUnreadCount(
    roomId: string,
    tenantId: string,
    lastReadMessageId: string | null,
  ): Promise<number> {
    const base = { roomId, tenantId, isDeleted: false, threadId: null };

    if (!lastReadMessageId) return this.count({ where: base });

    // The read-cursor must belong to the same room's root-message set in the
    // same tenant; a cursor from another room/thread/tenant is ignored rather
    // than skewing the count (S5 #1392).
    const lastReadMsg = await this.get({
      id: lastReadMessageId,
      roomId,
      tenantId,
      isDeleted: false,
      threadId: null,
    });
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
   * `tenantId` is REQUIRED and bound into each per-room read so a same-id room
   * from another tenant can never leak a preview message.
   */
  async getLatestPerRoom(
    roomIds: string[],
    tenantId: string,
  ): Promise<Map<string, ChatMessage>> {
    const result = new Map<string, ChatMessage>();
    for (const roomId of roomIds) {
      const latest = await this.list({
        where: { roomId, tenantId, isDeleted: false, threadId: null },
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
