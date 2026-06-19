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
    tenantId?: string,
  ): Promise<ChatParticipant | null> {
    const where: Record<string, unknown> = { roomId, profileId };
    if (tenantId !== undefined) where.tenantId = tenantId;
    const results = await this.list({ where });
    return results[0] ?? null;
  }

  /**
   * Returns the participant row only if the profile is an ACTIVE member of the
   * room (not left/kicked/banned). Used by ChatService to gate sends and reads
   * on room membership (S5 #1392, IDOR hardening).
   *
   * `tenantId` is REQUIRED and always bound into the WHERE clause so a membership
   * lookup can never resolve a row belonging to another tenant, even when no ALS
   * tenant context is active to drive the tenancy interceptor (defense in depth).
   * Making it a required parameter (rather than optional) closes the hole where a
   * caller could omit it and silently drop the tenant predicate from the query.
   */
  async findActiveMembership(
    roomId: string,
    profileId: string,
    tenantId: string,
  ): Promise<ChatParticipant | null> {
    const where: Record<string, unknown> = {
      roomId,
      profileId,
      status: 'active',
      tenantId,
    };
    const results = await this.list({ where, limit: 1 });
    return results[0] ?? null;
  }

  /** True when the profile is an active member of the room (tenant-bound). */
  async isActiveMember(
    roomId: string,
    profileId: string,
    tenantId: string,
  ): Promise<boolean> {
    return (
      (await this.findActiveMembership(roomId, profileId, tenantId)) !== null
    );
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
