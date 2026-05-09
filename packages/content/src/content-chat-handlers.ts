import { type AIClientOptions, getAI } from '@happyvertical/ai';
import { ChatService } from '@happyvertical/smrt-chat';
import {
  type ResolvedPrompt,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { sanitizeHtml, stripHtml } from './body-format';
import {
  contentEditorInteractionPrompt,
  contentEditorSessionPrompt,
} from './content-chat-prompts';
import {
  buildContentChatModelUpdates,
  buildContentEditorInteractionVariables,
  buildContentEditorSessionContext,
  getContentChatAISelection,
  resolveContentChatModelSelection,
} from './content-chat-session';

const CONTENT_EDITOR_AGENT_ID = 'content_editor';
const REFERENCE_TITLE_MAX_LENGTH = 200;
const REFERENCE_BODY_MAX_LENGTH = 2000;

export type ContentChatAIConfig = AIClientOptions & {
  apiKey?: string;
  model?: string;
  defaultModel?: string;
  provider?: string;
  type?: string;
};

export interface ContentChatCollectionLike {
  db: DatabaseInterface;
  get(id: string): Promise<unknown>;
}

export interface ContentChatSessionInput {
  db: DatabaseInterface;
  tenantId?: string | null;
  profileId?: string | null;
  contentId: string;
  resolvePromptFn?: typeof resolvePrompt;
}

export interface CreateContentChatThreadInput extends ContentChatSessionInput {
  title: string;
  sessionId: string;
  model?: string | null;
  initializeChatCollections?: () => Promise<void>;
}

export interface ListContentChatThreadMessagesInput {
  db: DatabaseInterface;
  tenantId?: string | null;
  profileId?: string | null;
  contentId: string;
  threadId: string;
}

export interface SendContentChatThreadMessageInput {
  contents: ContentChatCollectionLike;
  tenantId?: string | null;
  profileId?: string | null;
  contentId: string;
  threadId: string;
  content: string;
  sessionId: string;
  model?: string | null;
  currentEditorState?: unknown;
  referenceIds?: unknown;
  formFields?: Record<string, unknown> | null;
  aiConfig?: ContentChatAIConfig | null;
  env?: Record<string, string | undefined>;
  resolvePromptFn?: typeof resolvePrompt;
  getAIClient?: typeof getAI;
  resolveAI?: (
    input: ResolveContentChatAIInput,
  ) => Promise<ResolvedContentChatAI | null> | ResolvedContentChatAI | null;
}

export interface ResolveContentChatAIInput {
  aiConfig: ContentChatAIConfig;
  env: Record<string, string | undefined>;
  sessionContext: Record<string, unknown>;
  requestedModel?: string | null;
  interactionPrompt: ResolvedPrompt;
}

export interface ResolvedContentChatAI {
  clientOptions: ContentChatAIConfig;
  model: string;
  provider?: string | null;
  profile?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
}

function resolveTenantId(value: string | null | undefined): string {
  return value || 'global';
}

function resolveProfileId(value: string | null | undefined): string {
  return value || 'system';
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getSessionContext(session: unknown): Record<string, unknown> {
  const candidate = session as {
    getSessionContext?: () => Record<string, unknown>;
    sessionContext?: unknown;
  };
  return typeof candidate.getSessionContext === 'function'
    ? candidate.getSessionContext()
    : parseJsonObject(candidate.sessionContext);
}

function isActiveSession(session: unknown): boolean {
  const candidate = session as { isActive?: () => boolean; status?: string };
  return typeof candidate?.isActive === 'function'
    ? candidate.isActive()
    : candidate?.status === 'active';
}

export function contentChatSessionMatchesContent(
  session: unknown,
  contentId: string,
): boolean {
  const context = getSessionContext(session);
  return asNonEmptyString(context.contentId) === contentId;
}

export function contentChatSessionIsAuthorized(
  session: unknown,
  input: {
    profileId: string;
    contentId: string;
  },
): boolean {
  const candidate = session as {
    agentId?: string;
    participantProfileId?: string;
  };
  return (
    Boolean(session) &&
    isActiveSession(session) &&
    candidate.agentId === CONTENT_EDITOR_AGENT_ID &&
    candidate.participantProfileId === input.profileId &&
    contentChatSessionMatchesContent(session, input.contentId)
  );
}

export function contentChatMessageToJSON(
  message: unknown,
): Record<string, unknown> {
  return typeof (message as { toJSON?: () => unknown })?.toJSON === 'function'
    ? ((message as { toJSON: () => unknown }).toJSON() as Record<
        string,
        unknown
      >)
    : (message as Record<string, unknown>);
}

export function serializeContentChatMessageForUI(
  message: unknown,
): Record<string, unknown> {
  const json = contentChatMessageToJSON(message);
  return {
    ...json,
    senderName: json.role === 'user' ? 'You' : 'AI Assistant',
    senderAvatarUrl: json.senderAvatarUrl || '',
  };
}

export async function getOrCreateContentEditorChatSession(
  input: ContentChatSessionInput,
) {
  const tenantId = resolveTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({ tenantId, db: input.db });
  await chatService.initialize();

  let activeSession = null;
  try {
    const agentSessions = await chatService.agentSessions.list({
      where: {
        agentId: CONTENT_EDITOR_AGENT_ID,
        participantProfileId: profileId,
        status: 'active',
      },
    });
    activeSession =
      agentSessions.find((session: unknown) =>
        contentChatSessionMatchesContent(session, input.contentId),
      ) ?? null;
  } catch {
    // Chat tables may not exist yet. createAgentSession will surface the
    // concrete schema error if the runtime cannot create/use them.
  }

  if (!activeSession) {
    const resolvedPrompt = await (input.resolvePromptFn ?? resolvePrompt)(
      contentEditorSessionPrompt.key,
      {
        db: input.db,
        tenantId,
      },
    );
    const { session } = await chatService.createAgentSession({
      tenantId,
      agentId: CONTENT_EDITOR_AGENT_ID,
      participantProfileId: profileId,
      systemPrompt: resolvedPrompt.text,
    });
    await session.updateSessionContext(
      buildContentEditorSessionContext(input.contentId, resolvedPrompt),
    );
    activeSession = session;
  }

  let threads: unknown[] = [];
  try {
    const chatRoomId = (activeSession as { chatRoomId?: string | null })
      .chatRoomId;
    if (!chatRoomId) {
      throw new Error('Agent session is missing a chat room');
    }
    threads = await chatService.threads.list({
      where: { roomId: chatRoomId },
      orderBy: 'createdAt DESC',
    });
  } catch {
    // Threads table may not exist yet.
  }

  return {
    chatService,
    session: activeSession,
    threads,
  };
}

export async function createContentEditorChatThread(
  input: CreateContentChatThreadInput,
) {
  await input.initializeChatCollections?.();

  const tenantId = resolveTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({ tenantId, db: input.db });
  const session = await chatService.agentSessions.get(input.sessionId);

  if (
    !contentChatSessionIsAuthorized(session, {
      profileId,
      contentId: input.contentId,
    })
  ) {
    throw new Error('Active session not found');
  }

  const chatRoomId = (session as { chatRoomId?: string | null }).chatRoomId;
  if (!chatRoomId) {
    throw new Error('Active session is missing a chat room');
  }

  const thread = await chatService.threads.create({
    tenantId,
    roomId: chatRoomId,
    title: input.title,
    messageCount: 0,
  });

  if (input.model) {
    const ctx = getSessionContext(session);
    const updates = buildContentChatModelUpdates(ctx, input.model, input.model);
    if (Object.entries(updates).some(([key, value]) => ctx[key] !== value)) {
      await (
        session as { updateSessionContext: (value: unknown) => Promise<void> }
      ).updateSessionContext(updates);
    }
  }

  return { chatService, session, thread };
}

export async function listContentEditorChatThreadMessages(
  input: ListContentChatThreadMessagesInput,
) {
  const tenantId = resolveTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({ tenantId, db: input.db });
  const thread = await chatService.threads.get(input.threadId);
  if (!thread) {
    throw new Error('Thread not found');
  }

  const roomId = (thread as { roomId?: string }).roomId;
  const activeSessions = await chatService.agentSessions.list({
    where: {
      agentId: CONTENT_EDITOR_AGENT_ID,
      participantProfileId: profileId,
      status: 'active',
    },
  });
  const authorizedSession = activeSessions.find(
    (session: unknown) =>
      (session as { chatRoomId?: string }).chatRoomId === roomId &&
      contentChatSessionMatchesContent(session, input.contentId),
  );
  if (!authorizedSession) {
    throw new Error('Thread not found');
  }

  const messages = await chatService.messages.list({
    where: { threadId: input.threadId },
    orderBy: 'createdAt DESC',
    limit: 100,
  });

  return {
    chatService,
    thread,
    messages: messages.reverse(),
  };
}

function getEnvApiKey(
  provider: string,
  env: Record<string, string | undefined>,
): string | undefined {
  return provider === 'anthropic'
    ? env.ANTHROPIC_API_KEY
    : provider === 'gemini'
      ? env.GEMINI_API_KEY
      : env.OPENAI_API_KEY;
}

function defaultEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' ? process.env : {};
}

export function resolveDefaultContentChatAI(
  input: ResolveContentChatAIInput,
): ResolvedContentChatAI {
  const storedSelection = getContentChatAISelection(input.sessionContext);
  const fallbackModel =
    storedSelection.model ??
    input.aiConfig.model ??
    input.aiConfig.defaultModel ??
    input.requestedModel ??
    null;
  if (!fallbackModel) {
    throw new Error('AI model is not configured for content chat');
  }

  const { model, provider } = resolveContentChatModelSelection(
    input.sessionContext,
    input.requestedModel,
    fallbackModel,
  );
  const apiKey = input.aiConfig.apiKey || getEnvApiKey(provider, input.env);

  return {
    clientOptions: {
      ...input.aiConfig,
      provider,
      apiKey,
      model,
    },
    model,
    provider,
    temperature: storedSelection.temperature ?? 0.7,
    maxTokens: storedSelection.maxTokens ?? 2000,
  };
}

function sanitizeReferenceText(value: unknown, maxLength: number): string {
  const text = stripHtml(sanitizeHtml(String(value ?? '')))
    .replace(/<{2,}/g, '< <')
    .replace(/>{2,}/g, '> >')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function sanitizeReferenceId(value: string): string {
  return value.replace(/[^\w:.-]/g, '_').slice(0, 128);
}

async function buildReferenceContext(
  contents: ContentChatCollectionLike,
  referenceIds: unknown,
): Promise<string> {
  if (!Array.isArray(referenceIds) || referenceIds.length === 0) {
    return '';
  }

  const refTexts: string[] = [];
  for (const refId of referenceIds) {
    const id = asNonEmptyString(refId);
    if (!id) {
      continue;
    }
    const ref = (await contents.get(id)) as {
      title?: string;
      body?: string;
    } | null;
    if (ref) {
      const safeTitle = sanitizeReferenceText(
        ref.title,
        REFERENCE_TITLE_MAX_LENGTH,
      );
      const safeBody = sanitizeReferenceText(
        ref.body,
        REFERENCE_BODY_MAX_LENGTH,
      );
      refTexts.push(
        `<<<SMRT_REFERENCE id=${sanitizeReferenceId(id)}>>>\nTitle: ${safeTitle}\nBody: ${safeBody}\n<<<END_SMRT_REFERENCE>>>`,
      );
    }
  }

  return refTexts.length > 0
    ? `\n\nATTACHED REFERENCE MATERIALS:\n${refTexts.join('\n\n')}\n`
    : '';
}

export async function sendContentEditorChatThreadMessage(
  input: SendContentChatThreadMessageInput,
) {
  const tenantId = resolveTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({
    tenantId,
    db: input.contents.db,
  });

  const session = await chatService.agentSessions.get(input.sessionId);
  if (
    !contentChatSessionIsAuthorized(session, {
      profileId,
      contentId: input.contentId,
    })
  ) {
    throw new Error('Active session not found');
  }

  const thread = await chatService.threads.get(input.threadId);
  if (
    !thread ||
    (thread as { roomId?: string }).roomId !==
      (session as { chatRoomId?: string | null }).chatRoomId
  ) {
    throw new Error('Thread not found');
  }

  const chatRoomId = (session as { chatRoomId?: string | null }).chatRoomId;
  if (!chatRoomId) {
    throw new Error('Active session is missing a chat room');
  }

  const userMessage = await chatService.sendMessage({
    tenantId,
    roomId: chatRoomId,
    threadId: (thread as { id: string }).id,
    senderProfileId: profileId,
    content: input.content,
    role: 'user',
    agentSessionId: (session as { id: string }).id,
  });

  const references = await buildReferenceContext(
    input.contents,
    input.referenceIds,
  );
  const interactionPrompt = await (input.resolvePromptFn ?? resolvePrompt)(
    contentEditorInteractionPrompt.key,
    {
      db: input.contents.db,
      tenantId,
      variables: buildContentEditorInteractionVariables({
        fields: input.formFields,
        currentEditorState: input.currentEditorState,
        references,
      }),
    },
  );

  const history = await chatService.messages.list({
    where: { threadId: (thread as { id: string }).id },
    orderBy: 'createdAt DESC',
    limit: 10,
  });

  const conversation = history.reverse().map((message: unknown) => {
    const json = contentChatMessageToJSON(message);
    return {
      role: json.role as 'user' | 'assistant' | 'system',
      content: String(json.content ?? ''),
    };
  });

  const sessionContext = getSessionContext(session);
  const aiConfig = input.aiConfig ?? {};
  const resolvedAI =
    (await input.resolveAI?.({
      aiConfig,
      env: input.env ?? defaultEnv(),
      sessionContext,
      requestedModel: input.model,
      interactionPrompt,
    })) ??
    resolveDefaultContentChatAI({
      aiConfig,
      env: input.env ?? defaultEnv(),
      sessionContext,
      requestedModel: input.model,
      interactionPrompt,
    });

  const ai = await (input.getAIClient ?? getAI)(resolvedAI.clientOptions);

  const fullSystemPrompt =
    typeof (session as { systemPrompt?: unknown }).systemPrompt === 'string'
      ? (session as { systemPrompt: string }).systemPrompt
      : '';
  conversation.unshift({
    role: 'system',
    content: `${fullSystemPrompt}\n\n${interactionPrompt.text}`,
  });

  const response = await ai.chat(conversation, {
    model: resolvedAI.model,
    temperature: resolvedAI.temperature ?? 0.7,
    maxTokens: resolvedAI.maxTokens ?? 2000,
  });

  const agentMessage = await chatService.sendMessage({
    tenantId,
    roomId: chatRoomId,
    agentSessionId: (session as { id: string }).id,
    threadId: (thread as { id: string }).id,
    senderProfileId: (session as { agentId: string }).agentId,
    content: response.content,
    role: 'assistant',
  });

  const updates = buildContentChatModelUpdates(
    sessionContext,
    input.model,
    resolvedAI.model,
  );
  updates.model = resolvedAI.model;
  if (resolvedAI.provider !== undefined) {
    updates.provider = resolvedAI.provider;
  }
  if (resolvedAI.profile !== undefined) {
    updates.profile = resolvedAI.profile;
  }
  if (
    Object.entries(updates).some(
      ([key, value]) => sessionContext[key] !== value,
    )
  ) {
    await (
      session as { updateSessionContext: (value: unknown) => Promise<void> }
    ).updateSessionContext(updates);
  }

  return {
    chatService,
    session,
    thread,
    userMessage,
    agentMessage,
  };
}
