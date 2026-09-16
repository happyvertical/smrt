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
 *  - `createSmrtAssistantTransport` — backed by the generated
 *    `ChatThread`/`ChatMessage` REST routes. Those models are configured with
 *    `api: { include: ['list', 'get'] }` only (see `../../../models/ChatThread.ts:16`
 *    and `../../../models/ChatMessage.ts:26`), so this implementation can serve
 *    `listThreads`/`loadMessages` directly, but `createThread`/`sendMessage`
 *    have no generated REST counterpart to call (no `create`/`post` route is
 *    exposed) and must be wired to an application's own `ChatService`-backed
 *    endpoint by the host. This is documented as a known gap in
 *    `docs/assistant-dock.md` rather than silently faked.
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

export interface SmrtAssistantTransportOptions {
  baseUrl: string;
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
 * Backed by ChatThread/ChatMessage's generated `list`/`get` REST routes for
 * reads. Writes (`createThread`, `sendMessage`, `uploadAttachment`) require an
 * explicit `writeEndpoint` supplied by the host application, since neither
 * model exposes a generated `create` route (`api: { include: ['list', 'get'] }`,
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
      const page = await getJson<{ items: AssistantThreadSummary[] }>(
        fetchImpl,
        `${options.baseUrl}/chat-threads`,
        options.token,
      );
      return page.items ?? [];
    },

    ...(options.models
      ? { listModels: async () => options.models as ModelOption[] }
      : {}),

    async createThread(title: string) {
      return requireWrite('createThread')(title);
    },

    async loadMessages(threadId: string) {
      const page = await getJson<{ items: AssistantMessage[] }>(
        fetchImpl,
        `${options.baseUrl}/chat-messages?threadId=${encodeURIComponent(threadId)}`,
        options.token,
      );
      return page.items ?? [];
    },

    async sendMessage(input: AssistantSendMessageInput) {
      return requireWrite('sendMessage')(input);
    },

    async uploadAttachment(file: File) {
      return requireWrite('uploadAttachment')(file);
    },
  };
}
