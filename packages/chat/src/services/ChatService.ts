import {
  ObjectRegistry,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import { AgentSessionCollection } from '../collections/AgentSessionCollection.js';
import { ChatMessageCollection } from '../collections/ChatMessageCollection.js';
import { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';
import { ChatReactionCollection } from '../collections/ChatReactionCollection.js';
import { ChatRoomCollection } from '../collections/ChatRoomCollection.js';
import { ChatThreadCollection } from '../collections/ChatThreadCollection.js';
import type {
  ChatMessageRole,
  ChatMessageType,
  ChatParticipantRole,
  ChatRoomStatus,
  ChatRoomType,
} from '../types.js';

/**
 * Internal write descriptor for {@link ChatService.writeMessage}. This shape can
 * author a message as an arbitrary profile/role and may skip the membership
 * check, so it MUST NOT be reachable from any public/route-facing signature
 * (S5 #1392). Only the trusted in-class callers below construct it.
 */
interface InternalMessageWrite {
  tenantId: string;
  roomId: string;
  senderProfileId: string;
  content: string;
  role: ChatMessageRole;
  messageType?: ChatMessageType;
  threadId?: string | null;
  agentSessionId?: string | null;
  replyToMessageId?: string | null;
  toolCallData?: Record<string, unknown> | null;
  /** Internal-only escape hatch for system-authored writes. */
  skipMembershipCheck?: boolean;
}

/**
 * Parameters for emitting an agent-authored (assistant/tool) message. Used only
 * by the internal {@link sendAgentReply} bridge below — NOT a public surface.
 */
export interface AgentReplyParams {
  tenantId: string;
  agentSessionId: string;
  content: string;
  kind?: 'assistant' | 'tool';
  messageType?: ChatMessageType;
  toolCallData?: Record<string, unknown> | null;
  /**
   * Optional thread to attach the agent reply to. It MUST belong to the same
   * room/tenant as the session (validated in {@link ChatService.writeMessage}).
   */
  threadId?: string | null;
}

export class ChatService {
  readonly rooms: ChatRoomCollection;
  readonly messages: ChatMessageCollection;
  readonly participants: ChatParticipantCollection;
  readonly threads: ChatThreadCollection;
  readonly agentSessions: AgentSessionCollection;
  readonly reactions: ChatReactionCollection;

  private constructor(
    rooms: ChatRoomCollection,
    messages: ChatMessageCollection,
    participants: ChatParticipantCollection,
    threads: ChatThreadCollection,
    agentSessions: AgentSessionCollection,
    reactions: ChatReactionCollection,
  ) {
    this.rooms = rooms;
    this.messages = messages;
    this.participants = participants;
    this.threads = threads;
    this.agentSessions = agentSessions;
    this.reactions = reactions;
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
    ObjectRegistry.registerCollection(
      '@happyvertical/smrt-chat:ChatReaction',
      ChatReactionCollection,
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
    const reactions = (await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:ChatReaction',
      options,
    )) as ChatReactionCollection;

    return new ChatService(
      rooms,
      messages,
      participants,
      threads,
      agentSessions,
      reactions,
    );
  }

  /** Initialize all underlying collections (table creation) */
  async initialize(): Promise<void> {
    await this.rooms.initialize();
    await this.messages.initialize();
    await this.participants.initialize();
    await this.threads.initialize();
    await this.agentSessions.initialize();
    await this.reactions.initialize();
  }

  /**
   * Create a room and add the creating actor as owner (S5 #1392).
   *
   * The acting identity is the server-supplied `actorProfileId` (the
   * authenticated principal the route injects). The creator/owner is ALWAYS the
   * actor — a caller cannot supply a `createdByProfileId` to attribute the room
   * to (and enroll as owner) some other profile.
   */
  async createRoom(params: {
    tenantId: string;
    name: string;
    roomType: ChatRoomType;
    actorProfileId: string;
    description?: string;
    topic?: string;
  }) {
    const room = await this.rooms.create({
      tenantId: params.tenantId,
      name: params.name,
      roomType: params.roomType,
      createdByProfileId: params.actorProfileId,
      description: params.description ?? '',
      topic: params.topic ?? '',
      status: 'active',
    });

    await this.enrollParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.actorProfileId,
      role: 'owner',
    });

    return room;
  }

  /**
   * Send a USER message to a room as the authenticated caller (S5 #1392).
   *
   * The acting identity is the server-supplied `actorProfileId` (the
   * authenticated principal the route injects). The message is ALWAYS authored
   * as `actorProfileId` with `role: 'user'` — the caller cannot supply a
   * `senderProfileId` to impersonate another profile or the agent, and cannot
   * supply a privileged `role` (assistant/system/tool). Agent-authored messages
   * go exclusively through the internal {@link ChatService.sendAgentReply}.
   *
   * Authorization: `actorProfileId` must be an ACTIVE participant of the target
   * room, preventing cross-room IDOR within a tenant. There is no public
   * membership-skip parameter; system-authored writes use the internal
   * {@link ChatService.writeMessage} path.
   */
  async sendMessage(params: {
    tenantId: string;
    roomId: string;
    actorProfileId: string;
    content: string;
    messageType?: ChatMessageType;
    threadId?: string | null;
    agentSessionId?: string | null;
    replyToMessageId?: string | null;
  }) {
    return this.writeMessage({
      tenantId: params.tenantId,
      roomId: params.roomId,
      senderProfileId: params.actorProfileId,
      content: params.content,
      role: 'user',
      messageType: params.messageType ?? 'text',
      threadId: params.threadId ?? null,
      agentSessionId: params.agentSessionId ?? null,
      replyToMessageId: params.replyToMessageId ?? null,
    });
  }

  /**
   * INTERNAL persistence path for all message writes. Not exposed publicly: it
   * accepts an arbitrary author/role and an internal-only `skipMembershipCheck`
   * (S5 #1392). Every public entry point (`sendMessage`, `sendAgentUserMessage`,
   * `sendAgentReply`) funnels through here with a server-derived author/role.
   *
   * Membership is enforced unless `skipMembershipCheck` is set, which only the
   * in-class system-authored callers may do.
   */
  private async writeMessage(write: InternalMessageWrite) {
    if (!write.skipMembershipCheck) {
      const isMember = await this.participants.isActiveMember(
        write.roomId,
        write.senderProfileId,
        write.tenantId,
      );
      if (!isMember) {
        throw new Error(
          'Sender is not an active member of the room (authorization denied)',
        );
      }
    }

    // Every supplied reference (thread / agent session / reply-to message) MUST
    // belong to the SAME room AND tenant as the message being written (S5
    // #1392). Without this, an active member of one room could attach a message
    // to — or pull in/mutate the stats of — an unrelated thread/session/message
    // from another room or tenant. Bind roomId + tenantId into each lookup and
    // reject any mismatch. The validated rows are reused below for stat updates,
    // so there is no second, tenant-UNBOUND lookup.
    const thread = write.threadId
      ? await this.threads.get({
          id: write.threadId,
          roomId: write.roomId,
          tenantId: write.tenantId,
        })
      : null;
    if (write.threadId && !thread) {
      throw new Error(
        'threadId does not belong to this room/tenant (authorization denied)',
      );
    }

    const session = write.agentSessionId
      ? await this.agentSessions.get({
          id: write.agentSessionId,
          chatRoomId: write.roomId,
          tenantId: write.tenantId,
        })
      : null;
    if (write.agentSessionId && !session) {
      throw new Error(
        'agentSessionId does not belong to this room/tenant (authorization denied)',
      );
    }

    if (write.replyToMessageId) {
      const replyTo = await this.messages.get({
        id: write.replyToMessageId,
        roomId: write.roomId,
        tenantId: write.tenantId,
      });
      if (!replyTo) {
        throw new Error(
          'replyToMessageId does not belong to this room/tenant (authorization denied)',
        );
      }
    }

    const message = await this.messages.create({
      tenantId: write.tenantId,
      roomId: write.roomId,
      senderProfileId: write.senderProfileId,
      content: write.content,
      messageType: write.messageType ?? 'text',
      role: write.role,
      threadId: write.threadId ?? null,
      agentSessionId: write.agentSessionId ?? null,
      replyToMessageId: write.replyToMessageId ?? null,
      toolCallData: write.toolCallData
        ? JSON.stringify(write.toolCallData)
        : null,
    });

    // Update room's lastMessageAt
    const room = await this.rooms.get({
      id: write.roomId,
      tenantId: write.tenantId,
    });
    if (room) {
      room.lastMessageAt = new Date();
      await room.save();
    }

    // Update thread stats if threaded (reuse the validated row)
    if (thread) {
      thread.messageCount++;
      thread.lastMessageAt = new Date();
      await thread.save();
    }

    // Record on agent session if applicable (reuse the validated row)
    if (session) {
      await session.recordMessage();
    }

    return message;
  }

  /**
   * Start a thread from a message (S5 #1392).
   *
   * The acting identity is the server-supplied `actorProfileId`, which must be
   * an active member of the room. Generated thread `create` is disabled, so this
   * is the only path to create a thread.
   */
  async startThread(params: {
    tenantId: string;
    roomId: string;
    actorProfileId: string;
    rootMessageId: string;
    title?: string;
  }) {
    await this.requireActiveMembership(
      params.roomId,
      params.actorProfileId,
      params.tenantId,
    );
    const thread = await this.threads.create({
      tenantId: params.tenantId,
      roomId: params.roomId,
      rootMessageId: params.rootMessageId,
      title: params.title ?? '',
      messageCount: 0,
    });
    return thread;
  }

  /**
   * Add a participant to a room (S5 #1392).
   *
   * Authorization: the acting identity is the server-supplied `actorProfileId`,
   * which MUST be an owner/admin of the target room. This prevents an arbitrary
   * tenant member from adding anyone (or themselves) to any room with any role —
   * a privilege-escalation / IDOR. System-bootstrap enrollment (room creation,
   * DM/agent-session setup) uses the internal {@link ChatService.enrollParticipant}.
   */
  async addParticipant(params: {
    tenantId: string;
    roomId: string;
    actorProfileId: string;
    profileId: string;
    role?: ChatParticipantRole;
  }) {
    await this.requireRoomAdmin(
      params.roomId,
      params.actorProfileId,
      params.tenantId,
    );
    return this.enrollParticipant({
      tenantId: params.tenantId,
      roomId: params.roomId,
      profileId: params.profileId,
      role: params.role,
    });
  }

  /**
   * INTERNAL participant enrollment (S5 #1392). No authorization check — only
   * the trusted in-class bootstrap paths (room creation, DM/agent-session setup)
   * and the owner-checked {@link ChatService.addParticipant} call this. Not
   * exposed publicly so a route cannot enroll an arbitrary profile.
   */
  private async enrollParticipant(params: {
    tenantId: string;
    roomId: string;
    profileId: string;
    role?: ChatParticipantRole;
  }) {
    const existing = await this.participants.findMembership(
      params.roomId,
      params.profileId,
      params.tenantId,
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

  /**
   * Remove (soft-leave) a participant from a room (S5 #1392).
   *
   * Authorization: the server-supplied `actorProfileId` may remove THEMSELVES
   * (leave) at any time; removing ANOTHER profile requires the actor to be an
   * owner/admin of the room. An admin who is not an owner cannot remove an owner.
   */
  async removeParticipant(params: {
    tenantId: string;
    roomId: string;
    actorProfileId: string;
    profileId: string;
  }) {
    const target = await this.participants.findMembership(
      params.roomId,
      params.profileId,
      params.tenantId,
    );
    if (!target) return;

    const isSelf = params.actorProfileId === params.profileId;
    if (!isSelf) {
      const actor = await this.participants.findActiveMembership(
        params.roomId,
        params.actorProfileId,
        params.tenantId,
      );
      if (!actor || !actor.isAdmin()) {
        throw new Error(
          'Only a room owner/admin may remove another participant (authorization denied)',
        );
      }
      // An admin (non-owner) cannot remove an owner.
      if (target.isOwner() && !actor.isOwner()) {
        throw new Error(
          'Only a room owner may remove an owner (authorization denied)',
        );
      }
    }

    target.status = 'left';
    await target.save();
  }

  /**
   * Update mutable room fields, restricted to a room owner/admin (S5 #1392).
   *
   * Generated `update` on ChatRoom is disabled, so this owner-checked path is the
   * only way to mutate room state. The acting identity is the server-supplied
   * `actorProfileId`.
   */
  async updateRoom(params: {
    tenantId: string;
    roomId: string;
    actorProfileId: string;
    name?: string;
    description?: string;
    topic?: string;
    avatarUrl?: string;
    status?: ChatRoomStatus;
  }) {
    await this.requireRoomAdmin(
      params.roomId,
      params.actorProfileId,
      params.tenantId,
    );
    const room = await this.rooms.get({
      id: params.roomId,
      tenantId: params.tenantId,
    });
    if (!room) throw new Error('Room not found');

    if (params.name !== undefined) room.name = params.name;
    if (params.description !== undefined) room.description = params.description;
    if (params.topic !== undefined) room.topic = params.topic;
    if (params.avatarUrl !== undefined) room.avatarUrl = params.avatarUrl;
    if (params.status !== undefined) room.status = params.status;
    await room.save();
    return room;
  }

  /**
   * Add a reaction to a message as the authenticated caller (S5 #1392).
   *
   * Generated `create` on ChatReaction is disabled. The reaction is always
   * authored as the server-supplied `actorProfileId` (no caller-supplied
   * `profileId`), and the actor must be an active member of the room that owns
   * the message. Idempotent: re-reacting with the same emoji returns the
   * existing row.
   */
  async addReaction(params: {
    tenantId: string;
    messageId: string;
    actorProfileId: string;
    emoji: string;
  }) {
    const message = await this.messages.get({
      id: params.messageId,
      tenantId: params.tenantId,
    });
    if (!message) throw new Error('Message not found');

    await this.requireActiveMembership(
      message.roomId,
      params.actorProfileId,
      params.tenantId,
    );

    const existing = await this.reactions.list({
      where: {
        tenantId: params.tenantId,
        messageId: params.messageId,
        profileId: params.actorProfileId,
        emoji: params.emoji,
      },
      limit: 1,
    });
    if (existing[0]) return existing[0];

    return this.reactions.create({
      tenantId: params.tenantId,
      messageId: params.messageId,
      profileId: params.actorProfileId,
      emoji: params.emoji,
    });
  }

  /**
   * Remove the caller's own reaction from a message (S5 #1392).
   *
   * Generated `delete` on ChatReaction is disabled. A caller may only delete
   * THEIR OWN reaction (keyed on `actorProfileId`), so the route cannot remove
   * another member's reaction.
   */
  async removeReaction(params: {
    tenantId: string;
    messageId: string;
    actorProfileId: string;
    emoji: string;
  }): Promise<boolean> {
    const existing = await this.reactions.list({
      where: {
        tenantId: params.tenantId,
        messageId: params.messageId,
        profileId: params.actorProfileId,
        emoji: params.emoji,
      },
      limit: 1,
    });
    if (existing[0]) {
      await existing[0].delete();
      return true;
    }
    return false;
  }

  /**
   * Get or create a DM room with auto-participant setup.
   *
   * The acting identity is the server-supplied `actorProfileId`, which must be
   * one of the two DM participants — a caller cannot open a DM between two other
   * profiles on their behalf (S5 #1392). Enrollment uses the internal system
   * path (no owner check needed for a DM the actor is part of).
   */
  async getOrCreateDM(params: {
    tenantId: string;
    actorProfileId: string;
    profileId1: string;
    profileId2: string;
  }) {
    if (
      params.actorProfileId !== params.profileId1 &&
      params.actorProfileId !== params.profileId2
    ) {
      throw new Error(
        'Caller must be a participant of the DM (authorization denied)',
      );
    }

    const room = await this.rooms.findOrCreateDM(
      params.profileId1,
      params.profileId2,
      params.tenantId,
      this.participants,
    );

    await this.enrollParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.profileId1,
    });
    await this.enrollParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.profileId2,
    });

    return room;
  }

  /**
   * Create an agent conversation session with a linked chat room (S5 #1392).
   *
   * The acting identity is the server-supplied `actorProfileId`; the session is
   * ALWAYS created for that actor as the owning participant. A caller cannot
   * supply a `participantProfileId` to open (and own) a session on behalf of
   * another profile.
   */
  async createAgentSession(params: {
    tenantId: string;
    agentId: string;
    actorProfileId: string;
    allowedTools?: string[];
    systemPrompt?: string;
    maxTokens?: number;
    maxMessages?: number;
  }) {
    const participantProfileId = params.actorProfileId;
    // Check for existing active session first to avoid orphaned rooms
    const existingSession = await this.agentSessions.findActiveSession(
      params.agentId,
      participantProfileId,
      params.tenantId,
    );
    if (existingSession && existingSession.tenantId === params.tenantId) {
      if (existingSession.chatRoomId) {
        const existingRoom = await this.rooms.get({
          id: existingSession.chatRoomId,
        });
        if (existingRoom) {
          // Ensure both the participant and the agent are enrolled even on the
          // existing-session path. Legacy sessions created before the agent was
          // enrolled as a member would otherwise fail sendAgentReply's
          // membership check (S5 #1392). enrollParticipant is idempotent.
          await this.enrollParticipant({
            tenantId: params.tenantId,
            roomId: existingRoom.id as string,
            profileId: participantProfileId,
            role: 'owner',
          });
          await this.enrollParticipant({
            tenantId: params.tenantId,
            roomId: existingRoom.id as string,
            profileId: params.agentId,
            role: 'member',
          });
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
      createdByProfileId: participantProfileId,
      status: 'active',
      maxParticipants: 2,
    });

    // Add participant
    await this.enrollParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: participantProfileId,
      role: 'owner',
    });

    // Add the agent itself as a member so its assistant/tool messages pass the
    // room-membership authorization check in sendMessage (S5 #1392).
    await this.enrollParticipant({
      tenantId: params.tenantId,
      roomId: room.id as string,
      profileId: params.agentId,
      role: 'member',
    });

    // Create session
    const session = await this.agentSessions.findOrCreate({
      agentId: params.agentId,
      participantProfileId,
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

  /**
   * Send a USER message within an agent session (S5 #1392).
   *
   * The authenticated caller (`actorProfileId`) must be the session's owning
   * participant. The message is always authored as `session.participantProfileId`
   * — the caller cannot supply a `senderProfileId`, a `role`, or tool-call data,
   * so this path can never be used to post as the agent (`assistant`/`tool`) or
   * to impersonate another profile. Agent replies go through the internal
   * {@link ChatService.sendAgentReply}.
   */
  async sendAgentUserMessage(params: {
    tenantId: string;
    agentSessionId: string;
    actorProfileId: string;
    content: string;
    messageType?: ChatMessageType;
  }) {
    const session = await this.loadActiveSession(
      params.agentSessionId,
      params.tenantId,
    );

    if (params.actorProfileId !== session.participantProfileId) {
      throw new Error(
        'Only the session participant may post user messages in this agent session (authorization denied)',
      );
    }

    return this.writeMessage({
      tenantId: params.tenantId,
      roomId: session.chatRoomId as string,
      senderProfileId: session.participantProfileId,
      content: params.content,
      role: 'user',
      messageType: params.messageType ?? 'text',
      agentSessionId: params.agentSessionId,
    });
  }

  /**
   * Emit an ASSISTANT or TOOL message authored by the agent (S5 #1392).
   *
   * INTERNAL authority: this is the only path that authors a message as the
   * agent, and it is not reachable with a caller-supplied `senderProfileId`/
   * `role`. The author is always `session.agentId`. Tool calls are gated
   * fail-closed against the session's allow-list. Intended for the trusted
   * agent-runtime, never a per-tenant request handler driven by client-supplied
   * role/sender.
   *
   * This is a `private` method and is NOT exported from the package index. The
   * in-process agent runtime reaches it through the {@link sendAgentReply}
   * bridge in this module, which is deliberately not re-exported from
   * `src/index.ts`, so a route/consumer can never author a message as the agent.
   */
  private async emitAgentReply(params: AgentReplyParams) {
    const session = await this.loadActiveSession(
      params.agentSessionId,
      params.tenantId,
    );

    const role: ChatMessageRole = params.kind === 'tool' ? 'tool' : 'assistant';

    // Enforce the per-session tool allow-list, fail-closed (S5 #1392). A tool
    // call carries its tool name in toolCallData.name (or .tool); any call to a
    // tool not on the session's whitelist is rejected.
    if (
      params.messageType === 'tool_call' ||
      role === 'tool' ||
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

    return this.writeMessage({
      tenantId: params.tenantId,
      roomId: session.chatRoomId as string,
      senderProfileId: session.agentId,
      content: params.content,
      role,
      messageType: params.messageType ?? 'text',
      threadId: params.threadId ?? null,
      agentSessionId: params.agentSessionId,
      toolCallData: params.toolCallData ?? null,
    });
  }

  /** Load an active agent session by id, tenant-bound, or throw. */
  private async loadActiveSession(agentSessionId: string, tenantId: string) {
    const session = await this.agentSessions.get({
      id: agentSessionId,
      tenantId,
    });
    if (!session) throw new Error('Agent session not found');
    if (!session.isActive()) throw new Error('Agent session is not active');
    if (!session.chatRoomId) throw new Error('Agent session has no chat room');
    return session;
  }

  /**
   * Read messages in a room, gated on the caller's active membership (S5 #1392).
   *
   * Prevents a tenant member from reading any room they do not belong to. Throws
   * if `profileId` is not an active participant of `roomId`. `tenantId` is
   * required so the membership gate is always tenant-scoped.
   */
  async getRoomMessages(params: {
    roomId: string;
    profileId: string;
    tenantId: string;
    limit?: number;
    before?: string;
  }) {
    await this.requireActiveMembership(
      params.roomId,
      params.profileId,
      params.tenantId,
    );
    return this.messages.getByRoom(params.roomId, {
      limit: params.limit,
      before: params.before,
    });
  }

  /**
   * Load a room only if the caller is an active member (S5 #1392).
   *
   * Returns null when the room does not exist; throws when the caller is not an
   * active participant. `tenantId` is required so the lookup and the membership
   * gate are always tenant-scoped.
   */
  async getRoomForMember(roomId: string, profileId: string, tenantId: string) {
    const room = await this.rooms.get({ id: roomId, tenantId });
    if (!room) return null;
    await this.requireActiveMembership(roomId, profileId, tenantId);
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
    tenantId: string | null;
    allowedTools?: string[];
    systemPrompt?: string;
  }) {
    // `tenantId` is mandatory and ALWAYS bound into the lookup (S5 #1392).
    // AgentSession tenancy is optional, so `null` is the explicit "no tenant"
    // scope — never "any tenant". This prevents mutating allowedTools /
    // systemPrompt on a session belonging to another tenant via an unbound get.
    const session = await this.agentSessions.get({
      id: params.agentSessionId,
      tenantId: params.tenantId,
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
    tenantId: string,
  ): Promise<void> {
    const isMember = await this.participants.isActiveMember(
      roomId,
      profileId,
      tenantId,
    );
    if (!isMember) {
      throw new Error(
        'Caller is not an active member of the room (authorization denied)',
      );
    }
  }

  /** Throw unless the profile is an active owner/admin of the room. */
  private async requireRoomAdmin(
    roomId: string,
    profileId: string,
    tenantId: string,
  ): Promise<void> {
    const actor = await this.participants.findActiveMembership(
      roomId,
      profileId,
      tenantId,
    );
    if (!actor || !actor.isAdmin()) {
      throw new Error(
        'Caller must be a room owner/admin (authorization denied)',
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

  /**
   * Internal bridge to the `private` {@link ChatService.emitAgentReply} for the
   * module-local {@link sendAgentReply} function (S5 #1392). A static method may
   * reach a private instance member of its own class, so this is the sanctioned
   * "friend" access without widening the public instance surface. Marked with a
   * leading underscore to signal internal use; it is not part of the documented
   * facade and is unreachable from the package index.
   */
  static _runAgentReply(service: AgentReplyService, params: AgentReplyParams) {
    // The structural param lets this bridge be called across pnpm
    // module-instance boundaries (src vs dist). Any real instance is a
    // ChatService, so reaching the private `emitAgentReply` here is safe.
    return (service as ChatService).emitAgentReply(params);
  }
}

/**
 * Structural ChatService surface accepted by {@link sendAgentReply}. Using a
 * structural type (not the nominal `ChatService` class) keeps the function
 * callable across module-instance boundaries — in a pnpm workspace a consumer's
 * `ChatService` type may resolve to the package source while this function
 * resolves to dist, and the nominal `private` members would otherwise make the
 * two declarations incompatible. The shape below is satisfied by any real
 * ChatService instance.
 */
export type AgentReplyService = Pick<
  ChatService,
  'rooms' | 'messages' | 'participants' | 'threads' | 'agentSessions'
>;

/**
 * Internal agent-runtime entry point: emit an ASSISTANT/TOOL message authored
 * as the session's agent (S5 #1392).
 *
 * NOT re-exported from `src/index.ts`. Only in-process, trusted agent-runtime
 * code that imports this module path directly can author messages as the agent;
 * route handlers and package consumers (which import from the package index)
 * cannot. The author is always `session.agentId`, never a caller-supplied
 * sender/role, and tool calls are gated fail-closed against `allowedTools`.
 *
 * Because this lives in the same module as {@link ChatService}, reaching the
 * `private` method is the owning module's sanctioned "friend" access, not an
 * external private reach-in.
 */
export function sendAgentReply(
  service: AgentReplyService,
  params: AgentReplyParams,
) {
  return ChatService._runAgentReply(service, params);
}
