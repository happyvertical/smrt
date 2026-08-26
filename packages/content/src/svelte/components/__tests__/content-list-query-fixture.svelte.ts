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
  /** Publish a result page. `total` defaults to the page length. */
  resolve(rows: Array<Record<string, unknown>>, total?: number): void;
  /** Publish a failure. */
  fail(error: unknown): void;
  /** Toggle the busy flags independently of a request. */
  setBusy(options: { loading?: boolean; refreshing?: boolean }): void;
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
  const requests: ContentListDataQueryRequest[] = [];
  let retries = 0;
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
      return false;
    },
    get error() {
      return error;
    },
    async execute(request) {
      requests.push(request);
      return envelope;
    },
    async retry() {
      retries += 1;
      // `remoteQuery.retry()` resolves the refreshed envelope, and the
      // component reads the completeness flags off it.
      return envelope;
    },
  };

  return {
    binding,
    requests,
    get retries() {
      return retries;
    },
    resolve(nextRows, nextTotal) {
      rows = nextRows;
      total = { kind: 'exact', value: nextTotal ?? nextRows.length };
      loading = false;
      refreshing = false;
      error = null;
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
    setEnvelope(next) {
      envelope = next;
    },
  };
}
