import { SmrtCollection } from '@happyvertical/smrt-core';
import { ChatReaction } from '../models/ChatReaction.js';

export class ChatReactionCollection extends SmrtCollection<ChatReaction> {
  static readonly _itemClass = ChatReaction;

  async getByMessage(messageId: string): Promise<ChatReaction[]> {
    return this.list({ where: { messageId } });
  }

  /** Get reaction counts grouped by emoji for a message */
  async getReactionCounts(
    messageId: string,
  ): Promise<Map<string, { count: number; profileIds: string[] }>> {
    const reactions = await this.list({ where: { messageId } });
    const counts = new Map<string, { count: number; profileIds: string[] }>();

    for (const reaction of reactions) {
      const existing = counts.get(reaction.emoji);
      if (existing) {
        existing.count++;
        existing.profileIds.push(reaction.profileId);
      } else {
        counts.set(reaction.emoji, {
          count: 1,
          profileIds: [reaction.profileId],
        });
      }
    }

    return counts;
  }

  /** Toggle a reaction: add if not present, remove if already reacted */
  async toggle(
    messageId: string,
    profileId: string,
    emoji: string,
    tenantId: string,
  ): Promise<{ added: boolean }> {
    const existing = await this.list({
      where: { messageId, profileId, emoji },
    });

    if (existing.length > 0) {
      await existing[0].delete();
      return { added: false };
    }

    const reaction = await this.create({
      tenantId,
      messageId,
      profileId,
      emoji,
    });
    await reaction.save();
    return { added: true };
  }
}
