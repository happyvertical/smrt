/**
 * TwitterAccount model - Twitter/X account extending the Account STI base
 */

// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import { smrt } from '@happyvertical/smrt-core';
import type { MessageSenderInterface, TwitterAccountOptions } from '../types';
import { Account } from './Account';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class TwitterAccount extends Account {
  handle = '';
  twitterUserId = '';

  constructor(options: TwitterAccountOptions = {}) {
    super(options);

    if (options.handle !== undefined) this.handle = options.handle;
    if (options.twitterUserId !== undefined)
      this.twitterUserId = options.twitterUserId;

    // Default provider type
    if (!this.providerType) this.providerType = 'twitter';
    this.channelType = 'twitter';
  }

  /**
   * Create a sender for this Twitter account
   */
  override async createSender(): Promise<MessageSenderInterface> {
    const { TweetSender } = await import('../senders/TweetSender');
    return new TweetSender(this);
  }
}
