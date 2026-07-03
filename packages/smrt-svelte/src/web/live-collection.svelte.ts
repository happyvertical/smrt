/**
 * Svelte 5 live-query bindings for `@happyvertical/smrt-web` (#1761, slice A).
 *
 * Turns a SMRT-owned {@link SmrtWebCollection} into runes-reactive live-query
 * state plus mutation helpers, so a consumer writes reactive components WITHOUT
 * importing TanStack. The client-data engine (`@tanstack/db` +
 * `@tanstack/svelte-db`) is used only inside this module — its types never
 * appear on the public surface, mirroring smrt-web's own engine-absorption
 * boundary (ratified condition for #1761).
 *
 * Two engine facts drive the shape of this file:
 *
 * 1. `useLiveQuery` internally uses `$state`/`$derived`/`$effect`, so it (and
 *    therefore {@link liveCollection}) MUST be called during Svelte component
 *    initialization — exactly like this package's other `use*` composables.
 *    Its internal `$effect` binds to the calling component's lifecycle, so the
 *    live subscription is torn down automatically when the component unmounts.
 *
 * 2. `@tanstack/svelte-db` live-query rows carry ENUMERABLE engine virtual
 *    props (`$key`/`$origin`/`$synced`/`$collectionId`) that would otherwise
 *    escape through spread or JSON. Every exposed row is projected to a plain
 *    DTO by stripping `$`-prefixed keys (the `$` prefix is reserved for the
 *    engine; SMRT columns never begin with it), mirroring smrt-web's internal
 *    `toPlainRow`.
 */

import {
  getEngineCollection,
  type SmrtWebCollection,
  type SmrtWebRow,
} from '@happyvertical/smrt-web';
import type { Collection } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/svelte-db';

// ---------------------------------------------------------------------------
// SMRT-owned public surface (no @tanstack/* type appears below this line in an
// exported position — the engine stays swappable behind these interfaces).
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a {@link LiveCollection}'s underlying read.
 *
 * - `loading` — the first load has not completed yet (also covers the engine's
 *   pre-start `idle` and post-teardown `cleaned-up` phases).
 * - `ready` — data has arrived and the collection is live.
 * - `error` — the read failed during sync initialization.
 */
export type LiveCollectionStatus = 'loading' | 'ready' | 'error';

/**
 * A live, runes-reactive view over a {@link SmrtWebCollection}. Read `rows`,
 * `status`, and `error` directly in markup — they update as the collection
 * changes. Do NOT destructure this object (Svelte 5 reactivity is lost on
 * destructure); read through the object, e.g. `view.rows`, or wrap in
 * `$derived`.
 */
export interface LiveCollection<TData extends object> {
  /** Live rows as plain DTOs (no `$`-prefixed engine props), insertion order. */
  readonly rows: ReadonlyArray<SmrtWebRow<TData>>;
  /** Coarse lifecycle status of the underlying read. */
  readonly status: LiveCollectionStatus;
  /**
   * The most recent error surfaced by the underlying read, or `null`. Mutation
   * errors are surfaced on the {@link LiveCollectionMutation} returned by the
   * mutation helpers, not here.
   */
  readonly error: unknown;
  /** True while the first load has not completed (`status === 'loading'`). */
  readonly isLoading: boolean;
  /** True once data has arrived (`status === 'ready'`). */
  readonly isReady: boolean;
  /** True when the underlying read failed (`status === 'error'`). */
  readonly isError: boolean;
  /**
   * Optimistically insert a row and persist it through the collection's create
   * surface. The row is visible in `rows` synchronously; the returned handle's
   * reactive `pending`/`error` track the server outcome and a failed create
   * rolls the optimistic row back automatically.
   */
  insert(row: SmrtWebRow<TData>): LiveCollectionMutation;
}

/**
 * Reactive handle to one in-flight mutation. Read `pending`/`error`/`settled`
 * in markup to drive optimistic UI; await {@link done} to observe completion
 * imperatively. All fields are SMRT-owned — no engine transaction leaks.
 */
export interface LiveCollectionMutation {
  /** True while the write is persisting; flips to false on success or failure. */
  readonly pending: boolean;
  /** True once the write has settled (persisted or rolled back). */
  readonly settled: boolean;
  /** The rollback error if the write failed, else `null`. */
  readonly error: unknown;
  /**
   * Resolves when the write settles (persisted or rolled back); read
   * {@link error} (or {@link settled}) for the outcome. Never rejects, so
   * reactive-only consumers never risk an unhandled rejection.
   */
  readonly done: Promise<void>;
}

/** Options for {@link liveCollection}. Reserved for forward-compatible growth. */
export interface LiveCollectionOptions {
  /**
   * Trigger the collection's first load eagerly when the binding is created,
   * rather than waiting for the engine's first read. Defaults to `true`.
   */
  preload?: boolean;
}

// ---------------------------------------------------------------------------
// Engine-internal helpers (types below never reach an exported position)
// ---------------------------------------------------------------------------

/** Row shape the engine collection carries (DTO plus a required key). */
type EngineRow<TData extends object> = SmrtWebRow<TData>;

/**
 * Project an engine live-query row to a plain public DTO by dropping every
 * `$`-prefixed key. Mirrors smrt-web's internal `toPlainRow`: the `$` prefix is
 * reserved for the engine's enumerable virtual props (`$key`/`$origin`/
 * `$synced`/`$collectionId`); SMRT columns never begin with it. Char code 36
 * is `'$'`.
 */
function toPlainRow<TData extends object>(row: unknown): SmrtWebRow<TData> {
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (key.charCodeAt(0) !== 36) plain[key] = value;
  }
  return plain as SmrtWebRow<TData>;
}

/** Map the engine's fine-grained status to the coarse SMRT-owned status. */
function toLiveStatus(
  isReady: boolean,
  isError: boolean,
): LiveCollectionStatus {
  if (isError) return 'error';
  if (isReady) return 'ready';
  return 'loading';
}

/**
 * Create a runes-reactive live view over a {@link SmrtWebCollection}.
 *
 * MUST be called during Svelte component initialization (it delegates to
 * `@tanstack/svelte-db`'s `useLiveQuery`, which sets up a `$effect`). The live
 * subscription is torn down automatically when the calling component unmounts.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { createSmrtCollection } from '@happyvertical/smrt-web';
 *   import { liveCollection } from '@happyvertical/smrt-svelte/web';
 *   import { productsDefinition } from '@happyvertical/smrt-virt-web';
 *
 *   const products = createSmrtCollection(productsDefinition, {});
 *   const view = liveCollection(products);
 *
 *   async function add() {
 *     const m = view.insert({ id: crypto.randomUUID(), name: 'New' });
 *     await m.done.catch(() => {}); // error also reflected on m.error
 *   }
 * </script>
 *
 * {#if view.isLoading}
 *   <p>Loading…</p>
 * {:else if view.isError}
 *   <p>Failed: {String(view.error)}</p>
 * {:else}
 *   <ul>
 *     {#each view.rows as row (row.id)}
 *       <li>{row.name}</li>
 *     {/each}
 *   </ul>
 * {/if}
 * ```
 */
export function liveCollection<TData extends object>(
  handle: SmrtWebCollection<TData>,
  options: LiveCollectionOptions = {},
): LiveCollection<TData> {
  const { preload = true } = options;

  // Bridge to the engine collection (typed `unknown` at the boundary — cast to
  // the engine `Collection` here, and confine that type to this module).
  const engine = getEngineCollection(handle) as Collection<
    EngineRow<TData>,
    string | number,
    Record<string, never>
  >;

  // Kick the first load without forcing consumers to await preload() — the
  // live query subscribes lazily, so nudge it when requested. Swallow the
  // rejection: a load failure (network error, or an SSR relative-URL
  // `Failed to parse URL` TypeError) already surfaces reactively via the
  // live-query status; this fire-and-forget must not become an unhandled
  // rejection.
  if (preload) {
    void handle.preload().catch(() => {});
  }

  // The live query over the whole base collection. No `.select()` → `data`
  // carries the full row objects (with engine virtual props, stripped below).
  // `useLiveQuery` installs a `$effect`; calling `liveCollection` outside a
  // component surfaces Svelte's own "effect outside component" error, which is
  // the correct signal.
  const query = useLiveQuery((q) => q.from({ row: engine }));

  // Project rows to plain DTOs reactively. `query.data` is a $state-backed
  // reactive array; `$derived.by` recomputes the projection when it changes.
  const rows = $derived.by(() =>
    query.data.map((row) => toPlainRow<TData>(row)),
  );
  const status = $derived(toLiveStatus(query.isReady, query.isError));
  // useLiveQuery does not surface an error object, only an error status; expose
  // the status string as the error payload when the read has failed.
  const error = $derived<unknown>(query.isError ? query.status : null);

  return {
    get rows() {
      return rows;
    },
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get isLoading() {
      return status === 'loading';
    },
    get isReady() {
      return status === 'ready';
    },
    get isError() {
      return status === 'error';
    },
    insert(row) {
      return createMutation(() => handle.insert(row).isPersisted.promise);
    },
  };
}

/**
 * Wrap a transaction's settle promise in a reactive {@link LiveCollectionMutation}.
 * Runs the mutation immediately; tracks pending/error via runes. Kept separate
 * so `insert` (and future `update`/`delete` helpers) share one reactive shape.
 */
function createMutation(run: () => Promise<unknown>): LiveCollectionMutation {
  let pending = $state(true);
  let settled = $state(false);
  let error = $state<unknown>(null);

  // `done` RESOLVES on settle whether the write persisted or rolled back — the
  // failure is surfaced only reactively via `error`. Re-throwing here would
  // reject `done`, which a reactive-only consumer (reads `error`/`pending` in
  // markup, never awaits `done`) would leave as an unhandled rejection.
  const done = run().then(
    () => {
      pending = false;
      settled = true;
    },
    (cause: unknown) => {
      pending = false;
      settled = true;
      error = cause;
    },
  );

  return {
    get pending() {
      return pending;
    },
    get settled() {
      return settled;
    },
    get error() {
      return error;
    },
    get done() {
      return done;
    },
  };
}
