/**
 * Mountable SvelteKit routes for the AssistantDock (#3368).
 *
 * One call serves everything the dock's HTTP transport
 * (`createAssistantHttpTransport` / `createSmrtAssistantTransport`) and HTTP
 * action client (`createAssistantHttpActionClient`) call:
 *
 * ```ts
 * // src/routes/api/assistant/[...path]/+server.ts
 * import { mountAssistantRoutes } from '@happyvertical/smrt-chat/sveltekit';
 * import { getAssistantAI } from '$lib/server/ai';
 * export const { GET, POST } = mountAssistantRoutes({ ai: getAssistantAI });
 * ```
 *
 *   GET  threads                        member-scoped thread list
 *   POST threads                        { title } → { thread }
 *   GET  threads/:id/messages           member-scoped, chronological
 *   POST threads/:id/messages           { content, clientRequestId, ... } → SSE turn
 *   POST threads/:id/resume             { continuationId, results, ... } → SSE turn
 *   POST attachments                    multipart `file` (host storage only)
 *   POST actions/preview | actions/apply  DataSurfaceActionWireRequest → { result }
 *
 * Trust boundary: the principal comes from SvelteKit `event.locals` (as
 * populated by `createSessionHandler` from `@happyvertical/smrt-users/sveltekit`)
 * or an injected resolver — never from a header, hostname or request body.
 * Every actor gets ONE assistant `AgentSession` per tenant (keyed, so it never
 * reuses another feature's session); threads are readable and writable only
 * when they live in that session's room. Reads never create anything. Model
 * tools run under `executeAsPrincipal` (inside `runToolLoop`) with a
 * fail-closed allow-list: no `allowedTools` means no tools.
 *
 * Server-only: imports no Svelte or browser code.
 *
 * @packageDocumentation
 */

import './__smrt-register__.js';

import type { AIInterface, AIMessage } from '@happyvertical/ai';
import type {
  PrincipalAuditSink,
  PrincipalTool,
} from '@happyvertical/smrt-agents';
import type { DataSurfaceActionAdapter } from '@happyvertical/smrt-agents/server';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  type AssistantContinuationStore,
  type AssistantTurnErrorLogger,
  type AssistantTurnState,
  type AuthoredToolReply,
  createAssistantTurnResponse,
  createSessionContinuationStore,
  DEFAULT_CONTINUATION_TTL_MS,
  runAssistantTurn,
} from './assistant-turn.js';
import type { AssistantTurnEvent } from './assistant-turn-events.js';
import { MAX_CHAT_STREAM_CONTENT_LENGTH } from './chat-stream.js';
import type { AgentSession } from './models/AgentSession.js';
import type { ChatMessage } from './models/ChatMessage.js';
import type { ChatThread } from './models/ChatThread.js';
import {
  ChatClientRequestConflictError,
  type ChatClientRequestOutcome,
  type ChatMessageAttachment,
  ChatService,
  clientRequestMessageId,
} from './services/ChatService.js';
import {
  type ClientToolResultInput,
  MAX_CLIENT_TOOL_RESULT_CHARS,
  MAX_CLIENT_TOOLS,
  type ManifestTool,
  sanitizeClientToolDeclarations,
  type ToolInvocation,
  type ToolLoopUsage,
} from './tool-loop.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The slice of a SvelteKit `RequestEvent` these handlers read. */
export interface AssistantRouteEvent {
  request: Request;
  url: URL;
  params?: Partial<Record<string, string>>;
  locals?: unknown;
}

/** A SvelteKit `+server.ts` handler with no `@sveltejs/kit` dependency. */
export type AssistantRouteHandler = (
  event: AssistantRouteEvent,
) => Promise<Response>;

/** The authenticated caller, resolved server-side. */
export interface AssistantPrincipal {
  /** The user whose live permissions bound every tool call (`runAsUserId`). */
  userId: string;
  /** The user's Profile: the chat actor that owns the assistant session. */
  profileId: string;
  /** The active, session-authorized tenant. */
  tenantId: string;
  /** Optional permission snapshot; omitted resolves live permissions. */
  permissions?: string[];
}

/**
 * Resolves the caller. Return `null` for an unauthenticated request (401);
 * throw {@link AssistantRouteError} for any other refusal.
 */
export type AssistantPrincipalResolver = (
  event: AssistantRouteEvent,
) =>
  | AssistantPrincipal
  | null
  | undefined
  | Promise<AssistantPrincipal | null | undefined>;

/** What every per-request option callback receives. */
export interface AssistantRequestContext {
  event: AssistantRouteEvent;
  principal: AssistantPrincipal;
}

/** A value, or a per-request callback producing it. */
export type AssistantRouteValue<T> =
  | T
  | ((context: AssistantRequestContext) => T | Promise<T>);

/** A stored attachment, as the host's storage reports it. */
export interface AssistantAttachmentRecord {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url?: string;
}

/**
 * Host-owned attachment storage. Without it, uploads and sends with
 * attachments are refused: the chat package stores no files.
 */
export interface AssistantAttachmentStorage {
  /** Store an upload for the principal and describe it. */
  upload(
    file: File,
    context: AssistantRequestContext,
  ): Promise<AssistantAttachmentRecord>;
  /**
   * Check that the references a send names belong to the principal and
   * return the records to store on the message, or `null` to refuse. The
   * references are request input: never trust their `url`/`size` as given.
   */
  verify(
    references: unknown[],
    context: AssistantRequestContext,
  ): Promise<AssistantAttachmentRecord[] | null>;
  /** Largest accepted upload, bytes. Default 10 MiB. */
  maxBytes?: number;
}

/** The two adapter calls the action routes make. */
export type AssistantActionAdapter = Pick<
  DataSurfaceActionAdapter,
  'preview' | 'apply'
>;

/** Selectable model, the same shape the dock's `ModelPicker` uses. */
export interface AssistantRouteModel {
  id: string;
  label?: string;
}

/** Options for {@link mountAssistantRoutes}. */
export interface MountAssistantRoutesOptions {
  /**
   * The AI client, or a factory called once per turn. Required: these routes
   * never read provider credentials from the environment. A factory that
   * throws answers 503 before anything is written.
   */
  ai:
    | AIInterface
    | ((
        context: AssistantRequestContext & { model?: string },
      ) => AIInterface | Promise<AIInterface>);
  /** Database for chat persistence and the principal run. */
  db?: SmrtClassOptions['db'];
  /** Default: {@link resolveAssistantPrincipalFromLocals}. */
  resolvePrincipal?: AssistantPrincipalResolver;
  /** The assistant's agent id (its `bot` profile slug). Default `smrt-assistant`. */
  agentId?: string;
  systemPrompt?: AssistantRouteValue<string | undefined>;
  /**
   * Server tool allow-list, fail-closed: absent or empty offers NO tools.
   * Gates `extraTools`, `tools` and the data-surface action adapter.
   */
  allowedTools?: AssistantRouteValue<readonly string[]>;
  /** Server tools (e.g. `createDataSurfaceTools()`), narrowed by `allowedTools`. */
  extraTools?: AssistantRouteValue<readonly PrincipalTool[]>;
  /** Manifest tools (`buildManifestToolCatalog`), narrowed by `allowedTools`. */
  tools?: AssistantRouteValue<readonly ManifestTool[]>;
  /**
   * Browser tools the page may declare (exact names or `prefix*`). Empty
   * (the default) admits none.
   */
  clientToolAllowList?: readonly string[];
  /**
   * Where suspended turns wait. Default: the actor's assistant session
   * context (`createSessionContinuationStore`), re-read before every write.
   * A shared store must keep keys private to the session it is given.
   */
  continuations?: (
    context: AssistantRequestContext & { session: AgentSession },
  ) => AssistantContinuationStore;
  /** When set, a requested model must be listed; otherwise it is ignored. */
  models?: readonly AssistantRouteModel[];
  /** Model used when the request names none. */
  defaultModel?: string;
  maxSteps?: number;
  maxTurnTokens?: number;
  maxTurnMs?: number;
  maxTokens?: number;
  temperature?: number;
  /** Earlier messages sent with a new turn. Default 20. */
  historyLimit?: number;
  /**
   * A stored send with no reply and no recorded outcome (e.g. its process
   * died) counts as failed after this long. Default 15 minutes.
   */
  abandonedTurnMs?: number;
  describeTool?: (name: string, args?: Record<string, unknown>) => string;
  /**
   * Persist a server tool invocation into the thread (default: none). Its
   * tool name must be on `allowedTools`, which is mirrored onto the session.
   */
  authorInvocation?: (invocation: ToolInvocation) => AuthoredToolReply | null;
  onUsage?: (usage: ToolLoopUsage, context: AssistantRequestContext) => void;
  audit?: PrincipalAuditSink;
  postgresRls?: boolean;
  /** Host attachment storage; absent refuses attachments. */
  attachments?: AssistantAttachmentStorage;
  /** Data-surface action adapter; absent answers the action routes 404. */
  actions?: {
    adapter: AssistantRouteValue<AssistantActionAdapter>;
  };
  /**
   * Refuse mutating requests whose `Origin` (or `Sec-Fetch-Site`/`Referer`)
   * is not this origin. Default `true`.
   */
  checkOrigin?: boolean;
  /** Extra origins accepted by the origin check (e.g. behind a proxy). */
  trustedOrigins?: readonly string[];
  /** Largest JSON body, bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Longest user message, characters. Default 12,000. */
  maxContentLength?: number;
  /** SSE keep-alive interval. */
  heartbeatMs?: number;
  /** Server-side log for failures withheld from the browser. */
  onError?: AssistantTurnErrorLogger;
  /** Rest parameter name of the mounting route. Default `path`. */
  paramName?: string;
  /** Used when the route has no rest parameter: the prefix to strip. */
  basePath?: string;
}

/** The handlers {@link mountAssistantRoutes} returns. */
export interface AssistantRoutes {
  GET: AssistantRouteHandler;
  POST: AssistantRouteHandler;
  /** Method-agnostic entry point (GET and POST both delegate here). */
  handle: AssistantRouteHandler;
}

/** A refusal with an HTTP status and a stable, user-safe code. */
export class AssistantRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantRouteError';
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (mirrors `AssistantThreadSummary` / `AssistantMessage`)
// ---------------------------------------------------------------------------

/** Thread summary as the routes send it. */
export interface AssistantThreadWire {
  id: string;
  title: string;
  isResolved: boolean;
  messageCount: number;
  lastMessageAt: string | null;
}

/** Message as the routes send it (chronological in lists). */
export interface AssistantMessageWire {
  id: string;
  threadId: string;
  content: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  attachments?: AssistantAttachmentRecord[];
  toolCallData?: Record<string, unknown>;
  clientRequestId?: string;
}

/**
 * JSON answer to a send whose `clientRequestId` is already stored for this
 * thread and actor. `outcome`: `completed` (a reply follows), `cancelled`
 * (stopped, no reply), or `in_progress` (still running, or waiting on
 * browser tools). A failed or abandoned turn answers 409 `turn_failed`.
 */
export interface AssistantDuplicateSendWire {
  duplicate: true;
  inProgress: boolean;
  outcome: 'completed' | 'cancelled' | 'in_progress';
  userMessage: AssistantMessageWire;
  assistantMessage?: AssistantMessageWire;
  messages: AssistantMessageWire[];
}

// ---------------------------------------------------------------------------
// Defaults and helpers
// ---------------------------------------------------------------------------

/** Default assistant agent id. */
export const DEFAULT_ASSISTANT_AGENT_ID = 'smrt-assistant';
/** Session key isolating the dock's session from other uses of the agent id. */
export const ASSISTANT_DOCK_SESSION_KEY = 'assistant-dock';
/** Default JSON body cap. */
export const DEFAULT_ASSISTANT_MAX_BODY_BYTES = 1024 * 1024;
/** Default attachment cap. */
export const DEFAULT_ASSISTANT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ID_LENGTH = 128;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Default age after which an unanswered, unsettled send counts as failed. */
export const DEFAULT_ASSISTANT_ABANDONED_TURN_MS = 15 * 60 * 1000;
const GENERIC_ERROR = 'The assistant request failed.';

/**
 * The default principal resolver: SvelteKit `event.locals` as populated by
 * `createSessionHandler` (`user`, `tenantId`). No user → `null` (401); a user
 * without a Profile or an active tenant is refused with 403.
 */
export function resolveAssistantPrincipalFromLocals(
  locals: unknown,
): AssistantPrincipal | null {
  const record = (locals ?? {}) as {
    user?: { id?: unknown; profileId?: unknown } | null;
    tenantId?: unknown;
  };
  const user = record.user;
  const userId = nonEmpty(user?.id);
  if (!user || !userId) return null;
  const profileId = nonEmpty(user.profileId);
  if (!profileId) {
    throw new AssistantRouteError(
      403,
      'profile_required',
      'Your account has no profile, so it cannot use the assistant.',
    );
  }
  const tenantId = nonEmpty(record.tenantId);
  if (!tenantId) {
    throw new AssistantRouteError(
      403,
      'tenant_required',
      'Select an organization to use the assistant.',
    );
  }
  return { userId, profileId, tenantId };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  const out = new Headers(headers);
  out.set('content-type', 'application/json; charset=utf-8');
  out.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: out });
}

function errorResponse(error: AssistantRouteError): Response {
  return json({ error: error.message, code: error.code }, error.status);
}

const notFound = () =>
  new AssistantRouteError(404, 'not_found', 'Conversation not found.');
const badRequest = (message: string, code = 'invalid_request') =>
  new AssistantRouteError(400, code, message);

async function resolveValue<T>(
  value: AssistantRouteValue<T> | undefined,
  context: AssistantRequestContext,
): Promise<T | undefined> {
  if (typeof value === 'function') {
    return (value as (c: AssistantRequestContext) => T | Promise<T>)(context);
  }
  return value;
}

async function readBounded(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  const tooLarge = () =>
    new AssistantRouteError(
      413,
      'payload_too_large',
      'The request is too large.',
    );
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJsonObject(
  request: Request,
  max: number,
): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw new AssistantRouteError(415, 'unsupported_media_type', 'Send JSON.');
  }
  const bytes = await readBounded(request, max);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function requireId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw badRequest(`${label} is missing or invalid.`);
  }
  return value;
}

function originAllowed(
  request: Request,
  url: URL,
  trusted: readonly string[],
): boolean {
  const allowed = new Set([url.origin, ...trusted]);
  const origin = request.headers.get('origin');
  if (origin) return allowed.has(origin);
  const site = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (site) return site === 'same-origin';
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}

function toIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Map a persisted thread to the wire. */
export function toAssistantThreadWire(thread: ChatThread): AssistantThreadWire {
  return {
    id: String(thread.id),
    title: thread.title ?? '',
    isResolved: Boolean(thread.isResolved),
    messageCount: Number(thread.messageCount) || 0,
    lastMessageAt: toIso(thread.lastMessageAt),
  };
}

/** Map a persisted message to the wire. */
export function toAssistantMessageWire(
  message: ChatMessage,
): AssistantMessageWire {
  const metadata = parseObject(message.metadata);
  const toolCallData = parseObject(message.toolCallData);
  const attachments = parseArray(message.attachments)
    .map((entry): AssistantAttachmentRecord | null => {
      const a = entry as Record<string, unknown> | null;
      const id = nonEmpty(a?.id);
      const name = nonEmpty(a?.filename) ?? nonEmpty(a?.name);
      if (!id || !name) return null;
      return {
        id,
        name,
        contentType: nonEmpty(a?.contentType) ?? 'application/octet-stream',
        size: Number(a?.size) || 0,
        ...(nonEmpty(a?.url) ? { url: a?.url as string } : {}),
      };
    })
    .filter((a): a is AssistantAttachmentRecord => a !== null);
  const clientRequestId = nonEmpty(metadata?.clientRequestId);
  return {
    id: String(message.id),
    threadId: message.threadId ?? '',
    content: message.content ?? '',
    role: message.role,
    createdAt: toIso(message.created_at) ?? new Date(0).toISOString(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(toolCallData ? { toolCallData } : {}),
    ...(clientRequestId ? { clientRequestId } : {}),
  };
}

function isAuthorizationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /authorization denied|not found|not active/i.test(message);
}

// ---------------------------------------------------------------------------
// mountAssistantRoutes
// ---------------------------------------------------------------------------

type RouteMatch =
  | { route: 'threads' }
  | { route: 'thread-messages'; threadId: string }
  | { route: 'thread-resume'; threadId: string }
  | { route: 'attachments' }
  | { route: 'actions'; phase: 'preview' | 'apply' };

const ROUTE_METHODS: Record<RouteMatch['route'], readonly string[]> = {
  threads: ['GET', 'POST'],
  'thread-messages': ['GET', 'POST'],
  'thread-resume': ['POST'],
  attachments: ['POST'],
  actions: ['POST'],
};

function matchRoute(segments: string[]): RouteMatch | null {
  const [a, b, c, ...rest] = segments;
  if (rest.length > 0) return null;
  if (a === 'threads' && b === undefined) return { route: 'threads' };
  if (a === 'threads' && b && c === 'messages') {
    return { route: 'thread-messages', threadId: b };
  }
  if (a === 'threads' && b && c === 'resume') {
    return { route: 'thread-resume', threadId: b };
  }
  if (a === 'attachments' && b === undefined) return { route: 'attachments' };
  if (a === 'actions' && (b === 'preview' || b === 'apply') && !c) {
    return { route: 'actions', phase: b };
  }
  return null;
}

/**
 * Build the AssistantDock's server routes for one SvelteKit rest route
 * (e.g. `src/routes/api/assistant/[...path]/+server.ts`).
 */
export function mountAssistantRoutes(
  options: MountAssistantRoutesOptions,
): AssistantRoutes {
  if (!options?.ai) {
    throw new Error(
      'mountAssistantRoutes: `ai` is required (an AI client or a factory).',
    );
  }
  const agentId = options.agentId ?? DEFAULT_ASSISTANT_AGENT_ID;
  const paramName = options.paramName ?? 'path';
  const maxBody = options.maxBodyBytes ?? DEFAULT_ASSISTANT_MAX_BODY_BYTES;
  const maxContent = options.maxContentLength ?? MAX_CHAT_STREAM_CONTENT_LENGTH;
  const historyLimit = Math.max(0, options.historyLimit ?? 20);
  const checkOrigin = options.checkOrigin ?? true;
  const trustedOrigins = options.trustedOrigins ?? [];
  const resolvePrincipal: AssistantPrincipalResolver =
    options.resolvePrincipal ??
    ((event) => resolveAssistantPrincipalFromLocals(event.locals));
  const logError: AssistantTurnErrorLogger =
    options.onError ??
    ((error) => {
      // biome-ignore lint/suspicious/noConsole: server-side default for detail withheld from the browser; hosts pass `onError`
      console.error('[smrt-chat] assistant route failed:', error);
    });
  const safeLog = (error: unknown) => {
    try {
      logError(error);
    } catch {
      // Logging never breaks a response.
    }
  };
  const abandonedTurnMs =
    options.abandonedTurnMs ?? DEFAULT_ASSISTANT_ABANDONED_TURN_MS;

  const segmentsOf = (event: AssistantRouteEvent): string[] | null => {
    const param = event.params?.[paramName];
    let path: string | undefined =
      typeof param === 'string' ? param : undefined;
    if (path === undefined && options.basePath) {
      const base = options.basePath.replace(/\/+$/, '');
      const pathname = event.url.pathname;
      if (pathname === base || pathname.startsWith(`${base}/`)) {
        path = pathname.slice(base.length);
      }
    }
    if (path === undefined) return null;
    return path.split('/').filter((segment) => segment.length > 0);
  };

  const chatFor = async (principal: AssistantPrincipal) => {
    const chat = await ChatService.create({
      tenantId: principal.tenantId,
      ...(options.db ? { db: options.db } : {}),
    } as Parameters<typeof ChatService.create>[0]);
    await chat.initialize();
    return chat;
  };

  const findSession = async (
    chat: ChatService,
    principal: AssistantPrincipal,
  ): Promise<AgentSession | null> => {
    const sessions = await chat.findActiveAgentSessions({
      tenantId: principal.tenantId,
      agentId,
      participantProfileId: principal.profileId,
    });
    return (
      sessions.find(
        (session) =>
          session.getSessionKey() === ASSISTANT_DOCK_SESSION_KEY &&
          session.participantProfileId === principal.profileId &&
          session.tenantId === principal.tenantId &&
          Boolean(session.chatRoomId),
      ) ?? null
    );
  };

  const requireOwnThread = async (
    chat: ChatService,
    principal: AssistantPrincipal,
    session: AgentSession | null,
    threadId: string,
  ): Promise<ChatThread> => {
    if (!session?.chatRoomId) throw notFound();
    const thread = await chat.getThread({
      threadId,
      tenantId: principal.tenantId,
    });
    if (
      !thread ||
      thread.roomId !== session.chatRoomId ||
      thread.tenantId !== principal.tenantId
    ) {
      throw notFound();
    }
    return thread;
  };

  const allowedToolsFor = async (context: AssistantRequestContext) => {
    const list = await resolveValue(options.allowedTools, context);
    return Array.isArray(list)
      ? list.filter(
          (tool): tool is string => typeof tool === 'string' && tool.length > 0,
        )
      : [];
  };

  const resolveModel = (requested: unknown): string | undefined => {
    if (requested === undefined || requested === null || requested === '') {
      return options.defaultModel;
    }
    if (typeof requested !== 'string' || requested.length > MAX_ID_LENGTH) {
      throw badRequest('The model is invalid.', 'model_not_allowed');
    }
    if (!options.models || options.models.length === 0) {
      return options.defaultModel;
    }
    if (!options.models.some((model) => model.id === requested)) {
      throw badRequest('That model is not available.', 'model_not_allowed');
    }
    return requested;
  };

  const resolveAI = async (
    context: AssistantRequestContext,
    model: string | undefined,
  ): Promise<AIInterface> => {
    try {
      const ai =
        typeof options.ai === 'function'
          ? await options.ai({ ...context, ...(model ? { model } : {}) })
          : options.ai;
      if (!ai || typeof ai.chat !== 'function') {
        throw new Error('The AI factory returned no client.');
      }
      return ai;
    } catch (error) {
      safeLog(error);
      throw new AssistantRouteError(
        503,
        'assistant_unavailable',
        'The assistant is unavailable right now. Please try again later.',
      );
    }
  };

  /** The store suspended turns of this actor's session wait in. */
  const continuationStoreFor = (
    context: AssistantRequestContext,
    chat: ChatService,
    session: AgentSession,
  ): AssistantContinuationStore => {
    if (options.continuations) {
      return options.continuations({ ...context, session });
    }
    const { principal } = context;
    return createSessionContinuationStore(async () => {
      const current = await chat.getAgentSession({
        agentSessionId: String(session.id),
        tenantId: principal.tenantId,
      });
      return current &&
        current.participantProfileId === principal.profileId &&
        current.isActive()
        ? current
        : null;
    });
  };

  /** Everything a turn needs besides its transcript input. */
  const turnSetup = async (
    context: AssistantRequestContext,
    chat: ChatService,
    session: AgentSession,
    thread: ChatThread,
    body: Record<string, unknown>,
  ) => {
    const { principal } = context;
    const model = resolveModel(body.model);
    const allowedTools = await allowedToolsFor(context);
    const clientTools = sanitizeClientToolDeclarations(
      body.clientTools,
      options.clientToolAllowList ?? [],
    );
    const ai = await resolveAI(context, model);
    const [extraTools, tools, systemPrompt] = await Promise.all([
      resolveValue(options.extraTools, context),
      resolveValue(options.tools, context),
      resolveValue(options.systemPrompt, context),
    ]);
    // Mirror the allow-list onto the session so the authoring gate
    // (`sendAgentReply`) agrees with the loop's offer gate.
    if (options.authorInvocation) {
      const current = session.getAllowedTools();
      if (
        current.length !== allowedTools.length ||
        current.some((tool, index) => tool !== allowedTools[index])
      ) {
        await chat.updateAgentSessionConfig({
          agentSessionId: String(session.id),
          actorProfileId: principal.profileId,
          tenantId: principal.tenantId,
          allowedTools,
        });
      }
    }
    const continuations = continuationStoreFor(context, chat, session);
    return {
      ai,
      model,
      clientTools,
      continuations,
      continuationKey: String(thread.id),
      turn: {
        ai,
        principal: {
          runAsUserId: principal.userId,
          tenantId: principal.tenantId,
          allowedTools,
        },
        ...(options.db ? { db: options.db } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        extraTools: [...(extraTools ?? [])],
        tools: [...(tools ?? [])],
        clientTools,
        continuations,
        continuationKey: String(thread.id),
        ...(model ? { model } : {}),
        ...(options.maxSteps !== undefined
          ? { maxSteps: options.maxSteps }
          : {}),
        ...(options.maxTurnTokens !== undefined
          ? { maxTurnTokens: options.maxTurnTokens }
          : {}),
        ...(options.maxTurnMs !== undefined
          ? { maxTurnMs: options.maxTurnMs }
          : {}),
        ...(options.maxTokens !== undefined
          ? { maxTokens: options.maxTokens }
          : {}),
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(principal.permissions
          ? { permissions: principal.permissions }
          : {}),
        ...(options.audit ? { audit: options.audit } : {}),
        ...(options.postgresRls !== undefined
          ? { postgresRls: options.postgresRls }
          : {}),
        onBehalfOfUserId: principal.userId,
        signal: context.event.request.signal,
        ...(options.onUsage
          ? {
              onUsage: (usage: ToolLoopUsage) => {
                try {
                  options.onUsage?.(usage, context);
                } catch (error) {
                  safeLog(error);
                }
              },
            }
          : {}),
        ...(options.describeTool ? { describeTool: options.describeTool } : {}),
        onError: safeLog,
        serializeMessage: (message: unknown) =>
          toAssistantMessageWire(message as ChatMessage),
        author: {
          chatService: chat,
          agentSessionId: String(session.id),
          tenantId: principal.tenantId,
          threadId: String(thread.id),
          ...(options.authorInvocation
            ? { authorInvocation: options.authorInvocation }
            : {}),
        },
      },
    };
  };

  const stream = (
    events: AsyncGenerator<AssistantTurnEvent<AssistantMessageWire>, unknown>,
  ) =>
    createAssistantTurnResponse(events, {
      ...(options.heartbeatMs !== undefined
        ? { heartbeatMs: options.heartbeatMs }
        : {}),
      onError: safeLog,
    });

  // ---- route bodies ------------------------------------------------------

  const listThreads = async (context: AssistantRequestContext) => {
    const chat = await chatFor(context.principal);
    const session = await findSession(chat, context.principal);
    if (!session?.chatRoomId) return json({ items: [] });
    const threads = await chat.listRoomThreads({
      roomId: session.chatRoomId,
      actorProfileId: context.principal.profileId,
      tenantId: context.principal.tenantId,
    });
    return json({ items: threads.map(toAssistantThreadWire) });
  };

  const createThread = async (context: AssistantRequestContext) => {
    const body = await readJsonObject(context.event.request, maxBody);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw badRequest(
        `A title of 1 to ${MAX_TITLE_LENGTH} characters is required.`,
      );
    }
    const { principal } = context;
    const chat = await chatFor(principal);
    const allowedTools = await allowedToolsFor(context);
    const { session } = await chat.createAgentSession({
      tenantId: principal.tenantId,
      agentId,
      actorProfileId: principal.profileId,
      allowedTools,
      sessionKey: ASSISTANT_DOCK_SESSION_KEY,
    });
    if (!session.chatRoomId) throw new Error('Assistant session has no room');
    const thread = await chat.startThread({
      tenantId: principal.tenantId,
      roomId: session.chatRoomId,
      actorProfileId: principal.profileId,
      title,
    });
    return json({ thread: toAssistantThreadWire(thread) }, 201);
  };

  const loadMessages = async (
    context: AssistantRequestContext,
    threadId: string,
  ) => {
    const { principal } = context;
    const chat = await chatFor(principal);
    const session = await findSession(chat, principal);
    await requireOwnThread(chat, principal, session, threadId);
    const messages = await chat.getThreadMessages({
      threadId,
      actorProfileId: principal.profileId,
      tenantId: principal.tenantId,
      limit: 200,
    });
    return json({ items: messages.map(toAssistantMessageWire) });
  };

  /**
   * The answer for a send whose reservation (its deterministic user-message
   * id) is already stored, or `null` when it is not. Replies are the
   * messages linked to the send (`replyToMessageId`), never "whatever
   * follows it", so overlapping sends in one thread keep their own replies.
   * Legacy replies written without the link are not attributed.
   */
  const reservationAnswer = async (
    context: AssistantRequestContext,
    chat: ChatService,
    session: AgentSession,
    threadId: string,
    messageId: string,
  ): Promise<Response | null> => {
    const { principal } = context;
    const stored = await chat.getThreadMessageReplies({
      threadId,
      messageId,
      actorProfileId: principal.profileId,
      tenantId: principal.tenantId,
    });
    const anchor = stored?.message;
    if (
      !stored ||
      anchor?.role !== 'user' ||
      anchor.senderProfileId !== principal.profileId
    ) {
      return null;
    }
    const userMessage = toAssistantMessageWire(anchor);
    const after = stored.replies.map(toAssistantMessageWire);
    const assistantMessage = [...after]
      .reverse()
      .find((message) => message.role === 'assistant');
    const answer = (
      outcome: AssistantDuplicateSendWire['outcome'],
    ): Response => {
      const body: AssistantDuplicateSendWire = {
        duplicate: true,
        inProgress: outcome === 'in_progress',
        outcome,
        userMessage,
        ...(assistantMessage ? { assistantMessage } : {}),
        messages: after,
      };
      return json(body, 200);
    };
    const turnFailed = () =>
      new AssistantRouteError(
        409,
        'turn_failed',
        'The assistant could not answer this message. Send it again.',
      );
    const metadata = parseObject(anchor.metadata) ?? {};
    const recorded = metadata.turnOutcome;
    // A linked assistant reply is the turn's final answer (the runner
    // stores exactly one, when the turn finishes; tool results are role
    // `tool`; a suspension stores none), so it is completion evidence even
    // if the outcome marker is stale or its write was lost.
    if (assistantMessage) return answer('completed');
    if (recorded === 'failed') throw turnFailed();
    if (recorded === 'cancelled') return answer('cancelled');
    if (recorded === 'completed') return answer('completed');
    if (recorded === 'suspended') {
      // Waiting on the browser: alive exactly as long as its continuation.
      const continuationId = nonEmpty(metadata.turnContinuationId);
      if (!continuationId) throw turnFailed();
      const store = continuationStoreFor(context, chat, session);
      const alive = store.has
        ? await store.has(threadId, continuationId)
        : Date.now() - new Date(String(metadata.turnSettledAt)).getTime() <=
          DEFAULT_CONTINUATION_TTL_MS;
      if (!alive) throw turnFailed();
      return answer('in_progress');
    }
    // Not settled yet (no marker), or a resumed leg running: abandoned once
    // older than `abandonedTurnMs`, measured from when it last started.
    const since =
      recorded === 'running' ? metadata.turnSettledAt : anchor.created_at;
    const age = Date.now() - new Date(String(since)).getTime();
    if (Number.isFinite(age) && age > abandonedTurnMs) throw turnFailed();
    return answer('in_progress');
  };

  /** Record the turn's outcome on its send; never fails the response. */
  const settleOutcome =
    (
      chat: ChatService,
      principal: AssistantPrincipal,
      threadId: string,
      messageId: string,
    ) =>
    async (
      outcome: ChatClientRequestOutcome,
      settings: { quiet?: boolean } = {},
    ) => {
      try {
        await chat.recordClientRequestOutcome({
          tenantId: principal.tenantId,
          threadId,
          messageId,
          actorProfileId: principal.profileId,
          outcome,
          resumedFrom: null,
        });
      } catch (error) {
        // `quiet`: the send may never have been stored.
        if (!settings.quiet) safeLog(error);
      }
    };

  /**
   * The turn runner's own lifecycle reports (`onState`), recorded on the send
   * they belong to. The send comes from the runner: the user message for a
   * first leg, the consumed continuation for a resumed one — never from the
   * request. Writes are monotonic compare-and-set (`ChatService`).
   */
  const recordTurnState =
    (chat: ChatService, principal: AssistantPrincipal, threadId: string) =>
    async (state: AssistantTurnState): Promise<void> => {
      if (!state.originMessageId) return;
      await chat.recordClientRequestOutcome({
        tenantId: principal.tenantId,
        threadId,
        messageId: state.originMessageId,
        actorProfileId: principal.profileId,
        outcome: state.state,
        resumedFrom: state.resumedFrom,
        continuationId: state.continuationId ?? null,
      });
    };

  const sendMessage = async (
    context: AssistantRequestContext,
    threadId: string,
  ) => {
    const body = await readJsonObject(context.event.request, maxBody);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw badRequest('The message is empty.', 'empty_message');
    if (content.length > maxContent) {
      throw new AssistantRouteError(
        413,
        'message_too_long',
        `Messages are limited to ${maxContent} characters.`,
      );
    }
    const clientRequestId = body.clientRequestId;
    if (
      typeof clientRequestId !== 'string' ||
      !CLIENT_REQUEST_ID.test(clientRequestId)
    ) {
      throw badRequest('clientRequestId is missing or invalid.');
    }
    const references = body.attachments;
    if (
      references !== undefined &&
      references !== null &&
      (!Array.isArray(references) ||
        references.length > MAX_ATTACHMENTS_PER_MESSAGE)
    ) {
      throw badRequest('attachments must be a short list.');
    }
    const hasAttachments = Array.isArray(references) && references.length > 0;
    if (hasAttachments && !options.attachments) {
      throw badRequest(
        'This assistant does not accept attachments.',
        'attachments_unsupported',
      );
    }
    // Validate the model before any write.
    resolveModel(body.model);

    const { principal } = context;
    const chat = await chatFor(principal);
    const session = await findSession(chat, principal);
    const thread = await requireOwnThread(chat, principal, session, threadId);
    if (!session?.chatRoomId) throw notFound();

    // The reservation is the user message's deterministic primary key, scoped
    // to tenant, room, thread, actor and clientRequestId: the database's
    // primary-key uniqueness makes it atomic and durable across replicas.
    const reservationId = clientRequestMessageId({
      tenantId: principal.tenantId,
      roomId: session.chatRoomId,
      threadId,
      actorProfileId: principal.profileId,
      clientRequestId,
    });
    const known = await reservationAnswer(
      context,
      chat,
      session,
      threadId,
      reservationId,
    );
    if (known) return known;

    let attachments: ChatMessageAttachment[] | null = null;
    if (hasAttachments && options.attachments) {
      const verified = await options.attachments.verify(
        references as unknown[],
        context,
      );
      if (!verified || verified.length !== (references as unknown[]).length) {
        throw badRequest(
          'An attachment could not be found.',
          'attachment_not_found',
        );
      }
      attachments = verified.map((record) => ({
        id: record.id,
        filename: record.name,
        contentType: record.contentType,
        size: record.size,
        ...(record.url ? { url: record.url } : {}),
      }));
    }

    // Everything that can refuse (the AI factory's 503 included) runs before
    // the reservation, so a refused send stores nothing.
    const setup = await turnSetup(context, chat, session, thread, body);

    // A failure after the reservation may have been stored settles it as
    // failed (a no-op when nothing was stored), so a retry is told so at
    // once instead of waiting out `abandonedTurnMs`.
    const recordFailure = settleOutcome(
      chat,
      principal,
      threadId,
      reservationId,
    );
    let userMessage: ChatMessage;
    try {
      userMessage = await chat.sendMessage({
        tenantId: principal.tenantId,
        roomId: session.chatRoomId,
        threadId,
        actorProfileId: principal.profileId,
        agentSessionId: String(session.id),
        content,
        clientRequestId,
        attachments,
      });
    } catch (error) {
      if (error instanceof ChatClientRequestConflictError) {
        // Another request (any replica) took this reservation first.
        const answer = await reservationAnswer(
          context,
          chat,
          session,
          threadId,
          reservationId,
        );
        if (answer) return answer;
      } else {
        await recordFailure('failed', { quiet: true });
      }
      throw error;
    }
    const userWire = toAssistantMessageWire(userMessage);

    try {
      const history: AIMessage[] = [];
      if (historyLimit > 0) {
        const earlier = await chat.getThreadMessages({
          threadId,
          actorProfileId: principal.profileId,
          tenantId: principal.tenantId,
          limit: historyLimit + 1,
        });
        for (const message of earlier) {
          if (String(message.id) === userWire.id) continue;
          if (message.role !== 'user' && message.role !== 'assistant') {
            continue;
          }
          if (!message.content) continue;
          history.push({ role: message.role, content: message.content });
        }
      }

      const events = runAssistantTurn<AssistantMessageWire>({
        ...setup.turn,
        history: history.slice(-historyLimit),
        userMessage: content,
        // Every reply links to this send, and a suspension keeps it.
        originMessageId: userWire.id,
        onState: recordTurnState(chat, principal, threadId),
      });
      return stream(detached({ type: 'message', message: userWire }, events));
    } catch (error) {
      await recordFailure('failed');
      throw error;
    }
  };

  const resumeTurn = async (
    context: AssistantRequestContext,
    threadId: string,
  ) => {
    const body = await readJsonObject(context.event.request, maxBody);
    const continuationId = requireId(body.continuationId, 'continuationId');
    if (
      !Array.isArray(body.results) ||
      body.results.length > MAX_CLIENT_TOOLS
    ) {
      throw badRequest('results must be a list of tool results.');
    }
    const results: ClientToolResultInput[] = body.results.map((raw) => {
      const entry = raw as Record<string, unknown> | null;
      if (!entry || typeof entry !== 'object') {
        throw badRequest('Each result must be an object.');
      }
      const id = requireId(entry.id, 'result id');
      if (typeof entry.ok !== 'boolean') {
        throw badRequest('Each result needs an ok flag.');
      }
      const result =
        typeof entry.result === 'string'
          ? entry.result.slice(0, MAX_CLIENT_TOOL_RESULT_CHARS)
          : undefined;
      const error =
        typeof entry.error === 'string' ? entry.error.slice(0, 500) : undefined;
      return {
        id,
        ok: entry.ok,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    });
    resolveModel(body.model);

    const { principal } = context;
    const chat = await chatFor(principal);
    const session = await findSession(chat, principal);
    const thread = await requireOwnThread(chat, principal, session, threadId);
    if (!session) throw notFound();
    const setup = await turnSetup(context, chat, session, thread, body);
    // The send this leg belongs to comes only from the continuation it
    // consumes (stored server-side when the turn suspended), reported by the
    // runner; a request's `clientRequestId` is ignored here. A missing,
    // foreign or expired continuation is never consumed, so it changes no
    // send.
    return stream(
      detached(
        null,
        runAssistantTurn<AssistantMessageWire>({
          ...setup.turn,
          resume: { continuationId, results },
          onState: recordTurnState(chat, principal, threadId),
        }),
      ),
    );
  };

  const uploadAttachment = async (context: AssistantRequestContext) => {
    const storage = options.attachments;
    if (!storage) {
      throw new AssistantRouteError(
        404,
        'attachments_unsupported',
        'This assistant does not accept attachments.',
      );
    }
    const request = context.event.request;
    const type = request.headers.get('content-type') ?? '';
    if (!/^multipart\/form-data\b/i.test(type)) {
      throw new AssistantRouteError(
        415,
        'unsupported_media_type',
        'Upload a file as multipart/form-data.',
      );
    }
    const maxBytes = storage.maxBytes ?? DEFAULT_ASSISTANT_MAX_ATTACHMENT_BYTES;
    const bytes = await readBounded(request, maxBytes + 64 * 1024);
    let form: FormData;
    try {
      form = await new Response(
        bytes as unknown as ConstructorParameters<typeof Response>[0],
        {
          headers: { 'content-type': type },
        },
      ).formData();
    } catch {
      throw badRequest('The upload could not be read.');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw badRequest('Attach the upload as the `file` field.');
    }
    if (file.size > maxBytes) {
      throw new AssistantRouteError(
        413,
        'payload_too_large',
        'The file is too large.',
      );
    }
    const record = await storage.upload(file as File, context);
    return json(
      {
        attachment: {
          id: record.id,
          name: record.name,
          contentType: record.contentType,
          size: record.size,
          ...(record.url ? { url: record.url } : {}),
        },
      },
      201,
    );
  };

  const runAction = async (
    context: AssistantRequestContext,
    phase: 'preview' | 'apply',
  ) => {
    if (!options.actions) {
      throw new AssistantRouteError(
        404,
        'actions_unsupported',
        'This assistant has no actions.',
      );
    }
    const body = await readJsonObject(context.event.request, maxBody);
    if (body.phase !== phase) {
      throw badRequest(`Expected a ${phase} request.`);
    }
    const adapter = await resolveValue(options.actions.adapter, context);
    if (!adapter) throw new Error('No data-surface action adapter resolved.');
    const { principal } = context;
    const allowedTools = await allowedToolsFor(context);
    const actionContext = {
      principal: {
        ...(options.db ? { db: options.db } : {}),
        principal: {
          runAsUserId: principal.userId,
          tenantId: principal.tenantId,
          allowedTools,
        },
        onBehalfOfUserId: principal.userId,
        ...(principal.permissions
          ? { permissions: principal.permissions }
          : {}),
        ...(options.audit ? { audit: options.audit } : {}),
        ...(options.postgresRls !== undefined
          ? { postgresRls: options.postgresRls }
          : {}),
      },
    } as Parameters<AssistantActionAdapter['preview']>[1];
    const request = body as unknown as Parameters<
      AssistantActionAdapter['preview']
    >[0];
    try {
      const result =
        phase === 'preview'
          ? await adapter.preview(request, actionContext)
          : await adapter.apply(request, actionContext);
      return json({ result });
    } catch (error) {
      safeLog(error);
      return json(
        {
          error:
            phase === 'apply'
              ? 'The change may or may not have been applied. Check again.'
              : GENERIC_ERROR,
          code: phase === 'apply' ? 'outcome_unknown' : 'internal_error',
        },
        500,
      );
    }
  };

  // ---- dispatch ----------------------------------------------------------

  const handle: AssistantRouteHandler = async (event) => {
    try {
      const segments = segmentsOf(event);
      const match = segments ? matchRoute(segments) : null;
      if (!match) {
        throw new AssistantRouteError(404, 'not_found', 'Not found.');
      }
      const method = event.request.method.toUpperCase();
      const allowed = ROUTE_METHODS[match.route];
      if (!allowed.includes(method)) {
        return json(
          { error: 'Method not allowed.', code: 'method_not_allowed' },
          405,
          { allow: allowed.join(', ') },
        );
      }
      if (
        method !== 'GET' &&
        checkOrigin &&
        !originAllowed(event.request, event.url, trustedOrigins)
      ) {
        throw new AssistantRouteError(
          403,
          'invalid_origin',
          'Invalid request origin.',
        );
      }
      const principal = await resolvePrincipal(event);
      if (!principal) {
        throw new AssistantRouteError(
          401,
          'unauthenticated',
          'Sign in to use the assistant.',
        );
      }
      if (
        !nonEmpty(principal.userId) ||
        !nonEmpty(principal.profileId) ||
        !nonEmpty(principal.tenantId)
      ) {
        throw new AssistantRouteError(
          403,
          'principal_incomplete',
          'Your session cannot use the assistant.',
        );
      }
      const context: AssistantRequestContext = { event, principal };
      switch (match.route) {
        case 'threads':
          return method === 'GET'
            ? await listThreads(context)
            : await createThread(context);
        case 'thread-messages': {
          const threadId = requireId(match.threadId, 'thread id');
          return method === 'GET'
            ? await loadMessages(context, threadId)
            : await sendMessage(context, threadId);
        }
        case 'thread-resume':
          return await resumeTurn(
            context,
            requireId(match.threadId, 'thread id'),
          );
        case 'attachments':
          return await uploadAttachment(context);
        case 'actions':
          return await runAction(context, match.phase);
      }
    } catch (error) {
      if (error instanceof AssistantRouteError) return errorResponse(error);
      if (isAuthorizationFailure(error)) return errorResponse(notFound());
      safeLog(error);
      return json({ error: GENERIC_ERROR, code: 'internal_error' }, 500);
    }
  };

  return { GET: handle, POST: handle, handle };
}

/**
 * Run a turn to its end regardless of the reader. The events are pumped
 * from the moment the handler returns into a buffer the response reads from
 * (after `first`, when given); a reader that leaves only stops reading. The
 * turn itself records its outcome (`onState`), so nothing here depends on
 * how far the reader got. A client disconnect cancels the turn through the
 * request's abort signal, as the dock's Stop does; the runner then records
 * `cancelled` (or `completed`, if the reply was already stored).
 */
function detached<M>(
  first: AssistantTurnEvent<M> | null,
  events: AsyncGenerator<AssistantTurnEvent<M>, unknown>,
): AsyncGenerator<AssistantTurnEvent<M>, void> {
  const buffer: AssistantTurnEvent<M>[] = first ? [first] : [];
  let finished = false;
  let notify: (() => void) | null = null;
  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  void (async () => {
    try {
      for await (const event of events) {
        buffer.push(event);
        wake();
      }
    } catch {
      // runAssistantTurn reports failures in-band and does not throw.
    } finally {
      finished = true;
      wake();
    }
  })();
  return (async function* () {
    for (;;) {
      if (buffer.length > 0) {
        yield buffer.shift() as AssistantTurnEvent<M>;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  })();
}
