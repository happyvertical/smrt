import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ChatRoomOptions,
  ChatRoomStatus,
  ChatRoomType,
} from '../types.js';

type ChatRoomMetadata = Record<string, unknown>;

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_rooms',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class ChatRoom extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  name: string = '';
  description: string = '';
  roomType: ChatRoomType = 'public';
  status: ChatRoomStatus = 'active';
  topic: string = '';
  avatarUrl: string = '';
  isArchived: boolean = false;
  maxParticipants: number = 0;
  metadata: string = '{}';
  createdByProfileId: string = '';
  lastMessageAt: Date | null = null;

  constructor(options: ChatRoomOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.roomType !== undefined) this.roomType = options.roomType;
    if (options.status !== undefined) this.status = options.status;
    if (options.topic !== undefined) this.topic = options.topic;
    if (options.avatarUrl !== undefined) this.avatarUrl = options.avatarUrl;
    if (options.isArchived !== undefined) this.isArchived = options.isArchived;
    if (options.maxParticipants !== undefined)
      this.maxParticipants = options.maxParticipants;
    if (options.metadata !== undefined)
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    if (options.createdByProfileId !== undefined)
      this.createdByProfileId = options.createdByProfileId;
    if (options.lastMessageAt !== undefined)
      this.lastMessageAt = options.lastMessageAt;
  }

  getMetadata(): ChatRoomMetadata {
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  setMetadata(data: ChatRoomMetadata): void {
    this.metadata = JSON.stringify(data);
  }

  updateMetadata(updates: ChatRoomMetadata): void {
    const current = this.getMetadata();
    this.metadata = JSON.stringify({ ...current, ...updates });
  }

  isDM(): boolean {
    return this.roomType === 'dm';
  }

  isAgentRoom(): boolean {
    return this.roomType === 'agent';
  }

  isPublic(): boolean {
    return this.roomType === 'public';
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  async archive(): Promise<void> {
    this.isArchived = true;
    this.status = 'archived';
    await this.save();
  }

  async unarchive(): Promise<void> {
    this.isArchived = false;
    this.status = 'active';
    await this.save();
  }
}
