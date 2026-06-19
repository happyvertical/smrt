import { type AIClientOptions, getAI } from '@happyvertical/ai';
import { ChatService } from '@happyvertical/smrt-chat';
import { sendAgentReply } from '@happyvertical/smrt-chat/internal/agent-runtime';
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
const MAX_REFERENCE_IDS = 20;

export type ContentChatAIConfig = AIClientOptions & {
  apiKey?: string;
  allowedModels?: string[];
  model?: string;
  defaultModel?: string;
  provider?: string;
  type?: string;
};

export interface ContentChatCollectionLike {
  db: DatabaseInterface;
  // Accepts either a raw id or a bound `{ id, tenantId }` filter so the content
  // lookup can be tenant-bound at the query level (S5 #1392) rather than doing a
  // cross-tenant `get(id)` followed only by a post-filter. A real SmrtCollection
  // satisfies this — its `get` takes `string | Record<string, any>`.
  get(filter: string | Record<string, unknown>): Promise<unknown>;
}

export interface ContentChatSessionInput {
  db: DatabaseInterface;
  contents?: ContentChatCollectionLike;
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
  contents?: ContentChatCollectionLike;
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

function resolveTenantScope(value: string | null | undefined): string | null {
  return asNonEmptyString(value);
}

function resolveChatTenantId(value: string | null | undefined): string {
  return resolveTenantScope(value) ?? 'global';
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

function isSchemaMissingError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? '');
  return (
    (error as { code?: string })?.code === 'DB_SCHEMA_MISSING' ||
    /^no such table:\s+(?:agent_sessions|chat_(?:rooms|threads|messages|participants|reactions))\b/i.test(
      message,
    ) ||
    /relation ["']?(?:agent_sessions|chat_(?:rooms|threads|messages|participants|reactions))["']? does not exist/i.test(
      message,
    )
  );
}

export function contentChatSessionMatchesContent(
  session: unknown,
  contentId: string,
): boolean {
  const context = getSessionContext(session);
  return asNonEmptyString(context.contentId) === contentId;
}

/**
 * Tenant-bound content lookup (S5 #1392).
 *
 * Binds `tenantId` (including the `null` "global" scope) into the lookup itself
 * so a content row from another tenant can never be RESOLVED first and only
 * rejected after the fact. The `referenceBelongsToTenant` post-filter at every
 * call site remains as defense-in-depth.
 */
function getContentForTenant(
  contents: ContentChatCollectionLike,
  tenantScope: string | null,
  id: string,
): Promise<unknown> {
  return contents.get({ id, tenantId: tenantScope });
}

async function assertContentExistsForTenant(
  contents: ContentChatCollectionLike | undefined,
  tenantScope: string | null,
  contentId: string,
): Promise<void> {
  if (!contents) {
    return;
  }

  const content = await getContentForTenant(contents, tenantScope, contentId);
  if (!content || !referenceBelongsToTenant(content, tenantScope)) {
    throw new Error('Content not found');
  }
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
  const tenantScope = resolveTenantScope(input.tenantId);
  const tenantId = resolveChatTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({ tenantId, db: input.db });
  await chatService.initialize();
  await assertContentExistsForTenant(
    input.contents,
    tenantScope,
    input.contentId,
  );

  let activeSession = null;
  try {
    // Tenant-bound session list via the ChatService facade (S5 #1392): the raw
    // `agentSessions.list({ where })` reach-in was tenant-UNBOUND and could
    // surface a session from another tenant before authorization.
    const agentSessions = await chatService.findActiveAgentSessions({
      tenantId,
      agentId: CONTENT_EDITOR_AGENT_ID,
      participantProfileId: profileId,
    });
    activeSession =
      agentSessions.find((session: unknown) =>
        contentChatSessionMatchesContent(session, input.contentId),
      ) ?? null;
  } catch (error) {
    if (!isSchemaMissingError(error)) {
      throw error;
    }
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
      actorProfileId: profileId,
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
    // Membership- and tenant-gated thread list via the facade (S5 #1392); the
    // editor (profileId) is the room owner, so the membership check passes.
    threads = await chatService.listRoomThreads({
      roomId: chatRoomId,
      actorProfileId: profileId,
      tenantId,
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

  const tenantScope = resolveTenantScope(input.tenantId);
  const tenantId = resolveChatTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({ tenantId, db: input.db });
  await assertContentExistsForTenant(
    input.contents,
    tenantScope,
    input.contentId,
  );
  // Tenant-bound session lookup via the facade (S5 #1392): the raw
  // `agentSessions.get(id)` was tenant-UNBOUND and could select a session from
  // another tenant before the ownership/context check below.
  const session = await chatService.getAgentSession({
    agentSessionId: input.sessionId,
    tenantId,
  });

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

  let updates: Record<string, string | null> | null = null;
  if (input.model) {
    const ctx = getSessionContext(session);
    const allowedModels = Array.isArray(ctx.allowedModels)
      ? ctx.allowedModels
      : [];
    if (allowedModels.length > 0 && !allowedModels.includes(input.model)) {
      throw new Error('AI model is not allowed for content chat');
    }
    updates = buildContentChatModelUpdates(ctx, input.model, input.model);
  }

  // Member-checked thread creation via the facade (S5 #1392): the editor owns
  // the agent room, so the membership check passes. Replaces the raw
  // `threads.create(...)` that skipped the facade entirely.
  const thread = await chatService.startThread({
    tenantId,
    roomId: chatRoomId,
    actorProfileId: profileId,
    title: input.title,
  });

  if (updates) {
    const ctx = getSessionContext(session);
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
  const tenantScope = resolveTenantScope(input.tenantId);
  const tenantId = resolveChatTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({ tenantId, db: input.db });
  await assertContentExistsForTenant(
    input.contents,
    tenantScope,
    input.contentId,
  );
  // Tenant-bound thread + session lookups via the facade (S5 #1392): the raw
  // `threads.get(id)` / `agentSessions.list({ where })` reach-ins were
  // tenant-UNBOUND and could select cross-tenant chat state before authZ.
  const thread = await chatService.getThread({
    threadId: input.threadId,
    tenantId,
  });
  if (!thread) {
    throw new Error('Thread not found');
  }

  const roomId = (thread as { roomId?: string }).roomId;
  const activeSessions = await chatService.findActiveAgentSessions({
    tenantId,
    agentId: CONTENT_EDITOR_AGENT_ID,
    participantProfileId: profileId,
  });
  const authorizedSession = activeSessions.find(
    (session: unknown) =>
      (session as { chatRoomId?: string }).chatRoomId === roomId &&
      contentChatSessionMatchesContent(session, input.contentId),
  );
  if (!authorizedSession) {
    throw new Error('Thread not found');
  }

  // Membership- + tenant-gated thread message read via the facade (S5 #1392);
  // the editor owns the room, so the membership check passes. Returned
  // chronological (oldest-first) by the facade.
  const messages = await chatService.getThreadMessages({
    threadId: input.threadId,
    actorProfileId: profileId,
    tenantId,
    limit: 100,
  });

  return {
    chatService,
    thread,
    messages,
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
  const allowedModels =
    input.aiConfig.allowedModels ??
    input.interactionPrompt.ai.allowedModels ??
    storedSelection.allowedModels;
  if (
    Array.isArray(allowedModels) &&
    allowedModels.length > 0 &&
    !allowedModels.includes(model)
  ) {
    throw new Error('AI model is not allowed for content chat');
  }
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
    .replace(/<<<(?:END_)?SMRT_[^>]*>>>/g, '')
    .replace(/<{2,}/g, '< <')
    .replace(/>{2,}/g, '> >')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function sanitizeReferenceId(value: string): string {
  return value.replace(/[^\w:.-]/g, '_').slice(0, 128);
}

function getReferenceTenantId(value: unknown): string | null {
  const candidate = value as {
    tenantId?: unknown;
    tenant_id?: unknown;
  } | null;
  return (
    asNonEmptyString(candidate?.tenantId) ??
    asNonEmptyString(candidate?.tenant_id)
  );
}

function referenceBelongsToTenant(
  ref: unknown,
  tenantScope: string | null,
): boolean {
  const refTenantId = getReferenceTenantId(ref);
  if (tenantScope === null) {
    return !refTenantId;
  }
  return refTenantId === tenantScope;
}

async function buildReferenceContext(
  contents: ContentChatCollectionLike,
  tenantScope: string | null,
  referenceIds: unknown,
): Promise<string> {
  if (!Array.isArray(referenceIds) || referenceIds.length === 0) {
    return '';
  }

  const refTexts: string[] = [];
  const ids = [
    ...new Set(
      referenceIds
        .map(asNonEmptyString)
        .filter((id): id is string => Boolean(id)),
    ),
  ].slice(0, MAX_REFERENCE_IDS);
  for (const id of ids) {
    // Tenant-bound lookup (S5 #1392): bind tenantId into the query rather than
    // a cross-tenant get(id) + post-filter. The post-filter below stays as
    // defense-in-depth.
    const ref = (await getContentForTenant(contents, tenantScope, id)) as {
      title?: string;
      body?: string;
      tenantId?: string;
      tenant_id?: string;
    } | null;
    if (ref && referenceBelongsToTenant(ref, tenantScope)) {
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
  const tenantScope = resolveTenantScope(input.tenantId);
  const tenantId = resolveChatTenantId(input.tenantId);
  const profileId = resolveProfileId(input.profileId);
  const chatService = await ChatService.create({
    tenantId,
    db: input.contents.db,
  });
  await assertContentExistsForTenant(
    input.contents,
    tenantScope,
    input.contentId,
  );

  // Tenant-bound session + thread lookups via the facade (S5 #1392): the raw
  // `agentSessions.get(id)` / `threads.get(id)` reach-ins were tenant-UNBOUND
  // and could select cross-tenant chat state before the authorization below.
  const session = await chatService.getAgentSession({
    agentSessionId: input.sessionId,
    tenantId,
  });
  if (
    !contentChatSessionIsAuthorized(session, {
      profileId,
      contentId: input.contentId,
    })
  ) {
    throw new Error('Active session not found');
  }

  const thread = await chatService.getThread({
    threadId: input.threadId,
    tenantId,
  });
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

  const references = await buildReferenceContext(
    input.contents,
    tenantScope,
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

  const userMessage = await chatService.sendMessage({
    tenantId,
    roomId: chatRoomId,
    threadId: (thread as { id: string }).id,
    actorProfileId: profileId,
    content: input.content,
    agentSessionId: (session as { id: string }).id,
  });

  // Membership- + tenant-gated thread history via the facade (S5 #1392); the
  // editor owns the room. Returned chronological (oldest-first) by the facade.
  const history = await chatService.getThreadMessages({
    threadId: (thread as { id: string }).id,
    actorProfileId: profileId,
    tenantId,
    limit: 10,
  });

  const conversation = history.map((message: unknown) => {
    const json = contentChatMessageToJSON(message);
    return {
      role: json.role as 'user' | 'assistant' | 'system',
      content: String(json.content ?? ''),
    };
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

  // Author the assistant reply AS the session's agent via the trusted internal
  // agent-runtime surface — never via the public sendMessage (which would force
  // the message to the caller's identity with role 'user') (S5 #1392).
  const agentMessage = await sendAgentReply(chatService, {
    tenantId,
    agentSessionId: (session as { id: string }).id,
    threadId: (thread as { id: string }).id,
    content: response.content,
    kind: 'assistant',
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
