/**
 * SlackAccount model - Slack workspace account extending the Account STI base
 */

import { smrt } from '@happyvertical/smrt-core';
import type { SlackAccountOptions } from '../types';
import { Account } from './Account';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class SlackAccount extends Account {
  workspaceId = '';
  workspaceName = '';
  botUserId = '';

  constructor(options: SlackAccountOptions = {}) {
    super(options);

    if (options.workspaceId !== undefined)
      this.workspaceId = options.workspaceId;
    if (options.workspaceName !== undefined)
      this.workspaceName = options.workspaceName;
    if (options.botUserId !== undefined) this.botUserId = options.botUserId;

    // Default provider type
    if (!this.providerType) this.providerType = 'slack';
  }
}
