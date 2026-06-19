/**
 * @happyvertical/smrt-chat
 *
 * Chat rooms, DMs, threads, and agent conversations for the SMRT framework.
 *
 * Provides models and collections for real-time chat with support for:
 * - Public/private rooms and channels
 * - Direct messages between profiles
 * - Threaded conversations (Slack-style)
 * - Agent conversation sessions with tool access control
 * - Message reactions and read receipts
 *
 * @example
 * ```typescript
 * import { ChatService } from '@happyvertical/smrt-chat';
 *
 * const chat = await ChatService.create({
 *   persistence: { type: 'sql', url: 'chat.db' }
 * });
 *
 * // actorProfileId is the authenticated principal injected by the route; the
 * // acting actor becomes the room owner.
 * const room = await chat.createRoom({
 *   tenantId: 'tenant-1',
 *   name: 'General',
 *   roomType: 'public',
 *   actorProfileId: 'profile-1',
 * });
 *
 * // actorProfileId is the authenticated principal injected by the route;
 * // the message is always authored as that actor with role 'user'.
 * await chat.sendMessage({
 *   tenantId: 'tenant-1',
 *   roomId: room.id,
 *   actorProfileId: 'profile-1',
 *   content: 'Hello, world!',
 * });
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Collections are intentionally NOT exported (S5 #1392). The raw
// SmrtCollection handles (ChatRoomCollection, ChatMessageCollection,
// ChatParticipantCollection, ChatThreadCollection, AgentSessionCollection,
// ChatReactionCollection) can author/mutate any row with NO actor/membership
// authorization. Exposing them let a consumer call e.g.
// `messages.create({ senderProfileId, role })` or `participants.create(...)` to
// bypass the entire ChatService facade. All reads/writes now go through the
// authorized ChatService methods; legitimate reads have dedicated facade
// methods (getAgentSession, findActiveAgentSessions, getThread, listRoomThreads,
// getThreadMessages, getRoomMessages, getRoomForMember, ...).

// Models
export {
  AgentSession,
  ChatMessage,
  ChatParticipant,
  ChatReaction,
  ChatRoom,
  ChatThread,
} from './models/index.js';

// Services
export { ChatService } from './services/index.js';

// Types
export type {
  AgentSessionOptions,
  AgentSessionStatus,
  ChatMessageOptions,
  ChatMessageRole,
  ChatMessageSearchFilters,
  ChatMessageType,
  ChatParticipantOptions,
  ChatParticipantRole,
  ChatParticipantStatus,
  ChatReactionOptions,
  ChatRoomOptions,
  ChatRoomStatus,
  ChatRoomType,
  ChatThreadOptions,
  OnlineStatus,
} from './types.js';

// UI metadata (no Svelte dependency - import ./svelte for components)
export { CHAT_MODULE_META, CHAT_UI_SLOTS } from './ui.js';
