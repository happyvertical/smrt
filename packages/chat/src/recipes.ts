/**
 * Declared recipes for smrt-chat (#3719): small, user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { AgentSession } from './models/AgentSession.js';
import { ChatMessage } from './models/ChatMessage.js';
import { ChatParticipant } from './models/ChatParticipant.js';
import { ChatReaction } from './models/ChatReaction.js';
import { ChatRoom } from './models/ChatRoom.js';
import { ChatThread } from './models/ChatThread.js';

/**
 * Assistant: an AI chat dock in the app shell that sees the page you are on.
 *
 * The shell hosts the dock through its `dockToggles`/`ShellDockTool` pair; the
 * toggle button lives in `header.end` by default and the host passes the
 * dock a transport and the shell's data surface registry. Conversations are
 * kept in the agent-session room, thread and message records below, which no
 * screen lists: they are read through the member-checked assistant routes.
 */
export class AssistantRecipe extends SmrtRecipe {
  static id = 'chat.assistant';
  static help = './assistant.recipe.md';
  static label = 'Assistant';
  static summary =
    'Ask an AI assistant about the page you are on, from a dock in the app shell.';
  static synonyms = [
    'ai assistant',
    'ai chat',
    'copilot',
    'chatbot',
    'ask ai',
    'helper',
  ];
  static models = [
    AgentSession,
    ChatRoom,
    ChatParticipant,
    ChatThread,
    ChatMessage,
  ];
  // The dock runs in the browser, with the in-memory transport or a browser
  // model; saved conversations and tool use go through server routes.
  static runtime = 'both' as const;
  static surfaces = [
    {
      kind: 'shell-widget',
      slot: 'header.end',
      export: '@happyvertical/smrt-chat/svelte#AssistantDock',
      label: 'Assistant',
      icon: 'bot',
    },
  ] as const;
  // Names only, never values. A hosted model needs the key for the option the
  // app picks (the other two are unused); the browser options need none.
  static providers = [
    {
      id: 'llm',
      kind: 'llm',
      options: ['openai', 'anthropic', 'gemini', 'webllm', 'bitgpu'],
      required: true,
      secrets: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'],
      browserOptions: ['webllm', 'bitgpu'],
    },
  ] as const;
}
/** Team rooms and their conversations. */
export class ChatRoomsRecipe extends SmrtRecipe {
  static id = 'chat.rooms';
  static help = './chat-rooms.recipe.md';
  static label = 'Team Chat';
  static summary =
    'Organize team conversations in rooms with threads and reactions.';
  static synonyms = ['team chat', 'channels', 'group chat', 'conversations'];
  static models = [
    ChatRoom,
    ChatMessage,
    ChatParticipant,
    ChatThread,
    ChatReaction,
  ];
  static group = {
    id: 'team-collaboration',
    label: 'Team collaboration',
    summary: 'Keep conversations and shared work in one place.',
  };
  static section = {
    id: 'team',
    label: 'Team',
    icon: 'users',
    description: 'People and the conversations that keep them aligned.',
  };
  static nav = [
    {
      label: 'Chat Rooms',
      model: ChatRoom,
      icon: 'users',
      description: 'Team conversations organized by topic or audience.',
      noun: 'chat room',
    },
  ];
  static runtime = 'both' as const;
  static surfaces = [
    {
      kind: 'route',
      path: '/chat/rooms',
      export: '@happyvertical/smrt-chat/svelte#ChatLayout',
      label: 'Team chat',
    },
    {
      kind: 'playground',
      export: '@happyvertical/smrt-chat/playground#default',
      label: 'Static chat fixtures',
    },
  ] as const;
  static demoSeed = {
    export: '@happyvertical/smrt-chat/playground#chatRoomsFixture',
  } as const;
  static options = {
    ChatRoom: {
      fields: {
        metadata: { visibility: 'hidden' },
        createdByProfileId: { visibility: 'hidden' },
        lastMessageAt: { label: 'Last message', order: 1 },
      },
    },
    ChatMessage: {
      fields: {
        metadata: { visibility: 'hidden' },
        toolCallData: { visibility: 'hidden' },
        attachments: { visibility: 'advanced' },
      },
    },
    ChatParticipant: {
      fields: {
        lastReadMessageId: { visibility: 'hidden' },
        lastSeenAt: { visibility: 'advanced' },
      },
    },
  } as const;
}
