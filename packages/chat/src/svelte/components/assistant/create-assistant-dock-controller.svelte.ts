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
  /** A background failure (e.g. a failed `loadThreads`/`loadModels` call the
   * mount effect couldn't surface any other way) for the dock to render
   * (#2904 review finding 4). `null` when nothing is wrong. Set via
   * `setError`; a host or the dock's own `handleSend` can also report a
   * failure here. */
  readonly error: string | null;
  /** Records (or clears, with `null`) a background failure for `error` to
   * report. Distinct from a failed `AssistantPendingSend`/`AssistantActionState`,
   * which already carry their own `error` field — this is for failures with
   * no narrower place to live (a failed `loadThreads`/`loadModels`, or a
   * `send()` rejection AssistantDock's `handleSend` wants surfaced at the
   * dock level in addition to the pending send's own `'failed'` status). */
  setError(message: string | null): void;
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
  /** Re-checks whether the host has reassigned the `registry` prop to a
   * different instance and, if so, re-subscribes and resyncs `surfaces`
   * (#2904 review finding B). A no-op when unchanged. Call from a
   * `registry`-scoped effect, never from the mount effect (see
   * AssistantDock.svelte — F1 requires that one to run exactly once). */
  syncRegistry(): void;
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
  let error = $state<string | null>(null);

  function setError(message: string | null) {
    error = message;
  }
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
  // Finding B (#2904 review, third final pass): the registry SUBSCRIPTION
  // used to bind once, at construction, to whatever `options.registry`
  // happened to be at that instant — even though `options.registry` is a
  // getter and AssistantDock.svelte documents that reassigning the prop is
  // observed. `subscribedRegistry` is the instance we're CURRENTLY
  // subscribed to, so `syncRegistry()` (below) can detect a swap.
  let subscribedRegistry: DataSurfaceRegistry | null = null;
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

  // Finding B: a whole-registry swap (e.g. a host switching tenant/workspace
  // context) invalidates every outstanding preview, not just one surface's —
  // the new registry instance is a different trust boundary, so a preview
  // taken under the old one must never be confirmable against it.
  function invalidateAllPreviewedActions(reason: string) {
    for (const [requestId, state] of actions) {
      if (state.status === 'previewed' || state.status === 'previewing') {
        actions.set(requestId, { ...state, status: 'failed', error: reason });
      }
    }
  }

  function subscribeToRegistry(registry: DataSurfaceRegistry) {
    return registry.subscribe((event) => {
      if (event.type === 'registered' || event.type === 'unregistered') {
        syncSurfacesFromRegistry();
      }
      if (event.type === 'unregistered') {
        invalidatePreviewedActionsFor(event.identity);
      }
    });
  }

  // Finding B: re-checks whether `options.registry` (the getter) now returns
  // a DIFFERENT instance than the one we're subscribed to, and if so,
  // unsubscribes the old one, subscribes the new one, invalidates every
  // outstanding preview (they were taken under the old registry's trust
  // boundary), and resyncs `surfaces` from the new instance. A no-op when
  // the registry hasn't changed. Called once at construction and again by
  // the host's own `registry`-scoped effect (see AssistantDock.svelte) —
  // never from inside the mount effect that must run exactly once (F1).
  function syncRegistry() {
    if (options.surfaces) return; // explicit override wins; no subscription
    if (disposed) return;
    const current = options.registry;
    if (current === subscribedRegistry) return;
    // Only reached on an actual swap: the constructor sets
    // `subscribedRegistry` directly (bypassing this function), so every call
    // that gets here past the guard above is a genuine registry change.
    unsubscribeRegistry?.();
    subscribedRegistry = current;
    unsubscribeRegistry = subscribeToRegistry(current);
    invalidateAllPreviewedActions(
      'AssistantDock: the registry changed — this preview was taken under a previous context',
    );
    syncSurfacesFromRegistry();
  }

  // Initial sync + subscription.
  syncSurfacesFromRegistry();
  if (!options.surfaces) {
    subscribedRegistry = options.registry;
    unsubscribeRegistry = subscribeToRegistry(subscribedRegistry);
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
    // A pending send is resolved once its message appears in the thread
    // followed by an assistant/tool reply (#2904 review finding A):
    //  - scoped to `p.threadId === threadId` — `messages` only ever holds
    //    the CURRENTLY POLLED thread, but `pendingSends` can carry entries
    //    for other threads the user has since switched away from; matching
    //    across all of them let another thread's unrelated reply resolve
    //    this one.
    //  - id-first: if the transport echoed `clientRequestId` on the
    //    persisted message (assistant-transport.ts), match by that —
    //    unambiguous even when the same text is sent twice in one thread.
    //  - content fallback uses the LAST occurrence (not the first), so an
    //    earlier already-answered repeat of the same text (e.g. "yes") can
    //    never be mistaken for this send's own reply.
    pendingSends = pendingSends.filter((p) => {
      if (p.threadId !== threadId) return true;
      const byId = p.clientRequestId
        ? messages.findIndex(
            (m) => m.role === 'user' && m.clientRequestId === p.clientRequestId,
          )
        : -1;
      const userIndex =
        byId >= 0
          ? byId
          : messages.findLastIndex(
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

  // Finding 4 (#2904 review, fresh cycle): loadThreads/loadModels are fired
  // as `void controller.loadThreads()` from AssistantDock's mount effect —
  // an unhandled rejection there previously escaped silently (an empty,
  // explanation-free thread list, no error surfaced anywhere). Both now
  // catch and record the failure on `error` rather than throwing; the
  // effect's own call sites additionally forward to `setError` so the
  // dock's rendered message stays in sync even if a future caller catches
  // and reports the rejection itself (see AssistantDock.svelte).
  async function loadThreads() {
    try {
      threads = await options.transport.listThreads();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function loadModels() {
    if (!options.transport.listModels) {
      models = [];
      return;
    }
    try {
      models = await options.transport.listModels();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return;
    }
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
    // Finding 2 (#2904 review, fresh cycle): normalizeDataSurfaceActionRequest
    // can throw (e.g. a malformed proposal) and actionClient.preview is
    // documented as "an authenticated HTTP call to a server route" — i.e. it
    // rejects on any network error/5xx. Neither was previously caught, so a
    // throw/reject here left the entry stuck at 'previewing' (ToolCallDisplay
    // kept rendering live Confirm/Reject with no error) AND escaped as an
    // unhandled promise rejection. Every path below must reach a terminal
    // status.
    try {
      if (!options.actionClient) {
        throw new Error(
          'AssistantDock: previewAction requires an actionClient',
        );
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
    } catch (error) {
      actions.set(actionKey(request), {
        request,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        idempotencyKey,
      });
    }
  }

  async function applyAction(requestId: string) {
    const state = actions.get(requestId);
    if (!state) return;
    // Finding 3 (#2904 review, fresh cycle): refuse a second concurrent
    // apply for the same request — Confirm/Reject were previously still
    // live (and clickable) while an apply was already in flight.
    if (state.status === 'applying') return;
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
    // Finding 2 (#2904 review, fresh cycle): same rationale as previewAction
    // above — normalize can throw and actionClient.apply can reject; neither
    // was caught, leaving the entry stuck at 'applying' (Confirm/Reject
    // still rendered, no error shown) and an unhandled promise rejection.
    try {
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
      // Finding 3 (#2904 review, fresh cycle): re-read the CURRENT entry,
      // not the pre-await `state` snapshot — a Reject click during this
      // await deletes the entry (rejectAction), and writing back the stale
      // snapshot here would resurrect it as 'applied' even though the user
      // explicitly rejected it, silently overriding that decision (and
      // clobbering any other concurrent transition for this request id).
      // If the entry is gone or no longer 'applying', drop the write.
      const current = actions.get(requestId);
      if (current && current.status === 'applying') {
        actions.set(requestId, {
          ...current,
          request: applyRequest,
          status: result.ok ? 'applied' : 'failed',
          applyResult: result,
          error: result.ok ? undefined : result.reason,
        });
      } else if (!current && result.ok) {
        // The user rejected while this apply was in flight, and the server
        // mutation landed anyway — the rejection cannot undo a real server
        // effect. Surface that as a system message in the thread rather
        // than silently dropping it, so the user isn't left unaware their
        // rejected action still happened.
        if (activeThreadId) {
          messages = [
            ...messages,
            {
              id: `applied-after-reject-${requestId}`,
              threadId: activeThreadId,
              content: `The action "${applyRequest.actionId}" you rejected was already applied by the server before the rejection took effect.`,
              role: 'system',
              createdAt: new Date(now()),
            },
          ];
        }
      }
    } catch (error) {
      const current = actions.get(requestId);
      if (current && current.status === 'applying') {
        actions.set(requestId, {
          ...current,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
    get error() {
      return error;
    },
    setError,
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
    syncRegistry,
    dispose,
  };
}
