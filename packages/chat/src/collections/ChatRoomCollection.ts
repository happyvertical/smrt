import { SmrtCollection } from '@happyvertical/smrt-core';
import type { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';
import { ChatRoom } from '../models/ChatRoom.js';
import type { ChatRoomType } from '../types.js';

export class ChatRoomCollection extends SmrtCollection<ChatRoom> {
  static readonly _itemClass = ChatRoom;

  async findByType(roomType: ChatRoomType): Promise<ChatRoom[]> {
    return this.list({ where: { roomType, status: 'active' } });
  }

  async findPublic(): Promise<ChatRoom[]> {
    return this.list({ where: { roomType: 'public', status: 'active' } });
  }

  async findDMs(): Promise<ChatRoom[]> {
    return this.list({ where: { roomType: 'dm', status: 'active' } });
  }

  async findAgentRooms(): Promise<ChatRoom[]> {
    return this.list({ where: { roomType: 'agent', status: 'active' } });
  }

  /**
   * Search rooms by name/description/topic.
   *
   * Filtering and limiting are pushed into SQL via `LIKE` instead of loading
   * the entire tenant room set and filtering in JS (S5 #1392, DoS hardening).
   * The WHERE API does not support OR, so we issue one bounded query per
   * searchable column and merge the results, capping the total returned.
   */
  async search(
    query: string,
    options?: { limit?: number },
  ): Promise<ChatRoom[]> {
    const limit = options?.limit ?? 50;
    const like = `%${query}%`;
    const columns = ['name', 'description', 'topic'] as const;

    const merged = new Map<string, ChatRoom>();
    for (const column of columns) {
      const matches = await this.list({
        where: { status: 'active', [`${column} like`]: like },
        orderBy: 'created_at DESC',
        limit,
      });
      for (const room of matches) {
        if (room.id) merged.set(room.id, room);
      }
      if (merged.size >= limit) break;
    }

    return Array.from(merged.values()).slice(0, limit);
  }

  /**
   * Find an existing 1:1 DM room between two profiles, or create one.
   *
   * DM identity is derived from the authoritative `chat_participants` join
   * (server-controlled) rather than client-mutable room metadata (S5 #1392).
   * Callers are responsible for attaching both profiles as participants after
   * creation; {@link ChatService.getOrCreateDM} does this.
   */
  async findOrCreateDM(
    profileId1: string,
    profileId2: string,
    tenantId: string,
    participants: ChatParticipantCollection,
  ): Promise<ChatRoom> {
    // Candidate DM rooms: those where profile1 is an active participant.
    const memberships1 = await participants.list({
      where: { profileId: profileId1, status: 'active' },
    });
    const candidateRoomIds = memberships1.map((m) => m.roomId);

    for (const roomId of candidateRoomIds) {
      const dm = await this.get({ id: roomId });
      if (!dm || dm.roomType !== 'dm' || dm.status !== 'active') continue;

      // Confirm profile2 is also an active participant of this same room.
      const others = await participants.list({
        where: { roomId, profileId: profileId2, status: 'active' },
      });
      if (others.length > 0) {
        return dm;
      }
    }

    // Create new DM room. Membership is established by the caller via the
    // chat_participants join — not via client-supplied metadata.
    const room = await this.create({
      tenantId,
      name: '',
      roomType: 'dm',
      status: 'active',
      maxParticipants: 2,
    });
    return room;
  }
}
