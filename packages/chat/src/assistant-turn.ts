/**
 * Streamed assistant turn over the bounded tool loop (#2908).
 *
 * One call runs one assistant turn — model ↔ tools, up to `maxSteps` rounds —
 * and yields {@link AssistantTurnEvent}s as it goes: a generic `status` line,
 * `step`s ("calling X", "X done"), live `token` previews, each persisted
 * `message`, and one terminal event. It is the engine behind an assistant
 * dock's send route; the host owns authentication, tenancy, and persistence
 * of the user message, and hands this module an already-authorized principal.
 *
 * Tools come from three places, all fail-closed:
 *
 * - **manifest tools** (`tools`) and **server tools** (`extraTools`, e.g.
 *   `createDataSurfaceTools()`), run in-process by {@link runToolLoop} under
 *   the principal. `extraTools` is narrowed to `principal.allowedTools` here
 *   (the offer gate) and each tool re-asserts it (the execution gate).
 * - **browser tools** (`clientTools`): the page's WebMCP tools and view
 *   intents, declared by the browser. Validate and allow-list them with
 *   {@link sanitizeClientToolDeclarations} first. The server never runs them:
 *   when the model calls one, the turn SUSPENDS — the transcript is saved in
 *   the host's {@link AssistantContinuationStore} and a `client_tool_calls`
 *   event ends the stream. The browser runs the calls through its own
 *   registry (reads run; writes and destructive calls wait for the user's
 *   confirmation) and resumes the turn with `resume`. Results are fed back to
 *   the model marked untrusted.
 *
 * Suspension instead of an open connection keeps a turn independent of which
 * server replica receives the resume, and the `maxSteps` bound spans every
 * leg of the turn.
 *
 * @module
 */

import type { AIInterface, AIMessage, ChatOptions } from '@happyvertical/ai';
import type {
  PrincipalAuditSink,
  PrincipalBinding,
  PrincipalTool,
} from '@happyvertical/smrt-agents';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type {
  AssistantStatus,
  AssistantTurnEvent,
  AssistantTurnStopReason,
} from './assistant-turn-events.js';
import { encodeAssistantTurnEvent } from './assistant-turn-events.js';
import type { AgentReplyService } from './services/ChatService.js';
import {
  appendClientToolResults,
  CLIENT_TOOL_RESULT_GUIDANCE,
  type ClientToolDefinition,
  type ClientToolResultInput,
  DEFAULT_MAX_STEPS,
  type ManifestTool,
  type PendingClientToolCall,
  runToolLoop,
  type ToolInvocation,
  type ToolLoopResult,
  type ToolLoopUsage,
} from './tool-loop.js';

/** How long a suspended turn waits for the browser's results. */
export const DEFAULT_CONTINUATION_TTL_MS = 15 * 60 * 1000;

/**
 * A suspended turn: everything needed to resume it once the browser answers
 * its tool calls. Serializable JSON, so a host can keep it anywhere.
 */
export interface AssistantTurnContinuation {
  version: 1;
  id: string;
  /** `Date.now()` when it was saved. */
  createdAt: number;
  /** Tool rounds already used; the resumed leg continues the count. */
  steps: number;
  /** The loop transcript up to the suspension. */
  messages: AIMessage[];
  /** The browser calls the turn is waiting on. */
  pending: PendingClientToolCall[];
  /** The browser tools offered when it suspended. */
  clientTools: ClientToolDefinition[];
}

/**
 * Where suspended turns wait. `take` is single-use: it returns the
 * continuation once and removes it, so a result can never be replayed into a
 * turn twice. `key` scopes continuations (e.g. to one thread) — a resume
 * under another key never finds them.
 */
export interface AssistantContinuationStore {
  save(key: string, continuation: AssistantTurnContinuation): Promise<void>;
  take(key: string, id: string): Promise<AssistantTurnContinuation | null>;
}

/** In-memory store, for tests and single-process demos. */
export function createMemoryContinuationStore(
  options: { ttlMs?: number; now?: () => number } = {},
): AssistantContinuationStore {
  const ttl = options.ttlMs ?? DEFAULT_CONTINUATION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, AssistantTurnContinuation>();
  return {
    async save(key, continuation) {
      // One suspended turn per key: a new suspension replaces an old one.
      entries.set(key, continuation);
    },
    async take(key, id) {
      const entry = entries.get(key);
      if (!entry || entry.id !== id) return null;
      entries.delete(key);
      return now() - entry.createdAt > ttl ? null : entry;
    },
  };
}

/** The slice of `AgentSession` {@link createSessionContinuationStore} uses. */
export interface ContinuationSessionLike {
  getSessionContext(): Record<string, unknown>;
  updateSessionContext(updates: Record<string, unknown>): Promise<void>;
}

/** Reserved `AgentSession.sessionContext` field holding suspended turns. */
export const SESSION_CONTINUATIONS_FIELD = '__assistantContinuations';

/**
 * A store kept in an `AgentSession`'s `sessionContext` (reserved field
 * {@link SESSION_CONTINUATIONS_FIELD}), keyed by `key` — typically the thread
 * id. Needs no schema: the session is already tenant-bound and
 * participant-checked by the host that loaded it. Expired entries are pruned
 * on every write.
 */
export function createSessionContinuationStore(
  session: ContinuationSessionLike,
  options: { ttlMs?: number; now?: () => number } = {},
): AssistantContinuationStore {
  const ttl = options.ttlMs ?? DEFAULT_CONTINUATION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const read = (): Record<string, AssistantTurnContinuation> => {
    const raw = session.getSessionContext()[SESSION_CONTINUATIONS_FIELD];
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Record<string, AssistantTurnContinuation>) }
      : {};
  };
  const prune = (all: Record<string, AssistantTurnContinuation>) => {
    for (const [key, entry] of Object.entries(all)) {
      if (!entry || now() - Number(entry.createdAt) > ttl) delete all[key];
    }
    return all;
  };
  return {
    async save(key, continuation) {
      const all = prune(read());
      all[key] = continuation;
      await session.updateSessionContext({
        [SESSION_CONTINUATIONS_FIELD]: all,
      });
    },
    async take(key, id) {
      const all = read();
      const entry = all[key];
      if (!entry || entry.id !== id) return null;
      delete all[key];
      await session.updateSessionContext({
        [SESSION_CONTINUATIONS_FIELD]: prune(all),
      });
      return now() - Number(entry.createdAt) > ttl ? null : entry;
    },
  };
}

/** A tool invocation the host wants persisted into the conversation. */
export interface AuthoredToolReply {
  content: string;
  messageType?: 'tool_call' | 'tool_result' | 'text';
  toolCallData?: Record<string, unknown> | null;
}

/** Where and how a turn persists its messages (the trusted agent bridge). */
export interface AssistantTurnAuthor {
  chatService: AgentReplyService;
  agentSessionId: string;
  tenantId: string;
  threadId?: string | null;
  /**
   * Maps a server tool invocation to a persisted message, or `null` to keep
   * it out of the conversation (the default for every invocation). The
   * message's `toolCallData` tool name must be on the session's
   * `allowedTools` — `sendAgentReply`'s gate is unchanged.
   */
  authorInvocation?: (invocation: ToolInvocation) => AuthoredToolReply | null;
}

/** Options for {@link runAssistantTurn}. */
export interface AssistantTurnOptions<M = Record<string, unknown>> {
  ai: AIInterface;
  /** The already-authorized principal every server tool runs as. */
  principal: PrincipalBinding;
  db?: SmrtClassOptions['db'];
  systemPrompt?: string;
  /** Earlier turns, oldest first. Ignored on resume. */
  history?: AIMessage[];
  /** This turn's user message. Exactly one of `userMessage` / `resume`. */
  userMessage?: string;
  /** Resume a suspended turn with the browser's results. */
  resume?: { continuationId: string; results: ClientToolResultInput[] };
  tools?: ManifestTool[];
  /** Server tools, narrowed to `principal.allowedTools`. */
  extraTools?: PrincipalTool[];
  /** Validated, allow-listed browser tools (see `sanitizeClientToolDeclarations`). */
  clientTools?: ClientToolDefinition[];
  /** Required when `clientTools` are offered or `resume` is used. */
  continuations?: AssistantContinuationStore;
  /** Scope for `continuations` (e.g. the thread id). */
  continuationKey?: string;
  maxSteps?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  toolChoice?: ChatOptions['toolChoice'];
  /** Cancels the turn (e.g. the request's own abort signal). */
  signal?: AbortSignal;
  /** Per-round token usage, for the host's usage attribution. */
  onUsage?: (usage: ToolLoopUsage) => void;
  permissions?: string[];
  audit?: PrincipalAuditSink;
  postgresRls?: boolean;
  onBehalfOfUserId?: string | null;
  agentClass?: string;
  /** Persist tool results and the reply. Without it nothing is persisted. */
  author?: AssistantTurnAuthor;
  /** Maps a persisted chat message to the wire. Default: its `toJSON()`. */
  serializeMessage?: (message: unknown) => M;
  /** A plain-language label for a tool, used in steps and the status line. */
  describeTool?: (name: string) => string;
  /** Mint continuation ids (tests). Default `crypto.randomUUID()`. */
  createId?: () => string;
  now?: () => number;
}

/** What {@link runAssistantTurn} returns when its generator completes. */
export interface AssistantTurnResult {
  stoppedReason: AssistantTurnStopReason | 'client_tools' | 'error';
  content: string;
  loop?: ToolLoopResult;
}

function defaultSerialize<M>(message: unknown): M {
  const candidate = message as { toJSON?: () => unknown } | null;
  return (
    typeof candidate?.toJSON === 'function' ? candidate.toJSON() : message
  ) as M;
}

function defaultDescribe(name: string): string {
  return name.replace(/[_.-]+/g, ' ').trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one streamed assistant turn. Never throws: a failure is reported as an
 * in-band `error` event (a streaming response has already committed its
 * status by then). The generator's return value summarizes the turn.
 */
export async function* runAssistantTurn<M = Record<string, unknown>>(
  options: AssistantTurnOptions<M>,
): AsyncGenerator<AssistantTurnEvent<M>, AssistantTurnResult> {
  const serialize = options.serializeMessage ?? defaultSerialize<M>;
  const describe = options.describeTool ?? defaultDescribe;
  const status = (value: AssistantStatus): AssistantTurnEvent<M> => ({
    type: 'status',
    status: value,
  });

  // A small producer/consumer bridge: the loop reports through callbacks,
  // this generator yields in order.
  const queue: AssistantTurnEvent<M>[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  // Wake a parked consumer (if any) exactly once.
  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };
  const emit = (event: AssistantTurnEvent<M>) => {
    queue.push(event);
    wake();
  };

  let result: AssistantTurnResult = { stoppedReason: 'error', content: '' };

  const work = (async () => {
    try {
      result = await runTurn(options, emit, status, serialize, describe);
    } catch (error) {
      emit({ type: 'error', error: errorMessage(error) });
      emit(status({ state: 'error', label: errorMessage(error) }));
      result = { stoppedReason: 'error', content: '' };
    } finally {
      finished = true;
      wake();
    }
  })();

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as AssistantTurnEvent<M>;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    // The turn persists what it did even if the reader went away.
    await work;
  }
  return result;
}

async function runTurn<M>(
  options: AssistantTurnOptions<M>,
  emit: (event: AssistantTurnEvent<M>) => void,
  status: (value: AssistantStatus) => AssistantTurnEvent<M>,
  serialize: (message: unknown) => M,
  describe: (name: string) => string,
): Promise<AssistantTurnResult> {
  const { principal, author } = options;
  const now = options.now ?? (() => Date.now());
  const createId =
    options.createId ??
    (() =>
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  emit(status({ state: 'working', label: 'Thinking…', cancellable: true }));

  // ---- the transcript: a fresh turn, or a resumed suspension -------------
  let messages: AIMessage[];
  let initialSteps = 0;
  let clientTools = options.clientTools ?? [];
  if (options.resume) {
    if (!options.continuations || !options.continuationKey) {
      throw new Error('Resuming a turn needs a continuation store and key.');
    }
    const continuation = await options.continuations.take(
      options.continuationKey,
      options.resume.continuationId,
    );
    if (!continuation) {
      throw new Error(
        'This step expired or was already answered. Ask again to continue.',
      );
    }
    messages = appendClientToolResults(
      continuation.messages,
      continuation.pending,
      options.resume.results,
    );
    initialSteps = continuation.steps;
    // A fresh declaration reflects the page as it is now; fall back to what
    // was offered when the turn suspended.
    if (clientTools.length === 0) clientTools = continuation.clientTools;
    for (const call of continuation.pending) {
      const answer = options.resume.results.find((r) => r.id === call.id);
      emit({
        type: 'step',
        step: {
          kind: 'tool_result',
          callId: call.id,
          tool: call.name,
          label: describe(call.name),
          ok: answer?.ok === true,
          ...(answer && answer.ok !== true && answer.error
            ? { error: answer.error }
            : {}),
        },
      });
    }
  } else {
    const userMessage = options.userMessage?.trim();
    if (!userMessage) throw new Error('No user message to respond to.');
    const system = [
      options.systemPrompt?.trim(),
      clientTools.length > 0 ? CLIENT_TOOL_RESULT_GUIDANCE : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
    messages = [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...(options.history ?? []),
      { role: 'user', content: userMessage },
    ];
  }
  if (
    clientTools.length > 0 &&
    (!options.continuations || !options.continuationKey)
  ) {
    throw new Error('Browser tools need a continuation store and key.');
  }

  // Offer gate for server tools, as the persona path does.
  const allowed = new Set(principal.allowedTools ?? []);
  const extraTools = (options.extraTools ?? []).filter((tool) =>
    allowed.has(tool.slug),
  );

  const labels = new Map<string, string>();
  const labelFor = (name: string) => {
    let label = labels.get(name);
    if (!label) {
      label = describe(name);
      labels.set(name, label);
    }
    return label;
  };

  const sendAgentReply = author
    ? (await import('./services/ChatService.js')).sendAgentReply
    : null;

  const loop = await runToolLoop({
    ai: options.ai,
    messages,
    tools: options.tools ?? [],
    extraTools,
    clientTools,
    initialSteps,
    principal,
    db: options.db,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    toolChoice: options.toolChoice,
    signal: options.signal,
    onUsage: options.onUsage,
    permissions: options.permissions,
    audit: options.audit,
    postgresRls: options.postgresRls,
    onBehalfOfUserId: options.onBehalfOfUserId,
    agentClass: options.agentClass,
    onToken: (text) => {
      if (text) emit({ type: 'token', text });
    },
    onStep: (event) => {
      if (event.type === 'round') {
        if (event.step > initialSteps) {
          emit({ type: 'step', step: { kind: 'thinking', step: event.step } });
          emit(
            status({ state: 'working', label: 'Thinking…', cancellable: true }),
          );
        }
        return;
      }
      if (event.type === 'tool_call') {
        const label = labelFor(event.slug);
        emit({
          type: 'step',
          step: {
            kind: 'tool_call',
            callId: event.callId,
            tool: event.slug,
            label,
            location: event.location,
          },
        });
        if (event.location === 'server') {
          emit(
            status({ state: 'working', label: `${label}…`, cancellable: true }),
          );
        }
        return;
      }
      emit({
        type: 'step',
        step: {
          kind: 'tool_result',
          callId: event.callId,
          tool: event.slug,
          label: labelFor(event.slug),
          ok: event.ok,
          ...(event.error ? { error: event.error } : {}),
        },
      });
    },
    onInvocation: async (invocation) => {
      if (!author || !sendAgentReply || !invocation.ok) return;
      const reply = author.authorInvocation?.(invocation);
      if (!reply) return;
      try {
        const message = await sendAgentReply(author.chatService, {
          tenantId: author.tenantId,
          agentSessionId: author.agentSessionId,
          threadId: author.threadId ?? null,
          kind: 'tool',
          content: reply.content,
          messageType: reply.messageType ?? 'tool_result',
          toolCallData: reply.toolCallData ?? null,
        });
        emit({ type: 'message', message: serialize(message) });
      } catch (error) {
        // The tool ran; only its transcript entry failed. Keep the turn going
        // and say so in the step log rather than failing the whole reply.
        emit({
          type: 'step',
          step: {
            kind: 'tool_result',
            callId: `author-${invocation.slug}`,
            tool: invocation.slug,
            label: labelFor(invocation.slug),
            ok: false,
            error: errorMessage(error),
          },
        });
      }
    },
  });

  if (loop.stoppedReason === 'client_tools') {
    if (!options.continuations || !options.continuationKey) {
      throw new Error('Browser tools need a continuation store and key.');
    }
    const continuation: AssistantTurnContinuation = {
      version: 1,
      id: createId(),
      createdAt: now(),
      steps: loop.steps,
      messages: loop.messages,
      pending: loop.pendingClientToolCalls,
      clientTools,
    };
    await options.continuations.save(options.continuationKey, continuation);
    emit(
      status({
        state: 'working',
        label: `${labelFor(loop.pendingClientToolCalls[0]?.name ?? 'page tool')}…`,
        cancellable: true,
      }),
    );
    emit({
      type: 'client_tool_calls',
      continuationId: continuation.id,
      calls: loop.pendingClientToolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args,
        effect: call.effect,
      })),
    });
    return { stoppedReason: 'client_tools', content: loop.content, loop };
  }

  if (loop.stoppedReason === 'cancelled') {
    emit({ type: 'done', stoppedReason: 'cancelled' });
    emit(status({ state: 'idle', label: 'Stopped' }));
    return { stoppedReason: 'cancelled', content: '', loop };
  }

  const content = loop.content.trim() || 'Done.';
  let finalMessage: M | undefined;
  if (author && sendAgentReply) {
    const message = await sendAgentReply(author.chatService, {
      tenantId: author.tenantId,
      agentSessionId: author.agentSessionId,
      threadId: author.threadId ?? null,
      kind: 'assistant',
      content,
    });
    finalMessage = serialize(message);
    emit({ type: 'message', message: finalMessage });
  }
  emit({
    type: 'done',
    ...(finalMessage ? { message: finalMessage } : {}),
    stoppedReason: loop.stoppedReason,
  });
  emit(status({ state: 'done', label: 'Done' }));
  return { stoppedReason: loop.stoppedReason, content, loop };
}

/** Default SSE keep-alive for {@link createAssistantTurnResponse}. */
export const DEFAULT_ASSISTANT_TURN_HEARTBEAT_MS = 15_000;

/**
 * Wrap a turn's events as a `text/event-stream` `Response`. Heartbeat
 * comments keep idle intermediaries from cutting a quiet tool round; a
 * client disconnect ends the generator (the turn still persists what it did).
 */
export function createAssistantTurnResponse(
  events: AsyncGenerator<AssistantTurnEvent<unknown>, unknown>,
  options: { heartbeatMs?: number; headers?: Record<string, string> } = {},
): Response {
  const encoder = new TextEncoder();
  const heartbeatMs =
    options.heartbeatMs ?? DEFAULT_ASSISTANT_TURN_HEARTBEAT_MS;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return;
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          stop();
        }
      }, heartbeatMs);
      (heartbeat as { unref?: () => void }).unref?.();
    },
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          stop();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(encodeAssistantTurnEvent(value)));
      } catch (error) {
        stop();
        controller.enqueue(
          encoder.encode(
            encodeAssistantTurnEvent({
              type: 'error',
              error: errorMessage(error),
            }),
          ),
        );
        controller.close();
      }
    },
    async cancel() {
      stop();
      await events.return?.(undefined);
    },
  });
  const headers = new Headers(options.headers);
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-cache, no-transform');
  headers.set('x-accel-buffering', 'no');
  return new Response(body, { status: 200, headers });
}
