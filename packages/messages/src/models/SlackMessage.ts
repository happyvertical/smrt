/**
 * SlackMessage model - Slack message extending the Message STI base
 */

import { smrt } from '@happyvertical/smrt-core';
import type { SlackMessageOptions } from '../types';
import { Message } from './Message';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class SlackMessage extends Message {
  channelId = '';
  channelName = '';
  slackTs = ''; // Slack message timestamp (unique ID)
  slackThreadTs = ''; // Thread parent timestamp
  reactions = ''; // JSON array of {name, count, users[]}
  isEdited = false;
  messageType = ''; // 'message', 'bot_message', etc.
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
