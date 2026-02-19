import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
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
    const rooms = (await ChatRoomCollection.create(
      options,
    )) as ChatRoomCollection;
    const messages = (await ChatMessageCollection.create(
      options,
    )) as ChatMessageCollection;
    const participants = (await ChatParticipantCollection.create(
      options,
    )) as ChatParticipantCollection;
    const threads = (await ChatThreadCollection.create(
      options,
    )) as ChatThreadCollection;
    const agentSessions = (await AgentSessionCollection.create(
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
    });

    return room;
  }

  /** Send a message to a room */
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
  }) {
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
    if (existingSession?.chatRoomId) {
      const existingRoom = await this.rooms.get({
        id: existingSession.chatRoomId,
      });
      if (existingRoom) {
        return { session: existingSession, room: existingRoom };
      }
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

    // Default senderProfileId to session's agentId for assistant/tool roles
    const senderProfileId =
      params.senderProfileId ??
      (params.role === 'assistant' || params.role === 'tool'
        ? session.agentId
        : '');

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
}
