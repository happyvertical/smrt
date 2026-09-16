/**
 * Headless AssistantDock state (#2904).
 *
 * Composes: route-scoped `DataSurfaceDescriptor` discovery from a
 * `DataSurfaceRegistry` (`@happyvertical/smrt-ui/data-surface`), an
 * `AssistantTransport` (`./assistant-transport.js`) for thread/message I/O,
 * and an `AssistantActionClient` for action preview/apply.
 *
 * Action preview/apply is NOT routed through `DataSurfaceCommandBridge`
 * (`../../../data-surface-bridge.js`) — that bridge is the live-collaboration
 * query/select command channel (see its own tests in
 * `data-surface-conformance.integration.svelte.test.ts` around `ackBridge`).
 * The actual action pathway is `DataSurfaceActionAdapter.preview()`/`.apply()`
 * (`@happyvertical/smrt-agents/server`, exercised directly in
 * `packages/smrt-svelte/src/web/__tests__/data-surface-conformance.integration.svelte.test.ts:1221-1441`).
 * That adapter is server-only (it needs a `DataSurfaceExecutionContext` with a
 * principal/tenant the browser cannot self-assert). `AssistantActionClient` is
 * the client-side seam a host application implements to reach it — typically
 * an authenticated HTTP call to a server route that wraps the adapter. Tests
 * use an in-process implementation that calls the real adapter directly with
 * a fixed context, the same shape the conformance exemplar uses.
 *
 * Polling and stale-send recovery follow the pattern in anytown's
 * `PortalChatTool.svelte` (read in full for #2904 phase 2):
 *  - `clientRequestId` is generated once per distinct (threadId, content) draft
 *    and reused on retry until the send resolves or errors — mirrors
 *    `clientRequestIdForDraft`/`clearPendingRequest`,
 *    `PortalChatTool.svelte:304-322`.
 *  - A still-processing send (`inProgress: true`, mirrors
 *    `payload.inProgress`, `PortalChatTool.svelte:391`) schedules a poll of
 *    `loadMessages` rather than blocking — mirrors `scheduleThreadPoll`,
 *    `PortalChatTool.svelte:339-353` (there: fixed 8 attempts / 1500ms). This
 *    controller generalizes that into a configurable interval plus an
 *    absolute staleness timeout (default 90s) after which the pending send is
 *    marked `'stale'` and the composer can offer "retry", reusing the same
 *    `clientRequestId` so the transport dedups it (`assistant-transport.ts`
 *    `createInMemoryAssistantTransport.sendMessage`).
 */

import {
  type DataSurfaceActionRequest,
  type DataSurfaceActionResult,
  type DataSurfaceIdentity,
  type DataSurfaceRegistry,
  normalizeDataSurfaceActionRequest,
} from '@happyvertical/smrt-ui/data-surface';
import { SvelteMap } from 'svelte/reactivity';
import type {
  AssistantAttachmentRef,
  AssistantMessage,
  AssistantThreadSummary,
  AssistantTransport,
  ModelOption,
} from './assistant-transport.js';

export type AssistantPendingSendStatus =
  | 'sending'
  | 'processing'
  | 'stale'
  | 'failed';

export interface AssistantPendingSend {
  clientRequestId: string;
  threadId: string;
  content: string;
  status: AssistantPendingSendStatus;
  sentAt: number;
  attachments?: AssistantAttachmentRef[];
}

/** Client-side seam to a server-hosted `DataSurfaceActionAdapter`. */
export interface AssistantActionClient {
  preview(request: DataSurfaceActionRequest): Promise<DataSurfaceActionResult>;
  /** `idempotencyKey` is distinct from the send transport's `clientRequestId`
   * (binding decision #2904) and maps to
   * `DataSurfaceActionWireRequest.idempotencyKey`
   * (`packages/types/src/data-surface.ts:274`), which the host's actionClient
   * implementation attaches when calling the server-side adapter. */
  apply(
    request: DataSurfaceActionRequest,
    idempotencyKey: string,
  ): Promise<DataSurfaceActionResult>;
}

export interface AssistantActionState {
  request: DataSurfaceActionRequest;
  previewResult?: DataSurfaceActionResult;
  applyResult?: DataSurfaceActionResult;
  status: 'previewing' | 'previewed' | 'applying' | 'applied' | 'failed';
  error?: string;
  /** Minted once when the preview is created and reused for every apply
   * attempt on this proposed action (including retries after a failure), so
   * a retried Confirm click after a timeout where the server DID apply
   * dedups against that earlier attempt instead of re-executing. */
  idempotencyKey: string;
}

export interface AssistantDockControllerOptions {
  transport: AssistantTransport;
  registry: DataSurfaceRegistry;
  /** Explicit surface override (design decision #2904: `AssistantDock`
   * accepts `registry` plus an optional `surfaces` override rather than only
   * ever trusting live discovery). When set, this list is used instead of the
   * registry's current entries. */
  surfaces?: DataSurfaceIdentity[];
  actionClient?: AssistantActionClient;
  now?: () => number;
  createClientRequestId?: () => string;
  /** Generator for the per-action idempotency key minted at preview time;
   * defaults to `crypto.randomUUID()`. */
  createIdempotencyKey?: () => string;
  /** Poll cadence while a send is in flight. Default 3000ms. */
  activePollIntervalMs?: number;
  /** Poll cadence while idle (thread open, no send in flight). Default 15000ms. */
  idlePollIntervalMs?: number;
  /** Absolute age after which a pending send is marked stale. Default 90000ms. */
  staleAfterMs?: number;
  /** Whether the dock is currently visible; polling pauses when false. */
  visible?: () => boolean;
}

export interface AssistantDockController {
  readonly threads: AssistantThreadSummary[];
  readonly activeThreadId: string | null;
  readonly messages: AssistantMessage[];
  readonly pendingSends: AssistantPendingSend[];
  readonly surfaces: DataSurfaceIdentity[];
  readonly actions: Map<string, AssistantActionState>;
  readonly models: ModelOption[];
  readonly selectedModel: string | undefined;
  loadThreads(): Promise<void>;
  loadModels(): Promise<void>;
  setSelectedModel(modelId: string | undefined): void;
  openThread(threadId: string): Promise<void>;
  createThread(title: string): Promise<AssistantThreadSummary>;
  send(content: string, attachments?: AssistantAttachmentRef[]): Promise<void>;
  retry(clientRequestId: string): Promise<void>;
  previewAction(request: DataSurfaceActionRequest): Promise<void>;
  /** Applies the action using the idempotency key minted at preview time
   * (`AssistantActionState.idempotencyKey`) — never a fresh key per call. */
  applyAction(requestId: string): Promise<void>;
  rejectAction(requestId: string): void;
  startPolling(): void;
  stopPolling(): void;
  dispose(): void;
}

function defaultClientRequestId(threadId: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `assistant-message-${threadId}-${random}`;
}

// Mirrors the registry's own private `identityKey` tuple exactly
// (`packages/smrt-ui/src/components/data/data-surface.ts:501-507`, not
// exported so it can't be reused directly): kind + surfaceId + subject
// type/id, with an absent subject treated as a distinct third value (`null`)
// rather than collapsing into the same key as any subject-bearing identity.
// Dropping `subject` here (#2904 review F6) let a same-kind/same-surfaceId
// identity for a DIFFERENT subject (e.g. another tenant, site, or project
// instance) pass the mount gate — the client-side fail-closed scoping this
// component exists to provide.
function surfaceKey(identity: DataSurfaceIdentity): string {
  return JSON.stringify([
    identity.kind,
    identity.surfaceId,
    identity.subject ? [identity.subject.type, identity.subject.id] : null,
  ]);
}

export function createAssistantDockController(
  options: AssistantDockControllerOptions,
): AssistantDockController {
  const now = options.now ?? (() => Date.now());
  const activePollIntervalMs = options.activePollIntervalMs ?? 3_000;
  const idlePollIntervalMs = options.idlePollIntervalMs ?? 15_000;
  const staleAfterMs = options.staleAfterMs ?? 90_000;
  const isVisible = options.visible ?? (() => true);

  let threads = $state<AssistantThreadSummary[]>([]);
  let activeThreadId = $state<string | null>(null);
  let messages = $state<AssistantMessage[]>([]);
  let pendingSends = $state<AssistantPendingSend[]>([]);
  let surfaces = $state<DataSurfaceIdentity[]>(options.surfaces ?? []);
  let models = $state<ModelOption[]>([]);
  let selectedModel = $state<string | undefined>(undefined);
  // SvelteMap (not a plain Map) so `.set()` mutations are reactive to
  // template reads of `controller.actions`, matching Svelte 5's `$state`
  // proxy behavior for built-in objects it doesn't already deep-proxy.
  const actions = new SvelteMap<string, AssistantActionState>();

  // Cache of the in-flight/most-recent clientRequestId per (threadId, content)
  // draft — mirrors PortalChatTool.svelte:304-322 exactly: a resend of the
  // same unsent draft reuses the id instead of minting a new one.
  const draftIds = new Map<string, string>();
  function draftKey(threadId: string, content: string): string {
    return `${threadId}\n${content}`;
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeRegistry: (() => void) | null = null;
  // F3 (#2904 review): pollTick's loadMessages await can outlive dispose();
  // this flag lets it (and resetPollInterval) bail instead of re-arming a
  // timer past unmount.
  let disposed = false;

  function syncSurfacesFromRegistry() {
    if (options.surfaces) return; // explicit override wins; no live discovery
    surfaces = options.registry.list().map((descriptor) => descriptor.identity);
  }

  function isSurfaceMounted(identity: DataSurfaceIdentity): boolean {
    return surfaces.some((s) => surfaceKey(s) === surfaceKey(identity));
  }

  // F2 (#2904 review): a route change can unmount a surface between preview
  // and Confirm. Fail its outstanding preview closed rather than let a stale
  // Confirm reach applyAction.
  function invalidatePreviewedActionsFor(identity: DataSurfaceIdentity) {
    for (const [requestId, state] of actions) {
      if (
        surfaceKey(state.request.identity) === surfaceKey(identity) &&
        (state.status === 'previewed' || state.status === 'previewing')
      ) {
        actions.set(requestId, {
          ...state,
          status: 'failed',
          error: `AssistantDock: surface "${surfaceKey(identity)}" was unmounted before this action was applied`,
        });
      }
    }
  }

  // Initial sync + live updates as routes mount/unmount surfaces.
  syncSurfacesFromRegistry();
  if (!options.surfaces) {
    unsubscribeRegistry = options.registry.subscribe((event) => {
      if (event.type === 'registered' || event.type === 'unregistered') {
        syncSurfacesFromRegistry();
      }
      if (event.type === 'unregistered') {
        invalidatePreviewedActionsFor(event.identity);
      }
    });
  }

  function markStalePendingSends() {
    const cutoff = now() - staleAfterMs;
    pendingSends = pendingSends.map((p) =>
      p.status === 'processing' && p.sentAt < cutoff
        ? { ...p, status: 'stale' as const }
        : p,
    );
  }

  async function pollTick() {
    if (disposed || !isVisible() || !activeThreadId) return;
    markStalePendingSends();
    const threadId = activeThreadId;
    const fresh = await options.transport.loadMessages(threadId);
    // F3 (#2904 review): dispose() can run while this await is in flight —
    // bail before touching state or re-arming the interval.
    if (disposed) return;
    if (activeThreadId !== threadId) return; // thread switched mid-flight
    messages = fresh;
    const hasProcessing = pendingSends.some((p) => p.status === 'processing');
    resetPollInterval(hasProcessing);
    // Any pending send whose content now appears in the thread as a user
    // message followed by an assistant/tool reply is resolved.
    pendingSends = pendingSends.filter((p) => {
      const userIndex = messages.findIndex(
        (m) => m.role === 'user' && m.content === p.content,
      );
      if (userIndex < 0) return true;
      const resolved = messages
        .slice(userIndex + 1)
        .some((m) => m.role === 'assistant' || m.role === 'tool');
      // F5 (#2904 review): this is the terminal resolution for an
      // `inProgress` send that doSend() deliberately left the draft id
      // cached for — clear it now so a later resend of the same draft
      // mints a fresh id instead of reusing a long-resolved one.
      if (resolved) draftIds.delete(draftKey(p.threadId, p.content));
      return !resolved;
    });
  }

  function resetPollInterval(active: boolean) {
    if (pollTimer) clearInterval(pollTimer);
    if (disposed) {
      pollTimer = null;
      return;
    }
    pollTimer = setInterval(
      () => void pollTick(),
      active ? activePollIntervalMs : idlePollIntervalMs,
    );
  }

  function startPolling() {
    if (disposed || pollTimer) return;
    resetPollInterval(pendingSends.some((p) => p.status === 'processing'));
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function loadThreads() {
    threads = await options.transport.listThreads();
  }

  async function loadModels() {
    if (!options.transport.listModels) {
      models = [];
      return;
    }
    models = await options.transport.listModels();
    if (models.length > 0 && !selectedModel) {
      selectedModel = models[0].id;
    }
  }

  function setSelectedModel(modelId: string | undefined) {
    selectedModel = modelId;
  }

  async function openThread(threadId: string) {
    activeThreadId = threadId;
    messages = await options.transport.loadMessages(threadId);
  }

  async function createThread(title: string) {
    const thread = await options.transport.createThread(title);
    threads = [...threads, thread];
    return thread;
  }

  async function doSend(
    threadId: string,
    content: string,
    clientRequestId: string,
    attachments?: AssistantAttachmentRef[],
  ) {
    const existingIndex = pendingSends.findIndex(
      (p) => p.clientRequestId === clientRequestId,
    );
    const pending: AssistantPendingSend = {
      clientRequestId,
      threadId,
      content,
      status: 'sending',
      sentAt: now(),
      attachments,
    };
    pendingSends =
      existingIndex >= 0
        ? pendingSends.map((p, i) => (i === existingIndex ? pending : p))
        : [...pendingSends, pending];

    try {
      const result = await options.transport.sendMessage({
        threadId,
        content,
        attachments,
        clientRequestId,
        model: selectedModel,
      });
      if (result.inProgress) {
        // F5 (#2904 review): do NOT clear the draft id here — the turn is
        // still unresolved. Clearing it now would let a same-draft resend
        // during this window mint a fresh clientRequestId, defeating the
        // transport's dedup (mirrors PortalChatTool.svelte:304-322, which
        // only clears on terminal resolution). The id is cleared below, on
        // the poll-driven terminal transitions, and on error.
        pendingSends = pendingSends.map((p) =>
          p.clientRequestId === clientRequestId
            ? { ...p, status: 'processing' as const }
            : p,
        );
        startPolling();
        return;
      }
      draftIds.delete(draftKey(threadId, content));
      if (activeThreadId === threadId) {
        const toAppend = [result.userMessage, result.assistantMessage].filter(
          (m): m is AssistantMessage => Boolean(m),
        );
        const byId = new Map(messages.map((m) => [m.id, m]));
        for (const m of toAppend) byId.set(m.id, m);
        messages = Array.from(byId.values());
      }
      pendingSends = pendingSends.filter(
        (p) => p.clientRequestId !== clientRequestId,
      );
    } catch (error) {
      draftIds.delete(draftKey(threadId, content));
      pendingSends = pendingSends.map((p) =>
        p.clientRequestId === clientRequestId
          ? { ...p, status: 'failed' as const }
          : p,
      );
      throw error;
    }
  }

  async function send(content: string, attachments?: AssistantAttachmentRef[]) {
    if (!activeThreadId) {
      throw new Error('AssistantDock: send() called with no active thread');
    }
    const threadId = activeThreadId;
    const key = draftKey(threadId, content);
    let clientRequestId = draftIds.get(key);
    if (!clientRequestId) {
      clientRequestId =
        options.createClientRequestId?.() ?? defaultClientRequestId(threadId);
      draftIds.set(key, clientRequestId);
    }
    await doSend(threadId, content, clientRequestId, attachments);
  }

  async function retry(clientRequestId: string) {
    const pending = pendingSends.find(
      (p) => p.clientRequestId === clientRequestId,
    );
    if (!pending) return;
    await doSend(
      pending.threadId,
      pending.content,
      clientRequestId,
      pending.attachments,
    );
  }

  function actionKey(request: DataSurfaceActionRequest): string {
    return request.requestId;
  }

  function defaultIdempotencyKey(): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  }

  async function previewAction(request: DataSurfaceActionRequest) {
    // The idempotency key is minted HERE, once per proposed action, and
    // stored on the action state — never regenerated on a later apply/retry.
    // Binding decision #2904 (build phase 2): a fresh key per Confirm click
    // would defeat apply dedup when a retried click follows a timeout where
    // the server had actually already applied the first attempt.
    const idempotencyKey =
      options.createIdempotencyKey?.() ?? defaultIdempotencyKey();
    if (!isSurfaceMounted(request.identity)) {
      // Fail closed (binding decision #2904, item 5): a request targeting an
      // unmounted surface is rejected client-side before preview.
      actions.set(actionKey(request), {
        request,
        status: 'failed',
        error: `AssistantDock: surface "${surfaceKey(request.identity)}" is not mounted`,
        idempotencyKey,
      });
      return;
    }
    if (!options.actionClient) {
      throw new Error('AssistantDock: previewAction requires an actionClient');
    }
    const normalized = normalizeDataSurfaceActionRequest({
      ...request,
      phase: 'preview',
    });
    actions.set(actionKey(normalized), {
      request: normalized,
      status: 'previewing',
      idempotencyKey,
    });
    const result = await options.actionClient.preview(normalized);
    actions.set(actionKey(normalized), {
      request: normalized,
      status: result.ok ? 'previewed' : 'failed',
      previewResult: result,
      error: result.ok ? undefined : result.reason,
      idempotencyKey,
    });
  }

  async function applyAction(requestId: string) {
    const state = actions.get(requestId);
    if (!state) return;
    // F2 (#2904 review): re-check mount status at apply time, not only at
    // preview time — a route change between preview and Confirm can unmount
    // the surface, and previewAction's gate alone cannot catch that.
    if (!isSurfaceMounted(state.request.identity)) {
      actions.set(requestId, {
        ...state,
        status: 'failed',
        error: `AssistantDock: surface "${surfaceKey(state.request.identity)}" is not mounted`,
      });
      return;
    }
    if (!options.actionClient) {
      throw new Error('AssistantDock: applyAction requires an actionClient');
    }
    // idempotencyKey is distinct from send's clientRequestId (binding
    // decision #2904) and is carried on the wire request
    // (`DataSurfaceActionWireRequest.idempotencyKey`,
    // `packages/types/src/data-surface.ts:274`) by the host's actionClient
    // implementation; the client-facing `DataSurfaceActionRequest` itself
    // has no idempotency field, only `confirmationToken` from the preview.
    // Reuses `state.idempotencyKey`, minted once in `previewAction` — a
    // retried apply (e.g. after a client-side timeout) replays against the
    // same key instead of re-executing.
    const applyRequest = normalizeDataSurfaceActionRequest({
      ...state.request,
      phase: 'apply',
      // Only set when defined: an explicit `confirmationToken: undefined`
      // key fails normalizeDataSurfaceActionRequest's JSON-safety check for
      // an action whose preview didn't require confirmation.
      ...(state.previewResult?.confirmationToken
        ? { confirmationToken: state.previewResult.confirmationToken }
        : {}),
    });
    actions.set(requestId, {
      ...state,
      request: applyRequest,
      status: 'applying',
    });
    const result = await options.actionClient.apply(
      applyRequest,
      state.idempotencyKey,
    );
    actions.set(requestId, {
      ...state,
      request: applyRequest,
      status: result.ok ? 'applied' : 'failed',
      applyResult: result,
      error: result.ok ? undefined : result.reason,
    });
  }

  function rejectAction(requestId: string) {
    actions.delete(requestId);
  }

  function dispose() {
    // Idempotent (#2904 review F1/F3): safe to call more than once — a
    // second dispose() (or one racing an in-flight pollTick) must not
    // re-arm the timer or double-unsubscribe.
    if (disposed) return;
    disposed = true;
    stopPolling();
    unsubscribeRegistry?.();
    unsubscribeRegistry = null;
  }

  return {
    get threads() {
      return threads;
    },
    get activeThreadId() {
      return activeThreadId;
    },
    get messages() {
      return messages;
    },
    get pendingSends() {
      return pendingSends;
    },
    get surfaces() {
      return surfaces;
    },
    get actions() {
      return actions;
    },
    get models() {
      return models;
    },
    get selectedModel() {
      return selectedModel;
    },
    loadThreads,
    loadModels,
    setSelectedModel,
    openThread,
    createThread,
    send,
    retry,
    previewAction,
    applyAction,
    rejectAction,
    startPolling,
    stopPolling,
    dispose,
  };
}
