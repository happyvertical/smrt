/**
 * @happyvertical/smrt-web — capability extension seam (#1755).
 *
 * A capability is a small plug-in that hooks the {@link createSmrtCollection}
 * lifecycle so a follow-on client slice — the offline outbox (#1762),
 * persistence (#1764), or live SSE invalidation (#1763-client) — can live in
 * its OWN module instead of contending on `index.ts`. The factory runs the six
 * hooks below at fixed points; a collection with no capabilities is
 * byte-for-byte the collection of today (the no-op guarantee).
 *
 * ## The engine boundary is sacred
 *
 * Every type here is expressed ENTIRELY in existing SMRT-owned terms
 * (`SmrtWebCollectionDefinition`, `SmrtCrudFetchers`, `SmrtWebRow`, plain TS).
 * No `@tanstack/*` type — no `QueryClient`, no engine `Collection` — appears on
 * the capability surface, so the build's `.d.ts` boundary check stays green and
 * the engine stays swappable. A capability that genuinely needs deeper engine
 * access reaches it through the existing `getEngineCollection()` unknown-bridge
 * from inside its own module — NEVER by widening these types.
 *
 * These types intentionally import nothing from `./index.ts` beyond the
 * SMRT-owned contracts they name, so the seam is reviewable and unit-testable on
 * its own (see {@link runWrapMutation}).
 */

import type {
  SmrtCrudFetchers,
  SmrtWebCollectionDefinition,
  SmrtWebRow,
  SmrtWebSubscription,
} from './index.js';

/**
 * The context every capability hook receives — a stable, engine-free view of
 * the collection being built. All fields are the exact values the factory uses
 * internally (the resolved cache key/id, the same fetchers), so a capability
 * keys its own storage or subscriptions off the identical discriminators.
 */
export interface SmrtWebCapabilityContext<TData extends object = object> {
  /** The generated definition this collection materializes. */
  readonly definition: SmrtWebCollectionDefinition<TData>;
  /** The CRUD fetchers the collection persists through. */
  readonly fetchers: SmrtCrudFetchers;
  /**
   * The `queryKey` segments the collection's reads use — a LIVE view: from
   * `onAttach`/`warmStart` onward it is the final key (including every
   * capability-contributed segment); read during `contributeCacheKey` it omits
   * that capability's own not-yet-applied segment. Treat as read-only.
   */
  readonly cacheKey: readonly string[];
  /** The engine-collection id string (mirrors {@link cacheKey}). */
  readonly cacheId: string;
  /**
   * Enter the SAME relationship-derived invalidation the factory runs after a
   * settled mutation. A capability calls this to refetch this collection and its
   * manifest-related collections in response to an EXTERNAL trigger (e.g. an SSE
   * message) without reaching into the engine.
   */
  invalidate(): void;
  /**
   * A snapshot of the collection's current rows as plain public DTOs — the same
   * projection as {@link SmrtWebCollection.toArray}, so the engine's virtual
   * props never cross the boundary. The persistence slice (#1764) reads this in
   * its write-back to serialize the current cache to disk. Populated by the real
   * factory from `onAttach` onward; a hand-built test context may omit it, so
   * callers guard for its presence.
   */
  snapshot?(): ReadonlyArray<SmrtWebRow<TData>>;
  /**
   * Subscribe to the collection's change notifications — the same stream as
   * {@link SmrtWebCollection.subscribeChanges} (plain-DTO payloads). The
   * persistence slice (#1764) wires its debounced write-back here in `onAttach`
   * and detaches in `teardown`. Engine-free by construction: the payload is
   * `unknown` (the capability only needs the change SIGNAL, then re-reads via
   * {@link snapshot}), so no engine type crosses the seam. Populated by the real
   * factory; a hand-built test context may omit it.
   */
  subscribe?(callback: (changes: unknown) => void): SmrtWebSubscription;
}

/**
 * A single mutation described in SMRT-owned terms — handed to
 * {@link SmrtWebCapability.wrapMutation} and {@link SmrtWebCapability.onSettled}
 * so a capability can inspect or intercept a write without touching the engine's
 * transaction type.
 */
export interface SmrtWebMutationEnvelope {
  /** Which mutation kind this describes. */
  readonly kind: 'insert' | 'update' | 'delete';
  /** The row key: the client-local id on insert, else the target row's id. */
  readonly key: string;
  /**
   * The write payload: the full row on insert, the changed fields on update,
   * and an empty object on delete (the key carries the target).
   */
  readonly data: Record<string, unknown>;
  /**
   * The server `updated_at` / `updatedAt` value the mutation is based on, when
   * known. Update/delete handlers capture this from the original row so offline
   * replay can preserve the sync/apply conflict guard even when the write
   * payload only carries changed fields (or no fields for delete).
   */
  readonly baseUpdatedAt?: string;
}

/** The outcome handed to {@link SmrtWebCapability.wrapMutation}. */
export type WrapMutationOutcome =
  | { handled: true; result: unknown }
  | { handled: false }
  | undefined;

/** The settle outcome handed to {@link SmrtWebCapability.onSettled}. */
export type MutationSettleOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: unknown };

/**
 * A capability plugged into {@link createSmrtCollection}. Every hook is
 * optional; a capability implements only the points its slice needs. Hooks fire
 * in these fixed places, and capabilities run in ARRAY ORDER:
 *
 * - `contributeCacheKey` — ONCE, before the engine collection is constructed.
 * - `warmStart` — ONCE, before the first read (seeds the cache).
 * - `wrapMutation` — per mutation, BEFORE the fetcher, with a chance to handle
 *   the write itself (offline).
 * - `onSettled` — per mutation, AFTER it settles (success AND fetcher-throw).
 * - `onAttach` — ONCE, right after the engine collection is constructed; the
 *   ONLY place a capability registers an external (non-mutation) trigger such as
 *   an SSE subscription.
 * - `teardown` — in `cleanup()`, after the engine's own cleanup.
 */
export interface SmrtWebCapability<TData extends object = object> {
  /** Diagnostic name (e.g. `'offline-outbox'`). */
  readonly name: string;

  /**
   * Contribute extra cache-key segments so this capability can partition the
   * collection's cache (e.g. an outbox variant). Runs ONCE, before construction;
   * returned segments are appended to the collection's cache key/id. Return
   * `undefined` (or omit) to contribute nothing.
   */
  contributeCacheKey?(
    ctx: SmrtWebCapabilityContext<TData>,
  ): string[] | undefined;

  /**
   * Provide rows to seed the cache before the first read — the persistence
   * slice's rehydrate-from-disk path. Runs ONCE, before construction. NOTE:
   * caller-supplied `initialData` (fresher same-request SSR truth) WINS over any
   * capability `warmStart`. Return `undefined` to contribute no seed.
   */
  warmStart?(
    ctx: SmrtWebCapabilityContext<TData>,
  ): Promise<SmrtWebRow<TData>[] | undefined> | SmrtWebRow<TData>[] | undefined;

  /**
   * Intercept a mutation BEFORE its fetcher runs. Return `{ handled: true,
   * result }` to take over the write (the fetcher is skipped and `result`
   * reconciles the optimistic row — the offline path); return `{ handled: false
   * }` or `undefined` to fall through to the real fetcher. With multiple
   * capabilities the FIRST `{ handled: true }` wins and later capabilities'
   * `wrapMutation` are skipped.
   */
  wrapMutation?(
    envelope: SmrtWebMutationEnvelope,
    ctx: SmrtWebCapabilityContext<TData>,
  ): Promise<WrapMutationOutcome> | WrapMutationOutcome;

  /**
   * Observe a mutation after it settles — on BOTH a successful persist and a
   * fetcher throw (before the optimistic rollback propagates). Never swallows
   * the error: a thrown fetcher error still rolls the transaction back.
   */
  onSettled?(
    envelope: SmrtWebMutationEnvelope,
    outcome: MutationSettleOutcome,
    ctx: SmrtWebCapabilityContext<TData>,
  ): void;

  /**
   * Run ONCE, right after the engine collection is constructed. The ONLY hook
   * where a capability wires an external trigger (SSE subscription, focus
   * listener) — `ctx.invalidate()` is callable here.
   */
  onAttach?(ctx: SmrtWebCapabilityContext<TData>): void;

  /** Run inside `cleanup()`, AFTER the engine's own cleanup. Awaited if async. */
  teardown?(ctx: SmrtWebCapabilityContext<TData>): void | Promise<void>;
}

/**
 * Run the `wrapMutation` hook across `capabilities` in array order for one
 * mutation, short-circuiting on the FIRST capability that returns `{ handled:
 * true }` (later capabilities' `wrapMutation` are then skipped). A capability
 * that returns `{ handled: false }`, `undefined`, or omits the hook declines,
 * and the next is tried. When every capability declines, resolves `{ handled:
 * false }` so the factory falls through to the real fetcher.
 */
export async function runWrapMutation<TData extends object>(
  capabilities: readonly SmrtWebCapability<TData>[],
  envelope: SmrtWebMutationEnvelope,
  ctx: SmrtWebCapabilityContext<TData>,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  for (const capability of capabilities) {
    if (!capability.wrapMutation) continue;
    const outcome = await capability.wrapMutation(envelope, ctx);
    if (outcome?.handled) {
      return { handled: true, result: outcome.result };
    }
  }
  return { handled: false };
}
