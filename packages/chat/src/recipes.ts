/**
 * Team chat recipe: rooms, messages, membership, threads, and reactions.
 *
 * The recipe is declaration-only. Chat writes remain behind ChatService's
 * membership and owner checks; the model surfaces listed here are read-only.
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import {
  ChatMessage,
  ChatParticipant,
  ChatReaction,
  ChatRoom,
  ChatThread,
} from './models/index.js';

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
  static nav = [{ label: 'Chat Rooms', model: ChatRoom }];
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
