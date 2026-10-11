import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ChatThreadOptions } from '../types.js';

/**
 * Conversation thread. Internal model — threads must be created/mutated only
 * through the membership-checked {@link ChatService} (S5 #1392). The generated
 * CRUD surface is read-only (`get`/`list`); `create`/`update`/`delete` are NOT
 * generated, otherwise a caller could POST a thread rooted in an arbitrary room
 * (or mutate `messageCount`/`isResolved`) via the raw collection routes,
 * bypassing the room-membership authorization in {@link ChatService.startThread}.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_threads',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class ChatThread extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('ChatRoom', { required: true })
  @field({ description: 'The room containing this discussion thread.' })
  roomId: string = '';
  // Nullable FK (S5 #1392): a thread can be opened WITHOUT a root message (e.g.
  // a content/agent-editor thread). The previous `= ''` default wrote an empty
  // string into this FK column, which breaks native-`uuid` DBs (Postgres/DuckDB
  // reject `''` as a uuid). `null` is the correct "no root" value.
  @foreignKey('ChatMessage', { nullable: true })
  @field({
    description:
      'The message that started this thread, when it began as a reply.',
  })
  rootMessageId: string | null = null;
  @field({
    description: 'A short title describing the subject of this thread.',
  })
  title: string = '';
  @field({ description: 'Whether the discussion has reached a resolution.' })
  isResolved: boolean = false;
  @field({ description: 'The number of messages in this thread.' })
  messageCount: number = 0;
  @field({
    description: 'When the most recent message was sent in this thread.',
  })
  lastMessageAt: Date | null = null;
  @field({ description: 'The number of people participating in this thread.' })
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
