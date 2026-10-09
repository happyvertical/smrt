import { describe, expect, it } from 'vitest';
import {
  ChatMessage,
  ChatParticipant,
  ChatReaction,
  ChatRoom,
  ChatThread,
} from './models/index.js';
import { ChatRoomsRecipe } from './recipes.js';
import playground from './svelte/playground.js';

describe('ChatRoomsRecipe', () => {
  it('declares the read-only team chat models under the rooms navigation entry', () => {
    expect(ChatRoomsRecipe.id).toBe('chat.rooms');
    expect(ChatRoomsRecipe.models).toEqual([
      ChatRoom,
      ChatMessage,
      ChatParticipant,
      ChatThread,
      ChatReaction,
    ]);
    expect(ChatRoomsRecipe.nav).toEqual([
      {
        label: 'Chat Rooms',
        model: ChatRoom,
        icon: 'users',
        description: 'Team conversations organized by topic or audience.',
        noun: 'chat room',
      },
    ]);
    expect(ChatRoomsRecipe.group).toEqual({
      id: 'team-collaboration',
      label: 'Team collaboration',
      summary: 'Keep conversations and shared work in one place.',
    });
    expect(ChatRoomsRecipe.section).toEqual({
      id: 'team',
      label: 'Team',
      icon: 'users',
      description: 'People and the conversations that keep them aligned.',
    });
    expect(ChatRoomsRecipe.help).toBe('./chat-rooms.recipe.md');
  });

  it('labels its preview data as static mock fixtures', () => {
    for (const entry of playground.entries) {
      expect(entry.modes?.mock).toMatchObject({
        label: 'Static mock fixture',
        description: expect.stringContaining('no live chat service'),
      });
      expect(entry.modes?.live).toBeUndefined();
    }
  });
});
