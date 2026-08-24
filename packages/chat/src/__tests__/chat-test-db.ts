import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import '../index.js';
import { AgentSessionCollection } from '../collections/AgentSessionCollection.js';
import { ChatMessageCollection } from '../collections/ChatMessageCollection.js';
import { ChatRoomCollection } from '../collections/ChatRoomCollection.js';
import { ChatThreadCollection } from '../collections/ChatThreadCollection.js';

const CHAT_SCHEMA_CLASSES = [
  '@happyvertical/smrt-chat:ChatRoom',
  '@happyvertical/smrt-chat:ChatMessage',
  '@happyvertical/smrt-chat:ChatParticipant',
  '@happyvertical/smrt-chat:ChatThread',
  '@happyvertical/smrt-chat:ChatReaction',
  '@happyvertical/smrt-chat:AgentSession',
  '@happyvertical/smrt-chat:VoiceSession',
];

export async function createChatTestDatabase(
  url: string,
): Promise<DatabaseInterface> {
  return getTestDatabase({ type: 'sqlite', url, classes: CHAT_SCHEMA_CLASSES });
}

export async function seedChatRoom(
  db: DatabaseInterface,
  id = 'room-1',
): Promise<void> {
  const rooms = await ChatRoomCollection.create({ db });
  await rooms.create({
    id,
    tenantId: 'tenant-1',
    name: `Fixture ${id}`,
    roomType: 'public',
    createdByProfileId: 'profile-1',
  });
}

export async function seedChatMessage(
  db: DatabaseInterface,
  id = 'msg-1',
  roomId = 'room-1',
): Promise<void> {
  const messages = await ChatMessageCollection.create({ db });
  await messages.create({
    id,
    tenantId: 'tenant-1',
    roomId,
    senderProfileId: 'profile-1',
    content: `Fixture ${id}`,
  });
}

export async function seedChatThread(
  db: DatabaseInterface,
  id: string,
  rootMessageId = 'fixture-parent-message',
): Promise<void> {
  const threads = await ChatThreadCollection.create({ db });
  await threads.create({
    id,
    tenantId: 'tenant-1',
    roomId: 'fixture-parent-room',
    rootMessageId,
  });
}

export async function seedAgentSession(
  db: DatabaseInterface,
  id: string,
): Promise<void> {
  const sessions = await AgentSessionCollection.create({ db });
  await sessions.create({
    id,
    tenantId: 'tenant-1',
    agentId: 'fixture-agent',
    participantProfileId: 'fixture-profile',
    chatRoomId: 'fixture-parent-room',
  });
}
