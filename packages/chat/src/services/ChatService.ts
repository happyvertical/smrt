import {
  ObjectRegistry,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import { AgentSessionCollection } from '../collections/AgentSessionCollection.js';
import { ChatMessageCollection } from '../collections/ChatMessageCollection.js';
import { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';
import { ChatRoomCollection } from '../collections/ChatRoomCollection.js';
import { ChatThreadCollection } from '../collections/ChatThreadCollection.js';
import type {
  ChatMessageRole,
  ChatMessageType,
  ChatParticipantRole,
  ChatRoomType,
} from '../types.js';

export class ChatService {
  readonly rooms: ChatRoomCollection;
  readonly messages: ChatMessageCollection;
  readonly participants: ChatParticipantCollection;
  readonly threads: ChatThreadCollection;
  readonly agentSessions: AgentSessionCollection;

  private constructor(
    rooms: ChatRoomCollection,
    messages: ChatMessageCollection,
    participants: ChatParticipantCollection,
    threads: ChatThreadCollection,
    agentSessions: AgentSessionCollection,
  ) {
    this.rooms = rooms;
    this.messages = messages;
    this.participants = participants;
    this.threads = threads;
    this.agentSessions = agentSessions;
  }

  static async create(options: SmrtObjectOptions): Promise<ChatService> {
    ObjectRegistry.registerCollection(
      '@happyvertical/smrt-chat:ChatRoom',
      ChatRoomCollection,
    );
    ObjectRegistry.registerCollection(
      '@happyvertical/smrt-chat:ChatMessage',
      ChatMessageCollection,
    );
    ObjectRegistry.registerCollection(
      '@happyvertical/smrt-chat:ChatParticipant',
      ChatParticipantCollection,
    );
    ObjectRegistry.registerCollection(
      '@happyvertical/smrt-chat:ChatThread',
      ChatThreadCollection,
    );
    ObjectRegistry.registerCollection(
      '@happyvertical/smrt-chat:AgentSession',
      AgentSessionCollection,
    );

    const rooms = (await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:ChatRoom',
      options,
    )) as ChatRoomCollection;
    const messages = (await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:ChatMessage',
      options,
    )) as ChatMessageCollection;
    const participants = (await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:ChatParticipant',
      options,
    )) as ChatParticipantCollection;
    const threads = (await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:ChatThread',
      options,
    )) as ChatThreadCollection;
    const agentSessions = (await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:AgentSession',
      options,
    )) as AgentSessionCollection;

    return new ChatService(
      rooms,
      messages,
      participants,
      threads,
      agentSessions,
    );
  }

  /** Initialize all underlying collections (table creation) */
  async initialize(): Promise<void> {
    await this.rooms.initialize();
    await this.messages.initialize();
    await this.participants.initialize();
    await this.threads.initialize();
    await this.agentSessions.initialize();
  }

  /** Create a room and add the creator as owner */
  async createRoom(params: {
    tenantId: string;
    name: string;
    roomType: ChatRoomType;
    createdByProfileId: string;
    description?: string;
    topic?: string;
  }) {
    const room = await this.rooms.create({
      tenantId: params.tenantId,
      name: params.name,
      roomType: params.roomType,
      createdByProfileId: params.createdByProfileId,
      description: params.description ?? '',
      topic: params.topic ?? '',
      status: 'active',
    });

    await this.participants.create({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.createdByProfileId,
      role: 'owner' as ChatParticipantRole,
      status: 'active',
      joinedAt: new Date(),
    });

    return room;
  }

  /**
   * Send a message to a room.
   *
   * Enforces room-membership authorization (S5 #1392): the sender must be an
   * ACTIVE participant of the target room, preventing cross-room IDOR within a
   * tenant. System-authored messages (no senderProfileId, e.g. service events)
   * may pass `skipMembershipCheck` for trusted internal callers only.
   */
  async sendMessage(params: {
    tenantId: string;
    roomId: string;
    senderProfileId: string;
    content: string;
    messageType?: ChatMessageType;
    role?: ChatMessageRole;
    threadId?: string | null;
    agentSessionId?: string | null;
    replyToMessageId?: string | null;
    toolCallData?: Record<string, unknown> | null;
    skipMembershipCheck?: boolean;
  }) {
    if (!params.skipMembershipCheck) {
      const isMember = await this.participants.isActiveMember(
        params.roomId,
        params.senderProfileId,
      );
      if (!isMember) {
        throw new Error(
          'Sender is not an active member of the room (authorization denied)',
        );
      }
    }

    const message = await this.messages.create({
      tenantId: params.tenantId,
      roomId: params.roomId,
      senderProfileId: params.senderProfileId,
      content: params.content,
      messageType: params.messageType ?? 'text',
      role: params.role ?? 'user',
      threadId: params.threadId ?? null,
      agentSessionId: params.agentSessionId ?? null,
      replyToMessageId: params.replyToMessageId ?? null,
      toolCallData: params.toolCallData
        ? JSON.stringify(params.toolCallData)
        : null,
    });

    // Update room's lastMessageAt
    const room = await this.rooms.get({ id: params.roomId });
    if (room) {
      room.lastMessageAt = new Date();
      await room.save();
    }

    // Update thread stats if threaded
    if (params.threadId) {
      const thread = await this.threads.get({ id: params.threadId });
      if (thread) {
        thread.messageCount++;
        thread.lastMessageAt = new Date();
        await thread.save();
      }
    }

    // Record on agent session if applicable
    if (params.agentSessionId) {
      const session = await this.agentSessions.get({
        id: params.agentSessionId,
      });
      if (session) {
        await session.recordMessage();
      }
    }

    return message;
  }

  /** Start a thread from a message */
  async startThread(params: {
    tenantId: string;
    roomId: string;
    rootMessageId: string;
    title?: string;
  }) {
    const thread = await this.threads.create({
      tenantId: params.tenantId,
      roomId: params.roomId,
      rootMessageId: params.rootMessageId,
      title: params.title ?? '',
      messageCount: 0,
    });
    return thread;
  }

  /** Add a participant to a room */
  async addParticipant(params: {
    tenantId: string;
    roomId: string;
    profileId: string;
    role?: ChatParticipantRole;
  }) {
    const existing = await this.participants.findMembership(
      params.roomId,
      params.profileId,
    );
    if (existing) {
      if (existing.status !== 'active') {
        existing.status = 'active';
        existing.joinedAt = new Date();
        await existing.save();
      }
      return existing;
    }

    const participant = await this.participants.create({
      tenantId: params.tenantId,
      roomId: params.roomId,
      profileId: params.profileId,
      role: params.role ?? 'member',
      status: 'active',
      joinedAt: new Date(),
    });
    return participant;
  }

  /** Get or create a DM room with auto-participant setup */
  async getOrCreateDM(params: {
    tenantId: string;
    profileId1: string;
    profileId2: string;
  }) {
    const room = await this.rooms.findOrCreateDM(
      params.profileId1,
      params.profileId2,
      params.tenantId,
      this.participants,
    );

    await this.addParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.profileId1,
    });
    await this.addParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.profileId2,
    });

    return room;
  }

  /** Create an agent conversation session with a linked chat room */
  async createAgentSession(params: {
    tenantId: string;
    agentId: string;
    participantProfileId: string;
    allowedTools?: string[];
    systemPrompt?: string;
    maxTokens?: number;
    maxMessages?: number;
  }) {
    // Check for existing active session first to avoid orphaned rooms
    const existingSession = await this.agentSessions.findActiveSession(
      params.agentId,
      params.participantProfileId,
    );
    if (existingSession && existingSession.tenantId === params.tenantId) {
      if (existingSession.chatRoomId) {
        const existingRoom = await this.rooms.get({
          id: existingSession.chatRoomId,
        });
        if (existingRoom) {
          return { session: existingSession, room: existingRoom };
        }
      }
      // Session exists but room is missing/orphaned — expire it so we create fresh
      await existingSession.expire();
    }

    // Create an agent-type room for this session
    const room = await this.rooms.create({
      tenantId: params.tenantId,
      name: '',
      roomType: 'agent',
      createdByProfileId: params.participantProfileId,
      status: 'active',
      maxParticipants: 2,
    });

    // Add participant
    await this.addParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.participantProfileId,
      role: 'owner',
    });

    // Add the agent itself as a member so its assistant/tool messages pass the
    // room-membership authorization check in sendMessage (S5 #1392).
    await this.addParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.agentId,
      role: 'member',
    });

    // Create session
    const session = await this.agentSessions.findOrCreate({
      agentId: params.agentId,
      participantProfileId: params.participantProfileId,
      tenantId: params.tenantId,
      allowedTools: params.allowedTools,
      chatRoomId: room.id as string,
      systemPrompt: params.systemPrompt,
    });

    if (params.maxTokens) session.maxTokens = params.maxTokens;
    if (params.maxMessages) session.maxMessages = params.maxMessages;
    await session.save();

    return { session, room };
  }

  /** Send a message within an agent session */
  async sendAgentMessage(params: {
    tenantId: string;
    agentSessionId: string;
    senderProfileId?: string;
    content: string;
    role: ChatMessageRole;
    messageType?: ChatMessageType;
    toolCallData?: Record<string, unknown> | null;
  }) {
    const session = await this.agentSessions.get({
      id: params.agentSessionId,
    });
    if (!session) throw new Error('Agent session not found');
    if (!session.isActive()) throw new Error('Agent session is not active');
    if (!session.chatRoomId) throw new Error('Agent session has no chat room');

    // Enforce the per-session tool allow-list, fail-closed (S5 #1392). A tool
    // call carries its tool name in toolCallData.name (or .tool); any call to a
    // tool not on the session's whitelist is rejected.
    if (
      params.messageType === 'tool_call' ||
      params.role === 'tool' ||
      params.toolCallData
    ) {
      const toolName = ChatService.extractToolName(params.toolCallData);
      if (!toolName) {
        throw new Error('Tool call is missing a tool name');
      }
      if (!session.isToolAllowed(toolName)) {
        throw new Error(
          `Tool '${toolName}' is not allowed for this agent session (authorization denied)`,
        );
      }
    }

    // Default senderProfileId to session's agentId for assistant/tool roles.
    // For all other roles, senderProfileId must be explicitly provided.
    let senderProfileId = params.senderProfileId;
    if (!senderProfileId) {
      if (params.role === 'assistant' || params.role === 'tool') {
        senderProfileId = session.agentId;
      } else {
        throw new Error(
          'senderProfileId is required for non-assistant/tool roles in agent sessions',
        );
      }
    }

    return this.sendMessage({
      tenantId: params.tenantId,
      roomId: session.chatRoomId,
      senderProfileId,
      content: params.content,
      role: params.role,
      messageType: params.messageType ?? 'text',
      agentSessionId: params.agentSessionId,
      toolCallData: params.toolCallData ?? null,
    });
  }

  /**
   * Read messages in a room, gated on the caller's active membership (S5 #1392).
   *
   * Prevents a tenant member from reading any room they do not belong to. Throws
   * if `profileId` is not an active participant of `roomId`.
   */
  async getRoomMessages(params: {
    roomId: string;
    profileId: string;
    limit?: number;
    before?: string;
  }) {
    await this.requireActiveMembership(params.roomId, params.profileId);
    return this.messages.getByRoom(params.roomId, {
      limit: params.limit,
      before: params.before,
    });
  }

  /**
   * Load a room only if the caller is an active member (S5 #1392).
   *
   * Returns null when the room does not exist; throws when the caller is not an
   * active participant.
   */
  async getRoomForMember(roomId: string, profileId: string) {
    const room = await this.rooms.get({ id: roomId });
    if (!room) return null;
    await this.requireActiveMembership(roomId, profileId);
    return room;
  }

  /**
   * Update the per-session agent configuration (allowedTools / systemPrompt),
   * restricted to the session owner — the room owner participant (S5 #1392).
   *
   * Tool whitelist and system prompt govern what the agent may do, so only the
   * owning participant (not arbitrary tenant members or the agent itself) may
   * mutate them.
   */
  async updateAgentSessionConfig(params: {
    agentSessionId: string;
    actorProfileId: string;
    allowedTools?: string[];
    systemPrompt?: string;
  }) {
    const session = await this.agentSessions.get({
      id: params.agentSessionId,
    });
    if (!session) throw new Error('Agent session not found');

    const isOwner = params.actorProfileId === session.participantProfileId;
    if (!isOwner) {
      throw new Error(
        'Only the session owner may update agent session configuration (authorization denied)',
      );
    }

    if (params.allowedTools !== undefined) {
      session.setAllowedTools(params.allowedTools);
    }
    if (params.systemPrompt !== undefined) {
      session.systemPrompt = params.systemPrompt;
    }
    await session.save();
    return session;
  }

  /** Throw unless the profile is an active participant of the room. */
  private async requireActiveMembership(
    roomId: string,
    profileId: string,
  ): Promise<void> {
    const isMember = await this.participants.isActiveMember(roomId, profileId);
    if (!isMember) {
      throw new Error(
        'Caller is not an active member of the room (authorization denied)',
      );
    }
  }

  /** Extract a tool name from tool-call payload data, if present. */
  private static extractToolName(
    data: Record<string, unknown> | null | undefined,
  ): string | null {
    if (!data || typeof data !== 'object') return null;
    const candidate =
      (data.name as unknown) ??
      (data.tool as unknown) ??
      (data.toolName as unknown);
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : null;
  }
}
