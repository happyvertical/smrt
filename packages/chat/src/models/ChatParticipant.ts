import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ChatParticipantOptions,
  ChatParticipantRole,
  ChatParticipantStatus,
  OnlineStatus,
} from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_participants',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class ChatParticipant extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  roomId: string = '';
  profileId: string = '';
  role: ChatParticipantRole = 'member';
  status: ChatParticipantStatus = 'active';
  onlineStatus: OnlineStatus = 'offline';
  lastReadMessageId: string | null = null;
  lastSeenAt: Date | null = null;
  joinedAt: Date = new Date();
  nickname: string = '';
  isMuted: boolean = false;
  isPinned: boolean = false;

  constructor(options: ChatParticipantOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.roomId !== undefined) this.roomId = options.roomId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.role !== undefined) this.role = options.role;
    if (options.status !== undefined) this.status = options.status;
    if (options.onlineStatus !== undefined)
      this.onlineStatus = options.onlineStatus;
    if (options.lastReadMessageId !== undefined)
      this.lastReadMessageId = options.lastReadMessageId;
    if (options.lastSeenAt !== undefined) this.lastSeenAt = options.lastSeenAt;
    if (options.joinedAt !== undefined) this.joinedAt = options.joinedAt;
    if (options.nickname !== undefined) this.nickname = options.nickname;
    if (options.isMuted !== undefined) this.isMuted = options.isMuted;
    if (options.isPinned !== undefined) this.isPinned = options.isPinned;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  isOwner(): boolean {
    return this.role === 'owner';
  }

  isAdmin(): boolean {
    return this.role === 'admin' || this.role === 'owner';
  }

  async markRead(messageId: string): Promise<void> {
    this.lastReadMessageId = messageId;
    this.lastSeenAt = new Date();
    await this.save();
  }

  async leave(): Promise<void> {
    this.status = 'left';
    await this.save();
  }

  async setOnline(status: OnlineStatus): Promise<void> {
    this.onlineStatus = status;
    this.lastSeenAt = new Date();
    await this.save();
  }
}
