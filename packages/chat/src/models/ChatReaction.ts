import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ChatReactionOptions } from '../types.js';

/**
 * Message reaction. Internal model — reactions must be added/removed only
 * through the membership-checked {@link ChatService} (S5 #1392). The generated
 * CRUD surface is read-only (`list`); `create`/`update`/`delete` are NOT
 * generated, otherwise a caller could POST a reaction (forging a `profileId`)
 * onto a message in a room they do not belong to, or DELETE another member's
 * reaction, via the raw collection routes — bypassing the room-membership
 * authorization in {@link ChatService.addReaction}/{@link ChatService.removeReaction}.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_reactions',
  api: { include: ['list'] },
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
