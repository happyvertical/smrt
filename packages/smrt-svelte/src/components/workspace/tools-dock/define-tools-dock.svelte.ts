/**
 * defineToolsDock - factory for the ToolsDock API
 *
 * Creates a reactive {@link ToolsDockApi} instance backed by Svelte 5 runes
 * (`$state`) and registers it in Svelte context under {@link TOOLS_DOCK_KEY}.
 * Inside a `<ToolsDock>` provider tree, descendants (tools, deep panels,
 * arbitrary consumers) read the same instance via {@link useToolsDock}.
 *
 * The dock is intentionally domain-agnostic:
 *   - Tool IDs are arbitrary strings (no enum).
 *   - Availability is controlled via the optional `fetchAvailability` callback;
 *     when omitted, every registered tool is available.
 *   - Persistence is opt-in via `storageKey` and is SSR-safe.
 *   - Inter-tool messaging happens through a typed pub/sub bus (`emit`/`on`)
 *     in lieu of `window.dispatchEvent` patterns from older portals.
 *
 * @example Register a dock and a tool
 * ```ts
 * // somewhere in a +layout.svelte:
 * import { defineToolsDock } from '@happyvertical/smrt-svelte/workspace';
 * import ChatTool from './ChatTool.svelte';
 *
 * const dock = defineToolsDock({
 *   tools: [{ id: 'chat', label: 'Chat', component: ChatTool }],
 *   storageKey: 'app-name:tools-dock:v1',
 * });
 * ```
 *
 * @remarks ModuleUIRegistry integration point
 *
 * Consumer apps that want tools to come from `@happyvertical/smrt-*` module
 * packages (commerce, content, etc.) can populate `options.tools` from the
 * `ModuleUIRegistry` (see {@link ../../../registry/module-registry}) — e.g.
 * by walking `ModuleUIRegistry.getModules()` and pulling components from a
 * conventional slot id like `'tools-dock'`. This is left to consumers so the
 * dock has zero coupling to the registry; the surface area exposed here
 * (`ToolDef[]`) is what such an adapter would produce.
 */

import { setContext, untrack } from 'svelte';
import type {
  AvailableTool,
  ToolDef,
  ToolsDockApi,
  ToolsDockContext,
  ToolsDockEvents,
} from '../types.js';

/**
 * Svelte context key for the active ToolsDock API instance.
 */
export const TOOLS_DOCK_KEY = Symbol('smrt-tools-dock');

/**
 * Options accepted by {@link defineToolsDock}.
 *
 * `TData` types the shape of `context.data` passed through `setContext()` /
 * `fetchAvailability` — narrow it at the factory site to get a typed
 * `ctx.data` inside the availability callback without manual casts.
 * Defaults to `Record<string, unknown>` so existing callers keep compiling.
 *
 * `TActions` types the shape of `context.actions` and flows the same way.
 * Defaults to `Record<string, (...args: any[]) => unknown>` so the untyped
 * `dock.setContext({ actions: { triggerSave() {} } })` pattern keeps
 * compiling without a generic argument. The constraint is a self-mapped
 * `{ [K in keyof TActions]: (...args: any[]) => any }` so interface-style
 * action maps (without a string index signature) satisfy the bound —
 * see the JSDoc on {@link ToolsDockContext} for rationale.
 *
 * Tools themselves are stored as `ToolDef[]` (the generics are erased at
 * registration). Inside a tool component, type the prop locally — see the
 * JSDoc on {@link ToolDef.component} for the recommended pattern.
 */
export interface DefineToolsDockOptions<
  TData = Record<string, unknown>,
  TActions extends { [K in keyof TActions]: (...args: any[]) => any } = Record<
    string,
    (...args: any[]) => unknown
  >,
> {
  /** Registered tools. Order is preserved when rendering the activation rail/topbar. */
  tools: ToolDef[];
  /**
   * Optional backend-driven gating callback. Returns the subset of tools that
   * should be exposed for the current `context`. When omitted, every
   * registered tool is treated as available.
   *
   * The callback may return tool ids that aren't present in `tools` — these
   * are ignored. Conversely, tools missing from the callback's response are
   * hidden from the dock UI.
   *
   * The `ctx` parameter is typed against the factory's `TData` / `TActions`
   * generics — narrow them at the factory site for typed access to
   * `ctx.data` / `ctx.actions` here without manual casts.
   */
  fetchAvailability?: (
    ctx: ToolsDockContext<TData, TActions> | null,
  ) => Promise<AvailableTool[]>;
  /**
   * Optional `localStorage` key. When provided, the dock will persist a small
   * `{ isOpen, activeTool }` blob and hydrate it on mount. Persistence is
   * SSR-safe — no `localStorage` access happens at module scope or during
   * initial render on the server.
   */
  storageKey?: string;
  /**
   * Activation UI layout. Defaults to `'rail'`.
   *
   * - `'rail'`: vertical icon rail with the panel contained inside the
   *   dock's own aside. Safe to compose alongside `<WorkspaceShell>`'s
   *   `inspector` snippet — they don't fight for positioning.
   * - `'topbar'`: inline activation buttons with a SEPARATE
   *   `position: fixed` panel anchored to the bottom-right of the
   *   viewport. **Do not also use `<WorkspaceShell>`'s `inspector`
   *   snippet in this mode** — the shell renders its own
   *   `position: fixed` inspector with no z-index coordination, and the
   *   two panels will visibly overlap. Render `<ToolsDock layout='topbar'>`
   *   inside the shell's `topbarActions` snippet and leave the inspector
   *   slot unused.
   */
  layout?: 'rail' | 'topbar';
  /** Initial open state. Hydration from storage takes precedence. Defaults to `false`. */
  initialOpen?: boolean;
}

/**
 * Internal extension of {@link ToolsDockApi} with framework-only members:
 * the registered tools, the configured layout, and the persistence key.
 *
 * Mirrors the same `<TData, TActions>` generics as {@link ToolsDockApi} so
 * the narrowed `context` / `setContext()` signatures from
 * `defineToolsDock<TData, TActions>(...)` flow through to consumers that
 * hold the returned instance directly. Defaults preserve back-compat for
 * untyped callers (`defineToolsDock({...})`).
 */
export interface ToolsDockInstance<
  TData = Record<string, unknown>,
  TActions extends { [K in keyof TActions]: (...args: any[]) => any } = Record<
    string,
    (...args: any[]) => unknown
  >,
> extends ToolsDockApi<TData, TActions> {
  readonly tools: ReadonlyArray<ToolDef>;
  readonly layout: 'rail' | 'topbar';
  readonly storageKey: string | null;
  /** Internal: hydrate persisted state from `localStorage` (called by `<ToolsDock>` on mount). */
  hydrate(): void;
  /** Internal: persist current state to `localStorage`. */
  persist(): void;
}

interface PersistedState {
  isOpen?: boolean;
  activeTool?: string | null;
}

// Availability fetches are token-gated for race-safety (stale results are
// dropped — see `refreshAvailability`). We deliberately do NOT debounce by
// default because:
//   - `setContext` is typically called from `$effect` on route changes, not
//     in a tight loop
//   - debouncing complicates testing without buying meaningful protection
//     given the token-based stale-result drop
// Consumers that need debounce can wrap their own setContext call.

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function safeReadStorage(key: string): PersistedState | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { isOpen, activeTool } = parsed as PersistedState;
    return {
      isOpen: typeof isOpen === 'boolean' ? isOpen : undefined,
      activeTool:
        typeof activeTool === 'string' || activeTool === null
          ? activeTool
          : undefined,
    };
  } catch {
    return null;
  }
}

function safeWriteStorage(key: string, payload: PersistedState): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota errors, private browsing, etc. — silently drop.
  }
}

/**
 * Create a tools-dock instance and register it on Svelte context.
 *
 * Must be called inside a Svelte component initialization scope (`<script>`
 * top level, `+layout.svelte`, etc.) — `setContext` requires it.
 *
 * @param options factory options
 * @returns the {@link ToolsDockInstance} (a {@link ToolsDockApi} plus
 *   framework metadata `<ToolsDock>` consumes when rendering)
 */
export function defineToolsDock<
  TData = Record<string, unknown>,
  TActions extends { [K in keyof TActions]: (...args: any[]) => any } = Record<
    string,
    (...args: any[]) => unknown
  >,
>(
  options: DefineToolsDockOptions<TData, TActions>,
): ToolsDockInstance<TData, TActions> {
  const layout = options.layout ?? 'rail';
  const storageKey = options.storageKey ?? null;
  const fetchAvailability = options.fetchAvailability;
  const registeredTools = options.tools.slice();
  const registeredIds = new Set(registeredTools.map((t) => t.id));

  // Reactive state
  let isOpen = $state(Boolean(options.initialOpen));
  let activeTool = $state<string | null>(null);
  let context = $state<ToolsDockContext | null>(null);
  // Shadow of the last raw context reference passed to `setContextValue`.
  // Used for strict-equality short-circuiting: Svelte 5 wraps stored object
  // `$state` values in a Proxy, so `ctx === context` would never match the
  // original input. Comparing against this shadow gives us proxy-free
  // reference equality and avoids the `state_proxy_equality_mismatch`
  // warning.
  let rawContextRef: ToolsDockContext | null = null;
  let availableTools = $state<AvailableTool[]>(
    registeredTools.map((t) => ({ id: t.id, label: t.label, badge: t.badge })),
  );

  // Race-handle: each fetchAvailability call gets a token; only the most
  // recent token may apply its result.
  let availabilityToken = 0;

  /**
   * Set to `true` once the factory has finished wiring the instance. Used
   * to gate `'dock:change'` emits so handlers can't run before the instance
   * exists / is registered on context. Mutations issued from inside the
   * factory body (e.g. `applyAvailability` running during initial
   * availability snapshot) are silent.
   */
  let ready = false;

  // Pub/sub bus
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  function emit<TPayload>(event: string, payload: TPayload): void {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy so handlers that unsubscribe themselves don't mutate during iteration.
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        // Don't let one handler kill the rest.
        if (isBrowser()) console.error('[ToolsDock] handler error', err);
      }
    }
  }

  function on<TPayload>(
    event: string,
    handler: (payload: TPayload) => void,
  ): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => {
      const current = listeners.get(event);
      if (!current) return;
      current.delete(handler as (payload: unknown) => void);
      if (current.size === 0) listeners.delete(event);
    };
  }

  /**
   * Emit the appropriate dock-owned change events. Guarded by the `ready`
   * flag so handlers can't run during factory construction (before the
   * instance is fully wired / registered on Svelte context). Always reads
   * the latest `$state` values so handlers see the post-update state,
   * regardless of how many updates happened in a single call.
   *
   * The `$state` reads are wrapped in `untrack` so that when this is
   * invoked from inside a Svelte `$effect` (e.g. `<ToolsDock>`'s effect
   * forwarding the `context` prop into `dock.setContext`), the reads do
   * NOT become dependencies of that effect. Without this guard, a
   * subsequent `open()` / `close()` would re-run the calling effect,
   * which would call `setContext` again, triggering another availability
   * fetch and another emit — an infinite-ish feedback loop.
   *
   * Three events fan out from a single call, each gated by what actually
   * changed:
   *   - `'dock:state-changed'` — fired when `stateChanged` is true (open /
   *     close / toggle / availability cleared the active tool)
   *   - `'dock:context-changed'` — fired when `contextChanged` is true
   *     (`setContext` saw a different reference)
   *   - `'dock:change'` — legacy event, fired whenever this is called.
   *     Stays for back-compat; consumers should prefer the granular pair.
   *
   * Callers that only see a badge/label refresh (no state or context
   * change) still funnel through here so the legacy `'dock:change'`
   * subscribers see badge updates — but `stateChanged` / `contextChanged`
   * both stay `false`, keeping the granular events silent.
   */
  function emitChange(opts: {
    stateChanged: boolean;
    contextChanged: boolean;
  }): void {
    if (!ready) return;
    const snapshot = untrack(() => ({
      isOpen,
      activeTool,
      context,
    }));
    if (opts.stateChanged) {
      emit<ToolsDockEvents['dock:state-changed']>('dock:state-changed', {
        isOpen: snapshot.isOpen,
        activeTool: snapshot.activeTool,
      });
    }
    if (opts.contextChanged) {
      emit<ToolsDockEvents['dock:context-changed']>('dock:context-changed', {
        context: snapshot.context,
      });
    }
    emit<ToolsDockEvents['dock:change']>('dock:change', snapshot);
  }

  /**
   * Discriminating comparison of two availability snapshots. Returns true
   * when the new snapshot differs from the previous one in any user-visible
   * way (id ordering, badge value, or label). Used by `applyAvailability`
   * to decide whether to fire a `'dock:change'` event: refreshes that
   * resolve to byte-identical availability (the common no-op case when a
   * side-channel signal fires but underlying data didn't change) stay
   * silent, avoiding spurious work in consumer-side `'dock:change'`
   * mirrors.
   *
   * Both inputs come from `registeredTools.filter(...).map(...)` in the
   * same registration order, so a positional comparison is sufficient.
   */
  function availabilityActuallyChanged(
    prev: ReadonlyArray<AvailableTool>,
    next: ReadonlyArray<AvailableTool>,
  ): boolean {
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i++) {
      const a = prev[i];
      const b = next[i];
      if (a.id !== b.id) return true;
      if ((a.badge ?? null) !== (b.badge ?? null)) return true;
      if ((a.label ?? '') !== (b.label ?? '')) return true;
    }
    return false;
  }

  function applyAvailability(next: AvailableTool[]): void {
    // Filter to registered tools, preserve registration order, merge labels/badges.
    const byId = new Map(next.map((t) => [t.id, t]));
    const prev = availableTools;
    availableTools = registeredTools
      .filter((t) => byId.has(t.id))
      .map((t) => {
        const reported = byId.get(t.id);
        // Distinguish "key absent" (fall back to registered default) from
        // "key present with null" (explicitly clear the badge).
        const reportedBadge =
          reported && 'badge' in reported ? reported.badge : undefined;
        return {
          id: t.id,
          label: reported?.label ?? t.label,
          badge:
            reportedBadge !== undefined ? reportedBadge : (t.badge ?? null),
        } satisfies AvailableTool;
      });

    let stateChanged = false;
    let anyChange = false;

    // If the active tool is no longer available, clear it. Auto-close policy:
    //
    // - If the available set is now empty, close the dock too (nothing left
    //   to show — leaving `isOpen: true, activeTool: null` would render a
    //   floating empty panel in the topbar layout).
    // - If other tools remain, the dock stays open with `activeTool: null`.
    //   Consumers see the cleared state via `'dock:state-changed'` and can
    //   decide what to do (auto-pick the first remaining tool via
    //   `dock.open(availableTools[0].id)`, or surface a "select a tool"
    //   hint). The primitive stays policy-free — there's no universally
    //   correct auto-selection (the previously-active tool's adjacency to
    //   any specific replacement is consumer-specific).
    if (activeTool && !availableTools.some((t) => t.id === activeTool)) {
      activeTool = null;
      if (isOpen && availableTools.length === 0) {
        isOpen = false;
      }
      // Persist the cleared state so the factory's persistence guarantees
      // don't depend on the <ToolsDock> component being mounted to rescue
      // them via its $effect.
      persist();
      stateChanged = true;
      anyChange = true;
    }

    // Even when the active tool stayed put, the availability set may have
    // shifted in ways consumers care about (badge counts, label overrides,
    // tools appearing/disappearing). Emit so consumers mirroring
    // `availableTools` into their own state (badges in topbars, etc.) see
    // the update without polling.
    if (!anyChange) {
      anyChange = availabilityActuallyChanged(prev, availableTools);
    }

    if (anyChange) {
      // Pure badge/label refresh (no `stateChanged`, no context change)
      // still fires the legacy `'dock:change'` event for back-compat with
      // consumers mirroring `availableTools` — but stays silent on the
      // granular pair, which is the point of the U2 split.
      emitChange({ stateChanged, contextChanged: false });
    }
  }

  function refreshAvailability(): void {
    if (!fetchAvailability) {
      // Static availability — every registered tool.
      applyAvailability(
        registeredTools.map((t) => ({
          id: t.id,
          label: t.label,
          badge: t.badge,
        })),
      );
      return;
    }
    const token = ++availabilityToken;
    // Internally we store `context` as the default-generic shape; the
    // factory's `TData` / `TActions` only constrain the public callback
    // signature. Cast at the call boundary to thread the consumer's narrowed
    // type through without polluting the runtime store with the generic.
    const snapshotCtx = context as ToolsDockContext<TData, TActions> | null;
    // Funnel both synchronous throws (argument validation, undefined
    // dereferences before the promise is returned) and asynchronous
    // rejections through the same error path so neither escapes
    // `setContext` to the component.
    let pending: Promise<AvailableTool[]>;
    try {
      pending = Promise.resolve(fetchAvailability(snapshotCtx));
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending
      .then((result) => {
        if (token !== availabilityToken) return; // stale
        applyAvailability(Array.isArray(result) ? result : []);
      })
      .catch(() => {
        if (token !== availabilityToken) return;
        // On error, surface zero availability rather than stale state.
        applyAvailability([]);
      });
  }

  function persist(): void {
    if (!storageKey) return;
    safeWriteStorage(storageKey, { isOpen, activeTool });
  }

  function hydrate(): void {
    if (!storageKey) return;
    const persisted = safeReadStorage(storageKey);
    if (!persisted) return;
    if (typeof persisted.isOpen === 'boolean') {
      isOpen = persisted.isOpen;
    }
    if (
      typeof persisted.activeTool === 'string' &&
      registeredIds.has(persisted.activeTool)
    ) {
      activeTool = persisted.activeTool;
    }
  }

  function open(id?: string): void {
    const prevIsOpen = isOpen;
    const prevActive = activeTool;
    if (id) {
      if (!availableTools.some((t) => t.id === id)) return; // unavailable — no-op
      activeTool = id;
    } else if (!activeTool && availableTools.length > 0) {
      activeTool = availableTools[0].id;
    }
    isOpen = true;
    persist();
    // Skip emit when nothing observable changed — avoids spurious
    // 'dock:change' events when consumers idempotently call open() on the
    // already-active tool.
    if (isOpen !== prevIsOpen || activeTool !== prevActive) {
      emitChange({ stateChanged: true, contextChanged: false });
    }
  }

  function close(): void {
    if (!isOpen) {
      // Already closed — persist (cheap, no-op when nothing changed) but
      // skip emit so consumers don't see spurious 'dock:change' events.
      persist();
      return;
    }
    isOpen = false;
    persist();
    emitChange({ stateChanged: true, contextChanged: false });
  }

  function toggle(id?: string): void {
    const prevIsOpen = isOpen;
    const prevActive = activeTool;
    if (id) {
      if (!availableTools.some((t) => t.id === id)) return;
      if (isOpen && activeTool === id) {
        isOpen = false;
      } else {
        activeTool = id;
        isOpen = true;
      }
      persist();
      if (isOpen !== prevIsOpen || activeTool !== prevActive) {
        emitChange({ stateChanged: true, contextChanged: false });
      }
      return;
    }
    isOpen = !isOpen;
    if (isOpen && !activeTool && availableTools.length > 0) {
      activeTool = availableTools[0].id;
    }
    persist();
    if (isOpen !== prevIsOpen || activeTool !== prevActive) {
      emitChange({ stateChanged: true, contextChanged: false });
    }
  }

  function setContextValue(
    ctx: ToolsDockContext<TData, TActions> | null,
  ): void {
    // Strict-equality short-circuit: passing the same context reference is a
    // no-op. Skips both the availability refresh and the `'dock:change'`
    // emit so consumers (e.g. `<ToolsDock>`'s context-forwarding `$effect`)
    // can call this repeatedly without amplifying side effects. Consumers
    // who want a "force refresh" can pass a fresh object or `null` first.
    //
    // Compare against `rawContextRef` (a non-reactive shadow) rather than the
    // `$state` value, because Svelte 5 wraps object `$state` in a Proxy and
    // the original input would never `===` the proxied stored value.
    //
    // Internally the `context` `$state` is typed as the default
    // `ToolsDockContext` so the runtime store stays generic-erased — the
    // narrowed type only lives on the public boundary (this function
    // signature and the `instance.context` getter).
    const erased = ctx as ToolsDockContext | null;
    if (erased === rawContextRef) return;
    rawContextRef = erased;
    context = erased;
    if (fetchAvailability) refreshAvailability();
    // Emit AFTER kicking off availability refresh. The refresh is async and
    // may emit a second event later if it clears `activeTool` — that is
    // the intended behaviour (one event per observable state transition).
    // `contextChanged: true` fires `'dock:context-changed'`; `stateChanged`
    // stays false here because `setContext` itself doesn't touch isOpen/
    // activeTool (the async availability refresh handles that).
    emitChange({ stateChanged: false, contextChanged: true });
  }

  const instance: ToolsDockInstance<TData, TActions> = {
    // Reactive getters — keep the api surface read-only.
    get isOpen() {
      return isOpen;
    },
    get activeTool() {
      return activeTool;
    },
    get availableTools() {
      return availableTools;
    },
    // Internal `context` `$state` is typed as the default-generic shape so
    // the runtime store stays homogeneous. Cast at the public boundary —
    // structurally a `ToolsDockContext<TData, TActions>` IS a
    // `ToolsDockContext<defaults>` (the generics flow covariantly through
    // the field shapes); the cast threads the consumer's narrowed type
    // through to the API surface without forcing the internal store to
    // carry the generic.
    get context() {
      return context as ToolsDockContext<TData, TActions> | null;
    },
    open,
    close,
    toggle,
    setContext: setContextValue,
    refreshAvailability,
    emit,
    on,
    // Framework-only members:
    tools: registeredTools,
    layout,
    storageKey,
    hydrate,
    persist,
  };

  setContext(TOOLS_DOCK_KEY, instance);
  // From this point forward, mutations may emit `'dock:change'`. Anything
  // that ran during the factory body above (e.g. seeding `availableTools`
  // from the registered tools) is treated as part of initialization and
  // stays silent.
  ready = true;
  return instance;
}
