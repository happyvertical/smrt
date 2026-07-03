/**
 * `systemFeed` — a transport-light polling helper for the AdminShell system
 * scope (issue #1774, epic #1766).
 *
 * The System edge presents jobs / schedules / dispatch — data that lives in the
 * `_smrt_*` SYSTEM tables. Those tables are intentionally **excluded** from the
 * core change-feed (`packages/core/src/change-feed.ts`) and are **not** surfaced
 * as `smrt-web` collections, so the live-collection path used by tenant/app
 * data does not apply here. Instead, an app exposes its own status endpoint
 * (a `+server.ts` that reads `_smrt_*` through the `smrt-jobs` query API) and
 * this helper polls it on an interval, mapping the response into the
 * presentation contracts the shell already renders:
 * `ShellSystemPanel[]` (for `SystemScopePanel`) and `ShellStatusChip[]`
 * (for `SystemStatusChips`).
 *
 * This module is deliberately kept OUT of the `./workspace` presentation barrel
 * and the `./web` (smrt-web / TanStack) entry: it is opt-in via the
 * `@happyvertical/smrt-svelte/workspace/live` subpath and pulls no runtime
 * dependency beyond Svelte's reactivity. It only imports the shell's *types*.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { systemFeed } from '@happyvertical/smrt-svelte/workspace/live';
 *   import { SystemScopePanel, SystemStatusChips } from
 *     '@happyvertical/smrt-svelte/workspace';
 *   import { onDestroy } from 'svelte';
 *
 *   const feed = systemFeed({
 *     fetch: () => fetch('/admin/system/status').then((r) => r.json()),
 *     intervalMs: 5000,
 *     map: (status) => ({ panels: toPanels(status), chips: toChips(status) }),
 *   });
 *   onDestroy(feed.dispose);
 * </script>
 *
 * <SystemStatusChips chips={feed.chips} />
 * <SystemScopePanel panels={feed.panels} />
 * ```
 */

import type {
  ShellStatusChip,
  ShellSystemPanel,
} from '../admin-shell/types.js';

/** Lifecycle phase of a {@link SystemFeedController}. */
export type SystemFeedStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'error'
  | 'stopped';

/**
 * The shell-facing shape produced by {@link SystemFeedOptions.map}. Either half
 * is optional so a feed can drive only the panels, only the chips, or both.
 */
export interface SystemFeedView {
  panels?: ShellSystemPanel[];
  chips?: ShellStatusChip[];
}

/** Options for {@link systemFeed}. */
export interface SystemFeedOptions<T> {
  /**
   * App-supplied async loader. Called on each tick (and once immediately unless
   * `immediate` is `false`). Typically wraps `fetch('/…/status')`. Its resolved
   * value is handed to {@link SystemFeedOptions.map}. Rejections are caught and
   * surfaced via `error` / `onError` without stopping the poll loop.
   */
  fetch: (signal: AbortSignal) => T | Promise<T>;
  /**
   * Maps a raw `fetch` result into the shell presentation contracts. Runs
   * inside the same try/catch as `fetch`, so a throwing mapper is treated as a
   * failed tick (tolerated, loop continues).
   */
  map: (data: T) => SystemFeedView;
  /**
   * Poll interval in milliseconds. Values `<= 0` disable the timer (single
   * fetch only, useful for tests / manual `refresh()`). Default `5000`.
   */
  intervalMs?: number;
  /**
   * Fetch once as soon as the feed is created. Default `true`. When `false`,
   * nothing is fetched until the first timer tick or an explicit `refresh()`.
   */
  immediate?: boolean;
  /**
   * Skip ticks while `document.hidden` is true and refresh once on the next
   * `visibilitychange` back to visible. Avoids polling a backgrounded tab.
   * Default `true`. Ignored (treated as `false`) when there is no `document`
   * (SSR / non-DOM environments).
   */
  pauseWhenHidden?: boolean;
  /** Notified on every caught fetch/map error. Never throws into the loop. */
  onError?: (error: unknown) => void;
}

/**
 * Reactive controller returned by {@link systemFeed}. `panels` / `chips` are
 * `$state`-backed getters safe to bind straight to `SystemScopePanel` /
 * `SystemStatusChips`. Call {@link SystemFeedController.dispose} (e.g. from
 * `onDestroy`) to stop the timer and detach listeners — this is the disposer.
 */
export interface SystemFeedController {
  /** Latest mapped panels; `[]` until the first successful tick. */
  readonly panels: ShellSystemPanel[];
  /** Latest mapped chips; `[]` until the first successful tick. */
  readonly chips: ShellStatusChip[];
  /** Lifecycle phase of the most recent tick. */
  readonly status: SystemFeedStatus;
  /** The most recent caught error, or `null` after any success. */
  readonly error: unknown;
  /**
   * Whether the poll timer is currently armed. Stays `false` for single-shot
   * feeds (`intervalMs <= 0`), under SSR (no `document`), and after `stop()` /
   * `dispose()`.
   */
  readonly running: boolean;
  /** Fetch + map once, off-schedule. Resolves after state is updated. */
  refresh(): Promise<void>;
  /**
   * (Re)arm the poll timer. Idempotent. No-op when already running, after
   * {@link dispose}, when `intervalMs <= 0`, or under SSR (no `document`).
   */
  start(): void;
  /** Disarm the poll timer without tearing down listeners. Idempotent. */
  stop(): void;
  /** Stop the timer, detach listeners, abort any in-flight fetch. Terminal. */
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 5000;

/**
 * Create a polling feed that maps an app status endpoint into the AdminShell
 * system-scope presentation contracts.
 *
 * The returned {@link SystemFeedController} exposes reactive `panels` / `chips`
 * and a `dispose()` disposer. Bind the getters to the shell components and call
 * `dispose()` on teardown.
 */
export function systemFeed<T>(
  options: SystemFeedOptions<T>,
): SystemFeedController {
  const {
    fetch: fetcher,
    map,
    intervalMs = DEFAULT_INTERVAL_MS,
    immediate = true,
    pauseWhenHidden = true,
    onError,
  } = options;

  let panels = $state<ShellSystemPanel[]>([]);
  let chips = $state<ShellStatusChip[]>([]);
  let status = $state<SystemFeedStatus>('idle');
  let error = $state<unknown>(null);
  let running = $state(false);

  // Non-reactive machinery.
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: AbortController | null = null;
  let disposed = false;
  // Guards against a slow tick resolving after a newer one (or after dispose)
  // and clobbering fresher state.
  let generation = 0;

  const hasDocument = typeof document !== 'undefined';
  const usesVisibility = pauseWhenHidden && hasDocument;

  async function tick(): Promise<void> {
    if (disposed) return;
    // When hidden, skip the network entirely; the visibility listener will
    // refresh on the way back to visible.
    if (usesVisibility && document.hidden) return;

    const myGeneration = ++generation;
    // Supersede any still-running fetch so its result can't land late.
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    status = 'loading';
    try {
      const raw = await fetcher(controller.signal);
      if (disposed || myGeneration !== generation) return;
      const view = map(raw);
      if (disposed || myGeneration !== generation) return;
      if (view.panels) panels = view.panels;
      if (view.chips) chips = view.chips;
      error = null;
      status = 'success';
    } catch (caught) {
      if (disposed || myGeneration !== generation) return;
      // An abort is an intentional supersede/teardown, not a feed failure.
      if (isAbortError(caught)) return;
      error = caught;
      status = 'error';
      // Contain a throwing consumer callback: it must not reject the tick and
      // surface as an unhandled rejection from the interval / visibility path.
      try {
        onError?.(caught);
      } catch {
        // Swallow — the feed's own error handling already recorded `caught`.
      }
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  function start(): void {
    if (disposed || running) return;
    // Arm a timer only in a DOM environment (never spin a server-side interval
    // during SSR) and only when an interval is requested. `running` reflects an
    // actually-armed timer, so it stays false for single-shot feeds
    // (`intervalMs <= 0`) and under SSR.
    if (!hasDocument || intervalMs <= 0) return;
    running = true;
    timer = setInterval(() => void tick(), intervalMs);
  }

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function handleVisibility(): void {
    // Only catch up on becoming visible while actively polling — a stopped
    // (or disposed) feed must stay quiet.
    if (disposed || !running) return;
    if (!document.hidden) void tick();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
    // Invalidate any in-flight tick and abort its fetch.
    generation++;
    inFlight?.abort();
    inFlight = null;
    if (usesVisibility) {
      document.removeEventListener('visibilitychange', handleVisibility);
    }
    status = 'stopped';
  }

  // Everything below activates the feed. Under SSR (no `document`) the feed is
  // created inert — no listener, no immediate fetch, no timer — so a consumer
  // can safely construct it in a component script; the client re-runs this and
  // brings it to life. Callers can also drive an inert feed manually via
  // `refresh()` / `start()`.
  if (hasDocument) {
    if (usesVisibility) {
      document.addEventListener('visibilitychange', handleVisibility);
    }
    if (immediate) void tick();
    start();
  }

  return {
    get panels() {
      return panels;
    },
    get chips() {
      return chips;
    },
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get running() {
      return running;
    },
    refresh: tick,
    start,
    stop,
    dispose,
  };
}

function isAbortError(error: unknown): boolean {
  // Guard `DOMException` — it is undefined in some non-DOM runtimes, so a bare
  // `instanceof` would throw a ReferenceError and defeat the SSR-safe contract.
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
