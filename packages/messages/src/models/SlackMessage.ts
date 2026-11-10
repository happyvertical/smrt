/**
 * SlackMessage model - Slack message extending the Message STI base
 */

// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import { field, smrt } from '@happyvertical/smrt-core';
import type { SlackMessageOptions } from '../types';
import { Message } from './Message';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
  // Message is read-only over REST; this provider type is writable there.
  widenParentExposure: { api: ['create'] },
})
export class SlackMessage extends Message {
  @field({ description: 'The identifier of the channel this message is in.' })
  channelId = '';
  @field({ description: 'The name of the channel this message was posted in.' })
  channelName = '';
  @field({ description: "The workspace's own reference for this message." })
  slackTs = ''; // Slack message timestamp (unique ID)
  @field({
    description:
      "The workspace's own reference for the thread this message belongs to.",
  })
  slackThreadTs = ''; // Thread parent timestamp
  @field({ description: 'The reactions people added to this message.' })
  reactions = ''; // JSON array of {name, count, users[]}
  @field({ description: 'Whether this message was edited after posting.' })
  isEdited = false;
  @field({
    description: 'The kind of message, such as one from a person or a bot.',
  })
  messageType = ''; // 'message', 'bot_message', etc.
  @field({
    description: 'The rich layout of the message as the workspace stores it.',
  })
  blocks = ''; // JSON - Slack Block Kit blocks

  constructor(options: SlackMessageOptions = {}) {
    super(options);

    if (options.channelId !== undefined) this.channelId = options.channelId;
    if (options.channelName !== undefined)
      this.channelName = options.channelName;
    if (options.slackTs !== undefined) this.slackTs = options.slackTs;
    if (options.slackThreadTs !== undefined)
      this.slackThreadTs = options.slackThreadTs;
    if (options.reactions !== undefined) this.reactions = options.reactions;
    if (options.isEdited !== undefined) this.isEdited = options.isEdited;
    if (options.messageType !== undefined)
      this.messageType = options.messageType;
    if (options.blocks !== undefined) this.blocks = options.blocks;
  }

  /**
   * Get reactions as parsed array
   */
  getReactions(): Array<{ name: string; count: number; users?: string[] }> {
    if (!this.reactions) return [];
    try {
      return JSON.parse(this.reactions);
    } catch {
      return [];
    }
  }

  /**
   * Get blocks as parsed array
   */
  getBlocks(): Record<string, unknown>[] {
    if (!this.blocks) return [];
    try {
      return JSON.parse(this.blocks);
    } catch {
      return [];
    }
  }

  /**
   * Check if message is in a thread
   */
  isInThread(): boolean {
    return !!this.slackThreadTs && this.slackThreadTs !== this.slackTs;
  }

  /**
   * Get total reaction count
   */
  getTotalReactions(): number {
    return this.getReactions().reduce((sum, r) => sum + r.count, 0);
  }
}
