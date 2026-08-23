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

export {
  acceptAppliedChange,
  type CaptureChatFeedbackOptions,
  type ChatFeedbackBase,
  type ChatFeedbackPersona,
  type ChatFeedbackResult,
  captureChatFeedback,
  correctResponse,
  rateResponse,
  rejectAppliedChange,
  thumbsDown,
  thumbsUp,
} from './chat-feedback.js';
// Conversational harness (L3, #1891): the persona-bound agentic tool-loop and
// in-chat feedback capture. `chat → personas` is the new acyclic edge.
export {
  ChatStreamBadRequestError,
  type ChatStreamContext,
  type ChatStreamControlCommand,
  ChatStreamError,
  type ChatStreamEvent,
  type ChatStreamHandlerOptions,
  type ChatStreamMessage,
  type ChatStreamPersonaBinding,
  type ChatStreamRequestBody,
  type ChatStreamRole,
  type ChatStreamSession,
  ChatStreamUnauthorizedError,
  createChatStreamHandler,
  DEFAULT_CHAT_STREAM_HEARTBEAT_MS,
  encodeChatStreamEvent,
  MAX_CHAT_STREAM_CONTENT_LENGTH,
  MAX_CHAT_STREAM_MESSAGES,
  type RunChatConversationStreamOptions,
  runChatConversationStream,
} from './chat-stream.js';
// Principal-bound data discovery/inspection/query tools are offered through
// the same `extraTools` seam as invoke-agent; authority remains in agents.
export * from './data-surface-tools.js';
// Models
export {
  AgentSession,
  ChatMessage,
  ChatParticipant,
  ChatReaction,
  ChatRoom,
  ChatThread,
  VoiceGatewayTurn,
  VoiceSession,
} from './models/index.js';
export {
  type AuthoredConversationMessages,
  type BindPersonaToSessionOptions,
  bindPersonaToSession,
  type ConversationPersona,
  type ConversationReplyService,
  conversationPersonaFromAgentPersona,
  conversationPersonaFromResolved,
  formatRecalledMemory,
  type PersonaConversationTurnOptions,
  type PersonaConversationTurnResult,
  type PersonaRecallOptions,
  principalBindingFor,
  recallPersonaMemory,
  resolveConversationInstructions,
  runPersonaConversationTurn,
} from './persona-conversation.js';
// Services
export { ChatService } from './services/index.js';
export {
  buildManifestToolCatalog,
  DEFAULT_MAX_STEPS,
  invokeManifestTool,
  type ManifestTool,
  manifestToolToAITool,
  runToolLoop,
  type ToolExecutionContext,
  type ToolInvocation,
  type ToolLoopOptions,
  type ToolLoopResult,
  type ToolLoopStopReason,
} from './tool-loop.js';
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
  VoiceGatewayTurnOptions,
  VoiceGatewayTurnStatus,
  VoiceSessionOptions,
  VoiceSessionStatus,
} from './types.js';

// UI metadata (no Svelte dependency - import ./svelte for components)
export { CHAT_MODULE_META, CHAT_UI_SLOTS } from './ui.js';
export {
  assertVoiceGatewayBearer,
  type CreateVoiceChatSessionOptions,
  createVoiceChatSession,
  createVoiceGatewayTurnHandler,
  type HandleVoiceGatewayTurnOptions,
  handleVoiceGatewayTurn,
  MAX_VOICE_GATEWAY_TEXT_LENGTH,
  SMRT_CHAT_VOICE_TARGET,
  type VoiceChatSessionCreationResult,
  VoiceGatewayBadRequestError,
  VoiceGatewayError,
  VoiceGatewayReplayError,
  type VoiceGatewayTurnHandlerOptions,
  type VoiceGatewayTurnMetadata,
  type VoiceGatewayTurnPayload,
  type VoiceGatewayTurnResponse,
  type VoiceGatewayTurnResponseMetadata,
  VoiceGatewayUnauthorizedError,
  VoiceSessionExpiredError,
  VoiceSessionRejectedError,
} from './voice.js';
