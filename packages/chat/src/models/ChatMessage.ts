import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ChatMessageOptions,
  ChatMessageRole,
  ChatMessageType,
} from '../types.js';

/**
 * Chat message. Internal model — all mutations must go through the
 * membership-checked {@link ChatService} (S5 #1392). The generated CRUD surface
 * is read-only (`get`/`list`); `create`/`update`/`delete` are intentionally NOT
 * generated so an authenticated caller cannot write into an arbitrary room via
 * the raw collection routes, bypassing the room-membership authorization in
 * {@link ChatService.sendMessage}.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_messages',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class ChatMessage extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('ChatRoom', { required: true })
  roomId: string = '';
  @foreignKey('ChatThread')
  threadId: string | null = null;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  senderProfileId: string = '';
  @foreignKey('AgentSession')
  agentSessionId: string | null = null;

  @field()
  content: string = '';
  @field({ required: true })
  messageType: ChatMessageType = 'text';
  @field({ required: true })
  role: ChatMessageRole = 'user';

  @field()
  isEdited: boolean = false;
  @field()
  editedAt: Date | null = null;
  @field()
  isDeleted: boolean = false;
  @foreignKey('ChatMessage')
  replyToMessageId: string | null = null;

  @field()
  metadata: string = '{}';
  @field()
  toolCallData: string | null = null;
  @field()
  attachments: string = '[]';

  constructor(options: ChatMessageOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.roomId !== undefined) this.roomId = options.roomId;
    if (options.threadId !== undefined) this.threadId = options.threadId;
    if (options.senderProfileId !== undefined)
      this.senderProfileId = options.senderProfileId;
    if (options.agentSessionId !== undefined)
      this.agentSessionId = options.agentSessionId;
    if (options.content !== undefined) this.content = options.content;
    if (options.messageType !== undefined)
      this.messageType = options.messageType;
    if (options.role !== undefined) this.role = options.role;
    if (options.isEdited !== undefined) this.isEdited = options.isEdited;
    if (options.editedAt !== undefined) this.editedAt = options.editedAt;
    if (options.isDeleted !== undefined) this.isDeleted = options.isDeleted;
    if (options.replyToMessageId !== undefined)
      this.replyToMessageId = options.replyToMessageId;
    if (options.metadata !== undefined)
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    if (options.toolCallData !== undefined)
      this.toolCallData =
        options.toolCallData === null
          ? null
          : typeof options.toolCallData === 'string'
            ? options.toolCallData
            : JSON.stringify(options.toolCallData);
    if (options.attachments !== undefined)
      this.attachments = options.attachments;
  }

  getAttachments(): Array<{
    id: string;
    filename: string;
    contentType: string;
    size: number;
    url?: string;
  }> {
    try {
      return JSON.parse(this.attachments);
    } catch {
      return [];
    }
  }

  setAttachments(
    items: Array<{
      id: string;
      filename: string;
      contentType: string;
      size: number;
      url?: string;
    }>,
  ): void {
    this.attachments = JSON.stringify(items);
  }

  getMetadata(): Record<string, unknown> {
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data);
  }

  getToolCallData(): Record<string, unknown> | null {
    if (!this.toolCallData) return null;
    try {
      return JSON.parse(this.toolCallData);
    } catch {
      return null;
    }
  }

  setToolCallData(data: Record<string, unknown> | null): void {
    this.toolCallData = data ? JSON.stringify(data) : null;
  }

  hasAttachments(): boolean {
    return this.getAttachments().length > 0;
  }

  isToolCall(): boolean {
    return this.messageType === 'tool_call';
  }

  isToolResult(): boolean {
    return this.messageType === 'tool_result';
  }

  isFromAgent(): boolean {
    return this.role === 'assistant';
  }

  isSystemMessage(): boolean {
    return this.role === 'system';
  }

  async edit(newContent: string): Promise<void> {
    this.content = newContent;
    this.isEdited = true;
    this.editedAt = new Date();
    await this.save();
  }

  async softDelete(): Promise<void> {
    this.isDeleted = true;
    this.content = '';
    await this.save();
  }

  getPreview(maxLength = 100): string {
    if (this.isDeleted) return '(deleted)';
    const text = this.content || '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  }
}
