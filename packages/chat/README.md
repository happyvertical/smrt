# @happyvertical/smrt-chat

Chat rooms, DMs, threads, and agent conversations for the SMRT framework. Supports public, private, DM, and agent-type rooms with threaded messages, reactions, and agent sessions with tool whitelisting.

## Installation

```bash
pnpm add @happyvertical/smrt-chat
```

## Usage

```typescript
import {
  ChatRoom, ChatRoomCollection,
  ChatMessage, ChatMessageCollection,
  ChatParticipant, ChatParticipantCollection,
  ChatService
} from '@happyvertical/smrt-chat';

// Create a chat room
const rooms = new ChatRoomCollection(db);
const room = await rooms.create({
  name: 'General',
  type: 'public',
  status: 'active',
});
await room.save();

// Add a participant
const participants = new ChatParticipantCollection(db);
await participants.create({
  chatRoomId: room.id,
  profileId: 'user-123',
  role: 'member',
  status: 'active',
});

// Send a message
const messages = new ChatMessageCollection(db);
await messages.create({
  chatRoomId: room.id,
  profileId: 'user-123',
  content: 'Hello everyone!',
  role: 'user',
  type: 'text',
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `ChatRoom` | Room with type (public/private/dm/agent) and status |
| `ChatMessage` | Message with role, type, and optional thread reference |
| `ChatParticipant` | Room member with role and online status |
| `ChatThread` | Threaded conversation within a room |
| `ChatReaction` | Emoji reaction on a message |
| `AgentSession` | AI agent session within a room with tool whitelisting |

### Collections

`ChatRoomCollection`, `ChatMessageCollection`, `ChatParticipantCollection`, `ChatThreadCollection`, `ChatReactionCollection`, `AgentSessionCollection`

### Services

| Export | Description |
|--------|------------|
| `ChatService` | High-level chat operations service |

### Constants

`CHAT_MODULE_META`, `CHAT_UI_SLOTS`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- `@happyvertical/smrt-types` — shared type definitions
- Peer: `@happyvertical/smrt-agents`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-svelte`
