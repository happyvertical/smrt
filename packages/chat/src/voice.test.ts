import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AIInterface,
  AIMessage,
  AIResponse,
  ChatOptions,
} from '@happyvertical/ai';
import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  MembershipCollection,
  RoleCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationPersona } from './persona-conversation.js';
import { ChatService } from './services/index.js';
import {
  createVoiceChatSession,
  createVoiceGatewayTurnHandler,
  handleVoiceGatewayTurn,
  MAX_VOICE_GATEWAY_TEXT_LENGTH,
  SMRT_CHAT_VOICE_TARGET,
  VoiceGatewayBadRequestError,
  VoiceGatewayReplayError,
  type VoiceGatewayTurnPayload,
  VoiceSessionExpiredError,
  VoiceSessionRejectedError,
} from './voice.js';

@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  collection: 'voice_notes',
  tableName: 'voice_notes',
  tenantScoped: { field: 'tenantId', mode: 'optional' },
})
class VoiceNote extends SmrtObject {
  tenantId: string | null = null;

  @field()
  title = '';
}
void VoiceNote;

interface Captured {
  messages: AIMessage[];
  options: ChatOptions | undefined;
}

function makeAI(
  handler: (
    call: number,
    offered: boolean,
    messages: AIMessage[],
    options?: ChatOptions,
  ) => AIResponse,
): {
  ai: AIInterface;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const ai = {
    async chat(messages: AIMessage[], options?: ChatOptions) {
      const offered =
        Array.isArray(options?.tools) &&
        options.tools.length > 0 &&
        options.toolChoice !== 'none';
      captured.push({ messages, options });
      return handler(captured.length - 1, offered, messages, options);
    },
  } as unknown as AIInterface;
  return { ai, captured };
}

function textResponse(content: string): AIResponse {
  return { content, finishReason: 'stop' } as AIResponse;
}

function toolCall(name: string, args: Record<string, unknown>): AIResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: `tc_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

describe('voice gateway chat integration', () => {
  let dbPath: string;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let chat: ChatService;
  let tenantId: string;
  let runAsUserId: string;
  let persona: ConversationPersona;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-chat-voice-${Date.now()}-${Math.random()}.db`,
    );
    db = await getDatabase({ type: 'sqlite', url: dbPath });

    const users = await UserCollection.create({ db });
    const tenants = await TenantCollection.create({ db });
    const roles = await RoleCollection.create({ db });
    const memberships = await MembershipCollection.create({ db });

    const user = await users.create({ email: 'voice-persona@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Voice Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Voice Persona' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
      })
    ).save();

    tenantId = tenant.id as string;
    runAsUserId = user.id as string;
    persona = {
      id: 'persona-voice',
      tenantId,
      agentClass: '@happyvertical/smrt-agents:Praeco',
      runAsUserId,
      actsAsProfileId: 'voice-agent-profile',
      allowedTools: [],
      instructions: 'Answer voice chat turns plainly.',
      memoryScope: `voice:${tenantId}`,
    };

    chat = await ChatService.create({ db });
    await chat.initialize();
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function payloadFor(
    session: Awaited<ReturnType<typeof createVoiceChatSession>>,
    overrides: Partial<VoiceGatewayTurnPayload> = {},
  ): VoiceGatewayTurnPayload {
    return {
      session_id: session.gatewaySessionId,
      turn_id: 'turn-1',
      target: SMRT_CHAT_VOICE_TARGET,
      actor: 'Speaker',
      text: 'hello from voice',
      metadata: {
        ...session.metadata,
        source: 'voice-gateway',
      },
      ...overrides,
    };
  }

  it('persists a gateway transcript and persona response as normal chat messages', async () => {
    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      actorUserId: 'speaker-user',
      persona,
      ttlSeconds: 60,
    });
    const { ai } = makeAI(() => textResponse('I heard you.'));

    const response = await handleVoiceGatewayTurn({
      chatService: chat,
      db,
      ai,
      payload: payloadFor(voiceSession),
      recall: false,
    });

    expect(response).toMatchObject({
      session_id: voiceSession.gatewaySessionId,
      turn_id: 'turn-1',
      text: 'I heard you.',
      metadata: {
        tenantId,
        chatRoomId: voiceSession.chatRoomId,
        agentSessionId: voiceSession.agentSessionId,
        personaId: 'persona-voice',
        voiceSessionId: voiceSession.voiceSessionId,
      },
    });
    expect(response.metadata.userMessageId).toBeTruthy();
    expect(response.metadata.assistantMessageId).toBeTruthy();
    expect(response.metadata.correlationId).toBeTruthy();

    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    const transcript = messages.find((m) => m.role === 'user');
    const assistant = messages.find((m) => m.role === 'assistant');

    expect(transcript?.content).toBe('hello from voice');
    expect(transcript?.agentSessionId).toBe(voiceSession.agentSessionId);
    expect(transcript?.getMetadata()).toMatchObject({
      source: 'voice-gateway',
      voiceSessionId: voiceSession.voiceSessionId,
      gatewayTurnId: 'turn-1',
      voiceRole: 'transcript',
      correlationId: response.metadata.correlationId,
    });

    expect(assistant?.content).toBe('I heard you.');
    expect(assistant?.agentSessionId).toBe(voiceSession.agentSessionId);
    expect(assistant?.getMetadata()).toMatchObject({
      source: 'voice-gateway',
      voiceSessionId: voiceSession.voiceSessionId,
      gatewayTurnId: 'turn-1',
      voiceRole: 'assistant',
      correlationId: response.metadata.correlationId,
    });
  });

  it('rejects an expired voice session before creating chat messages', async () => {
    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      persona,
      expiresAt: new Date(Date.now() - 1000),
    });
    const { ai } = makeAI(() => textResponse('should not run'));

    await expect(
      handleVoiceGatewayTurn({
        chatService: chat,
        db,
        ai,
        payload: payloadFor(voiceSession),
        recall: false,
      }),
    ).rejects.toBeInstanceOf(VoiceSessionExpiredError);

    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    expect(messages).toHaveLength(0);
  });

  it('rejects gateway metadata that conflicts with the server-side tenant binding', async () => {
    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      persona,
      ttlSeconds: 60,
    });
    const { ai } = makeAI(() => textResponse('should not run'));

    await expect(
      handleVoiceGatewayTurn({
        chatService: chat,
        db,
        ai,
        payload: payloadFor(voiceSession, {
          metadata: {
            ...voiceSession.metadata,
            tenantId: 'other-tenant',
            source: 'voice-gateway',
          },
        }),
        recall: false,
      }),
    ).rejects.toBeInstanceOf(VoiceSessionRejectedError);

    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    expect(messages).toHaveLength(0);
  });

  it('rejects oversized gateway text before creating chat messages', async () => {
    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      persona,
      ttlSeconds: 60,
    });
    const { ai } = makeAI(() => textResponse('should not run'));

    await expect(
      handleVoiceGatewayTurn({
        chatService: chat,
        db,
        ai,
        payload: payloadFor(voiceSession, {
          text: 'x'.repeat(MAX_VOICE_GATEWAY_TEXT_LENGTH + 1),
        }),
        recall: false,
      }),
    ).rejects.toBeInstanceOf(VoiceGatewayBadRequestError);

    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    expect(messages).toHaveLength(0);
  });

  it('rejects an invalid persona snapshot before creating chat messages', async () => {
    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      persona,
      ttlSeconds: 60,
    });
    voiceSession.voiceSession.setPersonaSnapshot({
      ...persona,
      runAsUserId: '',
    });
    await voiceSession.voiceSession.save();
    const { ai } = makeAI(() => textResponse('should not run'));

    await expect(
      handleVoiceGatewayTurn({
        chatService: chat,
        db,
        ai,
        payload: payloadFor(voiceSession),
        recall: false,
      }),
    ).rejects.toBeInstanceOf(VoiceSessionRejectedError);

    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    expect(messages).toHaveLength(0);
  });

  it('rejects duplicate gateway turn ids with one persisted transcript', async () => {
    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      persona,
      ttlSeconds: 60,
    });
    const { ai } = makeAI(() => textResponse('I heard you.'));
    const payload = payloadFor(voiceSession);

    await handleVoiceGatewayTurn({
      chatService: chat,
      db,
      ai,
      payload,
      recall: false,
    });

    await expect(
      handleVoiceGatewayTurn({
        chatService: chat,
        db,
        ai,
        payload,
        recall: false,
      }),
    ).rejects.toBeInstanceOf(VoiceGatewayReplayError);

    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('rejects an invalid gateway bearer token through the HTTP handler', async () => {
    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      persona,
      ttlSeconds: 60,
    });
    const { ai } = makeAI(() => textResponse('should not run'));
    const handler = createVoiceGatewayTurnHandler({
      chatService: chat,
      db,
      ai,
      gatewayToken: 'correct-token',
      recall: false,
    });

    const response = await handler(
      new Request('http://localhost/api/voice/smrt-chat/turn', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payloadFor(voiceSession)),
      }),
    );

    expect(response.status).toBe(401);
    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    expect(messages).toHaveLength(0);
  });

  it('keeps persona tool allow-list enforcement on voice turns', async () => {
    persona = { ...persona, allowedTools: ['voice_notes.read'] };
    const notes = await ObjectRegistry.getCollection('VoiceNote', { db });
    const note = await notes.create({ tenantId, title: 'Keep this note' });
    await note.save();

    const voiceSession = await createVoiceChatSession({
      chatService: chat,
      db,
      tenantId,
      actorProfileId: 'speaker-profile',
      persona,
      ttlSeconds: 60,
    });
    const { ai } = makeAI((call, offered) =>
      call === 0 && offered
        ? toolCall('voice_notes.delete', { id: note.id })
        : textResponse('I cannot delete that.'),
    );

    const response = await handleVoiceGatewayTurn({
      chatService: chat,
      db,
      ai,
      payload: payloadFor(voiceSession),
      recall: false,
    });

    expect(response.text).toBe('I cannot delete that.');
    expect(await notes.get({ id: note.id })).toBeTruthy();

    const messages = await chat.getRoomMessages({
      roomId: voiceSession.chatRoomId,
      actorProfileId: 'speaker-profile',
      tenantId,
      limit: 10,
    });
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(0);
  });
});
