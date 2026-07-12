import { smrt } from '@happyvertical/smrt-core';
import type { AccountOptions } from '../types.js';
import { Account } from './Account.js';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class ZulipAccount extends Account {
  constructor(options: AccountOptions = {}) {
    super(options);
    this.providerType = 'zulip';
    this.channelType = 'zulip';
  }
}
