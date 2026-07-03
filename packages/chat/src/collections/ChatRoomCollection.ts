import { createHash } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import type { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';
import { ChatRoom } from '../models/ChatRoom.js';
import type { ChatRoomType } from '../types.js';

/**
 * Deterministic, order-independent room id for a 1:1 DM between two profiles
 * within a tenant (S5 #1392, DM race hardening).
 *
 * Concurrent {@link ChatRoomCollection.findOrCreateDM} calls for the same pair
 * compute the SAME id, so the underlying upsert (which conflicts on `id` for new
 * objects) collapses the racing inserts onto one row instead of creating
 * duplicate DM rooms. The id is a deterministic UUIDv5-shaped value derived from
 * the tenant and the sorted profile pair.
 */
export function canonicalDmRoomId(
  tenantId: string,
  profileId1: string,
  profileId2: string,
): string {
  const [a, b] = [profileId1, profileId2].sort();
  const key = `dm ${tenantId} ${a} ${b}`;
  const hash = createHash('sha1').update(key).digest('hex');
  // Shape the digest as a v5 UUID (set version/variant nibbles).
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((Number.parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, '0') + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-');
}

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
    // Fast, race-safe path: a DM for a tenant + profile pair has a deterministic
    // id, so a prior (or concurrently-created) DM resolves directly (S5 #1392).
    const dmId = canonicalDmRoomId(tenantId, profileId1, profileId2);
    const canonical = await this.get({ id: dmId, tenantId });
    if (canonical && canonical.roomType === 'dm') {
      return canonical;
    }

    // Legacy fallback: DMs created before the deterministic-id scheme are still
    // discovered via the authoritative chat_participants join. tenantId is bound
    // into every lookup so a DM can never be resolved (or reused) across tenants,
    // even without an ALS tenant context.
    const memberships1 = await participants.list({
      where: { profileId: profileId1, status: 'active', tenantId },
    });
    const candidateRoomIds = memberships1.map((m) => m.roomId);

    for (const roomId of candidateRoomIds) {
      const dm = await this.get({ id: roomId, tenantId });
      if (dm?.roomType !== 'dm' || dm.status !== 'active') continue;

      // Confirm profile2 is also an active participant of this same room.
      const others = await participants.list({
        where: { roomId, profileId: profileId2, status: 'active', tenantId },
      });
      if (others.length > 0) {
        return dm;
      }
    }

    // Create new DM room with the deterministic id. Membership is established by
    // the caller via the chat_participants join — not via client metadata. The
    // deterministic id makes concurrent creates upsert onto a single row,
    // eliminating the former check-then-create duplicate-DM race.
    const room = await this.create({
      id: dmId,
      tenantId,
      name: '',
      roomType: 'dm',
      status: 'active',
      maxParticipants: 2,
    });
    return room;
  }
}
