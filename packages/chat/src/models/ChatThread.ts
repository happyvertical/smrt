import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ChatThreadOptions } from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_threads',
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class ChatThread extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('ChatRoom', { required: true })
  roomId: string = '';
  @foreignKey('ChatMessage')
  rootMessageId: string = '';
  @field()
  title: string = '';
  @field()
  isResolved: boolean = false;
  @field()
  messageCount: number = 0;
  @field()
  lastMessageAt: Date | null = null;
  @field()
  participantCount: number = 0;

  constructor(options: ChatThreadOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.roomId !== undefined) this.roomId = options.roomId;
    if (options.rootMessageId !== undefined)
      this.rootMessageId = options.rootMessageId;
    if (options.title !== undefined) this.title = options.title;
    if (options.isResolved !== undefined) this.isResolved = options.isResolved;
    if (options.messageCount !== undefined)
      this.messageCount = options.messageCount;
    if (options.lastMessageAt !== undefined)
      this.lastMessageAt = options.lastMessageAt;
    if (options.participantCount !== undefined)
      this.participantCount = options.participantCount;
  }

  async resolve(): Promise<void> {
    this.isResolved = true;
    await this.save();
  }

  async reopen(): Promise<void> {
    this.isResolved = false;
    await this.save();
  }
}
