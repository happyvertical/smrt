import {
  executeSmrtWebDataQuery,
  type SmrtWebDataQueryRequest,
  type SmrtWebDataQueryResult,
  type SmrtWebDataQueryTransport,
} from './data-query.js';
import type { SmrtWebCollection } from './index.js';

/** How a query run is allowed to affect the visible query state. */
export type SmrtWebQueryMode = 'visible' | 'background' | 'prefetch' | 'silent';

export interface SmrtWebQueryRunOptions {
  mode?: SmrtWebQueryMode;
  signal?: AbortSignal;
  /** Cancel this run after the given number of milliseconds. */
  deadlineMs?: number;
  /** Bypass the keyed cache and execute a fresh request (used by refresh). */
  force?: boolean;
}

export interface SmrtWebQueryPage {
  kind: 'offset' | 'cursor';
  limit: number;
  offset?: number;
  nextCursor?: string;
  hasMore: boolean;
}

export interface SmrtWebQueryState<TData extends object = object> {
  readonly rows: ReadonlyArray<TData>;
  readonly page: SmrtWebQueryPage | undefined;
  readonly total: SmrtWebDataQueryResult['total'] | undefined;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly error: unknown;
  readonly lastUpdated: number | undefined;
  readonly result: SmrtWebDataQueryResult | undefined;
}

export interface SmrtWebQueryLiveSubscription {
  unsubscribe(): void;
  reconnect(): void;
}

export interface SmrtWebQueryTransport extends SmrtWebDataQueryTransport {
  /** Subscribe to changes for this exact query, not the entire collection. */
  subscribe?(
    request: SmrtWebDataQueryRequest,
    onResult: (result: unknown) => void,
    options?: { signal?: AbortSignal },
  ): SmrtWebQueryLiveSubscription | { unsubscribe(): void };
}

export interface SmrtWebQuery<TData extends object = object> {
  readonly state: SmrtWebQueryState<TData>;
  readonly request: SmrtWebDataQueryRequest | undefined;
  execute(
    request: SmrtWebDataQueryRequest,
    options?: SmrtWebQueryRunOptions,
  ): Promise<SmrtWebDataQueryResult>;
  refresh(
    options?: Omit<SmrtWebQueryRunOptions, 'mode' | 'force'>,
  ): Promise<SmrtWebDataQueryResult | undefined>;
  retry(): Promise<SmrtWebDataQueryResult | undefined>;
  subscribe(listener: (state: SmrtWebQueryState<TData>) => void): () => void;
  subscribeLive(): SmrtWebQueryLiveSubscription | undefined;
  invalidate(): void;
  dispose(): void;
}

interface CacheEntry {
  result: SmrtWebDataQueryResult;
  updatedAt: number;
}

interface SharedFlight {
  controller: AbortController;
  promise: Promise<SmrtWebDataQueryResult>;
  waiters: number;
  settled: boolean;
}

interface LiveIntent {
  active: boolean;
}

interface ManagedLiveSubscription extends SmrtWebQueryLiveSubscription {
  readonly intent: LiveIntent;
  disconnect(): void;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function keyFor(request: SmrtWebDataQueryRequest): string {
  // requestId is correlation metadata, not query identity. Removing it allows
  // refreshes and independently-created equivalent requests to share a result.
  const { requestId: _requestId, ...semantic } = request;
  return JSON.stringify(canonicalize(semantic));
}

function rebindRequestId(
  result: SmrtWebDataQueryResult,
  request: SmrtWebDataQueryRequest,
): SmrtWebDataQueryResult {
  return result.requestId === request.requestId
    ? result
    : { ...result, requestId: request.requestId };
}

function abortError(): DOMException | Error {
  if (typeof DOMException !== 'undefined')
    return new DOMException('The operation was aborted', 'AbortError');
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function pageOf(result: SmrtWebDataQueryResult): SmrtWebQueryPage | undefined {
  if (!result.page) return undefined;
  return result.page.kind === 'offset'
    ? { ...result.page }
    : { ...result.page };
}

/**
 * Create a query controller over one SMRT collection. Query rows stay in a
 * separate keyed cache; the collection's full list is never loaded.
 */
export function createSmrtWebQuery<TData extends object>(
  _collection: SmrtWebCollection<TData>,
  transport: SmrtWebQueryTransport,
  options: { staleTimeMs?: number } = {},
): SmrtWebQuery<TData> {
  const staleTimeMs = options.staleTimeMs ?? 30_000;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, SharedFlight>();
  const latestSuccessfulFlight = new Map<string, number>();
  let flightSequence = 0;
  const listeners = new Set<(state: SmrtWebQueryState<TData>) => void>();
  let request: SmrtWebDataQueryRequest | undefined;
  let visibleController: AbortController | undefined;
  const runControllers = new Set<AbortController>();
  let generation = 0;
  let live: ManagedLiveSubscription | undefined;
  let liveIntent: LiveIntent | undefined;
  let liveGeneration = 0;
  let disposed = false;
  let state: SmrtWebQueryState<TData> = {
    rows: [],
    page: undefined,
    total: undefined,
    loading: false,
    refreshing: false,
    stale: false,
    error: null,
    lastUpdated: undefined,
    result: undefined,
  };

  const publish = (next: SmrtWebQueryState<TData>): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const cached = (key: string): CacheEntry | undefined => cache.get(key);
  const cacheSuccess = (
    key: string,
    result: SmrtWebDataQueryResult,
    sequence: number,
    updatedAt = Date.now(),
  ): boolean => {
    if (disposed) return false;
    const latest = latestSuccessfulFlight.get(key);
    if (latest === undefined || sequence > latest) {
      latestSuccessfulFlight.set(key, sequence);
      cache.set(key, { result, updatedAt });
      return true;
    }
    return false;
  };
  const apply = (
    result: SmrtWebDataQueryResult,
    candidate: SmrtWebDataQueryRequest,
    updatedAt = Date.now(),
    successSequence?: number,
  ): void => {
    if (
      successSequence !== undefined &&
      !cacheSuccess(keyFor(candidate), result, successSequence, updatedAt)
    )
      return;
    publish({
      rows: result.rows as TData[],
      page: pageOf(result),
      total: result.total,
      loading: false,
      refreshing: false,
      stale: result.freshness.state === 'stale',
      error: null,
      lastUpdated: updatedAt,
      result,
    });
  };
  const runTransport = async (
    candidate: SmrtWebDataQueryRequest,
    controller: AbortController,
  ): Promise<SmrtWebDataQueryResult> => {
    runControllers.add(controller);
    try {
      const result = await executeSmrtWebDataQuery(transport, candidate, {
        signal: controller.signal,
      });
      // Some transports cannot observe AbortSignal. Cancellation remains
      // authoritative after they resolve, so their result must not reach the
      // cache or visible state.
      if (controller.signal.aborted) {
        throw abortError();
      }
      return result;
    } catch (error) {
      // A transport may reject with its own error instead of propagating the
      // abort reason. Once cancelled, that transport error is not query state.
      if (controller.signal.aborted) {
        throw abortError();
      }
      throw error;
    } finally {
      runControllers.delete(controller);
    }
  };
  const execute = async (
    candidate: SmrtWebDataQueryRequest,
    runOptions: SmrtWebQueryRunOptions = {},
  ): Promise<SmrtWebDataQueryResult> => {
    if (disposed) throw abortError();
    const mode = runOptions.mode ?? 'visible';
    const key = keyFor(candidate);
    if (runOptions.signal?.aborted || (runOptions.deadlineMs ?? 1) <= 0)
      throw abortError();
    // A live connection is scoped to the complete semantic query, not merely
    // the controller. Preserve its caller-owned intent through a replacement
    // so rapid visible changes cannot lose it, while a caller can still cancel
    // that intent through the original returned subscription handle.
    const shouldRebindLive =
      mode === 'visible' &&
      liveIntent?.active &&
      (!live || (request !== undefined && keyFor(request) !== key));
    const rebindIntent = shouldRebindLive ? liveIntent : undefined;
    const entry = cached(key);
    const fresh =
      entry !== undefined && Date.now() - entry.updatedAt < staleTimeMs;
    if (mode !== 'visible' && !runOptions.force && fresh)
      return rebindRequestId(entry.result, candidate);
    if (mode === 'visible' && !runOptions.force && fresh) {
      generation += 1;
      visibleController?.abort(abortError());
      if (disposed) throw abortError();
      visibleController = undefined;
      request = candidate;
      if (rebindIntent) live?.disconnect();
      const result = rebindRequestId(entry.result, candidate);
      apply(result, candidate, entry.updatedAt);
      if (disposed) throw abortError();
      if (rebindIntent?.active && !live) resumeLive(rebindIntent);
      return result;
    }
    if (mode === 'visible') {
      generation += 1;
      visibleController?.abort(abortError());
      if (disposed) throw abortError();
      const invocationController = new AbortController();
      visibleController = invocationController;
      request = candidate;
      if (rebindIntent) live?.disconnect();
      const current = generation;
      const signal = runOptions.signal;
      let removeCallerAbort: (() => void) | undefined;
      if (signal?.aborted) invocationController.abort(signal.reason);
      else if (signal) {
        const abortCaller = () => invocationController.abort(signal.reason);
        signal.addEventListener('abort', abortCaller, { once: true });
        removeCallerAbort = () =>
          signal.removeEventListener('abort', abortCaller);
      }
      publish({
        ...state,
        loading: entry === undefined,
        refreshing: entry !== undefined,
        stale: entry !== undefined,
        error: null,
      });
      // A visible run is a successor boundary: it must never adopt an older
      // same-key shared promise whose signal was just aborted above.
      runOptions = {
        ...runOptions,
        signal: invocationController.signal,
        force: true,
      };
      try {
        if (disposed) throw abortError();
        const result = await runShared(candidate, key, runOptions);
        // A query-scoped live update or background successor may have won
        // while this transport was in flight. Do not let the older visible
        // result overwrite it, but always release this invocation's busy
        // state once it has settled.
        if (current === generation) {
          if (cached(key)?.result === result) apply(result, candidate);
          else publish({ ...state, loading: false, refreshing: false });
          if (rebindIntent?.active && !live) resumeLive(rebindIntent);
        }
        return result;
      } catch (error) {
        if (current === generation) {
          if (isAbort(error)) {
            // Cancellation is not an error, but the current invocation must
            // still release its busy state. Preserve all other state fields.
            publish({ ...state, loading: false, refreshing: false });
          } else {
            publish({
              ...state,
              loading: false,
              refreshing: false,
              stale: entry !== undefined,
              error,
            });
          }
        }
        throw error;
      } finally {
        removeCallerAbort?.();
        if (visibleController === invocationController)
          visibleController = undefined;
      }
    }
    return runShared(candidate, key, runOptions);
  };
  const waitForFlight = (
    flight: SharedFlight,
    key: string,
    candidate: SmrtWebDataQueryRequest,
    runOptions: SmrtWebQueryRunOptions,
  ): Promise<SmrtWebDataQueryResult> => {
    if (runOptions.signal?.aborted || (runOptions.deadlineMs ?? 1) <= 0)
      return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        flight.waiters -= 1;
        if (timer) clearTimeout(timer);
        runOptions.signal?.removeEventListener('abort', cancel);
      };
      const cancel = (): void => {
        if (settled) return;
        settle();
        if (flight.waiters === 0 && !flight.settled) {
          flight.controller.abort(abortError());
          if (inFlight.get(key) === flight) inFlight.delete(key);
        }
        reject(abortError());
      };
      const timer =
        runOptions.deadlineMs === undefined
          ? undefined
          : setTimeout(cancel, runOptions.deadlineMs);
      flight.waiters += 1;
      runOptions.signal?.addEventListener('abort', cancel, { once: true });
      flight.promise.then(
        (result) => {
          if (settled) return;
          settle();
          resolve(rebindRequestId(result, candidate));
        },
        (error) => {
          if (settled) return;
          settle();
          reject(error);
        },
      );
    });
  };
  const runShared = async (
    candidate: SmrtWebDataQueryRequest,
    key: string,
    runOptions: SmrtWebQueryRunOptions,
  ): Promise<SmrtWebDataQueryResult> => {
    if (runOptions.signal?.aborted || (runOptions.deadlineMs ?? 1) <= 0)
      throw abortError();
    if (!runOptions.force) {
      const existing = inFlight.get(key);
      if (existing) return waitForFlight(existing, key, candidate, runOptions);
    }
    const flight = ++flightSequence;
    const controller = new AbortController();
    const running = runTransport(candidate, controller).then((result) => {
      // A failed or aborted successor must not suppress an older valid result,
      // but a successful successor must win over any later predecessor.
      if (controller.signal.aborted) throw abortError();
      cacheSuccess(key, result, flight);
      return result;
    });
    const shared: SharedFlight = {
      controller,
      promise: running,
      waiters: 0,
      settled: false,
    };
    inFlight.set(key, shared);
    // A forced successor may replace this map entry while the predecessor is
    // still settling. Only the promise that currently owns the key may delete
    // it, otherwise a third caller can miss the active successor flight.
    void running.then(
      () => {
        shared.settled = true;
        if (inFlight.get(key) === shared) inFlight.delete(key);
      },
      () => {
        shared.settled = true;
        if (inFlight.get(key) === shared) inFlight.delete(key);
      },
    );
    return waitForFlight(shared, key, candidate, runOptions);
  };
  const refresh = (
    refreshOptions: Omit<SmrtWebQueryRunOptions, 'mode' | 'force'> = {},
  ) => {
    if (!request) return Promise.resolve(undefined);
    return execute(request, {
      ...refreshOptions,
      mode: 'visible',
      force: true,
    });
  };
  const startLive = (
    intent: LiveIntent,
  ): ManagedLiveSubscription | undefined => {
    if (disposed || !intent.active || !request || !transport.subscribe)
      return undefined;
    const candidate = request;
    const currentGeneration = ++liveGeneration;
    const controller = new AbortController();
    let connected = true;
    let subscription: SmrtWebQueryLiveSubscription | { unsubscribe(): void };
    let handle: ManagedLiveSubscription;
    const disconnect = (): void => {
      if (!connected) return;
      connected = false;
      controller.abort();
      subscription.unsubscribe();
      if (live === handle) live = undefined;
    };
    const unsubscribe = (): void => {
      if (!intent.active) return;
      intent.active = false;
      disconnect();
      if (liveIntent === intent) liveIntent = undefined;
      if (live?.intent === intent) live.disconnect();
    };
    const reconnect = (): void => {
      if (!intent.active || disposed) return;
      if (!connected) {
        if (live?.intent === intent) live.reconnect();
        return;
      }
      if (currentGeneration !== liveGeneration) return;
      disconnect();
      // Refresh the exact page first, then replace the old subscription. This
      // avoids reconnecting against a stale cursor or cached snapshot.
      void execute(candidate, { mode: 'visible', force: true })
        .catch(() => undefined)
        .finally(() => {
          if (
            intent.active &&
            !disposed &&
            liveIntent === intent &&
            !live &&
            request &&
            keyFor(request) === keyFor(candidate)
          )
            resumeLive(intent);
        });
    };
    handle = { intent, disconnect, unsubscribe, reconnect };
    subscription = transport.subscribe(
      candidate,
      (raw) => {
        if (
          !connected ||
          !intent.active ||
          disposed ||
          currentGeneration !== liveGeneration ||
          controller.signal.aborted
        )
          return;
        // Claim ordering when the push arrives, before envelope validation
        // yields. A later explicit fetch must remain newer even if this
        // callback resumes after it.
        const liveFlight = ++flightSequence;
        void (async () => {
          const result = await executeSmrtWebDataQuery(
            { query: async () => raw },
            candidate,
          );
          if (
            connected &&
            intent.active &&
            !disposed &&
            currentGeneration === liveGeneration &&
            request &&
            keyFor(request) === keyFor(candidate)
          )
            apply(
              rebindRequestId(result, request),
              request,
              Date.now(),
              liveFlight,
            );
        })().catch((error) => {
          const latestSuccessful = latestSuccessfulFlight.get(
            keyFor(candidate),
          );
          if (
            !isAbort(error) &&
            connected &&
            intent.active &&
            !disposed &&
            currentGeneration === liveGeneration &&
            request &&
            keyFor(request) === keyFor(candidate) &&
            (latestSuccessful === undefined || liveFlight > latestSuccessful)
          )
            publish({ ...state, error });
        });
      },
      { signal: controller.signal },
    );
    if (disposed || !intent.active) {
      disconnect();
      return undefined;
    }
    live = handle;
    return handle;
  };
  const clearLiveIntent = (intent: LiveIntent): void => {
    intent.active = false;
    if (liveIntent === intent) liveIntent = undefined;
  };
  const resumeLive = (intent: LiveIntent): void => {
    try {
      startLive(intent);
    } catch (error) {
      // An automatic rebind must not turn a successful cache/read result into
      // a rejected execution, or leave a reconnect's detached promise
      // unhandled. The caller can start a new live subscription explicitly.
      clearLiveIntent(intent);
      if (!disposed) publish({ ...state, error });
    }
  };
  const subscribeLive = (): SmrtWebQueryLiveSubscription | undefined => {
    if (disposed || !request || !transport.subscribe) return undefined;
    if (liveIntent) {
      liveIntent.active = false;
      live?.disconnect();
    }
    const intent = { active: true };
    liveIntent = intent;
    try {
      return startLive(intent);
    } catch (error) {
      clearLiveIntent(intent);
      throw error;
    }
  };
  return {
    get state() {
      return state;
    },
    get request() {
      return request;
    },
    execute,
    refresh,
    retry: () => refresh(),
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    subscribeLive,
    invalidate() {
      if (!request) return;
      const key = keyFor(request);
      const entry = cache.get(key);
      // A response that started before invalidation cannot restore freshness.
      latestSuccessfulFlight.set(key, ++flightSequence);
      if (entry) cache.set(key, { ...entry, updatedAt: 0 });
      publish({ ...state, loading: false, refreshing: false, stale: true });
    },
    dispose() {
      disposed = true;
      generation += 1;
      liveGeneration += 1;
      visibleController?.abort(abortError());
      for (const controller of runControllers) controller.abort(abortError());
      if (liveIntent) liveIntent.active = false;
      live?.disconnect();
      live = undefined;
      liveIntent = undefined;
      request = undefined;
      listeners.clear();
      cache.clear();
      latestSuccessfulFlight.clear();
      inFlight.clear();
    },
  };
}
