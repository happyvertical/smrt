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
  const listeners = new Set<(state: SmrtWebQueryState<TData>) => void>();
  let request: SmrtWebDataQueryRequest | undefined;
  let visibleController: AbortController | undefined;
  let generation = 0;
  let live: SmrtWebQueryLiveSubscription | undefined;
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
  const apply = (
    result: SmrtWebDataQueryResult,
    candidate: SmrtWebDataQueryRequest,
    updatedAt = Date.now(),
  ): void => {
    const entry = { result, updatedAt };
    cache.set(keyFor(candidate), entry);
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
      return await executeSmrtWebDataQuery(transport, candidate, {
        signal: controller.signal,
      });
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
      visibleController = new AbortController();
      request = candidate;
      const current = generation;
      const signal = runOptions.signal;
      if (signal?.aborted) visibleController.abort(signal.reason);
      else if (signal)
        signal.addEventListener(
          'abort',
          () => visibleController?.abort(signal.reason),
          { once: true },
        );
      publish({
        ...state,
        loading: entry === undefined,
        refreshing: entry !== undefined,
        stale: entry !== undefined,
        error: null,
      });
      runOptions = { ...runOptions, signal: visibleController.signal };
      try {
        const result = await runShared(candidate, key, runOptions);
        if (current === generation) apply(result, candidate);
        return result;
      } catch (error) {
        if (current === generation && !isAbort(error)) {
          publish({
            ...state,
            loading: false,
            refreshing: false,
            stale: entry !== undefined,
            error,
          });
        }
        throw error;
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
    const running = runTransport(candidate, runOptions)
      .then((result) => {
        cache.set(key, { result, updatedAt: Date.now() });
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, running);
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
    if (!request || !transport.subscribe) return undefined;
    live?.unsubscribe();
    const candidate = request;
    const controller = new AbortController();
    const subscription = transport.subscribe(
      candidate,
      (raw) => {
        void (async () => {
          const result = await executeSmrtWebDataQuery(
            { query: async () => raw },
            candidate,
          );
          if (request && keyFor(request) === keyFor(candidate))
            apply(result, candidate);
        })().catch((error) => {
          if (!isAbort(error)) publish({ ...state, error });
        });
      },
      { signal: controller.signal },
    );
    const reconnect =
      'reconnect' in subscription &&
      typeof subscription.reconnect === 'function'
        ? () => (subscription as SmrtWebQueryLiveSubscription).reconnect()
        : () => {
            controller.abort();
            void execute(candidate, { mode: 'background', force: true });
          };
    live = {
      unsubscribe: () => {
        controller.abort();
        subscription.unsubscribe();
      },
      reconnect,
    };
    return live;
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
      cache.delete(keyFor(request));
      publish({ ...state, stale: true });
    },
    dispose() {
      generation += 1;
      visibleController?.abort(abortError());
      live?.unsubscribe();
      listeners.clear();
      cache.clear();
      inFlight.clear();
    },
  };
}

// Naming aliases keep the capability discoverable for consumers that call the
// feature a data query or a remote query; all aliases share the same controller.
export const createSmrtDataQuery = createSmrtWebQuery;
export const createSmrtQuery = createSmrtWebQuery;
