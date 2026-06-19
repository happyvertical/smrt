# @happyvertical/smrt-chat

Chat rooms, threads, and agent sessions with app-controlled tool whitelisting.

## Models

Internal models — all mutations go through the membership/owner-checked `ChatService` (S5 #1392). EVERY `@smrt()` model in this package (ChatRoom, ChatMessage, ChatParticipant, ChatThread, ChatReaction, AgentSession) has a READ-ONLY generated REST/MCP surface (`list`/`get` only); `create`/`update`/`delete` are intentionally NOT generated so the raw collection routes cannot skip the service-layer authorization. A structural regression test enumerates the registry to assert no chat model exposes a mutating op.

- **ChatRoom**: `roomType` (public/private/dm/agent), `status`, `topic`, `maxParticipants`, `lastMessageAt`. Tenant-scoped (required).
- **ChatMessage**: shared by users + agents. `role` (user/assistant/system/tool), `messageType` (text/system/action/file/tool_call/tool_result), `toolCallData` JSON. Unified model — no separate agent message type. Tenant-scoped (required).
- **ChatParticipant**: `role` (owner/admin/member/viewer), `onlineStatus`, `lastReadMessageId`, `isMuted`. Tenant-scoped (required).
- **ChatThread**: `rootMessageId`, `isResolved`, `messageCount`. Created via `ChatService.startThread()` (member-checked). Tenant-scoped (required).
- **ChatReaction**: `messageId`, `profileId`, `emoji`. Added/removed via `ChatService.addReaction()`/`removeReaction()` (member-checked, self-keyed). Tenant-scoped (required).
- **AgentSession**: `agentId` (string ref, not FK), `allowedTools` (JSON string array), `sessionContext` (JSON), `systemPrompt`, limits (`maxTokens`/`maxMessages`/`expiresAt`). Optional tenancy.

## ChatService

Every public write takes an explicit server-supplied `actorProfileId` (the authenticated principal the route injects) — never a caller-controlled `senderProfileId`/`role` (S5 #1392).

Facade: `sendMessage()` (authors as the actor with `role: 'user'`; room-membership-checked; no caller-supplied sender/role and no public membership-skip), `createRoom()` (acting actor becomes owner — no caller-supplied `createdByProfileId`), `startThread()` (member-checked), `addParticipant()`/`removeParticipant()` (owner/admin-checked; self-leave allowed), `updateRoom()` (owner/admin-checked), `addReaction()`/`removeReaction()` (member-checked, self-keyed), `getOrCreateDM()` (actor must be a DM participant), `createAgentSession()` (acting actor becomes the session participant — no caller-supplied `participantProfileId`), `getRoomMessages()`/`getRoomForMember()` (membership-checked reads, `tenantId` required), `updateAgentSessionConfig()` (owner-checked; `tenantId` mandatory and bound into the lookup). Agent session messaging is split by authority: `sendAgentUserMessage()` (caller `actorProfileId` must be the session participant; always authored as the participant). The agent-authored reply path `sendAgentReply(service, params)` is an exported **function — NOT a `ChatService` method and NOT on the package index**; it is reachable only via the dedicated `@happyvertical/smrt-chat/internal/agent-runtime` subpath (S5 #1392), so only trusted in-process agent-runtime code that explicitly opts into that subpath can author as the agent. It authors as `session.agentId`, accepts an optional same-room/tenant `threadId`, and gates tool calls fail-closed against `allowedTools`. The shared internal persistence path (`writeMessage`) is private — it alone may author an arbitrary profile/role or skip the membership check, and is unreachable from any route; it also validates every supplied `threadId`/`agentSessionId`/`replyToMessageId` belongs to the SAME room AND tenant (tenant/room-bound lookups) before use, rejecting cross-room/cross-tenant references. Auto-creates rooms/sessions/participants via an internal `enrollParticipant`.

## Agent Tool Whitelisting

`allowedTools` is a JSON array controlled by the consuming app. Fail-closed: an empty/unparseable whitelist permits NO tools. The internal `sendAgentReply(service, params)` function enforces the whitelist before emitting any `tool`/`tool_call` message; a caller cannot supply a `senderProfileId`/`role` to post as the agent, and the function is not reachable from the package index.

## Gotchas

- **sessionContext, not context**: `context` is reserved for slug scoping. Use `getSessionContext()`/`updateSessionContext()` for agent memory.
- **Agent rooms auto-created**: `roomType: 'agent'`, `maxParticipants` defaults to 2; the agent is enrolled as a member so its replies pass the membership check. `createAgentSession()` re-enrolls the participant AND the agent on the existing-session path, so legacy sessions created before the agent was enrolled self-heal.
- **Session expiry**: check `isActive()` before allowing messages (expiresAt or limit-based)
- **DM identity**: derived from the deterministic per-tenant `canonicalDmRoomId()` and the authoritative `chat_participants` join, not client metadata; concurrent creates upsert onto one row.
- **Tenant-bound lookups**: membership/session/DM lookups REQUIRE `tenantId` and always bind it into the WHERE clause (`findActiveMembership`/`isActiveMember`/`findActiveSession` take a required `tenantId`; AgentSession's `null` tenant is an explicit bound scope, not "any tenant") so they can never resolve a row from another tenant.
