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

import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** Tokens the turn used so far (for `maxTurnTokens`). Absent: 0. */
  tokens?: number;
  /** `Date.now()` when the turn started (for `maxTurnMs`). Absent: `createdAt`. */
  startedAt?: number;
  /**
   * The message that started the turn (`AssistantTurnOptions.originMessageId`),
   * kept server-side so a resume restores it from here, never from the
   * request.
   */
  originMessageId?: string;
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
  /**
   * Whether `id` is still waiting under `key` (present and unexpired, or
   * claimed by a resume that is still activating), without consuming it.
   * Optional; both built-in stores implement it.
   */
  has?(key: string, id: string): Promise<boolean>;
  /**
   * Forget a continuation `take` returned. The built-in stores' `take`
   * CLAIMS the entry (no second `take` can return it, and `has` stays true)
   * instead of deleting it, so a resume is never invisible between taking
   * its continuation and recording that it runs; the runner calls `release`
   * once that is recorded. An unreleased claim expires after
   * {@link CONTINUATION_CLAIM_TTL_MS}. Optional.
   */
  release?(key: string, id: string): Promise<void>;
}

/** How long a claimed (taken, unreleased) continuation still counts. */
export const CONTINUATION_CLAIM_TTL_MS = 60 * 1000;

type StoredContinuation = AssistantTurnContinuation & { claimedAt?: number };

function liveFor(
  entry: StoredContinuation | undefined,
  id: string,
  ttl: number,
  at: number,
): boolean {
  if (!entry || entry.id !== id) return false;
  // An active claim lives from its claim time, whatever the original
  // lifetime; an unclaimed (or lapsed-claim) entry from its creation.
  if (claimActive(entry, at)) return true;
  return at - Number(entry.createdAt) <= ttl;
}

function claimActive(entry: StoredContinuation, at: number): boolean {
  return (
    entry.claimedAt !== undefined &&
    at - Number(entry.claimedAt) <= CONTINUATION_CLAIM_TTL_MS
  );
}

function unclaimed(entry: StoredContinuation): AssistantTurnContinuation {
  const { claimedAt: _claimedAt, ...continuation } = entry;
  return continuation;
}

/** In-memory store, for tests and single-process demos. */
export function createMemoryContinuationStore(
  options: { ttlMs?: number; now?: () => number } = {},
): AssistantContinuationStore {
  const ttl = options.ttlMs ?? DEFAULT_CONTINUATION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, StoredContinuation>();
  return {
    async save(key, continuation) {
      // One suspended turn per key: a new suspension replaces an old one.
      entries.set(key, continuation);
    },
    async take(key, id) {
      const entry = entries.get(key);
      // An active claim is single-use; a lapsed one (its activation never
      // became durable) is claimable again within the original lifetime.
      if (!entry || entry.id !== id || claimActive(entry, now())) {
        return null;
      }
      if (now() - entry.createdAt > ttl) {
        entries.delete(key);
        return null;
      }
      // Claimed, not deleted: single-use, and still visible until released.
      entries.set(key, { ...entry, claimedAt: now() });
      return unclaimed(entry);
    },
    async has(key, id) {
      return liveFor(entries.get(key), id, ttl, now());
    },
    async release(key, id) {
      if (entries.get(key)?.id === id) entries.delete(key);
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
 *
 * Pass a LOADER rather than a session instance whenever the turn also writes
 * chat messages: authoring a reply updates the session row, so an instance
 * loaded at the start of the request is stale by the time the turn suspends,
 * and saving it fails its revision check. The loader is called before every
 * read-modify-write so each one starts from the current row.
 */
export function createSessionContinuationStore(
  session:
    | ContinuationSessionLike
    | (() => Promise<ContinuationSessionLike | null | undefined>),
  options: { ttlMs?: number; now?: () => number } = {},
): AssistantContinuationStore {
  const ttl = options.ttlMs ?? DEFAULT_CONTINUATION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const load = async (): Promise<ContinuationSessionLike> => {
    const current = typeof session === 'function' ? await session() : session;
    if (!current) {
      throw new AssistantTurnUserError(
        'The assistant session is no longer active.',
        'session_inactive',
      );
    }
    return current;
  };
  const read = (
    current: ContinuationSessionLike,
  ): Record<string, StoredContinuation> => {
    const raw = current.getSessionContext()[SESSION_CONTINUATIONS_FIELD];
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Record<string, StoredContinuation>) }
      : {};
  };
  const prune = (all: Record<string, StoredContinuation>) => {
    for (const [key, entry] of Object.entries(all)) {
      if (!entry || !liveFor(entry, entry.id, ttl, now())) delete all[key];
    }
    return all;
  };
  return {
    async save(key, continuation) {
      const current = await load();
      const all = prune(read(current));
      all[key] = continuation;
      await current.updateSessionContext({
        [SESSION_CONTINUATIONS_FIELD]: all,
      });
    },
    async take(key, id) {
      const current = await load();
      const all = read(current);
      const entry = all[key];
      // An active claim is single-use; a lapsed one is claimable again.
      if (!entry || entry.id !== id || claimActive(entry, now())) {
        return null;
      }
      const expired = now() - Number(entry.createdAt) > ttl;
      if (expired) delete all[key];
      // Claimed, not deleted: single-use (the session row's revision check
      // refuses a concurrent claim), and still visible until released.
      else all[key] = { ...entry, claimedAt: now() };
      await current.updateSessionContext({
        [SESSION_CONTINUATIONS_FIELD]: prune(all),
      });
      return expired ? null : unclaimed(entry);
    },
    async has(key, id) {
      return liveFor(read(await load())[key], id, ttl, now());
    },
    async release(key, id) {
      const current = await load();
      const all = read(current);
      if (all[key]?.id !== id) return;
      delete all[key];
      await current.updateSessionContext({
        [SESSION_CONTINUATIONS_FIELD]: prune(all),
      });
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
  /**
   * The message that started this turn (e.g. the user's send). Every reply
   * the turn authors links to it (`replyToMessageId`), and a suspension keeps
   * it with the continuation. Ignored on resume: the consumed continuation's
   * value is used instead.
   */
  originMessageId?: string;
  /**
   * The turn's own lifecycle, reported (and awaited) by the runner at the
   * moment each fact becomes true, whether or not anyone still reads the
   * events: `running` when a fresh turn starts or a resume has consumed its
   * continuation, `suspended` once the continuation is stored (before its
   * `client_tool_calls` event), and `completed` / `cancelled` / `failed`
   * when the leg ends (`completed` after the reply is stored). A throw is
   * logged and never breaks the turn, except for a resume's `running`: when
   * that report throws or returns `false` (not recorded), the leg stops
   * before any model or tool call with `resume_not_recorded`, and its
   * continuation stays claimed (claimable again after
   * {@link CONTINUATION_CLAIM_TTL_MS}). Not called for a resume whose
   * continuation is missing, foreign or expired. Resolve `false` (or throw)
   * for "not recorded"; any other value counts as recorded.
   */
  onState?: (state: AssistantTurnState) => unknown;
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
  /**
   * Token budget for the whole turn, across every browser round trip. Once
   * spent, the model gets one last round without tools to answer, and the
   * turn ends with `stoppedReason: 'budget'`. Unset: no budget.
   */
  maxTurnTokens?: number;
  /**
   * Wall-clock budget for the whole turn (ms from its first leg, including
   * time spent waiting on the browser). Same ending as `maxTurnTokens`.
   */
  maxTurnMs?: number;
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
  /**
   * A plain-language label for a tool, used in steps and the status line.
   * On a tool call it also gets the call's arguments, so a label can name
   * the target ("Opening Events"); keep it free of ids and raw values.
   */
  describeTool?: (name: string, args?: Record<string, unknown>) => string;
  /** Mint continuation ids (tests). Default `crypto.randomUUID()`. */
  createId?: () => string;
  /**
   * Server-side log for an unexpected failure (default `console.error`). The
   * browser only ever gets a generic message and code for these.
   */
  onError?: AssistantTurnErrorLogger;
  now?: () => number;
}

/**
 * One lifecycle fact of a turn leg, for {@link AssistantTurnOptions.onState}.
 * `resumedFrom` is the continuation this leg consumed (`null` for the first
 * leg), so a recorder can refuse a write from a leg that is no longer
 * current. `continuationId` is set for `suspended`.
 */
export interface AssistantTurnState {
  state: 'running' | 'suspended' | 'completed' | 'cancelled' | 'failed';
  originMessageId?: string;
  resumedFrom: string | null;
  continuationId?: string;
}

/** What {@link runAssistantTurn} returns when its generator completes. */
export interface AssistantTurnResult {
  stoppedReason: AssistantTurnStopReason | 'client_tools' | 'error';
  content: string;
  loop?: ToolLoopResult;
  /** The turn's origin message (from the continuation on a resume). */
  originMessageId?: string;
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

/** What the browser is told when a turn fails unexpectedly. */
export const ASSISTANT_TURN_GENERIC_ERROR =
  'The assistant ran into a problem. Please try again.';

/**
 * A failure whose message is deliberately written for the user (an expired
 * step, an empty message). Only these reach the browser verbatim, with their
 * `code`; every other error is replaced by {@link ASSISTANT_TURN_GENERIC_ERROR}
 * and code `internal_error`, and its detail goes to the server-side log.
 */
export class AssistantTurnUserError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AssistantTurnUserError';
  }
}

/** Server-side sink for an unexpected turn failure. */
export type AssistantTurnErrorLogger = (error: unknown) => void;

function defaultLogError(error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: the server-side default for detail withheld from the browser; hosts pass `onError` to route it to their logger
  console.error('[smrt-chat] assistant turn failed:', error);
}

/** The wire form of a failure; logs anything that is not user-facing. */
function wireError(
  error: unknown,
  log: AssistantTurnErrorLogger,
): { error: string; code: string } {
  if (error instanceof AssistantTurnUserError) {
    return { error: error.message, code: error.code };
  }
  try {
    log(error);
  } catch {
    // Logging never breaks the response.
  }
  return { error: ASSISTANT_TURN_GENERIC_ERROR, code: 'internal_error' };
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
  const leg: TurnLeg = {
    originMessageId: options.resume ? undefined : options.originMessageId,
    resumedFrom: null,
    started: !options.resume,
  };
  const report = reporter(options, leg);

  const work = (async () => {
    try {
      result = await runTurn(options, emit, status, serialize, describe, leg);
    } catch (error) {
      const wire = wireError(error, options.onError ?? defaultLogError);
      // A resume that never consumed its continuation changes nothing.
      if (leg.started) await report('failed');
      emit({ type: 'error', ...wire });
      emit(status({ state: 'error', label: wire.error }));
      result = {
        stoppedReason: 'error',
        content: '',
        ...(leg.originMessageId
          ? { originMessageId: leg.originMessageId }
          : {}),
      };
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

/** The leg the runner is on: what `onState` reports. */
interface TurnLeg {
  originMessageId?: string;
  resumedFrom: string | null;
  /** False until a resume has consumed its continuation. */
  started: boolean;
}

function reporter<M>(options: AssistantTurnOptions<M>, leg: TurnLeg) {
  // Resolves whether the report was recorded (no `onState`: nothing to
  // record, so yes; `false` or a throw: no).
  return async (
    state: AssistantTurnState['state'],
    continuationId?: string,
  ): Promise<boolean> => {
    if (!options.onState) return true;
    try {
      const recorded = await options.onState({
        state,
        ...(leg.originMessageId
          ? { originMessageId: leg.originMessageId }
          : {}),
        resumedFrom: leg.resumedFrom,
        ...(continuationId ? { continuationId } : {}),
      });
      return recorded !== false;
    } catch (error) {
      try {
        (options.onError ?? defaultLogError)(error);
      } catch {
        // Logging never breaks the turn.
      }
      return false;
    }
  };
}

async function runTurn<M>(
  options: AssistantTurnOptions<M>,
  emit: (event: AssistantTurnEvent<M>) => void,
  status: (value: AssistantStatus) => AssistantTurnEvent<M>,
  serialize: (message: unknown) => M,
  describe: (name: string, args?: Record<string, unknown>) => string,
  leg: TurnLeg,
): Promise<AssistantTurnResult> {
  const { principal, author } = options;
  const report = reporter(options, leg);
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
  let initialTokens = 0;
  let startedAt = now();
  let clientTools = options.clientTools ?? [];
  let originMessageId = leg.originMessageId;
  if (options.resume) {
    if (!options.continuations || !options.continuationKey) {
      throw new Error('Resuming a turn needs a continuation store and key.');
    }
    const continuation = await options.continuations.take(
      options.continuationKey,
      options.resume.continuationId,
    );
    if (!continuation) {
      throw new AssistantTurnUserError(
        'This step expired or was already answered. Ask again to continue.',
        'continuation_expired',
      );
    }
    originMessageId = continuation.originMessageId;
    leg.originMessageId = originMessageId;
    leg.resumedFrom = continuation.id;
    if (!(await report('running'))) {
      // The activation is not durable: never run the leg. The continuation
      // stays claimed (has() true) and is claimable again after the claim
      // lapses.
      throw new AssistantTurnUserError(
        'This step could not be resumed right now. Try again in a minute.',
        'resume_not_recorded',
      );
    }
    leg.started = true;
    // `running` is recorded: the claimed continuation can go.
    try {
      await options.continuations.release?.(
        options.continuationKey,
        continuation.id,
      );
    } catch (error) {
      (options.onError ?? defaultLogError)(error);
    }
    messages = appendClientToolResults(
      continuation.messages,
      continuation.pending,
      options.resume.results,
    );
    initialSteps = continuation.steps;
    initialTokens = Number(continuation.tokens) || 0;
    startedAt = Number(continuation.startedAt) || continuation.createdAt;
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
    await report('running');
    const userMessage = options.userMessage?.trim();
    if (!userMessage) {
      throw new AssistantTurnUserError(
        'No user message to respond to.',
        'empty_message',
      );
    }
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
    ...(options.maxTurnTokens !== undefined
      ? { maxTotalTokens: options.maxTurnTokens, initialTokens }
      : {}),
    ...(options.maxTurnMs !== undefined
      ? { deadline: startedAt + options.maxTurnMs, now }
      : {}),
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
        let label = labelFor(event.slug);
        try {
          label = describe(event.slug, event.args) || label;
        } catch {
          // A host label callback never breaks the turn.
        }
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
          replyToMessageId: originMessageId ?? null,
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
            error: 'not_saved',
          },
        });
        try {
          (options.onError ?? defaultLogError)(error);
        } catch {
          // Logging never breaks the turn.
        }
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
      tokens: initialTokens + loop.totalTokens,
      startedAt,
      ...(originMessageId ? { originMessageId } : {}),
    };
    await options.continuations.save(options.continuationKey, continuation);
    // Recorded before the browser can see (and resume) the suspension.
    await report('suspended', continuation.id);
    emit(
      status({
        state: 'working',
        label: `${
          loop.pendingClientToolCalls[0]
            ? describe(
                loop.pendingClientToolCalls[0].name,
                loop.pendingClientToolCalls[0].args,
              )
            : labelFor('page tool')
        }…`,
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
    return {
      stoppedReason: 'client_tools',
      content: loop.content,
      loop,
      ...(originMessageId ? { originMessageId } : {}),
    };
  }

  if (loop.stoppedReason === 'cancelled') {
    await report('cancelled');
    emit({ type: 'done', stoppedReason: 'cancelled' });
    emit(status({ state: 'idle', label: 'Stopped' }));
    return {
      stoppedReason: 'cancelled',
      content: '',
      loop,
      ...(originMessageId ? { originMessageId } : {}),
    };
  }

  const content = loop.content.trim() || 'Done.';
  let finalMessage: M | undefined;
  if (author && sendAgentReply) {
    const message = await sendAgentReply(author.chatService, {
      tenantId: author.tenantId,
      agentSessionId: author.agentSessionId,
      threadId: author.threadId ?? null,
      replyToMessageId: originMessageId ?? null,
      kind: 'assistant',
      content,
    });
    finalMessage = serialize(message);
    emit({ type: 'message', message: finalMessage });
  }
  await report('completed');
  emit({
    type: 'done',
    ...(finalMessage ? { message: finalMessage } : {}),
    stoppedReason: loop.stoppedReason,
  });
  emit(status({ state: 'done', label: 'Done' }));
  return {
    stoppedReason: loop.stoppedReason,
    content,
    loop,
    ...(originMessageId ? { originMessageId } : {}),
  };
}

/** Default SSE keep-alive for {@link createAssistantTurnResponse}. */
export const DEFAULT_ASSISTANT_TURN_HEARTBEAT_MS = 15_000;

/**
 * Wrap a turn's events as a `text/event-stream` `Response`. Heartbeat
 * comments keep idle intermediaries from cutting a quiet tool round; a
 * client disconnect ends the generator (the turn still persists what it did).
 *
 * The body is pulled by the runtime after the handler returns, outside the
 * handler's async context. Every `next()` therefore runs in the async context
 * captured here (`AsyncLocalStorage.snapshot()`), so a turn started inside
 * `withTenant(...)` keeps its tenant scope for every step, including the
 * reply it persists at the end.
 */
export function createAssistantTurnResponse(
  events: AsyncGenerator<AssistantTurnEvent<unknown>, unknown>,
  options: {
    heartbeatMs?: number;
    headers?: Record<string, string>;
    /** Server-side log for a failure while pulling (default `console.error`). */
    onError?: AssistantTurnErrorLogger;
    /**
     * Called synchronously when the reader cancels the body (a client that
     * went away), before the generator is closed — e.g. to abort the turn.
     */
    onCancel?: () => void;
  } = {},
): Response {
  const encoder = new TextEncoder();
  const inCallerContext = AsyncLocalStorage.snapshot();
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
        const { value, done } = await inCallerContext(() => events.next());
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
              ...wireError(error, options.onError ?? defaultLogError),
            }),
          ),
        );
        controller.close();
      }
    },
    async cancel() {
      stop();
      try {
        options.onCancel?.();
      } catch {
        // A host callback never breaks the close.
      }
      await events.return?.(undefined);
    },
  });
  const headers = new Headers(options.headers);
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-cache, no-transform');
  headers.set('x-accel-buffering', 'no');
  return new Response(body, { status: 200, headers });
}
