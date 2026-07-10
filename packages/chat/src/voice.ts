import type { AIInterface, AIMessage } from '@happyvertical/ai';
import type { PrincipalAuditSink } from '@happyvertical/smrt-agents';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { VoiceSessionCollection } from './collections/VoiceSessionCollection.js';
import type { ChatMessage } from './models/ChatMessage.js';
import type { VoiceSession } from './models/VoiceSession.js';
import {
  bindPersonaToSession,
  type ConversationPersona,
  type PersonaRecallOptions,
  runPersonaConversationTurn,
} from './persona-conversation.js';
import type { ChatService } from './services/index.js';

export const SMRT_CHAT_VOICE_TARGET = 'smrt:chat';
const DEFAULT_VOICE_SESSION_TTL_SECONDS = 10 * 60;
const DEFAULT_HISTORY_LIMIT = 24;

export interface VoiceGatewayTurnMetadata {
  tenantId?: string;
  actorProfileId?: string;
  chatRoomId?: string;
  threadId?: string;
  agentSessionId?: string;
  personaId?: string;
  voiceSessionId?: string;
  source?: string;
  [key: string]: unknown;
}

export interface VoiceGatewayTurnPayload {
  session_id: string;
  turn_id: string;
  target: string;
  actor?: string;
  text: string;
  metadata?: VoiceGatewayTurnMetadata;
}

export interface VoiceGatewayTurnResponseMetadata {
  tenantId: string;
  chatRoomId: string;
  threadId: string | null;
  agentSessionId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  personaId: string;
  correlationId: string;
  voiceSessionId: string;
  source: string;
}

export interface VoiceGatewayTurnResponse {
  session_id: string;
  turn_id: string;
  text: string;
  metadata: VoiceGatewayTurnResponseMetadata;
}

export interface CreateVoiceChatSessionOptions {
  chatService: ChatService;
  db: SmrtClassOptions['db'];
  tenantId: string;
  actorProfileId: string;
  actorUserId?: string | null;
  persona: ConversationPersona;
  /** Existing agent session to bind voice to. Omit to create/reuse one. */
  agentSessionId?: string;
  /** Agent profile/session author id when creating a new agent session. */
  agentId?: string;
  /** Optional existing thread within the bound session room. */
  threadId?: string | null;
  /** Stable gateway-level `session_id`. Generated when omitted. */
  gatewaySessionId?: string;
  /** Subject key forwarded to ChatService.createAgentSession(). */
  sessionKey?: string | null;
  /** Voice binding TTL. Ignored when `expiresAt` is supplied. */
  ttlSeconds?: number;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
  target?: string;
  maxTokens?: number;
  maxMessages?: number;
  instructions?: string;
}

export interface VoiceChatSessionCreationResult {
  voiceSession: VoiceSession;
  voiceSessionId: string;
  gatewaySessionId: string;
  expiresAt: Date;
  tenantId: string;
  actorProfileId: string;
  personaId: string;
  agentSessionId: string;
  chatRoomId: string;
  threadId: string | null;
  metadata: VoiceGatewayTurnMetadata;
}

export interface HandleVoiceGatewayTurnOptions {
  chatService: ChatService;
  db: SmrtClassOptions['db'];
  ai: AIInterface;
  payload: VoiceGatewayTurnPayload;
  now?: Date;
  historyLimit?: number;
  recall?: PersonaRecallOptions | false;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  postgresRls?: boolean;
  audit?: PrincipalAuditSink;
}

export interface VoiceGatewayTurnHandlerOptions
  extends Omit<HandleVoiceGatewayTurnOptions, 'payload'> {
  gatewayToken: string | (() => string | Promise<string>);
}

export class VoiceGatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'VoiceGatewayError';
    this.status = status;
    this.code = code;
  }
}

export class VoiceGatewayBadRequestError extends VoiceGatewayError {
  constructor(message: string) {
    super(message, 400, 'voice_gateway_bad_request');
    this.name = 'VoiceGatewayBadRequestError';
  }
}

export class VoiceGatewayUnauthorizedError extends VoiceGatewayError {
  constructor(message = 'Voice gateway authorization failed') {
    super(message, 401, 'voice_gateway_unauthorized');
    this.name = 'VoiceGatewayUnauthorizedError';
  }
}

export class VoiceSessionRejectedError extends VoiceGatewayError {
  constructor(message: string) {
    super(message, 403, 'voice_session_rejected');
    this.name = 'VoiceSessionRejectedError';
  }
}

export class VoiceSessionExpiredError extends VoiceGatewayError {
  constructor(message = 'Voice session is expired') {
    super(message, 410, 'voice_session_expired');
    this.name = 'VoiceSessionExpiredError';
  }
}

export class VoiceGatewayReplayError extends VoiceGatewayError {
  constructor(message = 'Voice gateway turn has already been processed') {
    super(message, 409, 'voice_gateway_replay');
    this.name = 'VoiceGatewayReplayError';
  }
}

export async function createVoiceChatSession(
  options: CreateVoiceChatSessionOptions,
): Promise<VoiceChatSessionCreationResult> {
  const target = options.target ?? SMRT_CHAT_VOICE_TARGET;
  const personaId = requireNonEmptyString(
    options.persona.id,
    'createVoiceChatSession requires a persisted persona id',
  );
  if (
    options.persona.tenantId !== null &&
    options.persona.tenantId !== options.tenantId
  ) {
    throw new VoiceSessionRejectedError(
      'Persona tenant does not match the voice session tenant',
    );
  }

  const persona: ConversationPersona = {
    ...options.persona,
    id: personaId,
    tenantId: options.tenantId,
  };

  let agentSession = options.agentSessionId
    ? await options.chatService.getAgentSession({
        agentSessionId: options.agentSessionId,
        tenantId: options.tenantId,
      })
    : null;

  if (options.agentSessionId) {
    if (!agentSession) {
      throw new VoiceSessionRejectedError('Agent session not found');
    }
    assertAgentSessionMatchesActor(agentSession, options.actorProfileId);
    assertActiveAgentSession(agentSession);
  } else {
    const agentId =
      options.agentId ??
      persona.actsAsProfileId ??
      persona.id ??
      persona.agentClass;
    if (!agentId) {
      throw new VoiceGatewayBadRequestError(
        'createVoiceChatSession requires agentId when the persona has no acting profile or id',
      );
    }
    const created = await options.chatService.createAgentSession({
      tenantId: options.tenantId,
      agentId,
      actorProfileId: options.actorProfileId,
      allowedTools: persona.allowedTools,
      systemPrompt: options.instructions ?? persona.instructions,
      maxTokens: options.maxTokens,
      maxMessages: options.maxMessages,
      sessionKey: options.sessionKey,
    });
    agentSession = created.session;
  }

  const boundSession = await bindPersonaToSession({
    chatService: options.chatService,
    session: agentSession,
    actorProfileId: options.actorProfileId,
    tenantId: options.tenantId,
    persona,
    instructions: options.instructions,
    db: options.db,
  });
  assertActiveAgentSession(boundSession);

  const chatRoomId = requireNonEmptyString(
    boundSession.chatRoomId,
    'Agent session has no chat room',
  );
  await options.chatService.getRoomForMember(
    chatRoomId,
    options.actorProfileId,
    options.tenantId,
  );

  const threadId = options.threadId ?? null;
  if (threadId) {
    const thread = await options.chatService.getThread({
      threadId,
      tenantId: options.tenantId,
    });
    if (!thread || thread.roomId !== chatRoomId) {
      throw new VoiceSessionRejectedError(
        'threadId does not belong to the bound agent session room',
      );
    }
  }

  const voiceSessions = await VoiceSessionCollection.create({ db: options.db });
  const gatewaySessionId = options.gatewaySessionId ?? crypto.randomUUID();
  const expiresAt =
    options.expiresAt ??
    new Date(
      Date.now() +
        (options.ttlSeconds ?? DEFAULT_VOICE_SESSION_TTL_SECONDS) * 1000,
    );

  const voiceSession = await voiceSessions.create({
    tenantId: options.tenantId,
    gatewaySessionId,
    actorProfileId: options.actorProfileId,
    actorUserId: options.actorUserId ?? null,
    personaId,
    agentSessionId: boundSession.id as string,
    chatRoomId,
    threadId,
    target,
    status: 'active',
    expiresAt,
    personaSnapshot: JSON.stringify(persona),
    metadata: JSON.stringify(options.metadata ?? {}),
  });

  const voiceSessionId = voiceSession.id as string;
  return {
    voiceSession,
    voiceSessionId,
    gatewaySessionId,
    expiresAt,
    tenantId: options.tenantId,
    actorProfileId: options.actorProfileId,
    personaId,
    agentSessionId: boundSession.id as string,
    chatRoomId,
    threadId,
    metadata: {
      tenantId: options.tenantId,
      actorProfileId: options.actorProfileId,
      chatRoomId,
      threadId: threadId ?? undefined,
      agentSessionId: boundSession.id as string,
      personaId,
      voiceSessionId,
      source: 'smrt-chat',
    },
  };
}

export async function handleVoiceGatewayTurn(
  options: HandleVoiceGatewayTurnOptions,
): Promise<VoiceGatewayTurnResponse> {
  const payload = normalizeGatewayPayload(options.payload);
  const metadata = payload.metadata ?? {};
  const voiceSessionId = requireNonEmptyString(
    metadata.voiceSessionId,
    'Voice gateway payload metadata.voiceSessionId is required',
  );

  const voiceSessions = await VoiceSessionCollection.create({ db: options.db });
  const voiceSession = await voiceSessions.get({
    id: voiceSessionId,
    target: payload.target,
  });
  if (!voiceSession) {
    throw new VoiceSessionRejectedError('Voice session not found');
  }
  if (voiceSession.isExpired(options.now)) {
    if (voiceSession.status === 'active') {
      await voiceSession.expire();
    }
    throw new VoiceSessionExpiredError();
  }
  if (!voiceSession.isActive(options.now)) {
    throw new VoiceSessionRejectedError('Voice session is not active');
  }
  if (voiceSession.hasProcessedTurn(payload.turn_id)) {
    throw new VoiceGatewayReplayError();
  }

  validateGatewayPayloadAgainstBinding(payload, voiceSession);

  const agentSession = await options.chatService.getAgentSession({
    agentSessionId: voiceSession.agentSessionId,
    tenantId: voiceSession.tenantId,
  });
  if (!agentSession) {
    throw new VoiceSessionRejectedError('Bound agent session not found');
  }
  assertAgentSessionMatchesActor(agentSession, voiceSession.actorProfileId);
  assertActiveAgentSession(agentSession);
  if (agentSession.chatRoomId !== voiceSession.chatRoomId) {
    throw new VoiceSessionRejectedError(
      'Bound agent session no longer belongs to the voice session room',
    );
  }

  if (voiceSession.threadId) {
    const thread = await options.chatService.getThread({
      threadId: voiceSession.threadId,
      tenantId: voiceSession.tenantId,
    });
    if (!thread || thread.roomId !== voiceSession.chatRoomId) {
      throw new VoiceSessionRejectedError(
        'Bound thread no longer belongs to the voice session room',
      );
    }
  }

  const history = await loadConversationHistory({
    chatService: options.chatService,
    tenantId: voiceSession.tenantId,
    actorProfileId: voiceSession.actorProfileId,
    roomId: voiceSession.chatRoomId,
    threadId: voiceSession.threadId,
    limit: options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
  });
  const correlationId = crypto.randomUUID();
  const commonMetadata = {
    source: 'voice-gateway',
    target: payload.target,
    voiceSessionId,
    gatewaySessionId: payload.session_id,
    gatewayTurnId: payload.turn_id,
    correlationId,
  };

  const userMessage = await options.chatService.sendAgentUserMessage({
    tenantId: voiceSession.tenantId,
    agentSessionId: voiceSession.agentSessionId,
    actorProfileId: voiceSession.actorProfileId,
    content: payload.text,
  });
  await mergeAndSaveMetadata(userMessage, {
    ...commonMetadata,
    voiceRole: 'transcript',
  });

  const turn = await runPersonaConversationTurn({
    ai: options.ai,
    db: options.db,
    persona: voiceSession.getPersonaSnapshot(),
    tenantId: voiceSession.tenantId,
    userMessage: payload.text,
    history,
    chatService: options.chatService,
    session: agentSession,
    threadId: voiceSession.threadId,
    recall: options.recall,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    maxSteps: options.maxSteps,
    postgresRls: options.postgresRls,
    audit: options.audit,
    onBehalfOfUserId: voiceSession.actorUserId ?? undefined,
    correlationId,
  });

  for (const toolMessage of turn.authoredMessages?.toolMessages ?? []) {
    await mergeAndSaveMetadata(toolMessage, {
      ...commonMetadata,
      voiceRole: 'tool',
    });
  }
  const assistantMessage = turn.authoredMessages?.assistantMessage ?? null;
  if (assistantMessage) {
    await mergeAndSaveMetadata(assistantMessage, {
      ...commonMetadata,
      voiceRole: 'assistant',
    });
  }

  voiceSession.recordGatewayTurn(payload.turn_id);
  await voiceSession.save();

  return {
    session_id: payload.session_id,
    turn_id: payload.turn_id,
    text: turn.result.content,
    metadata: {
      tenantId: voiceSession.tenantId,
      chatRoomId: voiceSession.chatRoomId,
      threadId: voiceSession.threadId,
      agentSessionId: voiceSession.agentSessionId,
      userMessageId: userMessage.id as string,
      assistantMessageId: (assistantMessage?.id as string | undefined) ?? null,
      personaId: voiceSession.personaId,
      correlationId: turn.correlationId,
      voiceSessionId,
      source: 'voice-gateway',
    },
  };
}

export function createVoiceGatewayTurnHandler(
  options: VoiceGatewayTurnHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
      }
      await assertVoiceGatewayBearer(
        request.headers,
        await resolveGatewayToken(options.gatewayToken),
      );
      const payload = normalizeGatewayPayload(await request.json());
      const response = await handleVoiceGatewayTurn({ ...options, payload });
      return jsonResponse(response, 200);
    } catch (error) {
      const status = error instanceof VoiceGatewayError ? error.status : 500;
      const message =
        error instanceof Error ? error.message : 'Voice gateway turn failed';
      const code =
        error instanceof VoiceGatewayError ? error.code : 'voice_gateway_error';
      return jsonResponse({ error: message, code }, status);
    }
  };
}

export async function assertVoiceGatewayBearer(
  headers: Headers,
  expectedToken: string,
): Promise<void> {
  if (!expectedToken) {
    throw new VoiceGatewayUnauthorizedError(
      'Voice gateway token is not configured',
    );
  }
  const authorization = headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const actual = match?.[1] ?? '';
  if (!constantTimeEquals(actual, expectedToken)) {
    throw new VoiceGatewayUnauthorizedError();
  }
}

async function resolveGatewayToken(
  token: string | (() => string | Promise<string>),
): Promise<string> {
  return typeof token === 'function' ? token() : token;
}

function normalizeGatewayPayload(input: unknown): VoiceGatewayTurnPayload {
  if (!isRecord(input)) {
    throw new VoiceGatewayBadRequestError('Voice gateway payload must be JSON');
  }
  const sessionId = requireNonEmptyString(
    input.session_id,
    'Voice gateway payload session_id is required',
  );
  const turnId = requireNonEmptyString(
    input.turn_id,
    'Voice gateway payload turn_id is required',
  );
  const target = requireNonEmptyString(
    input.target,
    'Voice gateway payload target is required',
  );
  if (target !== SMRT_CHAT_VOICE_TARGET) {
    throw new VoiceGatewayBadRequestError(
      `Unsupported voice gateway target '${target}'`,
    );
  }
  const text = requireNonEmptyString(
    input.text,
    'Voice gateway payload text is required',
  );
  const metadata = input.metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new VoiceGatewayBadRequestError(
      'Voice gateway payload metadata must be an object',
    );
  }

  return {
    session_id: sessionId,
    turn_id: turnId,
    target,
    actor:
      typeof input.actor === 'string' && input.actor.length > 0
        ? input.actor
        : undefined,
    text,
    metadata: metadata as VoiceGatewayTurnMetadata | undefined,
  };
}

function validateGatewayPayloadAgainstBinding(
  payload: VoiceGatewayTurnPayload,
  voiceSession: VoiceSession,
): void {
  if (payload.session_id !== voiceSession.gatewaySessionId) {
    throw new VoiceSessionRejectedError(
      'Gateway session_id does not match the voice session binding',
    );
  }
  const metadata = payload.metadata ?? {};
  assertMetadataMatches(
    metadata,
    'tenantId',
    voiceSession.tenantId,
    'tenantId does not match the voice session binding',
  );
  assertMetadataMatches(
    metadata,
    'actorProfileId',
    voiceSession.actorProfileId,
    'actorProfileId does not match the voice session binding',
  );
  assertMetadataMatches(
    metadata,
    'chatRoomId',
    voiceSession.chatRoomId,
    'chatRoomId does not match the voice session binding',
  );
  assertMetadataMatches(
    metadata,
    'threadId',
    voiceSession.threadId,
    'threadId does not match the voice session binding',
  );
  assertMetadataMatches(
    metadata,
    'agentSessionId',
    voiceSession.agentSessionId,
    'agentSessionId does not match the voice session binding',
  );
  assertMetadataMatches(
    metadata,
    'personaId',
    voiceSession.personaId,
    'personaId does not match the voice session binding',
  );
}

function assertMetadataMatches(
  metadata: VoiceGatewayTurnMetadata,
  key: keyof VoiceGatewayTurnMetadata,
  expected: string | null,
  message: string,
): void {
  const actual = metadata[key];
  if (actual === undefined || actual === null || actual === '') {
    return;
  }
  if (typeof actual !== 'string' || actual !== expected) {
    throw new VoiceSessionRejectedError(message);
  }
}

function assertAgentSessionMatchesActor(
  session: { participantProfileId: string },
  actorProfileId: string,
): void {
  if (session.participantProfileId !== actorProfileId) {
    throw new VoiceSessionRejectedError(
      'Agent session participant does not match the voice session actor',
    );
  }
}

function assertActiveAgentSession(session: {
  isActive: () => boolean;
  chatRoomId: string | null;
}): void {
  if (!session.isActive()) {
    throw new VoiceSessionRejectedError('Agent session is not active');
  }
  if (!session.chatRoomId) {
    throw new VoiceSessionRejectedError('Agent session has no chat room');
  }
}

async function loadConversationHistory(input: {
  chatService: ChatService;
  tenantId: string;
  actorProfileId: string;
  roomId: string;
  threadId: string | null;
  limit: number;
}): Promise<AIMessage[]> {
  const messages = input.threadId
    ? await input.chatService.getThreadMessages({
        threadId: input.threadId,
        actorProfileId: input.actorProfileId,
        tenantId: input.tenantId,
        limit: input.limit,
      })
    : (
        await input.chatService.getRoomMessages({
          roomId: input.roomId,
          actorProfileId: input.actorProfileId,
          tenantId: input.tenantId,
          limit: input.limit,
        })
      ).reverse();

  return messages
    .map(chatMessageToAIMessage)
    .filter((message): message is AIMessage => message !== null);
}

function chatMessageToAIMessage(message: ChatMessage): AIMessage | null {
  if (
    message.role !== 'user' &&
    message.role !== 'assistant' &&
    message.role !== 'system'
  ) {
    return null;
  }
  return { role: message.role, content: message.content } as AIMessage;
}

async function mergeAndSaveMetadata(
  message: ChatMessage,
  metadata: Record<string, unknown>,
): Promise<void> {
  message.setMetadata({ ...message.getMetadata(), ...metadata });
  await message.save();
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new VoiceGatewayBadRequestError(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function constantTimeEquals(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index++) {
    const actualCode = index < actual.length ? actual.charCodeAt(index) : 0;
    const expectedCode =
      index < expected.length ? expected.charCodeAt(index) : 0;
    diff |= actualCode ^ expectedCode;
  }
  return diff === 0;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
