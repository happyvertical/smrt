import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
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

  @foreignKey('ChatMessage', { required: true })
  messageId: string = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  profileId: string = '';
  @field({ required: true })
  emoji: string = '';

  constructor(options: ChatReactionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.messageId !== undefined) this.messageId = options.messageId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.emoji !== undefined) this.emoji = options.emoji;
  }
}
