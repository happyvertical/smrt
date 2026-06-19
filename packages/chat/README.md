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

// Create a public room (creator is added as owner)
const room = await chat.createRoom({
  tenantId: 'tenant-1',
  name: 'General',
  roomType: 'public',
  createdByProfileId: 'profile-1',
});

// Send a message
await chat.sendMessage({
  tenantId: 'tenant-1',
  roomId: room.id,
  senderProfileId: 'profile-1',
  content: 'Hello, world!',
});

// Start a threaded conversation from a message
const thread = await chat.startThread({
  tenantId: 'tenant-1',
  roomId: room.id,
  rootMessageId: message.id,
  title: 'Follow-up discussion',
});

// Reply within the thread
await chat.sendMessage({
  tenantId: 'tenant-1',
  roomId: room.id,
  senderProfileId: 'profile-2',
  content: 'Great point!',
  threadId: thread.id,
});
```

### Agent sessions with tool whitelisting

```typescript
// Create an agent session (auto-creates an agent-type room)
const { session, room } = await chat.createAgentSession({
  tenantId: 'tenant-1',
  agentId: 'agent-summarizer',
  participantProfileId: 'profile-1',
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

// Emit the agent's reply (internal trusted path, authored as the agent).
// Tool calls are gated fail-closed against the session's allowedTools.
await chat.sendAgentReply({
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
// Get or create a DM room between two profiles
const dmRoom = await chat.getOrCreateDM({
  tenantId: 'tenant-1',
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
| `ChatService` | Facade: `createRoom()`, `sendMessage()`, `startThread()`, `addParticipant()`, `getOrCreateDM()`, `createAgentSession()`, `sendAgentUserMessage()`, `sendAgentReply()`, `updateAgentSessionConfig()` |

### Types

`ChatRoomType`, `ChatRoomStatus`, `ChatRoomOptions`, `ChatMessageType`, `ChatMessageRole`, `ChatMessageOptions`, `ChatMessageSearchFilters`, `ChatParticipantRole`, `ChatParticipantStatus`, `ChatParticipantOptions`, `OnlineStatus`, `ChatThreadOptions`, `ChatReactionOptions`, `AgentSessionStatus`, `AgentSessionOptions`

### Constants

`CHAT_MODULE_META`, `CHAT_UI_SLOTS`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-types` -- shared type definitions
- Peer (optional): `@happyvertical/smrt-agents`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-svelte`
