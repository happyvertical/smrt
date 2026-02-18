import { SmrtCollection } from '@happyvertical/smrt-core';
import { ChatParticipant } from '../models/ChatParticipant.js';

export class ChatParticipantCollection extends SmrtCollection<ChatParticipant> {
  static readonly _itemClass = ChatParticipant;

  async getByRoom(roomId: string): Promise<ChatParticipant[]> {
    return this.list({ where: { roomId, status: 'active' } });
  }

  async getByProfile(profileId: string): Promise<ChatParticipant[]> {
    return this.list({ where: { profileId, status: 'active' } });
  }

  async findMembership(
    roomId: string,
    profileId: string,
  ): Promise<ChatParticipant | null> {
    const results = await this.list({ where: { roomId, profileId } });
    return results[0] ?? null;
  }

  async getOnlineInRoom(roomId: string): Promise<ChatParticipant[]> {
    const participants = await this.list({
      where: { roomId, status: 'active' },
    });
    return participants.filter((p) => p.onlineStatus !== 'offline');
  }

  async getAdminsInRoom(roomId: string): Promise<ChatParticipant[]> {
    const participants = await this.list({
      where: { roomId, status: 'active' },
    });
    return participants.filter((p) => p.isAdmin());
  }

  async countInRoom(roomId: string): Promise<number> {
    const participants = await this.list({
      where: { roomId, status: 'active' },
    });
    return participants.length;
  }
}
