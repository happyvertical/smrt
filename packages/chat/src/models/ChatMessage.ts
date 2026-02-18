import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ChatMessageOptions,
  ChatMessageRole,
  ChatMessageType,
} from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_messages',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class ChatMessage extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  roomId: string = '';
  threadId: string | null = null;
  senderProfileId: string = '';
  agentSessionId: string | null = null;

  content: string = '';
  messageType: ChatMessageType = 'text';
  role: ChatMessageRole = 'user';

  isEdited: boolean = false;
  editedAt: Date | null = null;
  isDeleted: boolean = false;
  replyToMessageId: string | null = null;

  metadata: Record<string, unknown> = {};
  toolCallData: Record<string, unknown> | null = null;
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
    if (options.metadata !== undefined) this.metadata = options.metadata;
    if (options.toolCallData !== undefined)
      this.toolCallData = options.toolCallData;
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
