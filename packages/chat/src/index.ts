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
 * const room = await chat.createRoom({
 *   tenantId: 'tenant-1',
 *   name: 'General',
 *   roomType: 'public',
 *   createdByProfileId: 'profile-1',
 * });
 *
 * await chat.sendMessage({
 *   tenantId: 'tenant-1',
 *   roomId: room.id,
 *   senderProfileId: 'profile-1',
 *   content: 'Hello, world!',
 * });
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__';

// Collections
export {
  AgentSessionCollection,
  ChatMessageCollection,
  ChatParticipantCollection,
  ChatReactionCollection,
  ChatRoomCollection,
  ChatThreadCollection,
} from './collections/index.js';

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
