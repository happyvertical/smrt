import { SmrtCollection } from '@happyvertical/smrt-core';
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

  async search(query: string): Promise<ChatRoom[]> {
    const rooms = await this.list({ where: { status: 'active' } });
    const lower = query.toLowerCase();
    return rooms.filter(
      (r) =>
        r.name.toLowerCase().includes(lower) ||
        r.description.toLowerCase().includes(lower) ||
        r.topic.toLowerCase().includes(lower),
    );
  }

  async findOrCreateDM(
    profileId1: string,
    profileId2: string,
    tenantId: string,
  ): Promise<ChatRoom> {
    // Find existing DM between these two profiles by checking all DM rooms
    const dms = await this.list({
      where: { roomType: 'dm', status: 'active' },
    });

    // Check each DM room to see if both profiles are participants
    // This is a simplified approach; in production you'd use a SQL join
    for (const dm of dms) {
      const meta = dm.getMetadata();
      if (meta.participantIds) {
        const pids = meta.participantIds as string[];
        if (pids.includes(profileId1) && pids.includes(profileId2)) {
          return dm;
        }
      }
    }

    // Create new DM room with participant IDs in metadata for lookup
    const room = await this.create({
      tenantId,
      name: '',
      roomType: 'dm',
      status: 'active',
      maxParticipants: 2,
    });
    room.setMetadata({ participantIds: [profileId1, profileId2] });
    await room.save();
    return room;
  }
}
