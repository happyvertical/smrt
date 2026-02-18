# @happyvertical/smrt-chat

Chat rooms, DMs, threads, and agent conversations for the SMRT framework.

## Purpose

This package provides SMRT-wrapped models for real-time chat:

- **ChatRoom**: Public/private channels, DMs, and agent conversation rooms
- **ChatThread**: Slack-style threaded conversations within rooms
- **ChatMessage**: Messages shared by users and agents (unified model)
- **ChatParticipant**: Room membership with roles and presence
- **ChatReaction**: Emoji reactions on messages
- **AgentSession**: Agent conversation session tracking with tool access control

## Architecture

```
Profile (smrt-profiles)
   ↑
   └── ChatParticipant (profileId + role, onlineStatus)
         ↓
ChatRoom (public | private | dm | agent)
   → ChatParticipant[] (owner, admin, member, viewer)
   → ChatMessage[] (text, system, file, tool_call, tool_result)
   → ChatThread[] (threaded sub-conversations)
         ↓
AgentSession (optional)
   → agentId (string ref to Agent)
   → allowedTools (JSON string array — app-controlled)
   → chatRoomId → ChatRoom (roomType: 'agent')
```

### Key Design: Shared Messages

Agent conversations reuse `ChatMessage` — no separate model. The `agentSessionId` field links messages to sessions. `role` (user/assistant/system/tool) and `messageType` (text/tool_call/tool_result) handle agent semantics.

### Key Design: App-Controlled Tool Access

`AgentSession.allowedTools` is a simple JSON string array. The consuming app decides which tools to pass at session creation. No tool tiers or scoping baked into the framework.

### Key Design: sessionContext (not context)

`SmrtObject` reserves `context` for slug scoping. Agent session memory uses `sessionContext` (JSON string) with helpers: `getSessionContext()`, `setSessionContext()`, `updateSessionContext()`.

## Usage

### Basic Setup

```typescript
import { ChatService } from '@happyvertical/smrt-chat';

const chat = await ChatService.create({
  persistence: { type: 'sql', url: 'chat.db' }
});
```

### Creating Rooms and Sending Messages

```typescript
// Create a room (automatically adds owner as participant)
const room = await chat.createRoom({
  tenantId: 'tenant-1',
  name: 'General',
  roomType: 'public',
  createdByProfileId: 'profile-1',
});

// Send a message (automatically updates room timestamps)
const message = await chat.sendMessage({
  tenantId: 'tenant-1',
  roomId: room.id,
  senderProfileId: 'profile-1',
  content: 'Hello, world!',
});

// Start a thread
const thread = await chat.startThread({
  tenantId: 'tenant-1',
  roomId: room.id,
  rootMessageId: message.id,
  title: 'Discussion',
});
```

### Direct Messages

```typescript
// Idempotent — returns existing DM room if one exists
const dm = await chat.getOrCreateDM({
  tenantId: 'tenant-1',
  profileId1: 'alice',
  profileId2: 'bob',
});
```

### Agent Conversations

```typescript
// Create agent session (creates room + participant + session)
const { room, session } = await chat.createAgentSession({
  tenantId: 'tenant-1',
  agentId: 'agent-helper',
  participantProfileId: 'profile-1',
  allowedTools: ['search', 'calculator'],
  systemPrompt: 'You are a helpful assistant.',
});

// Send agent message (validates session is active)
await chat.sendAgentMessage({
  tenantId: 'tenant-1',
  sessionId: session.id,
  content: 'How can I help?',
  role: 'assistant',
});
```

## Models Reference

### ChatRoom

| Field | Type | Description |
|-------|------|-------------|
| tenantId | string | Tenant scope (required) |
| name | string | Room display name |
| description | string | Room description |
| roomType | ChatRoomType | public, private, dm, agent |
| status | ChatRoomStatus | active, archived, deleted |
| topic | string | Current room topic |
| avatarUrl | string | Room avatar |
| isArchived | boolean | Archive flag |
| maxParticipants | number | Max allowed members |
| metadata | string (JSON) | Arbitrary metadata |
| createdByProfileId | string | Creator profile |
| lastMessageAt | Date | Last message timestamp |

Methods: `isDM()`, `isAgentRoom()`, `isPublic()`, `isActive()`, `archive()`, `unarchive()`

### ChatMessage

| Field | Type | Description |
|-------|------|-------------|
| tenantId | string | Tenant scope |
| roomId | string | Parent room |
| threadId | string? | Thread (null = root message) |
| senderProfileId | string | Sender profile |
| agentSessionId | string? | Agent session link |
| content | string | Message body |
| messageType | ChatMessageType | text, system, action, file, tool_call, tool_result |
| role | ChatMessageRole | user, assistant, system, tool |
| isEdited | boolean | Edit flag |
| isDeleted | boolean | Soft delete flag |
| replyToMessageId | string? | Reply-to reference |
| attachments | string (JSON) | File attachments |
| toolCallData | string (JSON) | Tool call metadata |

Methods: `getAttachments()`, `setAttachments()`, `isToolCall()`, `isFromAgent()`, `edit()`, `softDelete()`, `getPreview()`

### AgentSession

| Field | Type | Description |
|-------|------|-------------|
| tenantId | string? | Tenant scope (optional) |
| agentId | string | Agent identifier |
| participantProfileId | string | Human participant |
| chatRoomId | string? | Associated chat room |
| status | AgentSessionStatus | active, closed, expired |
| allowedTools | string (JSON) | Tool whitelist (app-controlled) |
| sessionContext | string (JSON) | Conversation memory |
| systemPrompt | string | System prompt override |
| messageCount | number | Messages sent |
| totalTokensUsed | number | Token usage tracking |
| maxTokens | number | Token limit (0 = unlimited) |
| maxMessages | number | Message limit (0 = unlimited) |

Methods: `getAllowedTools()`, `setAllowedTools()`, `isActive()`, `close()`, `expire()`, `getSessionContext()`, `setSessionContext()`, `updateSessionContext()`, `recordMessage()`

## Collections

- **ChatRoomCollection**: `findByType()`, `findPublic()`, `findDMs()`, `findAgentRooms()`, `search()`, `findOrCreateDM()`
- **ChatMessageCollection**: `getByRoom()` (paginated), `getByThread()`, `getByAgentSession()`, `search(filters)`, `getUnreadCount()`, `getLatestPerRoom()`
- **ChatParticipantCollection**: `getByRoom()`, `getByProfile()`, `findMembership()`, `getOnlineInRoom()`, `getAdminsInRoom()`, `countInRoom()`
- **ChatThreadCollection**: `getByRoom()`, `getActive()`, `getUnresolved()`
- **ChatReactionCollection**: `getByMessage()`, `getReactionCounts()`, `toggle()`
- **AgentSessionCollection**: `findActiveByParticipant()`, `findActiveSession()`, `findOrCreate()`, `findByAgent()`, `expireStale()`

## Svelte Components

Import from `@happyvertical/smrt-chat/svelte`. All components use Svelte 5 runes and `--smrt-*` CSS variables.

### Layout (4)
`ChatLayout`, `RoomList`, `RoomHeader`, `MemberList`

### Messages (4)
`MessageList`, `MessageItem`, `MessageInput`, `ThreadPanel`

### Tabs (4)
`ChatTabs`, `ChatTab`, `ChatTabList`, `MiniChat`

### Agent (4)
`AgentChat`, `AgentSelector`, `AgentSessionPanel`, `ToolCallDisplay`

### Shared (9)
`Avatar`, `FileUpload`, `LinkPreview`, `MentionAutocomplete`, `MessageBubble`, `ReactionPicker`, `ReadReceipts`, `TypingIndicator`, `UserPresence`

### Dialogs (2)
`RoomCreateDialog`, `SearchMessages`

Components auto-register with `ModuleUIRegistry` on import.

## Testing

```bash
npx vitest run
```

## Dependencies

- `@happyvertical/smrt-core`: SMRT framework
- `@happyvertical/smrt-tenancy`: Multi-tenancy
- `@happyvertical/smrt-types`: Shared types
- `@happyvertical/smrt-agents` (optional peer): Agent framework
- `@happyvertical/smrt-profiles` (optional peer): Profile linking
- `@happyvertical/smrt-svelte` (optional peer): Component registry
- `svelte` (optional peer): Svelte 5 for UI components
