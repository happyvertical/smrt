import {
  createSmrtWebQuery,
  type SmrtWebCollection,
  type SmrtWebDataQueryRequest,
  type SmrtWebDataQueryResult,
  type SmrtWebQuery,
  type SmrtWebQueryLiveSubscription,
  type SmrtWebQueryRunOptions,
  type SmrtWebQueryState,
  type SmrtWebQueryTransport,
} from '@happyvertical/smrt-web';

export interface RemoteQueryBinding<TData extends object = object> {
  readonly rows: ReadonlyArray<TData>;
  readonly page: SmrtWebQueryState<TData>['page'];
  readonly total: SmrtWebQueryState<TData>['total'];
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly error: unknown;
  readonly lastUpdated: number | undefined;
  /** Latest applied result, including query-scoped live replacements. */
  readonly result?: SmrtWebDataQueryResult | undefined;
  readonly request: SmrtWebDataQueryRequest | undefined;
  execute(
    request: SmrtWebDataQueryRequest,
    options?: SmrtWebQueryRunOptions,
  ): Promise<SmrtWebDataQueryResult>;
  refresh(
    options?: Omit<SmrtWebQueryRunOptions, 'mode' | 'force'>,
  ): Promise<SmrtWebDataQueryResult | undefined>;
  retry(): Promise<SmrtWebDataQueryResult | undefined>;
  subscribeLive(): SmrtWebQueryLiveSubscription | undefined;
  dispose(): void;
}

/**
 * Bind a canonical remote query to Svelte 5 state. The binding is query
 * shaped: rows are only the requested page and never the entire collection.
 * Call during component initialization so cleanup follows the component.
 */
export function remoteQuery<TData extends object>(
  collection: SmrtWebCollection<TData>,
  transport: SmrtWebQueryTransport,
  options?: { staleTimeMs?: number },
): RemoteQueryBinding<TData> {
  const query: SmrtWebQuery<TData> = createSmrtWebQuery(
    collection,
    transport,
    options,
  );
  let snapshot = $state<SmrtWebQueryState<TData>>(query.state);
  let activeRequest = $state<SmrtWebDataQueryRequest | undefined>(
    query.request,
  );
  const unsubscribe = query.subscribe((next) => {
    snapshot = next;
    activeRequest = query.request;
  });
  $effect(() => () => {
    unsubscribe();
    query.dispose();
  });
  const binding: RemoteQueryBinding<TData> = {
    get rows() {
      return snapshot.rows;
    },
    get page() {
      return snapshot.page;
    },
    get total() {
      return snapshot.total;
    },
    get loading() {
      return snapshot.loading;
    },
    get refreshing() {
      return snapshot.refreshing;
    },
    get stale() {
      return snapshot.stale;
    },
    get error() {
      return snapshot.error;
    },
    get lastUpdated() {
      return snapshot.lastUpdated;
    },
    get result() {
      return snapshot.result;
    },
    get request() {
      return activeRequest;
    },
    execute: (request, runOptions) => query.execute(request, runOptions),
    refresh: (runOptions) => query.refresh(runOptions),
    retry: () => query.retry(),
    subscribeLive: () => query.subscribeLive(),
    dispose: () => {
      unsubscribe();
      query.dispose();
    },
  };
  return binding;
}
