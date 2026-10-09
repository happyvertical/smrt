/**
 * Command palette state: provider registry, open/query state, local and
 * remote results, and keyboard selection. Components render this; assistants
 * and tests can drive it directly.
 */
import { logger } from '../../internal/logger.js';
import {
  buildPaletteSections,
  flattenSections,
  orderProviders,
} from './rank.js';
import type {
  PaletteErrorContext,
  PaletteItem,
  PaletteProvider,
  PaletteResult,
  PaletteSection,
} from './types.js';

export interface CommandPaletteOptions {
  /** Providers registered at construction (more can be registered later). */
  providers?: readonly PaletteProvider[];
  /**
   * Opens `href` for an item that has one. SvelteKit apps pass `goto`.
   * Default: `window.location.assign`.
   */
  navigate?: (href: string, item?: PaletteItem) => void | Promise<void>;
  /** Pause after the last keystroke before `search` providers run (ms). */
  searchDebounceMs?: number;
  /** Rows per group unless a provider sets `limit`. */
  maxPerGroup?: number;
  /**
   * Called when a provider fails to load or search, or an item's `run`
   * throws. The palette keeps working; default logs a warning.
   */
  onError?: (error: unknown, context: PaletteErrorContext) => void;
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class CommandPaletteController {
  #options: CommandPaletteOptions;
  #providers = $state.raw<readonly PaletteProvider[]>([]);
  #local = $state.raw<Readonly<Record<string, readonly PaletteItem[]>>>({});
  #remote = $state.raw<Readonly<Record<string, readonly PaletteItem[]>>>({});
  #failed = $state.raw<ReadonlySet<string>>(new Set());
  #itemsPending = $state(0);
  #searchPending = $state(0);
  #searchRun = 0;
  #activeKey = $state<string | null>(null);
  #open = $state(false);
  #query = $state('');

  #itemsAbort: AbortController | null = null;
  #searchAbort: AbortController | null = null;
  #searchTimer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;

  constructor(options: CommandPaletteOptions = {}) {
    this.#options = options;
    this.#providers = [...(options.providers ?? [])];
  }

  /** Whether the palette is showing. */
  get isOpen(): boolean {
    return this.#open;
  }

  /** The text in the search box. */
  get query(): string {
    return this.#query;
  }

  /** Registered providers, in registration order. */
  get providers(): readonly PaletteProvider[] {
    return this.#providers;
  }

  /** Whether any provider is still loading or searching. */
  get busy(): boolean {
    return this.#itemsPending + this.#searchPending > 0;
  }

  /** Ids of providers whose last load or search failed. */
  get failedProviders(): ReadonlySet<string> {
    return this.#failed;
  }

  /** Grouped, ranked rows for the current query. */
  readonly sections: readonly PaletteSection[] = $derived.by(() =>
    buildPaletteSections({
      providers: this.#providers,
      local: this.#local,
      remote: this.#remote,
      query: this.#query,
      maxPerGroup: this.#options.maxPerGroup,
    }),
  );

  /** The rows in display order. */
  readonly results: readonly PaletteResult[] = $derived(
    flattenSections(this.sections),
  );

  /** The highlighted row: the chosen one, else the first selectable row. */
  readonly active: PaletteResult | null = $derived.by(() => {
    const chosen = this.results.find(
      (result) => result.key === this.#activeKey && result.selectable,
    );
    return chosen ?? this.results.find((result) => result.selectable) ?? null;
  });

  /**
   * Register a provider; returns its disposer. Registering an id again
   * replaces the earlier provider in place (so a re-rendering component does
   * not stack duplicates); the disposer of a replaced registration is a no-op.
   */
  registerProvider(provider: PaletteProvider): () => void {
    const existing = this.#providers.findIndex((p) => p.id === provider.id);
    if (existing === -1) {
      this.#providers = [...this.#providers, provider];
    } else {
      this.#providers = this.#providers.map((p, index) =>
        index === existing ? provider : p,
      );
    }
    if (this.#open) {
      void this.#loadProvider(provider, this.#itemsSignal());
      if (this.#query.trim()) this.#scheduleSearch(0);
    }
    return () => {
      if (!this.#providers.includes(provider)) return;
      this.#providers = this.#providers.filter((p) => p !== provider);
      this.#local = omit(this.#local, provider.id);
      this.#remote = omit(this.#remote, provider.id);
    };
  }

  /** Show the palette with an empty query. */
  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.#query = '';
    this.#activeKey = null;
    this.#remote = {};
    this.#failed = new Set();
    this.#generation += 1;
    this.#itemsAbort?.abort();
    this.#itemsAbort = new AbortController();
    for (const provider of orderProviders(this.#providers)) {
      void this.#loadProvider(provider, this.#itemsAbort.signal);
    }
  }

  /** Hide the palette and cancel work in flight. */
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#query = '';
    this.#activeKey = null;
    this.#generation += 1;
    this.#cancelSearch();
    this.#itemsAbort?.abort();
    this.#itemsAbort = null;
    this.#itemsPending = 0;
    this.#searchPending = 0;
    this.#remote = {};
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  /** Set the search text; local rows update at once, `search` providers after a pause. */
  setQuery(query: string): void {
    if (query === this.#query) return;
    this.#query = query;
    this.#activeKey = null;
    this.#scheduleSearch(this.#options.searchDebounceMs ?? 150);
  }

  /** Move the highlight by `delta` rows among selectable ones, wrapping. */
  moveActive(delta: number): void {
    const selectable = this.results.filter((result) => result.selectable);
    if (selectable.length === 0) return;
    const current = this.active
      ? selectable.findIndex((result) => result.key === this.active?.key)
      : -1;
    const next =
      current === -1
        ? delta > 0
          ? 0
          : selectable.length - 1
        : (((current + delta) % selectable.length) + selectable.length) %
          selectable.length;
    this.#activeKey = selectable[next].key;
  }

  /** Move the highlight to the first or last selectable row. */
  moveActiveTo(edge: 'first' | 'last'): void {
    const selectable = this.results.filter((result) => result.selectable);
    if (selectable.length === 0) return;
    this.#activeKey = (
      edge === 'first' ? selectable[0] : selectable[selectable.length - 1]
    ).key;
  }

  /** Highlight a specific row (pointer hover). */
  setActive(key: string): void {
    const result = this.results.find((candidate) => candidate.key === key);
    if (result?.selectable) this.#activeKey = key;
  }

  /**
   * Choose a row (default: the highlighted one): closes the palette, then runs
   * the item or navigates to its `href`. Resolves once that has finished.
   */
  async activate(result: PaletteResult | null = this.active): Promise<void> {
    if (!result?.selectable) return;
    const { item, providerId } = result;
    const query = this.#query;
    this.close();
    try {
      if (item.run) {
        await item.run({
          query,
          providerId,
          navigate: (href) => this.navigate(href, item),
        });
      } else if (item.href) {
        await this.navigate(item.href, item);
      }
    } catch (error) {
      this.#report(error, { providerId, phase: 'run', item });
    }
  }

  /** Go to `href` with the host's `navigate` seam. */
  navigate(href: string, item?: PaletteItem): void | Promise<void> {
    if (this.#options.navigate) return this.#options.navigate(href, item);
    if (typeof window !== 'undefined') window.location.assign(href);
  }

  /** Cancel timers and requests; call when the owner is destroyed. */
  destroy(): void {
    this.#open = false;
    this.#generation += 1;
    this.#cancelSearch();
    this.#itemsAbort?.abort();
    this.#itemsAbort = null;
  }

  #itemsSignal(): AbortSignal {
    if (!this.#itemsAbort) this.#itemsAbort = new AbortController();
    return this.#itemsAbort.signal;
  }

  #report(error: unknown, context: PaletteErrorContext): void {
    if (this.#options.onError) {
      this.#options.onError(error, context);
      return;
    }
    logger.warn('[smrt-svelte] command palette provider failed', {
      ...context,
      item: context.item?.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  #markFailed(providerId: string, failed: boolean): void {
    if (this.#failed.has(providerId) === failed) return;
    const next = new Set(this.#failed);
    if (failed) next.add(providerId);
    else next.delete(providerId);
    this.#failed = next;
  }

  /** Read a provider's `items`; sync results land immediately. */
  #loadProvider(provider: PaletteProvider, signal: AbortSignal): Promise<void> {
    if (!provider.items) return Promise.resolve();
    const generation = this.#generation;
    const accept = (items: readonly PaletteItem[]) => {
      if (generation !== this.#generation || signal.aborted) return;
      this.#local = { ...this.#local, [provider.id]: items };
      this.#markFailed(provider.id, false);
    };
    let outcome: readonly PaletteItem[] | PromiseLike<readonly PaletteItem[]>;
    try {
      outcome = provider.items({ signal });
    } catch (error) {
      this.#markFailed(provider.id, true);
      this.#report(error, { providerId: provider.id, phase: 'items' });
      return Promise.resolve();
    }
    if (!isThenable<readonly PaletteItem[]>(outcome)) {
      accept(outcome);
      return Promise.resolve();
    }
    this.#itemsPending += 1;
    const settle = () => {
      // A close or reopen already reset the count for this generation.
      if (generation === this.#generation) {
        this.#itemsPending = Math.max(0, this.#itemsPending - 1);
      }
    };
    return Promise.resolve(outcome).then(
      (items) => {
        settle();
        accept(items);
      },
      (error) => {
        settle();
        if (generation !== this.#generation || signal.aborted) return;
        this.#markFailed(provider.id, true);
        this.#report(error, { providerId: provider.id, phase: 'items' });
      },
    );
  }

  #cancelSearch(): void {
    if (this.#searchTimer) clearTimeout(this.#searchTimer);
    this.#searchTimer = null;
    this.#searchAbort?.abort();
    this.#searchAbort = null;
    this.#searchRun += 1;
    this.#searchPending = 0;
  }

  #scheduleSearch(delayMs: number): void {
    if (this.#searchTimer) clearTimeout(this.#searchTimer);
    this.#searchTimer = null;
    this.#searchAbort?.abort();
    this.#searchAbort = null;
    this.#searchRun += 1;
    this.#searchPending = 0;
    const query = this.#query.trim();
    if (query.length === 0) {
      this.#remote = {};
      return;
    }
    if (!this.#open) return;
    this.#searchTimer = setTimeout(() => {
      this.#searchTimer = null;
      this.#runSearch(query);
    }, delayMs);
  }

  #runSearch(query: string): void {
    const generation = this.#generation;
    const controller = new AbortController();
    this.#searchAbort = controller;
    const run = ++this.#searchRun;
    this.#searchPending = 0;
    const stale = () =>
      generation !== this.#generation || controller.signal.aborted;
    const settle = () => {
      if (run === this.#searchRun) {
        this.#searchPending = Math.max(0, this.#searchPending - 1);
      }
    };

    for (const provider of this.#providers) {
      if (!provider.search) continue;
      if (query.length < (provider.minQueryLength ?? 2)) {
        // Too short for this provider: drop what an earlier, longer query left.
        if (this.#remote[provider.id]) {
          this.#remote = omit(this.#remote, provider.id);
        }
        continue;
      }
      const limit = provider.limit ?? this.#options.maxPerGroup ?? 8;
      let outcome: readonly PaletteItem[] | PromiseLike<readonly PaletteItem[]>;
      try {
        outcome = provider.search(query, { signal: controller.signal, limit });
      } catch (error) {
        this.#markFailed(provider.id, true);
        this.#report(error, { providerId: provider.id, phase: 'search' });
        continue;
      }
      // Earlier rows stay until these arrive, so a keystroke does not blank
      // the list; they are replaced (or cleared on failure) below.
      this.#searchPending += 1;
      Promise.resolve(outcome).then(
        (items) => {
          settle();
          if (stale()) return;
          this.#remote = { ...this.#remote, [provider.id]: items };
          this.#markFailed(provider.id, false);
        },
        (error) => {
          settle();
          if (stale()) return;
          this.#remote = omit(this.#remote, provider.id);
          this.#markFailed(provider.id, true);
          this.#report(error, { providerId: provider.id, phase: 'search' });
        },
      );
    }
  }
}

function omit<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** Create a palette controller. */
export function createCommandPalette(
  options: CommandPaletteOptions = {},
): CommandPaletteController {
  return new CommandPaletteController(options);
}
