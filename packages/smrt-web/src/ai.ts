/**
 * Browser inference path — ONE call-site object over interchangeable inference
 * backends.
 *
 * A caller (a component, a hook, a workbench) holds a single `InferencePath`
 * and calls `chat()`/`stream()` on it. Which backend actually answers is
 * resolved **per call**, never cached on the path, so changing the preference
 * between two calls takes effect on the next one. That is what makes "switch
 * between the local model and the server route mid-session" a property
 * assignment rather than session state to unwind.
 *
 * ## Why a mirror rather than an import
 *
 * `InferenceMessage`/`InferenceResponse`/`InferenceChatOptions` are TEXTUAL
 * structural mirrors of `@happyvertical/ai`'s `AIMessage`/`AIResponse`/
 * `ChatOptions`, and `InferenceProgress` mirrors the browser adapters'
 * `DownloadProgressInfo`. smrt-web deliberately has no `@happyvertical/*`
 * dependency (`AGENTS.md`, "No inter-smrt dependencies"), so an `AIInterface`
 * — the ecosystem's canonical inference boundary — is described here by shape.
 *
 * The mirror covers the text-generation surface only. A backend whose
 * `chat`/`stream` accept these shapes satisfies the consumers in this
 * repository; a consumer that needs more of `AIInterface` adapts at its own
 * boundary rather than widening this contract.
 *
 * ## What this module does NOT own
 *
 * Backends arrive as arguments, the same way definitions and fetchers do
 * everywhere else in this package. A WebLLM backend lives beside the adapter
 * it wraps; `createRouteInferenceBackend` here covers the streaming-route case
 * because that one is pure `fetch` plus an SSE frame reader.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Mirrored vocabulary
// ---------------------------------------------------------------------------

/** Text content part (mirrors `TextContentPart`). */
export interface InferenceTextPart {
  type: 'text';
  text: string;
}

/** Image content part (mirrors `ImageContentPart`). */
export interface InferenceImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type InferenceContentPart = InferenceTextPart | InferenceImagePart;

/** Message roles, mirroring `AIMessage['role']`. */
export type InferenceRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'function'
  | 'tool';

export interface InferenceToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One conversation message (mirrors `AIMessage`). */
export interface InferenceMessage {
  role: InferenceRole;
  content: string | InferenceContentPart[];
  name?: string;
  tool_calls?: InferenceToolCall[];
}

/** A tool definition offered to the model (mirrors `AITool`). */
export interface InferenceTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Token usage (mirrors `TokenUsage`). */
export interface InferenceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A completion result (mirrors `AIResponse`). */
export interface InferenceResponse {
  content: string;
  usage?: InferenceUsage;
  model?: string;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  toolCalls?: InferenceToolCall[];
}

/**
 * Per-call options (mirrors the `ChatOptions` fields a browser backend can
 * honor).
 *
 * `signal` is the cancellation seam a backend SHOULD respect — one that cannot
 * (the browser LLM adapter has no cancel path) ignores it rather than
 * pretending, so a caller must not read an abort as proof the work stopped.
 *
 * `tools` is refused, not ignored: every backend here is a text conversation,
 * and a backend that silently dropped a tool definition would let a caller
 * believe an answer was produced with tools it never received. Use
 * {@link assertTextOnlyTurn} to check a turn up front.
 */
export interface InferenceChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: InferenceTool[];
  toolChoice?:
    | 'auto'
    | 'none'
    | { type: 'function'; function: { name: string } };
  /** Token sink for a streamed reply. Backends that cannot stream ignore it. */
  onProgress?: (chunk: string) => void;
  /**
   * Caller cancellation. Honored by the route backend (composed with
   * `timeout`); the local WebLLM backend cannot cancel a generation already
   * running on the GPU and does not read it.
   */
  signal?: AbortSignal;
  /**
   * Deadline in milliseconds for one call. Honored by the route backend, which
   * aborts the request when it elapses. Not honored by the local backend.
   */
  timeout?: number;
}

/**
 * Model load/download progress, mirroring the browser adapters'
 * `DownloadProgressInfo` so a `DownloadProgress` control can render it
 * directly.
 */
export interface InferenceProgress {
  state: 'idle' | 'downloading' | 'extracting' | 'complete' | 'error';
  bytesLoaded: number;
  bytesTotal: number;
  percent: number;
  currentFile?: string;
  estimatedTimeRemaining?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Representation limits shared by every backend
// ---------------------------------------------------------------------------

/**
 * Cap on one undelivered SSE line, in UTF-16 code units. Without it a peer
 * that streams bytes with no `\n` grows the reader's buffer until the tab's
 * heap is exhausted.
 */
export const MAX_INFERENCE_STREAM_LINE_UNITS = 1_048_576;

/** Cap on total bytes read for one route call. */
export const MAX_INFERENCE_STREAM_BYTES = 64 * 1_048_576;

/** Cap on the reply a route backend's `chat()` will assemble. */
export const MAX_INFERENCE_REPLY_UNITS = 8 * 1_048_576;

/**
 * A turn in the subset every backend in this module can carry: a text
 * conversation with no tool traffic.
 */
export interface InferenceTextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Reject a turn this module's backends cannot faithfully carry, narrowing
 * `messages` to {@link InferenceTextMessage} on success.
 *
 * Every backend here is a TEXT conversation: roles `user`/`assistant`/
 * `system`, string content, no tools. Each of those limits is a real
 * difference between the backends' transports, so refusing up front is the
 * only way a caller can tell "this backend can't carry my turn" from "this
 * backend answered". The route wire contract (`chat-stream.ts`
 * `normalizeMessages`) and the local adapter both silently DROP exactly these
 * shapes, which is why this check is shared rather than reimplemented per
 * backend — two copies would drift, and the whole point is that both backends
 * agree.
 *
 * `backendLabel` names the backend in the message so a caller knows which one
 * refused.
 */
export function assertTextOnlyTurn(
  backendLabel: string,
  messages: InferenceMessage[],
  options?: InferenceChatOptions,
): asserts messages is InferenceTextMessage[] {
  if (options?.tools?.length || options?.toolChoice !== undefined) {
    throw new InferencePathError(
      `${backendLabel} cannot accept tool definitions or a tool choice. Route a tool-using turn to a backend that supports tools.`,
      'unsupported_message',
    );
  }
  for (const message of messages) {
    if (
      message.role !== 'user' &&
      message.role !== 'assistant' &&
      message.role !== 'system'
    ) {
      throw new InferencePathError(
        `${backendLabel} cannot carry a "${message.role}" message. Its transport keeps only user/assistant/system, so a tool observation would vanish from the conversation. Route a tool-using turn to a backend that supports it.`,
        'unsupported_message',
      );
    }
    if (message.tool_calls?.length) {
      throw new InferencePathError(
        `${backendLabel} cannot carry a record of a prior tool call. Dropping it would let the model answer as though the call never happened.`,
        'unsupported_message',
      );
    }
    if (typeof message.content !== 'string') {
      throw new InferencePathError(
        `${backendLabel} cannot carry non-string (multimodal) content. Route it to a backend that supports it.`,
        'unsupported_message',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

/**
 * Whether a backend can answer right now.
 *
 * - `unavailable` — cannot run in this environment at all (no WebGPU, model
 *   not offered). Never auto-selected.
 * - `idle` — could run, nothing loaded yet. Not auto-selected; call `load()`.
 * - `loading` — a load is in progress. Not auto-selected.
 * - `ready` — can answer now. The only state auto-selection picks.
 * - `error` — the last load or call failed. Never auto-selected.
 */
export type InferenceBackendStatus =
  | 'unavailable'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

/** Where a backend executes. Reporting only — the path never branches on it. */
export type InferenceBackendKind = 'local' | 'route';

export interface InferenceBackend {
  /** Stable id, unique across a path. A preference names this. */
  readonly id: string;
  /**
   * Where this backend runs. Purely descriptive: it exists so a UI can say
   * "runs on your device" and so callers can order backends sensibly. The
   * path's resolution never reads it.
   */
  readonly kind: InferenceBackendKind;
  readonly status: InferenceBackendStatus;
  /** Present while `status` is `loading` (and after a failure). */
  readonly progress?: InferenceProgress;

  /** Load whatever `status: 'idle'` is waiting on. No-op when already ready. */
  load?(onProgress?: (progress: InferenceProgress) => void): Promise<void>;
  /** Release loaded resources. No-op for backends with nothing to release. */
  unload?(): Promise<void>;

  chat(
    messages: InferenceMessage[],
    options?: InferenceChatOptions,
  ): Promise<InferenceResponse>;
  stream(
    messages: InferenceMessage[],
    options?: InferenceChatOptions,
  ): AsyncIterable<string>;

  /**
   * Optional change notification. A backend that exposes this lets the path
   * re-broadcast status/progress changes to UI subscribers; one that omits it
   * is simply non-reactive for those fields.
   */
  subscribe?(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/** Why a call was routed to the backend it was routed to. */
export interface InferenceResolution {
  backend: InferenceBackend;
  /**
   * - `preferred` — an explicit preference named this backend and it is usable.
   * - `fallback` — an explicit preference was unusable; `requested` names it.
   * - `auto` — no explicit preference; first usable backend in declared order.
   */
  reason: 'preferred' | 'fallback' | 'auto';
  /** The preference that could not be honored (`reason: 'fallback'` only). */
  requested?: string;
  /** Ids skipped because `canUse` returned false, in declared order. */
  skipped: readonly string[];
}

export interface InferencePathOptions {
  /**
   * Candidate backends, in priority order. Order IS the auto-selection
   * preference: list the local model first to prefer it when it is usable.
   */
  backends: readonly InferenceBackend[];
  /** Backend id to prefer, or `'auto'`. Defaults to `'auto'`. */
  preference?: string;
  /**
   * Whether a backend may answer. Defaults to `backend.status === 'ready'`,
   * so an unloaded (`idle`) local backend is skipped rather than silently
   * triggering a multi-gigabyte download mid-conversation.
   */
  canUse?: (backend: InferenceBackend) => boolean;
}

export interface InferencePath {
  readonly backends: readonly InferenceBackend[];
  /** The backend the NEXT call would use; `null` when none is usable. */
  readonly activeId: string | null;
  /** The configured preference, or `'auto'`. Settable; takes effect next call. */
  preference: string;

  /** The resolution the next call would produce, without making one. */
  resolve(): InferenceResolution;
  /** Pin to a backend id, or back to `'auto'`. */
  select(preference: string): void;

  chat(
    messages: InferenceMessage[],
    options?: InferenceChatOptions,
  ): Promise<InferenceResponse>;
  stream(
    messages: InferenceMessage[],
    options?: InferenceChatOptions,
  ): AsyncIterable<string>;

  /**
   * Notified when a backend reports a status/progress change or the
   * preference changes. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;

  /** Detach every backend subscription and drop all listeners. */
  dispose(): void;
}

export type InferencePathErrorCode =
  | 'no_backends'
  | 'duplicate_backend'
  | 'unknown_backend'
  | 'no_usable_backend'
  | 'unsupported_message'
  | 'route_request_failed'
  | 'route_stream_error'
  | 'route_stream_truncated';

export class InferencePathError extends Error {
  readonly code: InferencePathErrorCode;

  constructor(message: string, code: InferencePathErrorCode) {
    super(message);
    this.name = 'InferencePathError';
    this.code = code;
  }
}

/**
 * Create the browser's single inference path over `options.backends`.
 *
 * Resolution happens inside every `chat`/`stream` call, so a `preference` or
 * `select()` change made between calls is honored by the next one. A call
 * whose resolution finds nothing usable throws `InferencePathError` with
 * `code: 'no_usable_backend'` rather than falling back to a fake answer.
 */
export function createInferencePath(
  options: InferencePathOptions,
): InferencePath {
  const backends = [...options.backends];
  if (backends.length === 0) {
    throw new InferencePathError(
      'createInferencePath requires at least one backend',
      'no_backends',
    );
  }

  const seen = new Set<string>();
  for (const backend of backends) {
    if (seen.has(backend.id)) {
      // Fail closed and atomically, before anything is routed: a duplicate id
      // makes `preference` ambiguous, and picking one would silently ignore
      // the other.
      throw new InferencePathError(
        `Duplicate inference backend id "${backend.id}"`,
        'duplicate_backend',
      );
    }
    seen.add(backend.id);
  }

  const canUse = options.canUse ?? ((backend) => backend.status === 'ready');
  let preference = options.preference ?? 'auto';
  const listeners = new Set<() => void>();
  const backendTeardowns = new Map<string, () => void>();

  function resolve(): InferenceResolution {
    const requested = preference;
    if (requested !== 'auto') {
      const preferred = backends.find((backend) => backend.id === requested);
      if (!preferred) {
        throw new InferencePathError(
          `No inference backend with id "${requested}"`,
          'unknown_backend',
        );
      }
      if (canUse(preferred)) {
        return {
          backend: preferred,
          reason: 'preferred',
          skipped: [],
        };
      }
      const fallback = backends.find(canUse);
      if (!fallback) {
        throw new InferencePathError(
          `Preferred inference backend "${requested}" is not usable and no other backend is`,
          'no_usable_backend',
        );
      }
      return {
        backend: fallback,
        reason: 'fallback',
        requested,
        skipped: backends
          .filter((backend) => !canUse(backend))
          .map((backend) => backend.id),
      };
    }

    const skipped: string[] = [];
    for (const backend of backends) {
      if (canUse(backend)) {
        return { backend, reason: 'auto', skipped };
      }
      skipped.push(backend.id);
    }
    throw new InferencePathError(
      `No usable inference backend among: ${backends
        .map((backend) => backend.id)
        .join(', ')}`,
      'no_usable_backend',
    );
  }

  return {
    backends,
    get preference() {
      return preference;
    },
    set preference(next: string) {
      if (next === preference) return;
      preference = next;
      for (const listener of [...listeners]) listener();
    },

    get activeId() {
      try {
        return resolve().backend.id;
      } catch {
        return null;
      }
    },

    resolve,
    select(next: string) {
      this.preference = next;
    },

    async chat(messages, chatOptions) {
      return resolve().backend.chat(messages, chatOptions);
    },

    stream(messages, chatOptions) {
      // Resolution must happen when the consumer PULLS, not when `stream` is
      // called: `chat`/`stream` are per-call, so a preference set between the
      // call and the first pull has to be the one that applies.
      return (async function* streamRouted() {
        yield* resolve().backend.stream(messages, chatOptions);
      })();
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      // Attach to any backend that opted into change notification, once each.
      for (const backend of backends) {
        if (backendTeardowns.has(backend.id)) continue;
        const teardown = backend.subscribe?.(() => {
          for (const subscriber of [...listeners]) subscriber();
        });
        if (teardown) backendTeardowns.set(backend.id, teardown);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      for (const teardown of backendTeardowns.values()) teardown();
      backendTeardowns.clear();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming-route backend
// ---------------------------------------------------------------------------

export interface RouteInferenceBackendOptions {
  /** Full URL of a `text/event-stream` endpoint accepting `{ messages, session }`. */
  endpoint: string;
  /** Backend id. Defaults to `'route'`. */
  id?: string;
  /** Extra request headers, evaluated per call (auth tokens rotate). */
  headers?: () => Record<string, string>;
  /** Fetch credentials mode. Defaults to the platform default. */
  credentials?: RequestCredentials;
  /** Session metadata attached to the request body. */
  session?: Record<string, unknown>;
  /** Injectable fetch (tests, SSR-safe wrappers). */
  fetchImpl?: typeof fetch;
  /**
   * Model id recorded on the returned `InferenceResponse`. Reporting only —
   * the route resolves the model it actually uses, and a caller cannot widen
   * it by naming one here (the generation caps live in the server-resolved
   * stream context).
   */
  model?: string;
}

/** One frame the consumed route can produce. */
type RouteEvent =
  | { kind: 'token'; text: string }
  | { kind: 'done'; content: string | undefined };

interface RouteFrame {
  type?: unknown;
  text?: unknown;
  error?: unknown;
  message?: { content?: unknown } | null;
}

/**
 * One SSE line decoded, or the frame's terminal meaning.
 *
 * `emotion`/`control`/unknown `type` values resolve to `{ kind: 'ignored' }`:
 * `chat-stream.ts` declares lanes the engine does not emit yet, so an
 * unrecognized frame is forward compatibility, not a failure.
 */
function decodeRouteFrame(
  line: string,
): RouteEvent | { kind: 'ignored' } | { kind: 'error'; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice('data:'.length));
  } catch {
    return {
      kind: 'error',
      message: `Inference route sent an unparseable frame: ${line.slice(0, 80)}`,
    };
  }

  // `null`, a number and a bare string are all valid JSON and none of them is
  // a frame; reading a property off them would throw a raw TypeError past this
  // module's error contract. Treated as unrecognized (forward compatibility),
  // the same as an unknown `type`.
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'ignored' };
  }
  const frame = parsed as RouteFrame;

  if (frame.type === 'token') {
    return typeof frame.text === 'string' && frame.text.length > 0
      ? { kind: 'token', text: frame.text }
      : { kind: 'ignored' };
  }
  if (frame.type === 'done') {
    const content = frame.message?.content;
    return {
      kind: 'done',
      content: typeof content === 'string' ? content : undefined,
    };
  }
  if (frame.type === 'error') {
    return {
      kind: 'error',
      message:
        typeof frame.error === 'string' && frame.error.length > 0
          ? frame.error
          : 'Inference route reported an unspecified stream error',
    };
  }
  return { kind: 'ignored' };
}

/**
 * Read one SSE response body as route events.
 *
 * The reader is cancelled in a `finally`, so a consumer that abandons the
 * iterable (an aborted turn, an unmounted component) releases the connection
 * instead of leaving it open until GC.
 */
async function* readRouteEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RouteEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let consumed = 0;

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // A reset socket or an aborted read is a stream failure like any
        // other; every failure must leave this module as an
        // `InferencePathError` so a caller branching on `code` sees it.
        throw new InferencePathError(
          `Inference route stream read failed: ${error instanceof Error ? error.message : String(error)}`,
          'route_stream_error',
        );
      }
      if (chunk.done) break;

      consumed += chunk.value.byteLength;
      if (consumed > MAX_INFERENCE_STREAM_BYTES) {
        throw new InferencePathError(
          `Inference route stream exceeded ${MAX_INFERENCE_STREAM_BYTES} bytes`,
          'route_stream_error',
        );
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        // Blank lines and `: heartbeat` comments carry no frame.
        if (!line.startsWith('data:')) continue;

        const decoded = decodeRouteFrame(line);
        if (decoded.kind === 'error') {
          throw new InferencePathError(decoded.message, 'route_stream_error');
        }
        if (decoded.kind === 'ignored') continue;
        yield decoded;
        // `done` is terminal: the route never sends another frame after it,
        // and the consumer's `for await` should not wait for the close.
        if (decoded.kind === 'done') return;
      }

      // Whatever is left has no terminator yet. Bounding it is what keeps the
      // `indexOf`/`slice` rescans above bounded too: an unterminated line can
      // never grow past the cap, so neither can the per-chunk rescan cost.
      if (buffer.length > MAX_INFERENCE_STREAM_LINE_UNITS) {
        throw new InferencePathError(
          `Inference route stream sent an unterminated frame over ${MAX_INFERENCE_STREAM_LINE_UNITS} units`,
          'route_stream_error',
        );
      }
    }
    // The route always terminates with `done` or `error`. A clean close
    // without one means an intermediary cut the stream — never fabricate a
    // successful (possibly empty) reply out of a truncation.
    throw new InferencePathError(
      'Inference route stream ended without a done frame',
      'route_stream_truncated',
    );
  } finally {
    reader.cancel().catch(() => {
      /* stream already closed — nothing to release */
    });
  }
}

/**
 * Compose the caller's cancellation signal with this call's deadline, so a
 * request with a `timeout` cannot outlive it even when no signal was passed.
 */
function requestSignal(
  chatOptions?: InferenceChatOptions,
): AbortSignal | undefined {
  const { signal, timeout } = chatOptions ?? {};
  if (timeout === undefined) return signal;
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * A backend over a `text/event-stream` inference route.
 *
 * The wire contract is `@happyvertical/smrt-chat`'s `ChatStreamEvent` framing
 * (token deltas, then a terminal `done` or `error`), consumed here without
 * depending on that package: smrt-web carries no inter-SMRT dependencies, so
 * the frame vocabulary is mirrored the same way the rest of this module is.
 *
 * `status` is always `'ready'` — there is nothing to load — so an `auto` path
 * picks this backend until a local one reports ready. It defines neither
 * `load` nor `unload`, so a control must not offer those actions for it.
 *
 * A turn this wire cannot carry (tool turns, multimodal content, tool
 * definitions) is REFUSED with `unsupported_message` rather than forwarded:
 * the route silently drops those shapes, so forwarding would answer a
 * different question than the caller asked.
 */
export function createRouteInferenceBackend(
  options: RouteInferenceBackendOptions,
): InferenceBackend {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function openStream(
    messages: InferenceMessage[],
    chatOptions?: InferenceChatOptions,
  ): Promise<AsyncGenerator<RouteEvent>> {
    // Refuse rather than forward: the route's own wire contract
    // (`chat-stream.ts` `normalizeMessages`) silently DROPS tool turns,
    // non-string content and any tool definition, so forwarding them would
    // return a plausible answer to a different question than the caller asked.
    assertTextOnlyTurn('The streaming route', messages, chatOptions);

    let response: Response;
    try {
      response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.headers?.(),
        },
        ...(options.credentials ? { credentials: options.credentials } : {}),
        body: JSON.stringify({ messages, session: options.session }),
        signal: requestSignal(chatOptions),
      });
    } catch (error) {
      // Offline, DNS, CORS, TLS and an aborted or timed-out request all land
      // here; a caller must be able to see that as a route failure rather than
      // as an unexplained TypeError.
      throw new InferencePathError(
        `Inference route request failed: ${error instanceof Error ? error.message : String(error)}`,
        'route_request_failed',
      );
    }

    if (!response.ok || !response.body) {
      // The route renders structured errors — carry a bounded body excerpt so
      // an auth failure is distinguishable from a bad request.
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {
        /* body unreadable — the status alone will have to do */
      }
      throw new InferencePathError(
        `Inference route responded ${response.status}${detail ? `: ${detail}` : ''}`,
        'route_request_failed',
      );
    }

    return readRouteEvents(response.body);
  }

  return {
    id: options.id ?? 'route',
    kind: 'route',
    status: 'ready',

    async chat(messages, chatOptions) {
      const events = await openStream(messages, chatOptions);
      let assembled = '';
      for await (const event of events) {
        if (event.kind === 'token') {
          assembled += event.text;
          // Bound the accumulator, so a peer that streams token frames
          // forever cannot exhaust the tab's heap.
          if (assembled.length > MAX_INFERENCE_REPLY_UNITS) {
            throw new InferencePathError(
              `Inference route reply exceeded ${MAX_INFERENCE_REPLY_UNITS} units`,
              'route_stream_error',
            );
          }
        }
        // `done.message.content` is the server's persisted, authoritative
        // reply; the assembled tokens are a live preview that a tool-call
        // round may have narrated past.
        else if (event.content !== undefined) assembled = event.content;
      }
      return {
        content: assembled,
        ...(options.model ? { model: options.model } : {}),
      };
    },

    async *stream(messages, chatOptions) {
      const events = await openStream(messages, chatOptions);
      for await (const event of events) {
        if (event.kind === 'done') return;
        chatOptions?.onProgress?.(event.text);
        yield event.text;
      }
    },
  };
}
