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
 * import { runtime } from '$lib/server/smrt';
 * export const { GET, POST } = mountAssistantRoutes({
 *   allowedTools: ['notes.read', 'notes.create'],
 *   runtime,
 * });
 * ```
 *
 * `ai` defaults to the `smrt.config` `ai` block (resolved per turn through
 * `@happyvertical/smrt-config`); `allowedTools` alone offers the manifest
 * operations it names; `runtime` supplies the per-request database and the
 * streamed turn's own database lifetime (`db` may instead be a per-request
 * resolver).
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
import {
  getConfig,
  loadConfig,
  resolveConfiguredAIProvider,
  toAIClientOptions,
} from '@happyvertical/smrt-config';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
} from '@happyvertical/smrt-users';
import {
  ASSISTANT_TURN_GENERIC_ERROR,
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
  buildManifestToolCatalog,
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

/**
 * The two application-runtime calls the routes use; the runtime from
 * `@happyvertical/smrt-app-runtime/sveltekit` satisfies it as is.
 */
export interface AssistantRouteRuntime {
  /** The request's database (its RLS transaction inside one). */
  databaseConfig(): SmrtClassOptions['db'];
  /**
   * Run `fn` as a principal: under `database-rls` in a fresh transaction
   * publishing that user, tenant and live permissions (capped to `scopes`;
   * omitted means no cap), which `databaseConfig()` returns inside `fn`.
   * `fn` receives the bound principal, whose `scopes` are the effective set.
   */
  runAsPrincipal<T>(
    principal: {
      readonly id: string;
      readonly tenantId: string;
      readonly scopes?: readonly string[];
    },
    fn: (bound: AssistantRouteBoundPrincipal) => Promise<T>,
  ): Promise<T>;
}

/** What {@link AssistantRouteRuntime.runAsPrincipal} hands its callback. */
export interface AssistantRouteBoundPrincipal {
  /** The effective permissions: live at bind time, capped to the scopes. */
  readonly scopes: readonly string[];
}

/** Options for {@link mountAssistantRoutes}. */
export interface MountAssistantRoutesOptions {
  /**
   * The AI client, or a factory called once per turn. Omitted, each turn
   * builds a client from the `smrt.config` `ai` block through the shared
   * resolver (`resolveConfiguredAIProvider` → `toAIClientOptions` →
   * `getAI`), loading the config file first if nothing has. A factory that
   * throws (including `AIProviderNotConfiguredError` when nothing is
   * configured) answers 503 before anything is written; the error goes to
   * `onError` only. Passing `ai` explicitly as `undefined`/`null` is a mount
   * error, not a fallback.
   */
  ai?:
    | AIInterface
    | ((
        context: AssistantRequestContext & { model?: string },
      ) => AIInterface | Promise<AIInterface>);
  /**
   * Database for chat persistence, the tool catalog and the principal run:
   * a fixed value, or a resolver called once per request (and once more
   * inside a streamed turn's own database lifetime, see `runtime`). Default
   * with `runtime`: `() => runtime.databaseConfig()`.
   */
  db?: AssistantRouteValue<SmrtClassOptions['db']>;
  /**
   * The application runtime (`runtime` from
   * `@happyvertical/smrt-app-runtime/sveltekit`). A request inside an RLS
   * transaction (`database-rls`) ends, committing that transaction, when the
   * handler returns its streaming response, so a turn never keeps it: with
   * `runtime`, a streamed turn waits for the request's transaction to end and
   * then runs, persists its reply and records its outcome in its own
   * transaction for the same principal (`runtime.runAsPrincipal`). Without
   * it, such a turn runs to completion before the response is returned (the
   * events arrive at once, not incrementally). Outside an RLS transaction
   * (SQLite, the local profile) the turn streams as before either way.
   */
  runtime?: AssistantRouteRuntime;
  /** Default: {@link resolveAssistantPrincipalFromLocals}. */
  resolvePrincipal?: AssistantPrincipalResolver;
  /** The assistant's agent id (its `bot` profile slug). Default `smrt-assistant`. */
  agentId?: string;
  systemPrompt?: AssistantRouteValue<string | undefined>;
  /**
   * Server tool allow-list, fail-closed: absent or empty offers NO tools.
   * Gates `extraTools`, `tools` and the data-surface action adapter. Without
   * `tools`, the route offers the manifest operations named here
   * (`buildManifestToolCatalog`), except names an `extraTools` entry serves.
   * A name nothing provides is a configuration error: at mount when its
   * collection is already registered, otherwise the turn answers 503 (the
   * check is skipped when `actions` is set, since action tools may be named).
   */
  allowedTools?: AssistantRouteValue<readonly string[]>;
  /** Server tools (e.g. `createDataSurfaceTools()`), narrowed by `allowedTools`. */
  extraTools?: AssistantRouteValue<readonly PrincipalTool[]>;
  /**
   * Manifest tools, narrowed by `allowedTools`. Omitted, they are built from
   * `allowedTools`; pass a value (even `[]`) to supply them yourself.
   */
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
  /**
   * How long a streamed turn waits for its request's RLS transaction to end
   * before it reports an error instead of running (see `runtime`). It then
   * keeps watching, up to `abandonedTurnMs`, and settles a send that
   * committed late as `failed`. Default 60 s.
   */
  turnStartTimeoutMs?: number;
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

let configLoad: Promise<unknown> | undefined;

/**
 * The default AI factory: the `smrt.config` `ai` block (plus its key
 * variable) through the shared resolver. Loads the config file once when no
 * one has; throws `AIProviderNotConfiguredError` (variable names only, never
 * values) when nothing is configured.
 */
async function configuredAssistantAI(): Promise<AIInterface> {
  if (getConfig() === null) {
    configLoad ??= loadConfig().catch((error: unknown) => {
      configLoad = undefined;
      throw error;
    });
    await configLoad;
  }
  const options = toAIClientOptions(resolveConfiguredAIProvider());
  // Imported per turn, as the dev routes do: mounting (and SvelteKit's
  // build-time route analysis) never loads a provider SDK.
  const { getAI } = await import('@happyvertical/ai');
  return getAI(options);
}

/**
 * Allow-listed names that neither `extraTools` nor the manifest catalog
 * provides. With `registeredOnly`, only names whose collection the registry
 * already knows: a class may not be registered yet when a route module is
 * imported (e.g. during SvelteKit's build analysis), so only those prove a
 * typo at mount.
 */
function unprovidedToolNames(
  requested: readonly string[],
  offered: readonly ManifestTool[],
  registeredOnly: boolean,
): string[] {
  const provided = new Set(offered.map((tool) => tool.slug));
  const missing = requested.filter((name) => !provided.has(name));
  if (!registeredOnly || missing.length === 0) return missing;
  // `all: true` only lists collections for this check; nothing it returns is
  // ever offered to a model.
  const collections = new Set(
    buildManifestToolCatalog({ all: true }).map((tool) => tool.collection),
  );
  return missing.filter((name) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 && collections.has(name.slice(0, dot));
  });
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
  options: MountAssistantRoutesOptions = {},
): AssistantRoutes {
  if ('ai' in options && options.ai == null) {
    throw new Error(
      'mountAssistantRoutes: `ai` was passed but is empty. Pass an AI client ' +
        'or a factory, or omit `ai` to use the smrt.config `ai` block.',
    );
  }
  const aiSource = options.ai ?? configuredAssistantAI;
  if (
    options.tools === undefined &&
    !options.actions &&
    Array.isArray(options.allowedTools) &&
    typeof options.extraTools !== 'function'
  ) {
    // Fail fast on a name nothing can provide (a typo), when knowable now.
    const extra = new Set(
      ((options.extraTools ?? []) as readonly PrincipalTool[]).map(
        (tool) => tool.slug,
      ),
    );
    const requested = (options.allowedTools as readonly unknown[]).filter(
      (name): name is string =>
        typeof name === 'string' && name.length > 0 && !extra.has(name),
    );
    if (requested.length > 0) {
      const unknown = unprovidedToolNames(
        requested,
        buildManifestToolCatalog({ allowedTools: requested }),
        true,
      );
      if (unknown.length > 0) {
        throw new Error(
          `mountAssistantRoutes: allowedTools names ${unknown.join(', ')}, ` +
            'which no manifest operation or extraTools entry provides.',
        );
      }
    }
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
  const turnStartTimeoutMs =
    options.turnStartTimeoutMs ?? DEFAULT_ASSISTANT_TURN_START_TIMEOUT_MS;

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

  const runtime = options.runtime;
  const dbOption: AssistantRouteValue<SmrtClassOptions['db']> | undefined =
    options.db !== undefined || !runtime
      ? options.db
      : () => runtime.databaseConfig();

  // The database is resolved once per context (a resolver may return the
  // request's own RLS transaction) and never shared across requests. A
  // streamed turn's own lifetime gets a fresh context, so it resolves anew.
  const requestDbs = new WeakMap<
    AssistantRequestContext,
    Promise<SmrtClassOptions['db'] | undefined>
  >();
  const dbFor = (context: AssistantRequestContext) => {
    let db = requestDbs.get(context);
    if (!db) {
      db = resolveValue(dbOption, context);
      requestDbs.set(context, db);
    }
    return db;
  };

  const chatFor = async (context: AssistantRequestContext) => {
    const db = await dbFor(context);
    const chat = await ChatService.create({
      tenantId: context.principal.tenantId,
      ...(db ? { db } : {}),
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
        typeof aiSource === 'function'
          ? await aiSource({ ...context, ...(model ? { model } : {}) })
          : aiSource;
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

  /**
   * The manifest tools a turn is offered: `tools` when given, otherwise the
   * catalog entries for the allow-listed names `extraTools` does not serve.
   * A name nothing provides refuses the turn (503, detail to `onError`)
   * unless `actions` is set (action tools are allow-listed too).
   */
  const manifestToolsFor = async (
    context: AssistantRequestContext,
    allowedTools: readonly string[],
    extraTools: readonly PrincipalTool[],
    db: SmrtClassOptions['db'] | undefined,
  ): Promise<readonly ManifestTool[]> => {
    if (options.tools !== undefined) {
      return (await resolveValue(options.tools, context)) ?? [];
    }
    const extra = new Set(extraTools.map((tool) => tool.slug));
    const requested = allowedTools.filter((name) => !extra.has(name));
    if (requested.length === 0) return [];
    const tools = buildManifestToolCatalog({
      ...(db ? { db } : {}),
      allowedTools: requested,
    });
    if (!options.actions) {
      const unknown = unprovidedToolNames(requested, tools, false);
      if (unknown.length > 0) {
        safeLog(
          new Error(
            `mountAssistantRoutes: allowedTools names ${unknown.join(', ')}, ` +
              'which no manifest operation or extraTools entry provides.',
          ),
        );
        throw new AssistantRouteError(
          503,
          'assistant_unavailable',
          'The assistant is unavailable right now. Please try again later.',
        );
      }
    }
    return tools;
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

  /**
   * The request-bound part of a turn (model, allow-list, AI client, abort),
   * resolved once per request before anything is stored.
   */
  const prepareTurn = async (
    context: AssistantRequestContext,
    body: Record<string, unknown>,
  ) => {
    const model = resolveModel(body.model);
    const allowedTools = await allowedToolsFor(context);
    const clientTools = sanitizeClientToolDeclarations(
      body.clientTools,
      options.clientToolAllowList ?? [],
    );
    const ai = await resolveAI(context, model);
    // The turn stops when the request is aborted OR the response body is
    // cancelled (a client that left), whichever the adapter reports.
    const abort = new AbortController();
    const requestSignal = context.event.request.signal;
    if (requestSignal.aborted) abort.abort();
    else {
      requestSignal.addEventListener('abort', () => abort.abort(), {
        once: true,
      });
    }
    return { abort, ai, model, allowedTools, clientTools };
  };
  type PreparedTurn = Awaited<ReturnType<typeof prepareTurn>>;

  /**
   * Everything a turn needs that is bound to a database: built for the
   * request (where every refusal happens), and again inside a streamed
   * turn's own database lifetime (`mirror: false`: the request already
   * mirrored the allow-list).
   */
  const turnSetup = async (
    context: AssistantRequestContext,
    chat: ChatService,
    session: AgentSession,
    thread: ChatThread,
    prepared: PreparedTurn,
    mirror = true,
  ) => {
    const { principal } = context;
    const { abort, ai, model, allowedTools, clientTools } = prepared;
    const [extraTools, systemPrompt, db] = await Promise.all([
      resolveValue(options.extraTools, context),
      resolveValue(options.systemPrompt, context),
      dbFor(context),
    ]);
    const tools = await manifestToolsFor(
      context,
      allowedTools,
      extraTools ?? [],
      db,
    );
    // Mirror the allow-list onto the session so the authoring gate
    // (`sendAgentReply`) agrees with the loop's offer gate.
    if (options.authorInvocation && mirror) {
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
      abort,
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
        ...(db ? { db } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        extraTools: [...(extraTools ?? [])],
        tools: [...tools],
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
        signal: abort.signal,
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
    abort: AbortController,
  ) =>
    createAssistantTurnResponse(events, {
      ...(options.heartbeatMs !== undefined
        ? { heartbeatMs: options.heartbeatMs }
        : {}),
      onError: safeLog,
      // A cancelled body cancels the turn, even when the adapter never
      // aborts the request signal on disconnect.
      onCancel: () => abort.abort(),
    });

  type TurnSetup = Awaited<ReturnType<typeof turnSetup>>;
  type TurnEvent = AssistantTurnEvent<AssistantMessageWire>;

  /**
   * Answer with a turn's events. `start` runs the turn on a chat service
   * and setup bound to the database it may use. Outside an RLS request
   * transaction that is the request's own, and the turn is detached. Inside
   * one, the transaction commits when the handler returns, so the turn never
   * keeps it: with `runtime` it runs, once that transaction has ended, in its
   * own principal-bound transaction (rebinding chat, tools and continuations
   * there, and first checking that `durableSend`, the stored user message,
   * committed); without `runtime` it runs to completion before returning.
   */
  const respondWithTurn = async (
    context: AssistantRequestContext,
    chat: ChatService,
    session: AgentSession,
    thread: ChatThread,
    prepared: PreparedTurn,
    setup: TurnSetup,
    first: TurnEvent | null,
    start: (
      chat: ChatService,
      setup: TurnSetup,
    ) => AsyncGenerator<TurnEvent, unknown>,
    durableSend?: string,
  ): Promise<Response> => {
    const transaction = requestTransaction();
    if (!transaction) {
      return stream(
        detached(first, pump(start(chat, setup))).events,
        prepared.abort,
      );
    }
    const isActive = transaction.isActive;
    if (!runtime || typeof isActive !== 'function') {
      const turn = detached(first, pump(start(chat, setup)));
      await turn.settled;
      return stream(turn.events, prepared.abort);
    }
    const { principal } = context;
    // The request's authority, frozen before the response returns (an empty
    // set stays empty): the principal's snapshot, else the permissions the
    // request's RLS context published. Always the cap, so the turn runs with
    // (this snapshot ∩ live at bind) and never gains a later grant.
    const bound = {
      id: principal.userId,
      tenantId: principal.tenantId,
      scopes: Object.freeze([
        ...(principal.permissions ??
          getCurrentSessionPermissionContext()?.permissions ??
          []),
      ]),
    };
    /** Record the stored send as failed, in a fresh lifetime. */
    const settleFailed = async (messageId: string, onlyIfStored = false) => {
      try {
        await runtime.runAsPrincipal(bound, async () => {
          const settleChat = await chatFor({ event: context.event, principal });
          if (onlyIfStored) {
            const stored = await settleChat.getThreadMessageReplies({
              threadId: String(thread.id),
              messageId,
              actorProfileId: principal.profileId,
              tenantId: principal.tenantId,
            });
            if (!stored?.message) return;
          }
          await settleOutcome(
            settleChat,
            principal,
            String(thread.id),
            messageId,
          )('failed');
        });
      } catch (settleError) {
        safeLog(settleError);
      }
    };
    /** After a timed-out start: settle the send once its request ends. */
    const settleLateSend = async (
      requestActive: () => boolean,
      messageId: string,
    ) => {
      try {
        if (await requestEnded(requestActive, abandonedTurnMs)) {
          await settleFailed(messageId, true);
        } else {
          safeLog(
            new Error(
              'mountAssistantRoutes: the request transaction never ended; its send was not settled.',
            ),
          );
        }
      } catch (error) {
        safeLog(error);
      }
    };
    const ownLifetime = async (emit: (event: TurnEvent) => void) => {
      // Events after which the browser acts on stored state (resume, retry,
      // reload) wait until this lifetime has committed, with all that follow.
      const held: TurnEvent[] = [];
      let sendConfirmed = false;
      const requestActive = () => isActive.call(transaction) as boolean;
      try {
        if (!(await requestEnded(requestActive, turnStartTimeoutMs))) {
          // Never abandon the send: once the request's transaction ends,
          // settle it if it committed (a rollback stored nothing).
          if (durableSend) void settleLateSend(requestActive, durableSend);
          throw new Error(
            'mountAssistantRoutes: the request transaction did not end; the turn did not run.',
          );
        }
        await runtime.runAsPrincipal(bound, async (granted) => {
          // The turn's authority is the bound principal's effective set, as
          // narrowed at bind time; the pre-bind snapshot never reaches it.
          const turnContext: AssistantRequestContext = {
            event: context.event,
            principal: {
              ...principal,
              permissions: effectiveScopes(granted, bound.scopes),
            },
          };
          const turnChat = await chatFor(turnContext);
          if (durableSend) {
            const stored = await turnChat.getThreadMessageReplies({
              threadId: String(thread.id),
              messageId: durableSend,
              actorProfileId: principal.profileId,
              tenantId: principal.tenantId,
            });
            if (!stored?.message) {
              throw new Error(
                'mountAssistantRoutes: the send was not stored; the turn did not run.',
              );
            }
            sendConfirmed = true;
          }
          const turnSetupInLifetime = await turnSetup(
            turnContext,
            turnChat,
            session,
            thread,
            prepared,
            false,
          );
          for await (const event of start(turnChat, turnSetupInLifetime)) {
            if (held.length > 0 || HELD_UNTIL_COMMIT.has(event.type)) {
              held.push(event);
            } else {
              emit(event);
            }
          }
        });
        for (const event of held) emit(event);
      } catch (error) {
        // Nothing the turn wrote committed: settle the send as failed (in a
        // fresh lifetime) so it does not wait out `abandonedTurnMs`.
        safeLog(error);
        if (durableSend && sendConfirmed) await settleFailed(durableSend);
        emit({
          type: 'error',
          error: ASSISTANT_TURN_GENERIC_ERROR,
          code: 'internal_error',
        });
        emit({
          type: 'status',
          status: { state: 'error', label: ASSISTANT_TURN_GENERIC_ERROR },
        });
      }
    };
    return stream(detached(first, ownLifetime).events, prepared.abort);
  };

  // ---- route bodies ------------------------------------------------------

  const listThreads = async (context: AssistantRequestContext) => {
    const chat = await chatFor(context);
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
    const chat = await chatFor(context);
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
    const chat = await chatFor(context);
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
    async (state: AssistantTurnState): Promise<boolean> => {
      // A continuation without an origin has no send to record against.
      if (!state.originMessageId) return true;
      return chat.recordClientRequestOutcome({
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
    const chat = await chatFor(context);
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
    const prepared = await prepareTurn(context, body);
    const setup = await turnSetup(context, chat, session, thread, prepared);

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

      const transcript = history.slice(-historyLimit);
      return await respondWithTurn(
        context,
        chat,
        session,
        thread,
        prepared,
        setup,
        { type: 'message', message: userWire },
        (turnChat, turnSetupFor) =>
          runAssistantTurn<AssistantMessageWire>({
            ...turnSetupFor.turn,
            history: transcript,
            userMessage: content,
            // Every reply links to this send, and a suspension keeps it.
            originMessageId: userWire.id,
            onState: recordTurnState(turnChat, principal, threadId),
          }),
        userWire.id,
      );
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
    const chat = await chatFor(context);
    const session = await findSession(chat, principal);
    const thread = await requireOwnThread(chat, principal, session, threadId);
    if (!session) throw notFound();
    const prepared = await prepareTurn(context, body);
    const setup = await turnSetup(context, chat, session, thread, prepared);
    // The send this leg belongs to comes only from the continuation it
    // consumes (stored server-side when the turn suspended), reported by the
    // runner; a request's `clientRequestId` is ignored here. A missing,
    // foreign or expired continuation is never consumed, so it changes no
    // send.
    return respondWithTurn(
      context,
      chat,
      session,
      thread,
      prepared,
      setup,
      null,
      (turnChat, turnSetupFor) =>
        runAssistantTurn<AssistantMessageWire>({
          ...turnSetupFor.turn,
          resume: { continuationId, results },
          onState: recordTurnState(turnChat, principal, threadId),
        }),
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
    const db = await dbFor(context);
    const actionContext = {
      principal: {
        ...(db ? { db } : {}),
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
 * Events after which the browser acts on stored state (resumes a
 * suspension, retries, reloads the thread): a turn in its own database
 * lifetime holds them, and every event after them, until it commits.
 */
const HELD_UNTIL_COMMIT: ReadonlySet<string> = new Set([
  'client_tool_calls',
  'done',
  'error',
]);

/** Default for `turnStartTimeoutMs`. */
export const DEFAULT_ASSISTANT_TURN_START_TIMEOUT_MS = 60_000;

/**
 * The RLS request transaction this call runs in (`database-rls`), when
 * there is one. It commits when the request's handler chain returns.
 */
function requestTransaction(): { isActive?: unknown } | null {
  if (getCurrentSessionPermissionContext()?.postgresRls !== true) return null;
  return (
    (getRequestScopedDatabase() as { isActive?: unknown } | undefined) ?? null
  );
}

/**
 * The permissions a turn in its own lifetime runs with: the bound
 * principal's effective `scopes` (live at bind time, capped by the runtime),
 * kept within `cap` as well so a runtime that ignored the cap cannot widen
 * them. Malformed scopes refuse the turn.
 */
function effectiveScopes(
  granted: AssistantRouteBoundPrincipal | undefined,
  cap: readonly string[] | undefined,
): string[] {
  const scopes = granted?.scopes;
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === 'string')
  ) {
    throw new Error(
      'mountAssistantRoutes: runtime.runAsPrincipal bound no effective scopes.',
    );
  }
  const allowed = cap ? new Set(cap) : undefined;
  return scopes.filter((scope) => !allowed || allowed.has(scope));
}

/** Resolves `true` once `isActive()` is false, `false` after `timeoutMs`. */
async function requestEnded(
  isActive: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 2;
  while (isActive()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 50);
  }
  return true;
}

/** A producer that forwards a turn's events. */
function pump<M>(
  events: AsyncGenerator<AssistantTurnEvent<M>, unknown>,
): (emit: (event: AssistantTurnEvent<M>) => void) => Promise<void> {
  return async (emit) => {
    for await (const event of events) emit(event);
  };
}

/**
 * Run a turn to its end regardless of the reader. `produce` starts at once
 * and its events go into a buffer the response reads from (after `first`,
 * when given); a reader that leaves only stops reading, and `settled`
 * resolves when the producer has finished. The turn itself records its
 * outcome (`onState`), so nothing here depends on how far the reader got. A
 * client disconnect cancels the turn — through the request's abort signal,
 * or the response body's cancellation when the adapter does not abort the
 * request — as the dock's Stop does; the runner then records `cancelled`
 * (or `completed`, if the reply was already stored).
 */
function detached<M>(
  first: AssistantTurnEvent<M> | null,
  produce: (emit: (event: AssistantTurnEvent<M>) => void) => Promise<void>,
): {
  events: AsyncGenerator<AssistantTurnEvent<M>, void>;
  settled: Promise<void>;
} {
  const buffer: AssistantTurnEvent<M>[] = first ? [first] : [];
  let finished = false;
  let notify: (() => void) | null = null;
  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  const settled = (async () => {
    try {
      await produce((event) => {
        buffer.push(event);
        wake();
      });
    } catch {
      // Producers report failures in-band and do not throw.
    } finally {
      finished = true;
      wake();
    }
  })();
  const events = (async function* () {
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
  return { events, settled };
}
