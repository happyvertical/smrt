# @happyvertical/smrt-chat

Chat rooms, DMs, threads, and agent conversations for the SMRT framework. Supports public, private, DM, and agent-type rooms with threaded messages, reactions, and agent sessions with tool whitelisting.

## Installation

```bash
pnpm add @happyvertical/smrt-chat
```

## Usage

### Rooms and messages

```typescript
import { ChatService } from '@happyvertical/smrt-chat';

const chat = await ChatService.create({
  persistence: { type: 'sql', url: 'chat.db' },
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

### Collections

| Export | Description |
|--------|------------|
| `ChatRoomCollection` | Room queries, `findOrCreateDM()` |
| `ChatMessageCollection` | Message queries and search filters |
| `ChatParticipantCollection` | Participant queries, `findMembership()` |
| `ChatThreadCollection` | Thread queries |
| `ChatReactionCollection` | Reaction queries |
| `AgentSessionCollection` | Session queries, `findActiveSession()`, `findOrCreate()` |

### Services

| Export | Description |
|--------|------------|
| `ChatService` | Facade: `createRoom()`, `sendMessage()`, `startThread()`, `addParticipant()`, `removeParticipant()`, `updateRoom()`, `addReaction()`, `removeReaction()`, `getOrCreateDM()`, `createAgentSession()`, `sendAgentUserMessage()`, `getRoomMessages()`, `getRoomForMember()`, `updateAgentSessionConfig()`. Every write takes a server-supplied `actorProfileId`. The agent-authored reply path (`sendAgentReply`) is intentionally NOT on this facade or the package index — it is an internal function in `services/ChatService.ts` for the trusted in-process agent runtime only (S5 #1392). |

### Types

`ChatRoomType`, `ChatRoomStatus`, `ChatRoomOptions`, `ChatMessageType`, `ChatMessageRole`, `ChatMessageOptions`, `ChatMessageSearchFilters`, `ChatParticipantRole`, `ChatParticipantStatus`, `ChatParticipantOptions`, `OnlineStatus`, `ChatThreadOptions`, `ChatReactionOptions`, `AgentSessionStatus`, `AgentSessionOptions`

### Constants

`CHAT_MODULE_META`, `CHAT_UI_SLOTS`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-types` -- shared type definitions
- Peer (optional): `@happyvertical/smrt-agents`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-svelte`
