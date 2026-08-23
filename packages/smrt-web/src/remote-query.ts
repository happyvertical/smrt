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

function keyFor(request: SmrtWebDataQueryRequest): string {
  // requestId is correlation metadata, not query identity. Removing it allows
  // refreshes and independently-created equivalent requests to share a result.
  const { requestId: _requestId, ...semantic } = request;
  return JSON.stringify(semantic);
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
  const inFlight = new Map<string, Promise<SmrtWebDataQueryResult>>();
  const latestSuccessfulFlight = new Map<string, number>();
  let flightSequence = 0;
  const listeners = new Set<(state: SmrtWebQueryState<TData>) => void>();
  let request: SmrtWebDataQueryRequest | undefined;
  let visibleController: AbortController | undefined;
  let generation = 0;
  let live: SmrtWebQueryLiveSubscription | undefined;
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
  ): void => {
    if (disposed) return;
    const latest = latestSuccessfulFlight.get(key);
    if (latest === undefined || sequence > latest) {
      latestSuccessfulFlight.set(key, sequence);
      cache.set(key, { result, updatedAt });
    }
  };
  const apply = (
    result: SmrtWebDataQueryResult,
    candidate: SmrtWebDataQueryRequest,
    updatedAt = Date.now(),
    successSequence?: number,
  ): void => {
    if (successSequence !== undefined)
      cacheSuccess(keyFor(candidate), result, successSequence, updatedAt);
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
    runOptions: SmrtWebQueryRunOptions,
  ): Promise<SmrtWebDataQueryResult> => {
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    const abortFrom = (signal: AbortSignal | undefined): void => {
      if (!signal) return;
      if (signal.aborted) controller.abort(signal.reason);
      else {
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', abort));
      }
    };
    abortFrom(runOptions.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (runOptions.deadlineMs !== undefined) {
      if (runOptions.deadlineMs <= 0) controller.abort(abortError());
      else
        timer = setTimeout(
          () => controller.abort(abortError()),
          runOptions.deadlineMs,
        );
    }
    try {
      const result = await executeSmrtWebDataQuery(transport, candidate, {
        signal: controller.signal,
      });
      // Some transports cannot observe AbortSignal. Cancellation remains
      // authoritative after they resolve, so their result must not reach the
      // cache or visible state.
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? abortError();
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
    }
  };
  const execute = async (
    candidate: SmrtWebDataQueryRequest,
    runOptions: SmrtWebQueryRunOptions = {},
  ): Promise<SmrtWebDataQueryResult> => {
    const mode = runOptions.mode ?? 'visible';
    const key = keyFor(candidate);
    const entry = cached(key);
    const fresh =
      entry !== undefined && Date.now() - entry.updatedAt < staleTimeMs;
    if (mode !== 'visible' && !runOptions.force && fresh) return entry.result;
    if (mode === 'visible' && !runOptions.force && fresh) {
      generation += 1;
      visibleController?.abort(abortError());
      visibleController = undefined;
      request = candidate;
      apply(entry.result, candidate, entry.updatedAt);
      return entry.result;
    }
    if (mode === 'visible') {
      generation += 1;
      visibleController?.abort(abortError());
      const invocationController = new AbortController();
      visibleController = invocationController;
      request = candidate;
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
        const result = await runShared(candidate, key, runOptions);
        if (current === generation) apply(result, candidate);
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
  const runShared = async (
    candidate: SmrtWebDataQueryRequest,
    key: string,
    runOptions: SmrtWebQueryRunOptions,
  ): Promise<SmrtWebDataQueryResult> => {
    if (!runOptions.force) {
      const running = inFlight.get(key);
      if (running) return running;
    }
    const flight = ++flightSequence;
    const running = runTransport(candidate, runOptions).then((result) => {
      // A failed or aborted successor must not suppress an older valid result,
      // but a successful successor must win over any later predecessor.
      cacheSuccess(key, result, flight);
      return result;
    });
    inFlight.set(key, running);
    // A forced successor may replace this map entry while the predecessor is
    // still settling. Only the promise that currently owns the key may delete
    // it, otherwise a third caller can miss the active successor flight.
    void running.then(
      () => {
        if (inFlight.get(key) === running) inFlight.delete(key);
      },
      () => {
        if (inFlight.get(key) === running) inFlight.delete(key);
      },
    );
    return running;
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
  const subscribeLive = (): SmrtWebQueryLiveSubscription | undefined => {
    if (disposed || !request || !transport.subscribe) return undefined;
    live?.unsubscribe();
    const candidate = request;
    const currentGeneration = ++liveGeneration;
    let connectionGeneration = 0;
    let controller: AbortController | undefined;
    let subscription: SmrtWebQueryLiveSubscription | { unsubscribe(): void };
    let active = true;
    let handle: SmrtWebQueryLiveSubscription;
    const connect = (): void => {
      if (!active || disposed || currentGeneration !== liveGeneration) return;
      controller = new AbortController();
      const connection = ++connectionGeneration;
      const subscribe = transport.subscribe;
      if (!subscribe) return;
      subscription = subscribe(
        candidate,
        (raw) => {
          if (
            !active ||
            disposed ||
            currentGeneration !== liveGeneration ||
            connection !== connectionGeneration ||
            controller?.signal.aborted
          )
            return;
          void (async () => {
            const result = await executeSmrtWebDataQuery(
              { query: async () => raw },
              candidate,
            );
            if (
              active &&
              !disposed &&
              currentGeneration === liveGeneration &&
              connection === connectionGeneration &&
              request &&
              keyFor(request) === keyFor(candidate)
            )
              apply(result, candidate, Date.now(), ++flightSequence);
          })().catch((error) => {
            if (
              !isAbort(error) &&
              active &&
              !disposed &&
              currentGeneration === liveGeneration &&
              connection === connectionGeneration
            )
              publish({ ...state, error });
          });
        },
        { signal: controller.signal },
      );
    };
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      liveGeneration += 1;
      controller?.abort();
      subscription.unsubscribe();
      if (live === handle) live = undefined;
    };
    const reconnect = (): void => {
      if (!active || disposed || currentGeneration !== liveGeneration) return;
      // Invalidate callbacks that already entered envelope validation before
      // aborting this connection; the replacement is installed only after the
      // background refetch settles.
      connectionGeneration += 1;
      controller?.abort();
      subscription.unsubscribe();
      // Refresh the exact page first, then replace the old subscription. This
      // avoids reconnecting against a stale cursor or cached snapshot.
      void execute(candidate, { mode: 'background', force: true })
        .catch(() => undefined)
        .finally(() => {
          if (active && !disposed && currentGeneration === liveGeneration)
            connect();
        });
    };
    handle = { unsubscribe, reconnect };
    connect();
    live = handle;
    return handle;
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
      if (entry) cache.set(key, { ...entry, updatedAt: 0 });
      publish({ ...state, stale: true });
    },
    dispose() {
      disposed = true;
      generation += 1;
      liveGeneration += 1;
      visibleController?.abort(abortError());
      live?.unsubscribe();
      live = undefined;
      request = undefined;
      listeners.clear();
      cache.clear();
      latestSuccessfulFlight.clear();
      inFlight.clear();
    },
  };
}
