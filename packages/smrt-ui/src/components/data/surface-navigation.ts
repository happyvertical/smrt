/**
 * "Has the page settled after that command?"
 *
 * A visible command on a navigation surface (a link list, a tab row) starts a
 * page change and returns at once: awaiting it inside the command would make
 * the registry report `not_found` whenever the new page unmounts the surface
 * that ran it. The navigation's promise is tracked here instead, keyed by the
 * registry the command ran on, so whoever drives the page next — an in-page
 * assistant about to show the model the page's tools, a test — can wait for
 * it to finish and for the new page's surfaces to register:
 *
 * ```ts
 * await registry.execute(openEventsCommand);
 * await whenSurfaceNavigationSettled(registry); // new page mounted and quiet
 * ```
 *
 * `registerLinkSurface` tracks its own `navigate` result. A bespoke surface
 * whose command navigates calls {@link trackSurfaceNavigation} itself.
 */

import type { DataSurfaceRegistry } from '@happyvertical/smrt-types';

const pending = new WeakMap<DataSurfaceRegistry, Set<Promise<unknown>>>();

/**
 * Record a navigation a command on `registry` started. Returns the same
 * promise. A rejection is swallowed for waiting purposes (a failed navigation
 * is still a finished one); the caller keeps its own handling.
 */
export function trackSurfaceNavigation<T>(
  registry: DataSurfaceRegistry,
  navigation: T | Promise<T>,
): T | Promise<T> {
  if (!navigation || typeof (navigation as Promise<T>).then !== 'function') {
    return navigation;
  }
  const promise = Promise.resolve(navigation as Promise<T>);
  let set = pending.get(registry);
  if (!set) {
    set = new Set();
    pending.set(registry, set);
  }
  const entry = promise.then(
    () => undefined,
    () => undefined,
  );
  set.add(entry);
  void entry.then(() => set?.delete(entry));
  return promise;
}

/** Whether a tracked navigation on `registry` is still running. */
export function hasPendingSurfaceNavigation(
  registry: DataSurfaceRegistry,
): boolean {
  return (pending.get(registry)?.size ?? 0) > 0;
}

export interface SurfaceNavigationSettleOptions {
  /**
   * How long the registry must go without a surface registering or
   * unregistering before the page counts as settled. Default 120 ms.
   */
  quietMs?: number;
  /** Give up waiting after this long. Default 5000 ms. */
  timeoutMs?: number;
  /** Extra sources whose changes also reset the quiet timer (e.g. page tools). */
  alsoWatch?: ReadonlyArray<
    | { subscribe?: (listener: (event: unknown) => void) => () => void }
    | null
    | undefined
  >;
  signal?: AbortSignal;
}

/**
 * Resolve once every navigation tracked on `registry` has finished AND the
 * registry (plus `alsoWatch` sources) has been quiet for `quietMs`, or after
 * `timeoutMs`, whichever comes first. Never rejects.
 */
export async function whenSurfaceNavigationSettled(
  registry: DataSurfaceRegistry,
  options: SurfaceNavigationSettleOptions = {},
): Promise<void> {
  const quietMs = Math.max(0, options.quietMs ?? 120);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
  const started = Date.now();
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - started));

  const timeout = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // 1. Tracked navigations (a navigation may start another, so loop).
  for (;;) {
    const set = pending.get(registry);
    if (!set || set.size === 0 || options.signal?.aborted) break;
    const left = remaining();
    if (left === 0) return;
    await Promise.race([Promise.all([...set]), timeout(left)]);
  }
  if (options.signal?.aborted || remaining() === 0) return;

  // 2. Quiet period: new page components register their surfaces and tools.
  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribers: Array<() => void> = [];
    const finish = () => {
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      options.signal?.removeEventListener('abort', finish);
      resolve();
    };
    const restart = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    const hardTimer = setTimeout(finish, remaining());
    options.signal?.addEventListener('abort', finish, { once: true });
    unsubscribers.push(
      registry.subscribe((event) => {
        if (event.type === 'registered' || event.type === 'unregistered') {
          restart();
        }
      }),
    );
    for (const source of options.alsoWatch ?? []) {
      const unsubscribe = source?.subscribe?.(() => restart());
      if (unsubscribe) unsubscribers.push(unsubscribe);
    }
    restart();
  });
}
