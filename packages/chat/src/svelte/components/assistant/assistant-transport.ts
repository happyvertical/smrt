/**
 * AssistantDock transport contract (#2904).
 *
 * `AssistantTransport` is intentionally narrower than a full `ChatClientBackend`
 * (`../../../client.js`): it covers only what a route-mounted assistant surface
 * needs — list/create threads, load a thread's messages, send a message, and
 * stage an attachment. `SmrtChatBackend.send` (`../../../client.js`) still owns
 * the actual model-turn streaming/consumption contract; a `sendMessage` here is
 * expected to internally drive that turn (consuming only `onDone`, per the
 * binding decision that streaming UI is out of scope, tracked as #2908) and
 * return once a reply exists or the request is still processing.
 *
 * Two implementations ship in this file:
 *  - `createInMemoryAssistantTransport` — deterministic, no network, for tests
 *    and the package dev workbench/demos.
 *  - `createSmrtAssistantTransport` — reads go through a host-supplied,
 *    MEMBER-scoped `readEndpoint` (Copilot PR #2919 jAwqo/jAwrQ/jAwvV: NEVER
 *    the generated `ChatThread`/`ChatMessage` list REST routes directly —
 *    those enforce only authentication + tenant scope, not the per-room
 *    membership check that lives in `ChatService.listRoomThreads`, and
 *    `threadId` isn't even a filter the generated list handler understands).
 *    `createThread`/`sendMessage`/`uploadAttachment` have no generated REST
 *    counterpart to call either way (no `create`/`post` route is exposed on
 *    `ChatThread`/`ChatMessage`, `api: { include: ['list', 'get'] }` —
 *    `../../../models/ChatThread.ts:16`, `../../../models/ChatMessage.ts:26`)
 *    and must be wired to an application's own `ChatService`-backed
 *    `writeEndpoint`. Both gaps are documented in `docs/assistant-dock.md`
 *    rather than silently faked. See the "smrt-generated-REST-backed
 *    transport" section below for the full read wire contract.
 */

/**
 * AssistantDock uses its own light thread/message shapes rather than the
 * room-based `ChatThreadData`/`ChatMessageData` (`../types.js`): those UI
 * types require room-scoped fields (e.g. `ChatThreadData.rootMessage`,
 * `ChatMessageData.senderName`/`reactions`) that don't apply to a
 * tenant-scoped, route-agnostic assistant thread. Field names below
 * intentionally line up with `ChatThreadData`/`ChatMessageData` so a future
 * adapter between the two is a narrow mapping, not a rewrite.
 */
export interface AssistantThreadSummary {
  id: string;
  title: string;
  isResolved: boolean;
  messageCount: number;
  lastMessageAt?: string | Date | null;
}

export interface AssistantMessage {
  id: string;
  threadId: string;
  content: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string | Date;
  attachments?: AssistantAttachmentRef[];
  toolCallData?: unknown;
  /** The send transport's `clientRequestId` that produced this message, when
   * the transport echoes it back on the persisted row (#2904 review finding
   * A). Lets the controller resolve a pending send by id instead of by
   * `(threadId, content)` equality, which is ambiguous when a thread repeats
   * the same text (e.g. "yes") across turns. Optional: a transport that
   * doesn't persist/return this falls back to content matching. */
  clientRequestId?: string;
}

export interface AssistantAttachmentRef {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  url?: string;
}

/** A selectable model, matching `shared/ModelPicker.svelte`'s `ModelOption`. */
export interface ModelOption {
  id: string;
  label: string;
}

export interface AssistantSendMessageInput {
  threadId: string;
  content: string;
  attachments?: AssistantAttachmentRef[];
  /** Client-generated idempotency key for the send transport, distinct from
   * any data-surface action `idempotencyKey` (binding decision, #2904). */
  clientRequestId: string;
  /** The model selected via ModelPicker, when the transport supports one. */
  model?: string;
}

export interface AssistantSendMessageResult {
  /** True when the assistant turn has not resolved yet and the caller should
   * poll `loadMessages` for the reply (mirrors anytown's `payload.inProgress`,
   * `PortalChatTool.svelte:391`). */
  inProgress: boolean;
  userMessage?: AssistantMessage;
  assistantMessage?: AssistantMessage;
}

export interface AssistantTransport {
  listThreads(): Promise<AssistantThreadSummary[]>;
  createThread(title: string): Promise<AssistantThreadSummary>;
  loadMessages(threadId: string): Promise<AssistantMessage[]>;
  sendMessage(
    input: AssistantSendMessageInput,
  ): Promise<AssistantSendMessageResult>;
  uploadAttachment(file: File): Promise<AssistantAttachmentRef>;
  /** When present, `AssistantDock` renders `ModelPicker` in the composer
   * header and threads the selected id through `sendMessage`'s `model`. A
   * transport that has no model choice (e.g. a single fixed backend model)
   * simply omits this method. */
  listModels?(): Promise<ModelOption[]>;
}

// ---------------------------------------------------------------------------
// In-memory transport (tests, demos)
// ---------------------------------------------------------------------------

export interface InMemoryAssistantTransportOptions {
  /** Simulates a still-processing turn: the Nth send for a given thread
   * returns `inProgress: true` before resolving on a later `loadMessages`. */
  simulateInProgressOnce?: boolean;
  /** Copilot PR #2919 jAwu8: `simulateInProgressOnce` alone previously left a
   * turn `inProgress: true` FOREVER — it was never appended or scheduled to
   * resolve, so this shipped transport could not exercise successful
   * stale-send recovery (retry after the pending send goes 'stale'). When
   * set, the pending turn's assistant reply is appended on the Nth
   * `loadMessages()` call for that thread AFTER the send went in-progress
   * (1 = the very next load). Omitted (the default) preserves the prior
   * "never resolves on its own" behavior, which the existing stale-marking
   * test relies on (polling must NOT resolve it before the staleness
   * timeout fires). */
  resolveInProgressAfterLoads?: number;
  now?: () => number;
  /** Deterministic id generator for tests; defaults to an incrementing counter. */
  createId?: () => string;
  respond?: (
    threadId: string,
    userMessage: AssistantMessage,
    model?: string,
  ) => AssistantMessage | null;
  /** When set, `listModels()` resolves to this list, and `AssistantDock`
   * renders `ModelPicker`. Omit to simulate a transport with no model
   * choice. */
  models?: ModelOption[];
}

export function createInMemoryAssistantTransport(
  options: InMemoryAssistantTransportOptions = {},
): AssistantTransport {
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  const createId = options.createId ?? (() => `im-${++counter}`);

  const threads = new Map<string, AssistantThreadSummary>();
  const messages = new Map<string, AssistantMessage[]>();
  const seenClientRequestIds = new Map<string, AssistantSendMessageResult>();
  const pendingOnce = new Set<string>();
  // Copilot PR #2919 jAwu8: tracks an in-progress turn awaiting its
  // simulated resolution, keyed by threadId. `loadsRemaining` counts down on
  // each loadMessages() call for that thread; the assistant reply is
  // appended when it reaches 0.
  const pendingTurns = new Map<
    string,
    {
      userMessage: AssistantMessage;
      model: string | undefined;
      loadsRemaining: number;
    }
  >();

  function requireThread(threadId: string): AssistantThreadSummary {
    const thread = threads.get(threadId);
    if (!thread) {
      throw new Error(`AssistantDock: unknown thread "${threadId}"`);
    }
    return thread;
  }

  return {
    async listThreads() {
      return Array.from(threads.values());
    },

    ...(options.models
      ? { listModels: async () => options.models as ModelOption[] }
      : {}),

    async createThread(title: string) {
      const id = createId();
      const thread: AssistantThreadSummary = {
        id,
        title,
        isResolved: false,
        messageCount: 0,
        lastMessageAt: new Date(now()),
      };
      threads.set(id, thread);
      messages.set(id, []);
      return thread;
    },

    async loadMessages(threadId: string) {
      requireThread(threadId);
      // Copilot PR #2919 jAwu8: resolve a pending simulated in-progress turn
      // (only when `resolveInProgressAfterLoads` opted in — see its doc).
      const pending = pendingTurns.get(threadId);
      if (pending) {
        pending.loadsRemaining -= 1;
        if (pending.loadsRemaining <= 0) {
          pendingTurns.delete(threadId);
          const list = messages.get(threadId) ?? [];
          const assistantMessage: AssistantMessage = options.respond?.(
            threadId,
            pending.userMessage,
            pending.model,
          ) ?? {
            id: createId(),
            threadId,
            content: `echo: ${pending.userMessage.content}`,
            role: 'assistant',
            createdAt: new Date(now()),
          };
          list.push(assistantMessage);
          messages.set(threadId, list);
          const thread = threads.get(threadId);
          if (thread) thread.messageCount = (thread.messageCount ?? 0) + 1;
        }
      }
      return [...(messages.get(threadId) ?? [])];
    },

    async sendMessage(input: AssistantSendMessageInput) {
      const cached = seenClientRequestIds.get(input.clientRequestId);
      if (cached) {
        // Same retry semantics as PortalChatTool.svelte:304-316: a resend with
        // the same clientRequestId must not create a second message.
        return cached;
      }

      const thread = requireThread(input.threadId);
      const list = messages.get(input.threadId) ?? [];
      const userMessage: AssistantMessage = {
        id: createId(),
        threadId: input.threadId,
        content: input.content,
        role: 'user',
        createdAt: new Date(now()),
        attachments: input.attachments,
        // Echoed back so the controller can resolve this exact send by id
        // rather than by (threadId, content) equality (#2904 review F-A).
        clientRequestId: input.clientRequestId,
      };
      list.push(userMessage);
      messages.set(input.threadId, list);
      thread.messageCount = (thread.messageCount ?? 0) + 1;

      if (options.simulateInProgressOnce && !pendingOnce.has(input.threadId)) {
        pendingOnce.add(input.threadId);
        if (options.resolveInProgressAfterLoads !== undefined) {
          pendingTurns.set(input.threadId, {
            userMessage,
            model: input.model,
            loadsRemaining: options.resolveInProgressAfterLoads,
          });
        }
        const result: AssistantSendMessageResult = {
          inProgress: true,
          userMessage,
        };
        seenClientRequestIds.set(input.clientRequestId, result);
        return result;
      }

      const assistantMessage: AssistantMessage = options.respond?.(
        input.threadId,
        userMessage,
        input.model,
      ) ?? {
        id: createId(),
        threadId: input.threadId,
        content: `echo: ${input.content}`,
        role: 'assistant',
        createdAt: new Date(now()),
      };
      list.push(assistantMessage);
      thread.messageCount = (thread.messageCount ?? 0) + 1;

      const result: AssistantSendMessageResult = {
        inProgress: false,
        userMessage,
        assistantMessage,
      };
      seenClientRequestIds.set(input.clientRequestId, result);
      return result;
    },

    async uploadAttachment(file: File) {
      return {
        id: createId(),
        name: file.name,
        contentType: file.type || undefined,
        size: file.size,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// smrt-generated-REST-backed transport
// ---------------------------------------------------------------------------

/**
 * Wire contract for `createSmrtAssistantTransport`'s reads (Copilot PR #2919
 * jAwqo/jAwrQ/jAwvV). `readEndpoint` must be a host-supplied, MEMBER-scoped
 * endpoint — never the generated `ChatThread`/`ChatMessage` REST list routes
 * directly, which enforce only authentication + tenant scope, not the
 * per-room/per-thread membership check that lives in
 * `ChatService.listRoomThreads` (`packages/chat/src/services/ChatService.ts:1042`).
 * Calling the generated list route straight from the browser would let any
 * authenticated tenant member read every thread (and, for messages, every
 * OTHER thread's messages too — `threadId` isn't even a filter the generated
 * handler understands, it only parses `limit`/`offset`). See
 * `docs/assistant-dock.md`'s "Transport" section for the full contract this
 * endpoint must implement.
 *
 * Two calls:
 *  - `GET {readEndpoint}/threads` -> `{ items: <ThreadSummary wire shape>[] }`
 *  - `GET {readEndpoint}/threads/{id}/messages` -> `{ items: <Message wire shape>[] }`
 *
 * Documented wire shape (camelCase JSON, matching `AssistantThreadSummary`/
 * `AssistantMessage` field names directly) — this is what a CONFORMING
 * endpoint should send:
 *   ThreadSummary: `{ id, title, isResolved, messageCount, lastMessageAt? }`
 *   Message: `{ id, threadId, content, role, createdAt,
 *               attachments?: { name, url?, size? }[] }`, in CHRONOLOGICAL
 *            (oldest-first) order.
 *
 * `normalizeAssistantThreadSummary`/`normalizeAssistantMessage` below are
 * DEFENSIVE, not a second contract: a host wrapping the raw generated model
 * JSON (rather than writing a shape-converting endpoint) commonly hands back
 * snake_case (`created_at`, `thread_id`), a `ChatMessage.attachments` value
 * that is still the STORED JSON STRING with `filename` fields rather than a
 * parsed array with `name`, and newest-first pagination order. Both
 * normalizers tolerate that shape too so `loadMessages` still resolves
 * in-progress replies and renders attachments/messages correctly either way.
 */
export interface AssistantThreadSummaryWire {
  id: string;
  title: string;
  isResolved?: boolean;
  messageCount?: number;
  lastMessageAt?: string | Date | null;
  // Defensive snake_case fallbacks a raw generated-model JSON response uses.
  is_resolved?: boolean;
  message_count?: number;
  last_message_at?: string | Date | null;
}

export interface AssistantMessageWire {
  id: string;
  threadId?: string;
  content?: string;
  role?: AssistantMessage['role'];
  createdAt?: string | Date;
  attachments?: unknown;
  clientRequestId?: string;
  // Defensive snake_case fallbacks a raw generated-model JSON response uses.
  thread_id?: string;
  created_at?: string | Date;
  client_request_id?: string;
}

/**
 * Normalizes one attachment entry to `AssistantAttachmentRef`'s shape.
 * Accepts the documented `{ name, url?, size? }` shape directly, or a raw
 * generated-model `{ filename, ... }` entry (`filename` -> `name`).
 */
function normalizeAssistantAttachment(
  raw: unknown,
  index: number,
): AssistantAttachmentRef | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const name =
    typeof obj.name === 'string'
      ? obj.name
      : typeof obj.filename === 'string'
        ? obj.filename
        : undefined;
  if (!name) return undefined;
  return {
    id: typeof obj.id === 'string' ? obj.id : `att-${index}`,
    name,
    url: typeof obj.url === 'string' ? obj.url : undefined,
    size: typeof obj.size === 'number' ? obj.size : undefined,
    contentType:
      typeof obj.contentType === 'string'
        ? obj.contentType
        : typeof obj.content_type === 'string'
          ? (obj.content_type as string)
          : undefined,
  };
}

/**
 * Normalizes a message's `attachments` field, which the documented wire
 * shape sends as an array but `ChatMessage.attachments` (the raw generated
 * model column) stores as a JSON-encoded STRING (Copilot PR #2919 jAwvV).
 */
function normalizeAssistantAttachments(
  raw: unknown,
): AssistantAttachmentRef[] | undefined {
  let value: unknown = raw;
  if (typeof value === 'string') {
    if (value.length === 0) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry, index) => normalizeAssistantAttachment(entry, index))
    .filter((ref): ref is AssistantAttachmentRef => ref !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

/** Normalizes one thread summary row from either the documented camelCase
 * wire shape or a raw generated-model snake_case row. Exported for tests
 * (Copilot PR #2919 jAwvV). */
export function normalizeAssistantThreadSummary(
  raw: AssistantThreadSummaryWire,
): AssistantThreadSummary {
  return {
    id: raw.id,
    title: raw.title,
    isResolved: raw.isResolved ?? raw.is_resolved ?? false,
    messageCount: raw.messageCount ?? raw.message_count ?? 0,
    lastMessageAt: raw.lastMessageAt ?? raw.last_message_at ?? null,
  };
}

/** Normalizes one message row from either the documented camelCase wire
 * shape or a raw generated-model snake_case row, including its
 * (possibly JSON-string) `attachments` field. Exported for tests (Copilot
 * PR #2919 jAwvV). */
export function normalizeAssistantMessage(
  raw: AssistantMessageWire,
): AssistantMessage {
  return {
    id: raw.id,
    threadId: raw.threadId ?? raw.thread_id ?? '',
    content: raw.content ?? '',
    role: raw.role ?? 'assistant',
    createdAt: raw.createdAt ?? raw.created_at ?? new Date(),
    attachments: normalizeAssistantAttachments(raw.attachments),
    clientRequestId: raw.clientRequestId ?? raw.client_request_id,
  };
}

function messageTimeValue(message: AssistantMessage): number {
  const t = new Date(message.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Sorts messages chronologically (oldest first) — the documented wire order
 * this transport requires, but a raw generated-model list response is
 * newest-first (Copilot PR #2919 jAwvV): without this, an in-progress
 * reply's resolution check (which searches for an assistant/tool message
 * AFTER the triggering user message) never finds it. Exported for tests. */
export function sortAssistantMessagesChronologically(
  messages: AssistantMessage[],
): AssistantMessage[] {
  return [...messages].sort(
    (a, b) => messageTimeValue(a) - messageTimeValue(b),
  );
}

export interface SmrtAssistantTransportOptions {
  /** Host-supplied, MEMBER-scoped read endpoint (Copilot PR #2919
   * jAwqo/jAwrQ) — required. `GET {readEndpoint}/threads` and
   * `GET {readEndpoint}/threads/{id}/messages`; see this file's
   * "smrt-generated-REST-backed transport" section header for the full wire
   * contract and why the generated `ChatThread`/`ChatMessage` list routes
   * must never be called directly from here. `ChatService.listRoomThreads`
   * (`packages/chat/src/services/ChatService.ts:1042`) is the server-side
   * building block a host's endpoint implementation should call. */
  readEndpoint: string;
  token: string;
  /** Required for sendMessage/createThread, which have no generated REST route
   * (ChatThread/ChatMessage only expose `list`/`get` — see file header). Host
   * apps must supply a `ChatService`-backed endpoint here; omitting it leaves
   * `createThread`/`sendMessage` throwing a descriptive error rather than
   * silently no-opping. */
  writeEndpoint?: {
    createThread: (title: string) => Promise<AssistantThreadSummary>;
    sendMessage: (
      input: AssistantSendMessageInput,
    ) => Promise<AssistantSendMessageResult>;
    uploadAttachment: (file: File) => Promise<AssistantAttachmentRef>;
  };
  /** Static model catalog; when supplied, `listModels()` resolves to it and
   * `AssistantDock` renders `ModelPicker`. The `model` field of a `send` is
   * threaded straight through to `writeEndpoint.sendMessage`'s `input`. */
  models?: ModelOption[];
  fetchImpl?: typeof fetch;
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `AssistantDock transport: GET ${url} -> ${response.status}`,
    );
  }
  return response.json() as Promise<T>;
}

/**
 * Reads go through a host-supplied, MEMBER-scoped `readEndpoint` (never the
 * generated `ChatThread`/`ChatMessage` list routes directly — see this
 * section's header comment above `SmrtAssistantTransportOptions`). Writes
 * (`createThread`, `sendMessage`, `uploadAttachment`) require an explicit
 * `writeEndpoint` supplied by the host application, since neither model
 * exposes a generated `create` route (`api: { include: ['list', 'get'] }`,
 * `../../../models/ChatThread.ts:16`, `../../../models/ChatMessage.ts:26`).
 */
export function createSmrtAssistantTransport(
  options: SmrtAssistantTransportOptions,
): AssistantTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  function requireWrite<
    K extends keyof NonNullable<SmrtAssistantTransportOptions['writeEndpoint']>,
  >(key: K) {
    const endpoint = options.writeEndpoint?.[key];
    if (!endpoint) {
      throw new Error(
        `AssistantDock: createSmrtAssistantTransport has no writeEndpoint.${String(
          key,
        )} configured. ChatThread/ChatMessage do not expose a generated ` +
          `"create" REST route (list/get only); supply a ChatService-backed ` +
          `writeEndpoint to enable sending messages.`,
      );
    }
    return endpoint;
  }

  return {
    async listThreads() {
      const page = await getJson<{ items: AssistantThreadSummaryWire[] }>(
        fetchImpl,
        `${options.readEndpoint}/threads`,
        options.token,
      );
      return (page.items ?? []).map(normalizeAssistantThreadSummary);
    },

    ...(options.models
      ? { listModels: async () => options.models as ModelOption[] }
      : {}),

    async createThread(title: string) {
      return requireWrite('createThread')(title);
    },

    async loadMessages(threadId: string) {
      const page = await getJson<{ items: AssistantMessageWire[] }>(
        fetchImpl,
        `${options.readEndpoint}/threads/${encodeURIComponent(threadId)}/messages`,
        options.token,
      );
      const normalized = (page.items ?? []).map(normalizeAssistantMessage);
      return sortAssistantMessagesChronologically(normalized);
    },

    async sendMessage(input: AssistantSendMessageInput) {
      return requireWrite('sendMessage')(input);
    },

    async uploadAttachment(file: File) {
      return requireWrite('uploadAttachment')(file);
    },
  };
}
