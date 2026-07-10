import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

// ---- Enums / Literal Unions ----

export type ChatRoomType = 'public' | 'private' | 'dm' | 'agent';
export type ChatRoomStatus = 'active' | 'archived' | 'deleted';
export type ChatParticipantRole = 'owner' | 'admin' | 'member' | 'viewer';
export type ChatParticipantStatus = 'active' | 'left' | 'kicked' | 'banned';
export type OnlineStatus = 'online' | 'away' | 'dnd' | 'offline';
export type ChatMessageType =
  | 'text'
  | 'system'
  | 'action'
  | 'file'
  | 'tool_call'
  | 'tool_result';
export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type AgentSessionStatus = 'active' | 'closed' | 'expired';
export type VoiceSessionStatus = 'active' | 'expired' | 'revoked';
export type VoiceGatewayTurnStatus = 'processing' | 'completed' | 'failed';

// ---- Options Interfaces ----

export interface ChatRoomOptions extends SmrtObjectOptions {
  tenantId?: string;
  name?: string;
  description?: string;
  roomType?: ChatRoomType;
  status?: ChatRoomStatus;
  topic?: string;
  avatarUrl?: string;
  isArchived?: boolean;
  maxParticipants?: number;
  metadata?: Record<string, unknown> | string;
  createdByProfileId?: string;
  lastMessageAt?: Date | null;
}

export interface ChatThreadOptions extends SmrtObjectOptions {
  tenantId?: string;
  roomId?: string;
  rootMessageId?: string | null;
  title?: string;
  isResolved?: boolean;
  messageCount?: number;
  lastMessageAt?: Date | null;
  participantCount?: number;
}

export interface ChatMessageOptions extends SmrtObjectOptions {
  tenantId?: string;
  roomId?: string;
  threadId?: string | null;
  senderProfileId?: string;
  agentSessionId?: string | null;
  content?: string;
  messageType?: ChatMessageType;
  role?: ChatMessageRole;
  editedAt?: Date | null;
  isEdited?: boolean;
  isDeleted?: boolean;
  replyToMessageId?: string | null;
  metadata?: Record<string, unknown> | string;
  toolCallData?: Record<string, unknown> | string | null;
  attachments?: string;
}

export interface ChatParticipantOptions extends SmrtObjectOptions {
  tenantId?: string;
  roomId?: string;
  profileId?: string;
  role?: ChatParticipantRole;
  status?: ChatParticipantStatus;
  onlineStatus?: OnlineStatus;
  lastReadMessageId?: string | null;
  lastSeenAt?: Date | null;
  joinedAt?: Date | null;
  nickname?: string;
  isMuted?: boolean;
  isPinned?: boolean;
}

export interface ChatReactionOptions extends SmrtObjectOptions {
  tenantId?: string;
  messageId?: string;
  profileId?: string;
  emoji?: string;
}

export interface AgentSessionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  agentId?: string;
  participantProfileId?: string;
  chatRoomId?: string | null;
  status?: AgentSessionStatus;
  allowedTools?: string;
  sessionContext?: string;
  systemPrompt?: string;
  messageCount?: number;
  totalTokensUsed?: number;
  maxTokens?: number;
  maxMessages?: number;
  lastMessageAt?: Date | null;
  expiresAt?: Date | null;
  closedAt?: Date | null;
}

export interface VoiceSessionOptions extends SmrtObjectOptions {
  tenantId?: string;
  gatewaySessionId?: string;
  actorProfileId?: string;
  actorUserId?: string | null;
  personaId?: string;
  agentSessionId?: string;
  chatRoomId?: string;
  threadId?: string | null;
  target?: string;
  status?: VoiceSessionStatus;
  expiresAt?: Date;
  lastTurnAt?: Date | null;
  lastGatewayTurnId?: string | null;
  personaSnapshot?: Record<string, unknown> | string;
  metadata?: Record<string, unknown> | string;
  processedTurnIds?: string[] | string;
}

export interface VoiceGatewayTurnOptions extends SmrtObjectOptions {
  tenantId?: string;
  voiceSessionId?: string;
  gatewaySessionId?: string;
  gatewayTurnId?: string;
  target?: string;
  status?: VoiceGatewayTurnStatus;
  completedAt?: Date | null;
  failedAt?: Date | null;
}

// ---- Search / Filter types ----

export interface ChatMessageSearchFilters {
  roomId?: string;
  threadId?: string;
  senderProfileId?: string;
  messageType?: ChatMessageType;
  role?: ChatMessageRole;
  sinceDate?: Date;
  beforeDate?: Date;
  query?: string;
  hasAttachments?: boolean;
}
