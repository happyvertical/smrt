/**
 * TwitterAccount model - Twitter/X account extending the Account STI base
 */

import { smrt } from '@happyvertical/smrt-core';
import type { TwitterAccountOptions } from '../types';
import { Account } from './Account';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
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
  }
}
