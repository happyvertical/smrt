import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ChatParticipantOptions,
  ChatParticipantRole,
  ChatParticipantStatus,
  OnlineStatus,
} from '../types.js';

/**
 * Room membership row. Internal model — membership must be established and
 * mutated only through the membership/owner-checked {@link ChatService}
 * (S5 #1392). The generated CRUD surface is read-only (`get`/`list`);
 * `create`/`update`/`delete` are NOT generated, otherwise an authenticated
 * caller could POST a ChatParticipant to forge their own membership of any room
 * (privilege escalation) and bypass every downstream membership check.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'chat_participants',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class ChatParticipant extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('ChatRoom', { required: true })
  roomId: string = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  profileId: string = '';
  @field({ required: true })
  role: ChatParticipantRole = 'member';
  @field({ required: true })
  status: ChatParticipantStatus = 'active';
  @field({ required: true })
  onlineStatus: OnlineStatus = 'offline';
  @foreignKey('ChatMessage')
  lastReadMessageId: string | null = null;
  @field()
  lastSeenAt: Date | null = null;
  @field()
  joinedAt: Date | null = null;
  @field()
  nickname: string = '';
  @field()
  isMuted: boolean = false;
  @field()
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
