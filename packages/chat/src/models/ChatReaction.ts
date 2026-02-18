import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ChatReactionOptions } from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_reactions',
  api: { include: ['list', 'create', 'delete'] },
  mcp: { include: ['list'] },
  cli: false,
})
export class ChatReaction extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  messageId: string = '';
  profileId: string = '';
  emoji: string = '';

  constructor(options: ChatReactionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.messageId !== undefined) this.messageId = options.messageId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.emoji !== undefined) this.emoji = options.emoji;
  }
}
