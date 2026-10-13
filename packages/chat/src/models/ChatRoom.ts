import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ChatRoomOptions,
  ChatRoomStatus,
  ChatRoomType,
} from '../types.js';

type ChatRoomMetadata = Record<string, unknown>;

/**
 * Chat room supporting public channels, private groups, DMs, and agent conversations.
 *
 * @remarks
 * Room types: `public`, `private`, `dm`, `agent`. Agent rooms are auto-created by
 * {@link ChatService.createAgentSession} with `maxParticipants: 2`. DM rooms are
 * found-or-created via {@link ChatService.getOrCreateDM}. Threads are tracked via
 * {@link ChatThread} linked by `roomId`. Tenant-scoped (required).
 *
 * Internal model — room creation and mutation must go through the
 * membership/owner-checked {@link ChatService} (S5 #1392). The generated CRUD
 * surface is read-only (`get`/`list`); `create`/`update`/`delete` are NOT
 * generated, so a caller cannot forge a room or mutate room state via the raw
 * collection routes, skipping the ChatService authorization paths.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_rooms',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class ChatRoom extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @field({
    description: 'A recognizable name that helps teammates find this room.',
  })
  name: string = '';
  @field({
    description: 'Explain the purpose of the room and who should join.',
  })
  description: string = '';
  @field({
    required: true,
    description:
      'Whether the room is public, private, a direct message, or an assistant conversation.',
  })
  roomType: ChatRoomType = 'public';
  @field({
    required: true,
    description: 'Whether this room is active, archived, or deleted.',
  })
  status: ChatRoomStatus = 'active';
  @field({ description: 'The current subject or focus of the room.' })
  topic: string = '';
  @field({
    description: 'The address of the image used to represent this room.',
  })
  avatarUrl: string = '';
  @field({
    description:
      'Whether the room has been archived from active conversations.',
  })
  isArchived: boolean = false;
  @field({
    description:
      'The maximum number of members; zero means no configured limit.',
  })
  maxParticipants: number = 0;
  @field({
    description: 'Additional room details maintained by the application.',
  })
  metadata: string = '{}';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  @field({ description: 'The person who originally created this room.' })
  createdByProfileId: string = '';
  @field({ description: 'When the most recent message was sent in this room.' })
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
