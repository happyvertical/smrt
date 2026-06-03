# @happyvertical/smrt-chat

Chat rooms, threads, and agent sessions with app-controlled tool whitelisting.

## Models

- **ChatRoom**: `roomType` (public/private/dm/agent), `status`, `topic`, `maxParticipants`, `lastMessageAt`. Tenant-scoped (required).
- **ChatMessage**: shared by users + agents. `role` (user/assistant/system/tool), `messageType` (text/system/action/file/tool_call/tool_result), `toolCallData` JSON. Unified model — no separate agent message type.
- **ChatParticipant**: `role` (owner/admin/member/viewer), `onlineStatus`, `lastReadMessageId`, `isMuted`.
- **ChatThread**: `rootMessageId`, `isResolved`, `messageCount`.
- **AgentSession**: `agentId` (string ref, not FK), `allowedTools` (JSON string array), `sessionContext` (JSON), `systemPrompt`, limits (`maxTokens`/`maxMessages`/`expiresAt`). Optional tenancy.

## ChatService

Facade: `sendMessage()`, `createRoom()`, `createAgentSession()`, `sendAgentMessage()`. Auto-creates rooms/sessions/participants.

## Agent Tool Whitelisting

`allowedTools` is a simple JSON array controlled by the consuming app. No tier/scoping baked into framework — app decides what tools agents can access and validates before execution.

## Gotchas

- **sessionContext, not context**: `context` is reserved for slug scoping. Use `getSessionContext()`/`updateSessionContext()` for agent memory.
- **Agent rooms auto-created**: `roomType: 'agent'`, `maxParticipants` defaults to 2
- **Session expiry**: check `isActive()` before allowing messages (expiresAt or limit-based)
- **Tool validation is app responsibility**: framework stores whitelist but doesn't enforce
