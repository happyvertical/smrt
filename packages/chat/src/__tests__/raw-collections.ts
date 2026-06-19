/**
 * Test-only access to the raw chat collections (S5 #1392).
 *
 * The `ChatService` collections are `#private` and the package index no longer
 * exports the collection classes, so production consumers can only mutate chat
 * state through the authorized facade. Security regression tests, however, must
 * sometimes forge a row that "slipped past" the facade or read a row directly to
 * assert tenant binding. They obtain the collections from the `ObjectRegistry`
 * — the same registry `ChatService.create()` registers into — rather than
 * reaching into the service's private fields. This keeps the production surface
 * closed while letting tests exercise the collection layer.
 */

import {
  ObjectRegistry,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import type { AgentSessionCollection } from '../collections/AgentSessionCollection.js';
import type { ChatMessageCollection } from '../collections/ChatMessageCollection.js';
import type { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';
import type { ChatReactionCollection } from '../collections/ChatReactionCollection.js';
import type { ChatRoomCollection } from '../collections/ChatRoomCollection.js';
import type { ChatThreadCollection } from '../collections/ChatThreadCollection.js';

export interface RawChatCollections {
  rooms: ChatRoomCollection;
  messages: ChatMessageCollection;
  participants: ChatParticipantCollection;
  threads: ChatThreadCollection;
  agentSessions: AgentSessionCollection;
  reactions: ChatReactionCollection;
}

/**
 * Resolve the raw chat collections from the registry for the given DB options.
 * Must be called after `ChatService.create(options)` has registered them.
 */
export async function getRawChatCollections(
  options: SmrtObjectOptions,
): Promise<RawChatCollections> {
  const rooms = (await ObjectRegistry.getCollection(
    '@happyvertical/smrt-chat:ChatRoom',
    options,
  )) as ChatRoomCollection;
  const messages = (await ObjectRegistry.getCollection(
    '@happyvertical/smrt-chat:ChatMessage',
    options,
  )) as ChatMessageCollection;
  const participants = (await ObjectRegistry.getCollection(
    '@happyvertical/smrt-chat:ChatParticipant',
    options,
  )) as ChatParticipantCollection;
  const threads = (await ObjectRegistry.getCollection(
    '@happyvertical/smrt-chat:ChatThread',
    options,
  )) as ChatThreadCollection;
  const agentSessions = (await ObjectRegistry.getCollection(
    '@happyvertical/smrt-chat:AgentSession',
    options,
  )) as AgentSessionCollection;
  const reactions = (await ObjectRegistry.getCollection(
    '@happyvertical/smrt-chat:ChatReaction',
    options,
  )) as ChatReactionCollection;
  return { rooms, messages, participants, threads, agentSessions, reactions };
}
