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

import { setContext } from 'svelte';
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
 */
export interface DefineToolsDockOptions<TCtx = unknown> {
  /** Registered tools. Order is preserved when rendering the activation rail/topbar. */
  tools: ToolDef<TCtx>[];
  /**
   * Optional backend-driven gating callback. Returns the subset of tools that
   * should be exposed for the current `context`. When omitted, every
   * registered tool is treated as available.
   *
   * The callback may return tool ids that aren't present in `tools` — these
   * are ignored. Conversely, tools missing from the callback's response are
   * hidden from the dock UI.
   */
  fetchAvailability?: (
    ctx: ToolsDockContext | null,
  ) => Promise<AvailableTool[]>;
  /**
   * Optional `localStorage` key. When provided, the dock will persist a small
   * `{ isOpen, activeTool }` blob and hydrate it on mount. Persistence is
   * SSR-safe — no `localStorage` access happens at module scope or during
   * initial render on the server.
   */
  storageKey?: string;
  /** Activation UI layout. Defaults to `'rail'`. */
  layout?: 'rail' | 'topbar';
  /** Initial open state. Hydration from storage takes precedence. Defaults to `false`. */
  initialOpen?: boolean;
}

/**
 * Internal extension of {@link ToolsDockApi} with framework-only members:
 * the registered tools, the configured layout, and the persistence key.
 *
 * Marked as part of the public surface but stamped with a brand symbol so
 * that `<ToolsDock>` and `useToolsDock()` callers can safely destructure
 * without consumers depending on internal field names.
 */
export interface ToolsDockInstance<TCtx = unknown> extends ToolsDockApi {
  readonly tools: ReadonlyArray<ToolDef<TCtx>>;
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
export function defineToolsDock<TCtx = unknown>(
  options: DefineToolsDockOptions<TCtx>,
): ToolsDockInstance<TCtx> {
  const layout = options.layout ?? 'rail';
  const storageKey = options.storageKey ?? null;
  const fetchAvailability = options.fetchAvailability;
  const registeredTools = options.tools.slice();
  const registeredIds = new Set(registeredTools.map((t) => t.id));

  // Reactive state
  let isOpen = $state(Boolean(options.initialOpen));
  let activeTool = $state<string | null>(null);
  let context = $state<ToolsDockContext | null>(null);
  let availableTools = $state<AvailableTool[]>(
    registeredTools.map((t) => ({ id: t.id, label: t.label, badge: t.badge })),
  );

  // Race-handle: each fetchAvailability call gets a token; only the most
  // recent token may apply its result.
  let availabilityToken = 0;

  /**
   * Set to `true` once the factory has finished wiring the instance. Used
   * to gate `'change'` emits so handlers can't run before the instance
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
   * Emit a `'change'` event with a snapshot of the current public state.
   * Guarded by the `ready` flag so handlers can't run during factory
   * construction (before the instance is fully wired / registered on
   * Svelte context). Always reads the latest `$state` values so handlers
   * see the post-update state, regardless of how many updates happened
   * in a single call.
   */
  function emitChange(): void {
    if (!ready) return;
    const payload: ToolsDockEvents['change'] = {
      isOpen,
      activeTool,
      context,
    };
    emit('change', payload);
  }

  function applyAvailability(next: AvailableTool[]): void {
    // Filter to registered tools, preserve registration order, merge labels/badges.
    const byId = new Map(next.map((t) => [t.id, t]));
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
    // If the active tool is no longer available, clear it.
    if (activeTool && !availableTools.some((t) => t.id === activeTool)) {
      activeTool = null;
      if (isOpen && availableTools.length === 0) {
        isOpen = false;
      }
      // Persist the cleared state so the factory's persistence guarantees
      // don't depend on the <ToolsDock> component being mounted to rescue
      // them via its $effect.
      persist();
      emitChange();
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
    const snapshotCtx = context;
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
    if (id) {
      if (!availableTools.some((t) => t.id === id)) return; // unavailable — no-op
      activeTool = id;
    } else if (!activeTool && availableTools.length > 0) {
      activeTool = availableTools[0].id;
    }
    isOpen = true;
    persist();
    emitChange();
  }

  function close(): void {
    isOpen = false;
    persist();
    emitChange();
  }

  function toggle(id?: string): void {
    if (id) {
      if (!availableTools.some((t) => t.id === id)) return;
      if (isOpen && activeTool === id) {
        isOpen = false;
      } else {
        activeTool = id;
        isOpen = true;
      }
      persist();
      emitChange();
      return;
    }
    isOpen = !isOpen;
    if (isOpen && !activeTool && availableTools.length > 0) {
      activeTool = availableTools[0].id;
    }
    persist();
    emitChange();
  }

  function setContextValue(ctx: ToolsDockContext | null): void {
    context = ctx;
    if (fetchAvailability) refreshAvailability();
    // Emit AFTER kicking off availability refresh. The refresh is async and
    // may emit a second `'change'` later if it clears `activeTool` — that
    // is the intended behaviour (one event per observable state transition).
    emitChange();
  }

  const instance: ToolsDockInstance<TCtx> = {
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
    get context() {
      return context;
    },
    open,
    close,
    toggle,
    setContext: setContextValue,
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
  // From this point forward, mutations may emit `'change'`. Anything that
  // ran during the factory body above (e.g. seeding `availableTools` from
  // the registered tools) is treated as part of initialization and stays
  // silent.
  ready = true;
  return instance;
}
