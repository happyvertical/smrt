/**
 * Token-streaming conversation endpoint (SSE) for embeddable chat clients
 * (issue #1936).
 *
 * The seam that joins the conversational harness to an embeddable widget: a
 * client (first consumer: the Happy chat widget, `happyvertical/animation#5`)
 * POSTs the conversation so far and receives a `text/event-stream` of
 * `data: <json>` frames — token deltas as the model generates them, then a
 * final `done` frame carrying the persisted message. A floating character can
 * stream the reply into a bubble and lip-sync each sentence as it completes,
 * instead of waiting for the whole JSON reply the way `POST /api/dev-chat` does.
 *
 * Two modes, dispatched by the resolved {@link ChatStreamContext}:
 * - **persona-bound** (`context.binding` present): runs the full
 *   {@link runPersonaConversationTurn} — persona principal, allow-listed tools,
 *   recalled memory — with a token sink wired through the tool loop, then
 *   persists via `ChatService` and emits the persisted message as `done`.
 * - **plain / unbound** (`context.binding` absent): streams `ai.stream()`
 *   directly and emits a synthesized (unpersisted) `done` message.
 *
 * Security posture (mirrors the voice gateway, #1910): this module NEVER
 * authorizes from the request's `session` metadata. `createChatStreamHandler`
 * takes an injected `authorize(request, body)` that the app implements to
 * validate the caller (bearer session id / cookie) and resolve an already-
 * authorized `ChatStreamContext`. The streaming engine enforces whatever that
 * returns; no authorizer ⇒ the handler cannot run. The persona path reuses the
 * harness's own fail-closed principal + allow-list gates unchanged.
 */

import type { AIInterface, AIMessage } from '@happyvertical/ai';
import type { PrincipalAuditSink } from '@happyvertical/smrt-agents';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { AgentSession } from './models/AgentSession.js';
import type { ChatMessage } from './models/ChatMessage.js';
import {
  type ConversationPersona,
  type PersonaRecallOptions,
  runPersonaConversationTurn,
} from './persona-conversation.js';
import type { ChatService } from './services/index.js';
import type { VoiceGatewayTurnMetadata } from './voice.js';

/** Max conversation messages accepted on one streaming request. */
export const MAX_CHAT_STREAM_MESSAGES = 50;
/** Max characters per message (matches the voice gateway text cap). */
export const MAX_CHAT_STREAM_CONTENT_LENGTH = 12_000;
/**
 * Default SSE keep-alive interval (ms). A persona turn can go quiet for tens of
 * seconds during a silent tool-calling round (an LLM round-trip + an in-process
 * tool op emit no tokens), and idle intermediaries (nginx / ALB / Cloudflare —
 * the expected home for an embedded widget backend) drop a connection with no
 * traffic. A periodic SSE comment line keeps it warm, mirroring the core
 * `_events` route's `DEFAULT_EVENTS_HEARTBEAT_MS`.
 */
export const DEFAULT_CHAT_STREAM_HEARTBEAT_MS = 15_000;

/** Roles carried on the wire (a subset of the internal `ChatMessageRole`). */
export type ChatStreamRole = 'user' | 'assistant' | 'system';

/**
 * A conversation message on the wire — the shape the client sends in `messages`
 * and the shape the final `done` frame carries back. Kept self-contained (not
 * the internal `ChatMessage` model) so the contract is stable and JSON-only.
 */
export interface ChatStreamMessage {
  id?: string;
  role: ChatStreamRole;
  content: string;
  /** ISO-8601 timestamp. */
  createdAt?: string;
}

/**
 * Session metadata the client attaches to a turn — `VoiceGatewayTurnMetadata`-
 * shaped so voice and chat share one binding vocabulary. It is UNTRUSTED input:
 * the handler's `authorize` callback is responsible for validating any of these
 * ids against the authenticated principal before they reach a chat write or the
 * tool loop.
 */
export type ChatStreamSession = VoiceGatewayTurnMetadata;

/**
 * A host-page control command (#1921, smrt-ui `control-interaction.ts`) carried
 * on the optional `control` lane. Kept structural here so the streaming
 * contract does not hard-couple to `@happyvertical/smrt-ui/forms`' exact union:
 * the client adapter (the Happy widget) executes it against its own control
 * registry, where sensitivity gating and the stage→apply consent split stay
 * enforced registry-side.
 */
export interface ChatStreamControlCommand {
  action: string;
  [key: string]: unknown;
}

/**
 * One frame of the stream. `token`/`done`/`error` are emitted today; `emotion`
 * and `control` are part of the wire contract (so clients can rely on the union
 * and a future server hook can emit them without a breaking change) but are not
 * produced by the v1 engine.
 */
export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'emotion'; name: string }
  | { type: 'control'; command: ChatStreamControlCommand }
  | { type: 'done'; message: ChatStreamMessage }
  | { type: 'error'; error: string };

/** The JSON body of a streaming request. */
export interface ChatStreamRequestBody {
  messages?: unknown;
  session?: ChatStreamSession;
}

/** The minimal `AgentSession` surface the persona turn needs. */
type StreamSessionLike = Pick<
  AgentSession,
  'id' | 'chatRoomId' | 'systemPrompt'
>;

/**
 * A resolved, ALREADY-AUTHORIZED persona binding. The `authorize` callback
 * produces this after validating the request against the authenticated
 * principal; nothing here is taken from untrusted request metadata.
 */
export interface ChatStreamPersonaBinding {
  chatService: ChatService;
  /** Database handle the persona turn's side-door operations run against. */
  db: SmrtClassOptions['db'];
  persona: ConversationPersona;
  session: StreamSessionLike;
  tenantId: string;
  /** Thread within the bound session room to author into. */
  threadId?: string | null;
  /** Originating user the turn runs on behalf of (audited). */
  onBehalfOfUserId?: string | null;
  /** Recall configuration, or `false` to skip memory recall. */
  recall?: PersonaRecallOptions | false;
  /** Audit sink forwarded to the principal execution. */
  audit?: PrincipalAuditSink;
  /** Opt into Postgres RLS transaction wrapping. */
  postgresRls?: boolean;
}

/**
 * The trusted context a turn runs in. `binding` present ⇒ persona-bound; absent
 * ⇒ plain `ai.stream()`. Generation caps live here (server-resolved), never on
 * the request, so a caller cannot widen `maxTokens`/`maxSteps`.
 */
export interface ChatStreamContext {
  ai: AIInterface;
  binding?: ChatStreamPersonaBinding;
  /** System prompt for the PLAIN path. Ignored when `binding` is set. */
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
}

/** Options for {@link runChatConversationStream}. */
export interface RunChatConversationStreamOptions {
  context: ChatStreamContext;
  /** The conversation so far; the last user message is this turn's prompt. */
  messages: ChatStreamMessage[];
}

/** Base error carrying an HTTP status + code for the handler to render. */
export class ChatStreamError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ChatStreamError';
    this.status = status;
    this.code = code;
  }
}

/** 400 — malformed request body. */
export class ChatStreamBadRequestError extends ChatStreamError {
  constructor(message = 'Invalid chat stream request') {
    super(message, 400, 'chat_stream_bad_request');
    this.name = 'ChatStreamBadRequestError';
  }
}

/** 401 — the request could not be authorized. */
export class ChatStreamUnauthorizedError extends ChatStreamError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'chat_stream_unauthorized');
    this.name = 'ChatStreamUnauthorizedError';
  }
}

/**
 * Run one streaming conversation turn, yielding SSE events. Dispatches on
 * `context.binding`: persona-bound turns run the full harness; unbound turns
 * stream `ai.stream()`. Errors surface as an in-band `error` event (the HTTP
 * response has already committed to 200 once streaming starts), never a throw.
 */
export async function* runChatConversationStream(
  options: RunChatConversationStreamOptions,
): AsyncGenerator<ChatStreamEvent> {
  const { context } = options;
  const messages = normalizeMessages(options.messages);
  const { history, userMessage } = splitConversation(messages);
  if (!userMessage) {
    yield { type: 'error', error: 'No user message to respond to' };
    return;
  }

  if (context.binding) {
    yield* streamPersonaConversation(
      context,
      context.binding,
      history,
      userMessage,
    );
  } else {
    yield* streamPlainConversation(context, history, userMessage);
  }
}

/**
 * Persona-bound turn. Bridges the tool loop's callback-based token stream
 * (`onToken`) into this async generator via a small producer/consumer queue,
 * then emits the persisted assistant message as `done`.
 */
async function* streamPersonaConversation(
  context: ChatStreamContext,
  binding: ChatStreamPersonaBinding,
  history: AIMessage[],
  userMessage: string,
): AsyncGenerator<ChatStreamEvent> {
  // The producer (the turn's onToken) enqueues without awaiting the consumer, so
  // a slow client lets `queue` grow — but only up to ONE turn's emitted tokens,
  // which is bounded by the server-set `maxSteps`×`maxTokens` ceiling (the turn
  // runs to completion and then stops emitting). Tokens are intentionally NOT
  // coalesced: the widget lip-syncs each sentence as it streams, so per-delta
  // granularity is the contract. The browser-facing delivery is still
  // backpressured by the `ReadableStream` in `sseBody` (pull-based).
  const queue: ChatStreamEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;

  // Wake a parked consumer (if any) exactly once.
  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  const emit = (event: ChatStreamEvent) => {
    queue.push(event);
    wake();
  };

  const turnPromise = (async () => {
    try {
      const turn = await runPersonaConversationTurn({
        ai: context.ai,
        db: binding.db,
        persona: binding.persona,
        tenantId: binding.tenantId,
        userMessage,
        history,
        chatService: binding.chatService,
        session: binding.session,
        threadId: binding.threadId,
        recall: binding.recall,
        model: context.model,
        temperature: context.temperature,
        maxTokens: context.maxTokens,
        maxSteps: context.maxSteps,
        onBehalfOfUserId: binding.onBehalfOfUserId,
        audit: binding.audit,
        postgresRls: binding.postgresRls,
        onToken: (chunk) => {
          if (chunk) emit({ type: 'token', text: chunk });
        },
      });
      emit({ type: 'done', message: resolvePersonaDoneMessage(turn) });
    } catch (error) {
      emit({ type: 'error', error: toErrorMessage(error) });
    } finally {
      finished = true;
      wake();
    }
  })();

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as ChatStreamEvent;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    // Never leave the turn dangling — it persists + reinforces memory even if
    // the client disconnected and stopped consuming.
    await turnPromise;
  }
}

/** Unbound turn: stream `ai.stream()` directly, then a synthesized `done`. */
async function* streamPlainConversation(
  context: ChatStreamContext,
  history: AIMessage[],
  userMessage: string,
): AsyncGenerator<ChatStreamEvent> {
  const messages: AIMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  messages.push(...history, { role: 'user', content: userMessage });

  let content = '';
  try {
    for await (const chunk of context.ai.stream(messages, {
      model: context.model,
      temperature: context.temperature,
      maxTokens: context.maxTokens,
    })) {
      if (chunk) {
        content += chunk;
        yield { type: 'token', text: chunk };
      }
    }
  } catch (error) {
    yield { type: 'error', error: toErrorMessage(error) };
    return;
  }
  yield { type: 'done', message: synthesizeAssistantMessage(content) };
}

/**
 * Options for {@link createChatStreamHandler}.
 */
export interface ChatStreamHandlerOptions {
  /**
   * Resolve an ALREADY-AUTHORIZED context from the request. This is the sole
   * trust boundary: validate the caller (bearer session id / cookie /
   * same-origin) and the claimed `body.session` ids against the authenticated
   * principal here, and return the context the turn runs in. Throw a
   * {@link ChatStreamError} (or any error ⇒ 500) to reject before any byte is
   * streamed.
   */
  authorize: (
    request: Request,
    body: ChatStreamRequestBody,
  ) => ChatStreamContext | Promise<ChatStreamContext>;
  /**
   * Cross-origin allowlist for the embedded widget (#1861 posture): the request
   * `Origin` is echoed only when a member (never `*`). Empty/omitted ⇒
   * same-origin only.
   */
  allowedOrigins?: string[];
  /** Emit `Access-Control-Allow-Credentials: true` for an allow-listed origin. */
  allowCredentials?: boolean;
  /**
   * SSE keep-alive interval (ms). Defaults to
   * {@link DEFAULT_CHAT_STREAM_HEARTBEAT_MS}. `0` disables the heartbeat.
   */
  heartbeatMs?: number;
}

/**
 * Build a Fetch-compatible SSE handler for the streaming contract (mirrors
 * `createVoiceGatewayTurnHandler`). Returns `text/event-stream`; wire it into a
 * SvelteKit `+server.ts`, a Bun/Node server, or any Fetch host.
 */
export function createChatStreamHandler(
  options: ChatStreamHandlerOptions,
): (request: Request) => Promise<Response> {
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const allowCredentials = options.allowCredentials === true;
  const cors = (request: Request): Record<string, string> =>
    corsHeaders(request, allowedOrigins, allowCredentials);

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      const headers = cors(request);
      if (!('Access-Control-Allow-Origin' in headers)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': 'POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse(
        { error: 'Method not allowed', code: 'method_not_allowed' },
        405,
        cors(request),
      );
    }

    let body: ChatStreamRequestBody;
    try {
      body = (await request.json()) as ChatStreamRequestBody;
    } catch {
      return jsonResponse(
        { error: 'Request body must be JSON', code: 'chat_stream_bad_request' },
        400,
        cors(request),
      );
    }
    if (!body || typeof body !== 'object') {
      return jsonResponse(
        {
          error: 'Request body must be an object',
          code: 'chat_stream_bad_request',
        },
        400,
        cors(request),
      );
    }

    let context: ChatStreamContext;
    try {
      context = await options.authorize(request, body);
    } catch (error) {
      const status = error instanceof ChatStreamError ? error.status : 500;
      const code =
        error instanceof ChatStreamError ? error.code : 'chat_stream_error';
      return jsonResponse(
        { error: toErrorMessage(error), code },
        status,
        cors(request),
      );
    }

    const messages = Array.isArray(body.messages)
      ? (body.messages as ChatStreamMessage[])
      : [];
    const events = runChatConversationStream({ context, messages });

    return new Response(sseBody(events, options.heartbeatMs), {
      status: 200,
      headers: {
        ...cors(request),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  };
}

const encoder = new TextEncoder();

/** SSE serialization of one event: a single `data:` frame. */
export function encodeChatStreamEvent(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** SSE comment line — a keep-alive `EventSource` ignores natively. */
const HEARTBEAT_FRAME = encoder.encode(': heartbeat\n\n');

/**
 * Adapt the event generator into a backpressure-aware `ReadableStream`. `pull`
 * advances one event at a time (so browser-facing delivery stays backpressured);
 * a `start()` heartbeat interval enqueues an SSE comment while `events.next()`
 * is pending, so a quiet tool-calling round doesn't let an idle intermediary
 * drop the connection mid-turn. `cancel` (client disconnect) clears the
 * heartbeat and returns the generator so its `finally` runs (the persona turn is
 * still awaited to completion inside it).
 */
function sseBody(
  events: AsyncGenerator<ChatStreamEvent>,
  heartbeatMs = DEFAULT_CHAT_STREAM_HEARTBEAT_MS,
): ReadableStream<Uint8Array> {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return;
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(HEARTBEAT_FRAME);
        } catch {
          // Controller already closed — stop pinging a dead stream.
          closed = true;
          stopHeartbeat();
        }
      }, heartbeatMs);
      // Don't keep the event loop alive solely for heartbeats.
      (heartbeat as { unref?: () => void }).unref?.();
    },
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          closed = true;
          stopHeartbeat();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encodeChatStreamEvent(value)));
      } catch (error) {
        closed = true;
        stopHeartbeat();
        controller.enqueue(
          encoder.encode(
            encodeChatStreamEvent({
              type: 'error',
              error: toErrorMessage(error),
            }),
          ),
        );
        controller.close();
      }
    },
    async cancel() {
      closed = true;
      stopHeartbeat();
      await events.return?.(undefined);
    },
  });
}

/** Trim + cap the incoming messages, dropping empty/invalid entries. */
function normalizeMessages(messages: ChatStreamMessage[]): ChatStreamMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ChatStreamMessage[] = [];
  for (const message of messages.slice(-MAX_CHAT_STREAM_MESSAGES)) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const content =
      typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) continue;
    out.push({
      ...(typeof message.id === 'string' ? { id: message.id } : {}),
      role,
      content: content.slice(0, MAX_CHAT_STREAM_CONTENT_LENGTH),
      ...(typeof message.createdAt === 'string'
        ? { createdAt: message.createdAt }
        : {}),
    });
  }
  return out;
}

/**
 * Split the conversation into prior turns (`history`) and this turn's prompt
 * (`userMessage`, the last user message). Anything after the last user message
 * is dropped — the turn responds to the user's newest input.
 */
function splitConversation(messages: ChatStreamMessage[]): {
  history: AIMessage[];
  userMessage: string;
} {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) return { history: [], userMessage: '' };
  const history = messages.slice(0, lastUserIndex).map(
    (message): AIMessage => ({
      role: message.role,
      content: message.content,
    }),
  );
  return { history, userMessage: messages[lastUserIndex].content };
}

/** Map a persona turn's persisted reply to the wire `done` message. */
function resolvePersonaDoneMessage(turn: {
  result: { content: string };
  authoredMessages?: { assistantMessage: ChatMessage | null };
}): ChatStreamMessage {
  const persisted = turn.authoredMessages?.assistantMessage;
  if (persisted) {
    return toStreamMessage(persisted);
  }
  return synthesizeAssistantMessage(turn.result.content);
}

/**
 * Coerce a persisted `ChatMessageRole` (which also includes `'tool'`) into the
 * narrower wire role. A `done` message is always the authored assistant reply,
 * so any non-conversational role collapses to `'assistant'` rather than leaking
 * an invalid value onto the contract.
 */
function toWireRole(role: unknown): ChatStreamRole {
  return role === 'user' || role === 'system' ? role : 'assistant';
}

/** Project a persisted `ChatMessage` onto the stable wire shape. */
function toStreamMessage(message: ChatMessage): ChatStreamMessage {
  const createdAt = (message as { createdAt?: unknown }).createdAt;
  return {
    id: (message.id as string | undefined) ?? crypto.randomUUID(),
    role: toWireRole(message.role),
    content: message.content ?? '',
    createdAt: toIsoString(createdAt),
  };
}

/** A `done` message for the unbound path, which persists nothing. */
function synthesizeAssistantMessage(content: string): ChatStreamMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
  };
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return new Date().toISOString();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/** Trim/de-dupe an origin allowlist; empty ⇒ same-origin only. */
function normalizeAllowedOrigins(
  origins: string[] | undefined,
): string[] | undefined {
  if (!Array.isArray(origins)) return undefined;
  const cleaned = [
    ...new Set(
      origins
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
  ];
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * CORS headers for an embedded cross-origin widget. The `Origin` is echoed only
 * when allow-listed (never `*`); credentials are added only when opted in — the
 * same fail-closed posture as the core `_events` route (#1861).
 */
function corsHeaders(
  request: Request,
  allowedOrigins: string[] | undefined,
  allowCredentials: boolean,
): Record<string, string> {
  if (!allowedOrigins) return {};
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) return {};
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
  if (allowCredentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}
