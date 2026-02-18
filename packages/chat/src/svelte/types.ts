/** Room data for UI consumption (decoupled from ORM model) */
export interface ChatRoomData {
  id: string;
  name: string;
  description: string;
  roomType: 'public' | 'private' | 'dm' | 'agent';
  topic: string;
  avatarUrl?: string;
  participantCount: number;
  unreadCount: number;
  lastMessage?: ChatMessageData;
  lastMessageAt?: string | Date | null;
  isPinned?: boolean;
  isMuted?: boolean;
}

/** Message data for UI consumption */
export interface ChatMessageData {
  id: string;
  roomId: string;
  threadId?: string | null;
  senderProfileId: string;
  senderName: string;
  senderAvatarUrl?: string;
  agentSessionId?: string | null;
  content: string;
  messageType:
    | 'text'
    | 'system'
    | 'action'
    | 'file'
    | 'tool_call'
    | 'tool_result';
  role: 'user' | 'assistant' | 'system' | 'tool';
  isEdited: boolean;
  isDeleted: boolean;
  replyTo?: { id: string; senderName: string; content: string } | null;
  reactions: ReactionSummary[];
  attachments: ChatAttachmentData[];
  toolCallData?: ToolCallDisplayData | null;
  createdAt: string | Date;
}

/** Thread data for UI consumption */
export interface ChatThreadData {
  id: string;
  roomId: string;
  rootMessage: ChatMessageData;
  title: string;
  isResolved: boolean;
  messageCount: number;
  lastMessageAt?: string | Date | null;
  participantCount: number;
}

/** Participant data for UI consumption */
export interface ChatParticipantData {
  id: string;
  profileId: string;
  name: string;
  avatarUrl?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  onlineStatus: 'online' | 'away' | 'dnd' | 'offline';
  lastSeenAt?: string | Date | null;
  nickname?: string;
}

/** Reaction summary for a message */
export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
  profileIds: string[];
}

/** Attachment data for UI consumption */
export interface ChatAttachmentData {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url?: string;
  thumbnailUrl?: string;
}

/** Tool call display data for agent conversations */
export interface ToolCallDisplayData {
  toolName: string;
  toolCallId: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  status: 'pending' | 'running' | 'success' | 'error';
  duration?: number;
  error?: string;
}

/** Agent session data for UI consumption */
export interface AgentSessionData {
  id: string;
  agentId: string;
  agentName: string;
  agentAvatarUrl?: string;
  status: 'active' | 'closed' | 'expired';
  allowedTools: string[];
  messageCount: number;
  createdAt: string | Date;
  lastMessageAt?: string | Date | null;
}

/** Agent descriptor for the agent selector */
export interface AgentDescriptor {
  id: string;
  name: string;
  description: string;
  avatarUrl?: string;
  isAvailable: boolean;
}

/** Tab state for the Facebook-style expandable tabs */
export interface ChatTabState {
  roomId: string;
  room: ChatRoomData;
  isExpanded: boolean;
  isMinimized: boolean;
  unreadCount: number;
}
