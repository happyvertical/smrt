# @happyvertical/smrt-chat

Chat rooms, DMs, threads, and agent conversations for the s-m-r-t framework. Supports public, private, DM, and agent-type rooms with threaded messages, reactions, and agent sessions with tool whitelisting.

## Installation

```bash
pnpm add @happyvertical/smrt-chat
```

## Data-surface bridge security

The `./data-surface-bridge` entry point is the server half of the browser data-
surface protocol. Supply a transport adapter whose `subscribe` callback
provides peer metadata derived from authenticated connection state (such as a
bound WebSocket session or origin-checked `postMessage` peer). Never copy
`sessionId` or `source` from an untrusted message into that metadata, and route
`send` only to the authenticated peer.

The bridge validates and bounds every command, acknowledgement, and event
before it crosses the server boundary. `authorize` remains the application’s
responsibility and must fail closed. Commands are scoped to the configured
session/source, expire by TTL, and are idempotent by command ID plus command
signature; replay retention is bounded and capacity exhaustion returns an
explicit `replay_capacity_exceeded` outcome. Invalid, stale, disconnected, or
transport-failed work resolves with a protocol failure reason rather than
trusting browser data or throwing raw transport errors.

## Usage

### Local dev server

Run the chat package workbench directly:

```bash
pnpm --dir packages/chat dev
```

The root route opens an interactive chat surface backed by
`src/routes/api/dev-chat/+server.ts`. If `SMRT_CHAT_DEV_PROVIDER` /
`SMRT_CHAT_DEV_API_KEY` or standard provider credentials such as
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` are available, the
assistant turn goes through `@happyvertical/ai`; otherwise it uses a
deterministic local fallback. Component previews are available at `/previews`.

The workbench also has a local-only voice conversation mode. It reads
`SMRT_CHAT_DEV_VOICE_GATEWAY_HTTP_URL` and
`SMRT_CHAT_DEV_VOICE_GATEWAY_WS_URL`, fetches gateway targets from
`/api/dev-voice/config`, streams browser microphone audio to `WS /ws/voice` as
PCM16 mono at 16 kHz, appends gateway transcripts/responses to the chat, and
plays returned TTS audio. If the gateway requires a bearer token, set
`SMRT_CHAT_DEV_VOICE_GATEWAY_TOKEN`; browser WebSocket testing also requires
`SMRT_CHAT_DEV_VOICE_GATEWAY_EXPOSE_TOKEN=true`, so use this only for local dev.

### Rooms and messages

```typescript
import { ChatService } from '@happyvertical/smrt-chat';

const chat = await ChatService.create({
  db: { type: 'sqlite', url: 'chat.db' },
});

// `actorProfileId` is the authenticated principal the route injects. Every
// write takes it explicitly; the caller never supplies a `senderProfileId`,
// `role`, or `createdByProfileId` (S5 #1392).

// Create a public room (the acting actor becomes the owner)
const room = await chat.createRoom({
  tenantId: 'tenant-1',
  name: 'General',
  roomType: 'public',
  actorProfileId: 'profile-1',
});

// Send a message (always authored as the actor with role 'user')
const message = await chat.sendMessage({
  tenantId: 'tenant-1',
  roomId: room.id,
  actorProfileId: 'profile-1',
  content: 'Hello, world!',
});

// Start a threaded conversation from a message (member-checked)
const thread = await chat.startThread({
  tenantId: 'tenant-1',
  roomId: room.id,
  actorProfileId: 'profile-1',
  rootMessageId: message.id,
  title: 'Follow-up discussion',
});

// Reply within the thread. The thread (and any reply-to message) must belong
// to the same room and tenant, or the write is rejected.
await chat.sendMessage({
  tenantId: 'tenant-1',
  roomId: room.id,
  actorProfileId: 'profile-2',
  content: 'Great point!',
  threadId: thread.id,
});
```

### Agent sessions with tool whitelisting

```typescript
// Create an agent session (auto-creates an agent-type room). The acting actor
// becomes the owning participant; the caller cannot open a session for someone
// else by supplying a participant id.
const { session, room } = await chat.createAgentSession({
  tenantId: 'tenant-1',
  agentId: 'agent-summarizer',
  actorProfileId: 'profile-1',
  allowedTools: ['web-search', 'summarize'],
  systemPrompt: 'You are a research assistant.',
  maxMessages: 100,
});

// Send a USER message within the agent session. The caller must be the
// session participant; the message is always authored as that participant.
await chat.sendAgentUserMessage({
  tenantId: 'tenant-1',
  agentSessionId: session.id,
  actorProfileId: 'profile-1',
  content: 'Summarize the latest news',
});

// Emit the agent's reply. This is the INTERNAL trusted authority that authors
// a message AS the agent, so it is intentionally NOT a public ChatService
// method and NOT on the package index. It is reachable only via the dedicated
// `./internal/agent-runtime` subpath, which a normal route/consumer importing
// from '@happyvertical/smrt-chat' cannot reach. Opting into this subpath
// signals the importer IS the trusted in-process agent runtime. Tool calls are
// gated fail-closed against the session's allowedTools.
import { sendAgentReply } from '@happyvertical/smrt-chat/internal/agent-runtime';
await sendAgentReply(chat, {
  tenantId: 'tenant-1',
  agentSessionId: session.id,
  content: 'Here is the summary...',
  kind: 'assistant',
});

// Check session limits before allowing more messages
if (session.isActive()) {
  // Session has not expired or hit token/message limits
}
```

### Voice gateway turns

`smrt-chat` can expose a gateway-facing turn target for browser voice input.
The browser receives only a short-lived s-m-r-t voice session binding; the
gateway-to-s-m-r-t service bearer token stays server-side.

```typescript
import {
  createVoiceChatSession,
  createVoiceGatewayTurnHandler,
} from '@happyvertical/smrt-chat';

// Authenticated app route: bind the speaking profile to a persona and an
// existing or newly-created agent session.
const voice = await createVoiceChatSession({
  chatService: chat,
  db,
  tenantId: locals.tenantId,
  actorProfileId: locals.profileId,
  actorUserId: locals.userId,
  persona: resolvedPersona,
  agentSessionId: session.id, // omit to create/reuse an agent session
  ttlSeconds: 600,
});

// Return voice.gatewaySessionId + voice.metadata to the browser/gateway. Do not
// return the gateway service token.

// Gateway target route: configure the deployed voice gateway HTTP target to
// POST here with Authorization: Bearer <SMRT_VOICE_GATEWAY_TOKEN>.
export const POST = ({ request }) =>
  createVoiceGatewayTurnHandler({
    chatService: chat,
    db,
    ai,
    gatewayToken: process.env.SMRT_VOICE_GATEWAY_TOKEN ?? '',
  })(request);
```

The gateway sends the transcribed text turn:

```json
{
  "session_id": "gateway-or-smrt-stable-session-id",
  "turn_id": "gateway-generated-turn-id",
  "target": "smrt:chat",
  "actor": "optional-display-name",
  "text": "transcribed user utterance",
  "metadata": {
    "tenantId": "tenant uuid",
    "actorProfileId": "profile id",
    "chatRoomId": "room id",
    "threadId": "optional thread id",
    "agentSessionId": "agent session id",
    "personaId": "persona id",
    "voiceSessionId": "SMRT-issued voice session id",
    "source": "voice-gateway"
  }
}
```

s-m-r-t validates `metadata.voiceSessionId` against its server-side binding, then
checks any supplied tenant/profile/persona/session/thread ids against that
binding instead of trusting the gateway metadata. A valid turn is persisted as a
normal user chat message, routed through `runPersonaConversationTurn()`, and the
assistant reply is persisted as a normal assistant message. The response is:

```json
{
  "session_id": "same session_id",
  "turn_id": "same turn_id",
  "text": "assistant response text",
  "metadata": {
    "tenantId": "tenant id",
    "chatRoomId": "room id",
    "threadId": null,
    "agentSessionId": "agent session id",
    "userMessageId": "persisted transcript message id",
    "assistantMessageId": "persisted assistant message id",
    "personaId": "persona id",
    "correlationId": "feedback correlation id",
    "voiceSessionId": "SMRT-issued voice session id",
    "source": "voice-gateway"
  }
}
```

### Direct messages

```typescript
// Get or create a DM room between two profiles. The acting actor must be one
// of the two DM participants.
const dmRoom = await chat.getOrCreateDM({
  tenantId: 'tenant-1',
  actorProfileId: 'profile-1',
  profileId1: 'profile-1',
  profileId2: 'profile-2',
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `ChatRoom` | Room with type (`public`/`private`/`dm`/`agent`), status, topic, and metadata |
| `ChatMessage` | Message with `role` (user/assistant/system/tool), `messageType` (text/system/action/file/tool_call/tool_result), optional thread and reply references |
| `ChatParticipant` | Room member with `role` (owner/admin/member/viewer), online status, read tracking |
| `ChatThread` | Threaded conversation linked to a root message, with resolve/reopen lifecycle |
| `ChatReaction` | Emoji reaction on a message |
| `AgentSession` | AI agent session with `allowedTools` (JSON string array), `sessionContext` for multi-turn memory, `systemPrompt`, and usage limits (`maxTokens`/`maxMessages`/`expiresAt`) |
| `VoiceSession` | Short-lived voice gateway binding over a tenant, actor profile, persona, and agent session |

### Internal collections

Raw collection classes are not exported from the package index. They are listed
here as implementation details; application code should use `ChatService` and
the voice helpers.

| Internal class | Description |
|--------|------------|
| `ChatRoomCollection` | Room queries, `findOrCreateDM()` |
| `ChatMessageCollection` | Message queries and search filters |
| `ChatParticipantCollection` | Participant queries, `findMembership()` |
| `ChatThreadCollection` | Thread queries |
| `ChatReactionCollection` | Reaction queries |
| `AgentSessionCollection` | Session queries, `findActiveSession()`, `findOrCreate()` |
| `VoiceSessionCollection` | Voice session binding queries and stale-expiry helper |

### Services

| Export | Description |
|--------|------------|
| `ChatService` | Facade: `createRoom()`, `sendMessage()`, `startThread()`, `addParticipant()`, `removeParticipant()`, `updateRoom()`, `addReaction()`, `removeReaction()`, `getOrCreateDM()`, `createAgentSession()`, `sendAgentUserMessage()`, `getRoomMessages()`, `getRoomForMember()`, `updateAgentSessionConfig()`. Every write takes a server-supplied `actorProfileId`. The agent-authored reply path (`sendAgentReply`) is intentionally NOT on this facade or the package index — it is an internal function in `services/ChatService.ts` for the trusted in-process agent runtime only (S5 #1392). |
| `createVoiceChatSession()` | Creates a short-lived voice binding for an authenticated actor and persona, optionally against an existing agent session |
| `handleVoiceGatewayTurn()` | Lower-level gateway turn adapter for non-Fetch hosts |
| `createVoiceGatewayTurnHandler()` | Fetch-compatible HTTP handler for the gateway target endpoint |

### Types

`ChatRoomType`, `ChatRoomStatus`, `ChatRoomOptions`, `ChatMessageType`, `ChatMessageRole`, `ChatMessageOptions`, `ChatMessageSearchFilters`, `ChatParticipantRole`, `ChatParticipantStatus`, `ChatParticipantOptions`, `OnlineStatus`, `ChatThreadOptions`, `ChatReactionOptions`, `AgentSessionStatus`, `AgentSessionOptions`, `VoiceSessionStatus`, `VoiceSessionOptions`, `VoiceGatewayTurnPayload`, `VoiceGatewayTurnResponse`

### Constants

`CHAT_MODULE_META`, `CHAT_UI_SLOTS`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-types` -- shared type definitions
- Peer (optional): `@happyvertical/smrt-agents`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-svelte`

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.
