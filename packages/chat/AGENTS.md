# @happyvertical/smrt-chat

Chat rooms, threads, and agent sessions with app-controlled tool whitelisting.

## Models

Internal models — all mutations go through the membership/owner-checked `ChatService` (S5 #1392). The `@smrt()` generated REST/MCP surface on ChatRoom, ChatMessage, ChatParticipant, and AgentSession is READ-ONLY (`list`/`get`); `create`/`update`/`delete` are intentionally NOT generated so the raw collection routes cannot skip the service-layer authorization.

- **ChatRoom**: `roomType` (public/private/dm/agent), `status`, `topic`, `maxParticipants`, `lastMessageAt`. Tenant-scoped (required).
- **ChatMessage**: shared by users + agents. `role` (user/assistant/system/tool), `messageType` (text/system/action/file/tool_call/tool_result), `toolCallData` JSON. Unified model — no separate agent message type. Tenant-scoped (required).
- **ChatParticipant**: `role` (owner/admin/member/viewer), `onlineStatus`, `lastReadMessageId`, `isMuted`. Tenant-scoped (required).
- **ChatThread**: `rootMessageId`, `isResolved`, `messageCount`.
- **AgentSession**: `agentId` (string ref, not FK), `allowedTools` (JSON string array), `sessionContext` (JSON), `systemPrompt`, limits (`maxTokens`/`maxMessages`/`expiresAt`). Optional tenancy.

## ChatService

Facade: `sendMessage()` (room-membership-checked), `createRoom()`, `createAgentSession()`, `getOrCreateDM()`, `getRoomMessages()`/`getRoomForMember()` (membership-checked reads), `updateAgentSessionConfig()` (owner-checked). Agent session messaging is split by authority: `sendAgentUserMessage()` (caller must be the session participant; always authored as the participant) and the internal `sendAgentReply()` (authors as the agent; tool calls gated fail-closed against `allowedTools`). Auto-creates rooms/sessions/participants.

## Agent Tool Whitelisting

`allowedTools` is a JSON array controlled by the consuming app. Fail-closed: an empty/unparseable whitelist permits NO tools. `sendAgentReply()` enforces the whitelist before emitting any `tool`/`tool_call` message; a caller cannot supply a `senderProfileId`/`role` to post as the agent.

## Gotchas

- **sessionContext, not context**: `context` is reserved for slug scoping. Use `getSessionContext()`/`updateSessionContext()` for agent memory.
- **Agent rooms auto-created**: `roomType: 'agent'`, `maxParticipants` defaults to 2; the agent is enrolled as a member so its replies pass the membership check.
- **Session expiry**: check `isActive()` before allowing messages (expiresAt or limit-based)
- **DM identity**: derived from the deterministic per-tenant `canonicalDmRoomId()` and the authoritative `chat_participants` join, not client metadata; concurrent creates upsert onto one row.
- **Tenant-bound lookups**: membership/session/DM lookups bind `tenantId` into the WHERE clause so they can never resolve a row from another tenant.
