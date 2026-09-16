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
  /** Explicit surface narrowing filter (design decision #2904: `AssistantDock`
   * accepts `registry` plus an optional `surfaces` override rather than only
   * ever trusting live discovery). When set, only identities present in
   * BOTH this list and `registry.list()` are ever mounted (Copilot PR #2919
   * jAwr0) — an override entry that isn't genuinely registered is never
   * treated as mounted. */
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
   * different instance and, if so, re-subscribes, resyncs `surfaces`
   * (#2904 review finding B), and clears/reloads conversation state
   * (threads, activeThreadId, messages, pendingSends, actions, error,
   * draftIds — Copilot PR #2919 jAwsd). A no-op when unchanged. Call from a
   * `registry`-scoped effect, never from the mount effect (see
   * AssistantDock.svelte — F1 requires that one to run exactly once). */
  syncRegistry(): void;
  /** Re-reads the `surfaces` override getter (and falls back to the live
   * registry contents when unset) and invalidates outstanding previews for
   * any surface that fell out of scope on a narrowing change (#2904 review,
   * cycle-2 second final finding 1). A no-op when the effective set is
   * unchanged. Call from a `surfaces`-scoped effect, never from the mount
   * effect (see AssistantDock.svelte — F1 requires that one to run exactly
   * once). */
  syncSurfaces(): void;
  /** Re-checks whether the host has reassigned the `transport` prop to a
   * different instance and, if so, clears conversation state (threads,
   * activeThreadId, messages, pendingSends, actions, error, draftIds) and
   * reloads threads/models from the new transport (Copilot PR #2919 jAwsd —
   * mirrors `syncRegistry()`'s reset for the identical class of stale-context
   * bug). A no-op when unchanged. Call from a `transport`-scoped effect,
   * never from the mount effect (see AssistantDock.svelte — F1 requires that
   * one to run exactly once). */
  syncTransport(): void;
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

  // Cache of the in-flight/most-recent clientRequestId per (threadId,
  // content, attachments) draft — mirrors PortalChatTool.svelte:304-322: a
  // resend of the same unsent draft reuses the id instead of minting a new
  // one. Copilot PR #2919 jAwwB: the key was previously (threadId, content)
  // only, even though attachments are part of the send input — after an
  // in-progress send('same text', [A]) cleared the composer, a second send
  // with [B] before polling resolved reused the FIRST clientRequestId, and a
  // deduplicating transport returned the first request's cached result,
  // silently dropping attachment B. Attachment identity (id, falling back to
  // url then name) is now part of the key, sorted so the same SET of
  // attachments (regardless of staging order) still binds to one key —
  // retries of the exact same draft (same text AND same attachments) still
  // reuse it.
  const draftIds = new Map<string, string>();
  function draftKey(
    threadId: string,
    content: string,
    attachments?: AssistantAttachmentRef[],
  ): string {
    const attachmentIdentity = (attachments ?? [])
      .map((a) => a.id || a.url || a.name)
      .sort()
      .join(' ');
    return `${threadId}\n${content}\n${attachmentIdentity}`;
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
  // Copilot PR #2919 jAwsd: the transport isn't subscribed to like the
  // registry, but a host CAN reassign it (it's a getter, same as `registry`)
  // — `subscribedTransport` is the instance last seen, so `syncTransport()`
  // (below) can detect a swap the same way `syncRegistry()` detects a
  // registry swap.
  let subscribedTransport: AssistantTransport | null = null;
  // F3 (#2904 review): pollTick's loadMessages await can outlive dispose();
  // this flag lets it (and resetPollInterval) bail instead of re-arming a
  // timer past unmount.
  let disposed = false;
  // Cycle-2 second final finding 2: tracks whether the CURRENT value of
  // `error` was set by pollTick itself, so a failing poll records the
  // failure once (not once per tick — `setInterval` would otherwise spam an
  // identical assignment every 3-15s) and pollTick clears only an error it
  // owns on the next successful poll, rather than clobbering an unrelated
  // failure (e.g. a send or thread-open error) that hasn't been resolved.
  let pollErrorActive = false;
  // Cycle-3 first final finding 2: `stopPolling()` only cleared the timer —
  // it never recorded that polling was explicitly stopped. A tick's
  // `loadMessages` await can still be in flight when `stopPolling()` runs;
  // its post-await `resetPollInterval(...)` call then immediately re-arms a
  // NEW timer, undoing the stop. This flag is the `stopPolling()` analogue
  // of `disposed` for that same in-flight-await race — set by
  // `stopPolling()`, cleared by `startPolling()`.
  let pollingStopped = false;
  // Cycle-3 first final sweep: monotonic counter guarding openThread()'s
  // post-await write — see openThread() below.
  let openThreadRequestId = 0;

  // Cycle-2 second final finding 1: `options.surfaces` is a getter (a live
  // prop passthrough from AssistantDock.svelte), so it must be RE-READ on
  // every call, not captured once. Previously this function early-returned
  // whenever an override was present at construction time, which froze
  // `surfaces` at whatever `options.surfaces` first returned and also
  // suppressed all future registry-driven resyncs — a host reassigning the
  // `surfaces` prop (exactly what docs/assistant-dock.md's "Tenant scoping"
  // recipe describes) was never observed, and neither was the
  // override→registry (undefined) transition.
  // Copilot PR #2919 jAwr0: `options.surfaces` previously REPLACED
  // `registry.list()` wholesale, so an override identity that was never
  // genuinely registered still passed `isSurfaceMounted` — an override
  // could make an unmounted (or entirely fictitious) surface "appear"
  // mounted while the live registry had nothing, breaking the documented
  // fail-closed route scoping. The override is now a NARROWING filter: only
  // identities present in BOTH the override and the live registry are ever
  // mounted.
  function syncSurfacesFromRegistry() {
    const liveIdentities = options.registry
      .list()
      .map((descriptor) => descriptor.identity);
    if (!options.surfaces) {
      surfaces = liveIdentities;
      return;
    }
    const liveKeys = new Set(
      liveIdentities.map((identity) => surfaceKey(identity)),
    );
    surfaces = options.surfaces.filter((identity) =>
      liveKeys.has(surfaceKey(identity)),
    );
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
  // taken under the old one must never be confirmable against it. Copilot PR
  // #2919 jAwsd: superseded by `resetConversationStateForContextSwap()`'s
  // `actions.clear()` (called from `syncRegistry()`), which drops every
  // action entry outright rather than marking it 'failed' — removed as dead
  // code.

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

  // Copilot PR #2919 jAwsd: a registry (or transport) swap is documented as
  // covering tenant/workspace changes, but previously only invalidated
  // action previews and resynced `surfaces` — it left `threads`,
  // `activeThreadId`, `messages`, and pending sends from the OLD context in
  // place, so the mounted dock could go on displaying the previous tenant's
  // conversation after a context swap, and an old in-flight `loadMessages`
  // could still write it back. Called from both `syncRegistry()` and
  // `syncTransport()` below on an actual swap: clears every piece of
  // conversation state and reloads threads/models from the (now-current)
  // transport. Bumping `openThreadRequestId` here reuses `openThread()`'s
  // own "most recently started call wins" guard to drop an in-flight load
  // that was still in flight under the old context.
  function resetConversationStateForContextSwap() {
    threads = [];
    activeThreadId = null;
    messages = [];
    pendingSends = [];
    actions.clear();
    error = null;
    draftIds.clear();
    openThreadRequestId += 1;
    void loadThreads();
    void loadModels();
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
    if (disposed) return;
    const current = options.registry;
    if (current === subscribedRegistry) return;
    // Only reached on an actual swap: the constructor sets
    // `subscribedRegistry` directly (bypassing this function), so every call
    // that gets here past the guard above is a genuine registry change. The
    // subscription is kept live even while `surfaces` is overridden (cycle-2
    // second final finding 1) so a later override→registry transition has a
    // subscription already in place instead of needing its own bootstrap.
    unsubscribeRegistry?.();
    subscribedRegistry = current;
    unsubscribeRegistry = subscribeToRegistry(current);
    // Copilot PR #2919 jAwsd: `invalidateAllPreviewedActions` is now
    // superseded by `resetConversationStateForContextSwap`'s `actions.clear()`
    // below — every action entry is dropped outright on a registry swap, not
    // just marked 'failed'.
    syncSurfacesFromRegistry();
    resetConversationStateForContextSwap();
  }

  // Copilot PR #2919 jAwsd: the transport counterpart of `syncRegistry()` —
  // a host can reassign the `transport` prop too (e.g. switching tenant
  // context via both a new registry AND a new transport instance), and that
  // swap needs the identical conversation-state reset. `AssistantDock.svelte`
  // calls this from a `transport`-scoped effect, mirroring the `registry`
  // one. A no-op when the transport hasn't changed.
  function syncTransport() {
    if (disposed) return;
    const current = options.transport;
    if (current === subscribedTransport) return;
    subscribedTransport = current;
    resetConversationStateForContextSwap();
  }

  // Cycle-2 second final finding 1: re-reads the `surfaces` getter (and, when
  // unset, the registry) and, on a narrowing change, invalidates outstanding
  // previews for any surface that fell out of scope — mirrors
  // `invalidateAllPreviewedActions`'s rationale for a registry swap, but
  // scoped per-identity since an override change doesn't necessarily change
  // the trust boundary for surfaces that remain mounted. Call from a
  // `surfaces`-scoped effect (see AssistantDock.svelte), never from the mount
  // effect (F1 requires that one to run exactly once).
  function syncSurfaces() {
    if (disposed) return;
    const previous = surfaces;
    syncSurfacesFromRegistry();
    for (const identity of previous) {
      if (!isSurfaceMounted(identity)) {
        invalidatePreviewedActionsFor(identity);
      }
    }
  }

  // Initial sync + subscription. The registry subscription is unconditional
  // (cycle-2 second final finding 1) so it's already live for a later
  // override→registry (undefined) transition.
  syncSurfacesFromRegistry();
  subscribedRegistry = options.registry;
  unsubscribeRegistry = subscribeToRegistry(subscribedRegistry);
  // Copilot PR #2919 jAwsd: records the transport instance seen at
  // construction so `syncTransport()` only resets conversation state on an
  // ACTUAL later swap, not on this initial bind.
  subscribedTransport = options.transport;

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
    // Cycle-2 second final finding 2: `setInterval(() => void pollTick(), …)`
    // means an unhandled rejection here previously fired once per poll
    // interval, indefinitely, with the dock rendering a normal-looking, just
    // stale conversation. Catch and record on `error` instead.
    let fresh: AssistantMessage[];
    try {
      fresh = await options.transport.loadMessages(threadId);
    } catch (err) {
      // F3 (#2904 review): dispose() can run while this await is in flight.
      if (disposed) return;
      if (!pollErrorActive) {
        pollErrorActive = true;
        error = err instanceof Error ? err.message : String(err);
      }
      return;
    }
    // F3 (#2904 review): dispose() can run while this await is in flight —
    // bail before touching state or re-arming the interval. Cycle-3 first
    // final finding 2: an explicit stopPolling() call is the same race —
    // resetPollInterval() below would otherwise re-arm a timer the host just
    // asked to stop.
    if (disposed || pollingStopped) return;
    if (activeThreadId !== threadId) return; // thread switched mid-flight
    if (pollErrorActive) {
      pollErrorActive = false;
      error = null;
    }
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
      if (resolved)
        draftIds.delete(draftKey(p.threadId, p.content, p.attachments));
      return !resolved;
    });
  }

  function resetPollInterval(active: boolean) {
    if (pollTimer) clearInterval(pollTimer);
    // Cycle-3 first final finding 2: bail on `pollingStopped` exactly as on
    // `disposed` — this is the same guard `pollTick`'s post-await call site
    // above relies on, kept here too so any other caller of
    // `resetPollInterval` gets the same protection.
    if (disposed || pollingStopped) {
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
    pollingStopped = false;
    resetPollInterval(pendingSends.some((p) => p.status === 'processing'));
  }

  // Cycle-3 first final finding 2: sets `pollingStopped` (cleared by
  // `startPolling()`) so an in-flight `pollTick()` await that resolves AFTER
  // this call cannot undo it by re-arming a new timer via
  // `resetPollInterval()` — the same in-flight-await race `dispose()`
  // already closed via `disposed`.
  function stopPolling() {
    pollingStopped = true;
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
      const fresh = await options.transport.listThreads();
      // Cycle-3 first final sweep: dispose() can run while this await is in
      // flight — bail before writing state on a torn-down controller, same
      // "still current" discipline pollTick/openThread apply.
      if (disposed) return;
      threads = fresh;
      error = null;
    } catch (err) {
      if (disposed) return;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function loadModels() {
    if (!options.transport.listModels) {
      models = [];
      return;
    }
    let fresh: ModelOption[];
    try {
      fresh = await options.transport.listModels();
    } catch (err) {
      // Cycle-3 first final sweep: same disposed re-check as loadThreads.
      if (disposed) return;
      error = err instanceof Error ? err.message : String(err);
      return;
    }
    if (disposed) return;
    models = fresh;
    if (models.length > 0 && !selectedModel) {
      selectedModel = models[0].id;
    }
  }

  function setSelectedModel(modelId: string | undefined) {
    selectedModel = modelId;
  }

  // Cycle-2 second final finding 2: previously set `activeThreadId` BEFORE
  // the await, so a rejecting `loadMessages` left the previous thread's
  // messages rendered under the NEW thread id (composer enabled, sends
  // routed to the new thread) while also escaping as an unhandled promise
  // rejection from every un-awaited call site (AssistantThreadList's
  // fire-and-forget `onclick`). Now: `activeThreadId` only advances on
  // success, and any failure is caught and recorded on `error` rather than
  // thrown.
  async function openThread(threadId: string) {
    // Cycle-3 first final sweep: without this, two overlapping openThread()
    // calls (e.g. a fast double-click on two different threads) race —
    // whichever loadMessages() resolves LAST wins regardless of which was
    // started last, so an older, slower request can stomp the newer one's
    // activeThreadId/messages after the user has already moved on. Only the
    // most recently STARTED call may write.
    const requestId = ++openThreadRequestId;
    try {
      const fresh = await options.transport.loadMessages(threadId);
      if (disposed || requestId !== openThreadRequestId) return;
      activeThreadId = threadId;
      messages = fresh;
      error = null;
    } catch (err) {
      if (disposed || requestId !== openThreadRequestId) return;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // Cycle-2 second final finding 2: records a failure on `error` (mirroring
  // loadThreads/loadModels) in addition to rethrowing — createThread's
  // return value is load-bearing for its callers (AssistantDock.svelte
  // chains `openThread(thread.id)` on it), so it keeps throwing; the
  // rethrow is what AssistantDock's `handleCreateThread` catches to stop the
  // un-awaited onclick from producing an unhandled rejection.
  async function createThread(title: string) {
    try {
      const thread = await options.transport.createThread(title);
      // Cycle-3 first final sweep: dispose() can run while this await is in
      // flight. The return value stays load-bearing for the caller (see the
      // comment above) even on a disposed controller, so this only skips
      // the STATE writes, not the return.
      if (!disposed) {
        threads = [...threads, thread];
        error = null;
      }
      return thread;
    } catch (err) {
      if (!disposed) {
        error = err instanceof Error ? err.message : String(err);
      }
      throw err;
    }
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
      // Cycle-3 first final sweep: dispose() can run while sendMessage() is
      // in flight — bail before any of the writes below run on a torn-down
      // controller. draftIds is a plain (non-reactive) Map so clearing it is
      // harmless either way, but it's skipped too for a clean, single bail
      // point.
      if (disposed) return;
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
      draftIds.delete(draftKey(threadId, content, attachments));
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
      draftIds.delete(draftKey(threadId, content, attachments));
      // Cycle-3 first final sweep: same disposed re-check as the success
      // branch above; the throw below still needs to happen regardless (the
      // pending send's own 'failed' status is best-effort UI polish, not
      // load-bearing for the caller's control flow).
      if (!disposed) {
        pendingSends = pendingSends.map((p) =>
          p.clientRequestId === clientRequestId
            ? { ...p, status: 'failed' as const }
            : p,
        );
      }
      throw error;
    }
  }

  async function send(content: string, attachments?: AssistantAttachmentRef[]) {
    if (!activeThreadId) {
      throw new Error('AssistantDock: send() called with no active thread');
    }
    const threadId = activeThreadId;
    const key = draftKey(threadId, content, attachments);
    let clientRequestId = draftIds.get(key);
    if (!clientRequestId) {
      clientRequestId =
        options.createClientRequestId?.() ?? defaultClientRequestId(threadId);
      draftIds.set(key, clientRequestId);
    }
    await doSend(threadId, content, clientRequestId, attachments);
  }

  // Cycle-2 second final finding 2: AssistantDock.svelte's Retry buttons call
  // this from an un-awaited `onclick`, so a rejection here was previously
  // unhandled. `doSend` already writes the pending send's `'failed'` status
  // before rethrowing — that terminal UI state is preserved — but the reject
  // must be caught here too so it never escapes as an unhandled promise
  // rejection; also record it on `error` so a retry failure gets the same
  // dock-level banner as a first-attempt send failure.
  async function retry(clientRequestId: string) {
    const pending = pendingSends.find(
      (p) => p.clientRequestId === clientRequestId,
    );
    if (!pending) return;
    try {
      await doSend(
        pending.threadId,
        pending.content,
        clientRequestId,
        pending.attachments,
      );
      // Cycle-3 first final sweep: dispose() can run while doSend() is in
      // flight — bail before writing `error` on a torn-down controller.
      if (disposed) return;
      error = null;
    } catch (err) {
      if (disposed) return;
      error = err instanceof Error ? err.message : String(err);
    }
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
    let normalized: DataSurfaceActionRequest;
    try {
      if (!options.actionClient) {
        throw new Error(
          'AssistantDock: previewAction requires an actionClient',
        );
      }
      normalized = normalizeDataSurfaceActionRequest({
        ...request,
        phase: 'preview',
      });
    } catch (error) {
      // Synchronous failure (missing actionClient, or normalize rejecting a
      // malformed proposal) — NOTHING has awaited yet, so there is no race
      // window an invalidation could have landed in. Write unconditionally,
      // same as before cycle-3 first final finding 1.
      actions.set(actionKey(request), {
        request,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        idempotencyKey,
      });
      return;
    }
    actions.set(actionKey(normalized), {
      request: normalized,
      status: 'previewing',
      idempotencyKey,
    });
    // Finding 2 (#2904 review, fresh cycle): actionClient.preview is
    // documented as "an authenticated HTTP call to a server route" — i.e. it
    // rejects on any network error/5xx. Every path below must reach a
    // terminal status.
    let result: DataSurfaceActionResult;
    try {
      result = await options.actionClient.preview(normalized);
    } catch (error) {
      // Cycle-3 first final finding 1: re-read the CURRENT entry, not the
      // pre-await snapshot — an invalidation (registry 'unregistered', a
      // narrowing `syncSurfaces()`, a registry swap via `syncRegistry()`) or
      // an explicit `rejectAction()` can land while this preview was in
      // flight and already moved the entry to a terminal 'failed' state (or
      // deleted it). Writing back unconditionally here would resurrect a
      // fail-closed preview as confirmable, or restore an entry the user
      // explicitly rejected — the exact class of bug the identical guard on
      // applyAction's post-await write (below) already closed. Only write
      // when the entry still exists, is still 'previewing', and carries the
      // SAME idempotencyKey (a fresh previewAction() call racing this one
      // for the same request id would mint a new key, meaning this result
      // belongs to a superseded attempt).
      const current = actions.get(actionKey(normalized));
      if (
        current &&
        current.status === 'previewing' &&
        current.idempotencyKey === idempotencyKey
      ) {
        actions.set(actionKey(normalized), {
          request: normalized,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          idempotencyKey,
        });
      }
      return;
    }
    // Cycle-3 first final finding 1: same re-check as the catch branch above.
    const current = actions.get(actionKey(normalized));
    if (
      current &&
      current.status === 'previewing' &&
      current.idempotencyKey === idempotencyKey
    ) {
      actions.set(actionKey(normalized), {
        request: normalized,
        status: result.ok ? 'previewed' : 'failed',
        previewResult: result,
        error: result.ok ? undefined : result.reason,
        idempotencyKey,
      });
    }
  }

  async function applyAction(requestId: string) {
    const state = actions.get(requestId);
    if (!state) return;
    // Finding 3 (#2904 review, fresh cycle): refuse a second concurrent
    // apply for the same request — Confirm/Reject were previously still
    // live (and clickable) while an apply was already in flight. Silent
    // no-op (not an error): a duplicate click while genuinely busy, not a
    // caller mistake.
    if (state.status === 'applying') return;
    // Copilot PR #2919 jAwwg: this guard previously only blocked a second
    // CONCURRENT apply — 'previewing', 'applied', and 'failed' (from ANY
    // phase, including a preview-time failure that never reached apply)
    // were all still accepted here, so a failed preview (`ok: false`)
    // remained callable through the public headless controller without a
    // successful preview/confirmation, and an already-applied action could
    // be replayed outside the intended retry path. Permit only a genuinely
    // `previewed` action, or a `failed` action whose most recent attempt
    // was already in the APPLY phase (`state.request.phase === 'apply'`,
    // set by `previewAction`'s `normalizeDataSurfaceActionRequest` for a
    // preview-phase entry and re-set below for an apply-phase one) — i.e. an
    // apply retry after a transient failure, never a preview-phase failure.
    const isApplyPhaseRetry =
      state.status === 'failed' && state.request.phase === 'apply';
    if (state.status !== 'previewed' && !isApplyPhaseRetry) {
      actions.set(requestId, {
        ...state,
        status: 'failed',
        error:
          `AssistantDock: applyAction refused — action "${requestId}" is ` +
          `"${state.status}"${
            state.status === 'failed' ? ' from an unsuccessful preview' : ''
          }, not a confirmed preview or a retryable apply failure.`,
      });
      return;
    }
    // F2 (#2904 review): re-check mount status at apply time, not only at
    // preview time — a route change between preview and Confirm can unmount
    // the surface, and previewAction's gate alone cannot catch that.
    if (!isSurfaceMounted(state.request.identity)) {
      actions.set(requestId, {
        ...state,
        // Copilot PR #2919 jAwwg: mark this failure as an APPLY-phase one
        // (the user had a valid preview and clicked Confirm) so a retry
        // after the surface remounts is permitted by the guard above.
        request: { ...state.request, phase: 'apply' },
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
    syncSurfaces,
    syncTransport,
    dispose,
  };
}
