/**
 * ChatReaction model and collection tests
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatReactionCollection } from '../collections/ChatReactionCollection.js';

describe('ChatReaction', () => {
  let dbPath: string;
  let reactions: ChatReactionCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-reaction-test-${Date.now()}.db`);
    reactions = (await ChatReactionCollection.create({
      db: { type: 'sqlite', url: dbPath },
    })) as ChatReactionCollection;
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Basic CRUD', () => {
    it('should create a reaction', async () => {
      const reaction = await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-1',
        profileId: 'profile-1',
        emoji: '👍',
      });

      expect(reaction.id).toBeDefined();
      expect(reaction.messageId).toBe('msg-1');
      expect(reaction.profileId).toBe('profile-1');
      expect(reaction.emoji).toBe('👍');
    });

    it('should delete a reaction', async () => {
      const reaction = await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-1',
        profileId: 'profile-1',
        emoji: '👍',
      });

      await reaction.delete();

      const loaded = await reactions.get({ id: reaction.id });
      expect(loaded).toBeNull();
    });
  });

  describe('getByMessage', () => {
    it('should get all reactions for a message', async () => {
      await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-1',
        profileId: 'profile-1',
        emoji: '👍',
      });
      await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-1',
        profileId: 'profile-2',
        emoji: '❤️',
      });
      await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-2',
        profileId: 'profile-1',
        emoji: '👍',
      });

      const msgReactions = await reactions.getByMessage('msg-1');
      expect(msgReactions).toHaveLength(2);
    });
  });

  describe('getReactionCounts', () => {
    it('should return counts grouped by emoji', async () => {
      await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-1',
        profileId: 'profile-1',
        emoji: '👍',
      });
      await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-1',
        profileId: 'profile-2',
        emoji: '👍',
      });
      await reactions.create({
        tenantId: 'tenant-1',
        messageId: 'msg-1',
        profileId: 'profile-3',
        emoji: '❤️',
      });

      const counts = await reactions.getReactionCounts('msg-1');

      expect(counts.get('👍')).toEqual({
        count: 2,
        profileIds: ['profile-1', 'profile-2'],
      });
      expect(counts.get('❤️')).toEqual({
        count: 1,
        profileIds: ['profile-3'],
      });
    });

    it('should return empty map for message with no reactions', async () => {
      const counts = await reactions.getReactionCounts('msg-none');
      expect(counts.size).toBe(0);
    });
  });

  describe('toggle', () => {
    it('should add a reaction when not present', async () => {
      const result = await reactions.toggle(
        'msg-1',
        'profile-1',
        '👍',
        'tenant-1',
      );

      expect(result.added).toBe(true);

      const msgReactions = await reactions.getByMessage('msg-1');
      expect(msgReactions).toHaveLength(1);
    });

    it('should remove a reaction when already present', async () => {
      // Add first
      await reactions.toggle('msg-1', 'profile-1', '👍', 'tenant-1');

      // Toggle removes
      const result = await reactions.toggle(
        'msg-1',
        'profile-1',
        '👍',
        'tenant-1',
      );

      expect(result.added).toBe(false);

      const msgReactions = await reactions.getByMessage('msg-1');
      expect(msgReactions).toHaveLength(0);
    });

    it('should only toggle the specific emoji', async () => {
      await reactions.toggle('msg-1', 'profile-1', '👍', 'tenant-1');
      await reactions.toggle('msg-1', 'profile-1', '❤️', 'tenant-1');

      // Toggle only removes thumbs up
      await reactions.toggle('msg-1', 'profile-1', '👍', 'tenant-1');

      const msgReactions = await reactions.getByMessage('msg-1');
      expect(msgReactions).toHaveLength(1);
      expect(msgReactions[0].emoji).toBe('❤️');
    });

    it('should be profile-scoped (different profiles can react with same emoji)', async () => {
      await reactions.toggle('msg-1', 'profile-1', '👍', 'tenant-1');
      await reactions.toggle('msg-1', 'profile-2', '👍', 'tenant-1');

      const msgReactions = await reactions.getByMessage('msg-1');
      expect(msgReactions).toHaveLength(2);

      // Toggle only removes profile-1's reaction
      await reactions.toggle('msg-1', 'profile-1', '👍', 'tenant-1');

      const remaining = await reactions.getByMessage('msg-1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].profileId).toBe('profile-2');
    });
  });
});
