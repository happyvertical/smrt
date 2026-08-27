/**
 * A rune-backed stand-in for a `ContentListQueryBinding` (#2452).
 *
 * The production binding is `remoteQuery(...)` from
 * `@happyvertical/smrt-svelte/web`, whose getters read Svelte 5 `$state`. A
 * plain object would satisfy the type but not the reactivity contract, so the
 * fake is a `.svelte.ts` module and drives the same reactive reads. That keeps
 * the component test honest about *when* the list re-renders, not only about
 * what it renders.
 */

import type {
  ContentListDataQueryRequest,
  ContentListQueryBinding,
  ContentListQueryTotal,
} from '../../content-list-query.js';

export interface FakeContentListQuery {
  binding: ContentListQueryBinding;
  /** Every request the component executed, oldest first. */
  readonly requests: ContentListDataQueryRequest[];
  /** How many times the list asked the binding to retry. */
  readonly retries: number;
  readonly refreshes: number;
  readonly liveSubscriptions: number;
  readonly reconnects: number;
  readonly liveUnsubscribes: number;
  /** Publish a result page. `total` defaults to the page length. */
  resolve(rows: Array<Record<string, unknown>>, total?: number): void;
  /**
   * Publish a result page with an arbitrary total kind. `DataQueryTotal` is
   * exact | estimated | unavailable, and only `exact` is authoritative for
   * clamping, so the other two need to be expressible here.
   */
  resolveWithTotal(
    rows: Array<Record<string, unknown>>,
    total: ContentListQueryTotal,
  ): void;
  /** Publish a failure. */
  fail(error: unknown): void;
  /** Toggle the busy flags independently of a request. */
  setBusy(options: { loading?: boolean; refreshing?: boolean }): void;
  setFreshness(options: { stale?: boolean; lastUpdated?: number }): void;
  /** Publish a query-scoped live replacement and its completeness envelope. */
  publishLive(
    rows: Array<Record<string, unknown>>,
    envelope: unknown,
    total?: number,
  ): void;
  /**
   * The envelope subsequent `execute` calls resolve with. `RemoteQueryBinding`
   * does not expose `truncated`/`warnings`, so this is the path the component
   * actually reads them through.
   */
  setEnvelope(envelope: unknown): void;
}

export function createFakeContentListQuery(): FakeContentListQuery {
  let rows = $state<Array<Record<string, unknown>>>([]);
  let total = $state<ContentListQueryTotal | undefined>(undefined);
  let loading = $state(false);
  let refreshing = $state(false);
  let error = $state<unknown>(null);
  let stale = $state(false);
  let lastUpdated = $state<number | undefined>(undefined);
  let result = $state<unknown>(undefined);
  const requests: ContentListDataQueryRequest[] = [];
  let retries = 0;
  let refreshes = 0;
  let liveSubscriptions = 0;
  let reconnects = 0;
  let liveUnsubscribes = 0;
  let envelope: unknown;

  const binding: ContentListQueryBinding = {
    get rows() {
      return rows;
    },
    get total() {
      return total;
    },
    get loading() {
      return loading;
    },
    get refreshing() {
      return refreshing;
    },
    get stale() {
      return stale;
    },
    get error() {
      return error;
    },
    get lastUpdated() {
      return lastUpdated;
    },
    get result() {
      return result;
    },
    async execute(request) {
      requests.push(request);
      result = envelope;
      return envelope;
    },
    async retry() {
      retries += 1;
      // `remoteQuery.retry()` resolves the refreshed envelope, and the
      // component reads the completeness flags off it.
      result = envelope;
      return envelope;
    },
    async refresh() {
      refreshes += 1;
      result = envelope;
      return envelope;
    },
    subscribeLive() {
      liveSubscriptions += 1;
      return {
        reconnect() {
          reconnects += 1;
        },
        unsubscribe() {
          liveUnsubscribes += 1;
        },
      };
    },
  };

  return {
    binding,
    requests,
    get retries() {
      return retries;
    },
    get refreshes() {
      return refreshes;
    },
    get liveSubscriptions() {
      return liveSubscriptions;
    },
    get reconnects() {
      return reconnects;
    },
    get liveUnsubscribes() {
      return liveUnsubscribes;
    },
    resolve(nextRows, nextTotal) {
      rows = nextRows;
      total = { kind: 'exact', value: nextTotal ?? nextRows.length };
      loading = false;
      refreshing = false;
      error = null;
      stale = false;
      lastUpdated = Date.now();
      result = envelope;
    },
    resolveWithTotal(nextRows, nextTotal) {
      rows = nextRows;
      total = nextTotal;
      loading = false;
      refreshing = false;
      error = null;
      stale = false;
      lastUpdated = Date.now();
    },
    fail(nextError) {
      error = nextError;
      loading = false;
      refreshing = false;
    },
    setBusy(options) {
      if (options.loading !== undefined) loading = options.loading;
      if (options.refreshing !== undefined) refreshing = options.refreshing;
    },
    setFreshness(options) {
      if (options.stale !== undefined) stale = options.stale;
      if (options.lastUpdated !== undefined) lastUpdated = options.lastUpdated;
    },
    publishLive(nextRows, nextEnvelope, nextTotal) {
      rows = nextRows;
      total = { kind: 'exact', value: nextTotal ?? nextRows.length };
      loading = false;
      refreshing = false;
      error = null;
      stale = false;
      lastUpdated = Date.now();
      result = nextEnvelope;
    },
    setEnvelope(next) {
      envelope = next;
    },
  };
}
