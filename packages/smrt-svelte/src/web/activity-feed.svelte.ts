/**
 * AdminShell activity feed adapter — bridge a `@happyvertical/smrt-web` live
 * collection into the AdminShell activity registry (#1779, part of the WASD
 * AdminShell epic #1766).
 *
 * This is a thin, OPT-IN CONSUMER of already-shipped infrastructure, not a new
 * generated surface. It sits at the intersection of two existing contracts:
 *
 *  - the runes-reactive {@link liveCollection} view over a `SmrtWebCollection`
 *    (`@happyvertical/smrt-svelte/web`, slice A of #1761), and
 *  - the `ShellState` activity registry (`upsertActivity` / `updateActivity` /
 *    `removeActivity`, from `components/workspace/admin-shell`).
 *
 * The app supplies (a) the `@smrt()` DOMAIN collection (a `SmrtWebCollection`)
 * and (b) an editorial {@link ActivityFeedMap} that turns each row into the
 * shell-facing activity fields (`kind`, `scope`, `label`, `progress`, …). The
 * adapter reconciles the mapped rows against the shell as rows appear, change,
 * and vanish, and returns a disposer that removes the activities it created.
 *
 * ── Why it lives behind the `/web` opt-in entry ─────────────────────────────
 * `liveCollection` pulls the client-data engine (`@tanstack/db` +
 * `@tanstack/svelte-db`). Keeping this adapter in the `/web` subpath keeps that
 * engine OUT of the AdminShell core: nothing under `components/workspace/` may
 * import this module, so `@happyvertical/smrt-svelte/workspace` stays
 * transport-agnostic and TanStack-free (a hard constraint of #1766). The app
 * wires the adapter at the edge, next to where it already opts into `/web`.
 *
 * ── Engine-absorption boundary ──────────────────────────────────────────────
 * No `@tanstack/*` type appears here. The adapter reconciles against the plain
 * DTO rows exposed by {@link liveCollection} (which already strips the engine's
 * `$`-prefixed virtual props), so the engine stays swappable behind the same
 * boundary the rest of `/web` respects.
 *
 * ── Reconciliation, not change-diffing ──────────────────────────────────────
 * Rather than decode the engine's change payload, the adapter re-derives the
 * activity set from the current live rows on every reactive tick (via an
 * internal `$effect` over `view.rows`) and diffs it against what it last pushed
 * to the shell. This is robust to the change-notification shape (which is
 * engine-internal) and mirrors how the runtime's own consumers treat a change
 * as a "something moved, re-read" signal.
 */

import type { SmrtWebCollection, SmrtWebRow } from '@happyvertical/smrt-web';
import type { ShellState } from '../components/workspace/admin-shell/state.svelte.js';
import type { ShellActivity } from '../components/workspace/admin-shell/types.js';
import { liveCollection } from './live-collection.svelte.js';

/**
 * The shell-facing fields an {@link ActivityFeedMap} produces for one row — the
 * editorial half of a {@link ShellActivity}. The adapter owns the bookkeeping
 * fields (`id`, `createdAt`, `updatedAt`), so they are omitted here; `id` may be
 * supplied to decouple the activity id from the row id (it defaults to the row's
 * `id`). Everything a consumer legitimately controls (`kind`, `scope`, `label`,
 * `status`, `subject`, `progress`, `detailHref`, `message`, `edge`, `cancel`)
 * passes straight through.
 */
export type ShellActivityInput = Omit<
  ShellActivity,
  'id' | 'createdAt' | 'updatedAt'
> & {
  /**
   * Explicit activity id. Defaults to the row's `id` when omitted — the common
   * case (one activity per row). Supply it only to map a row onto a
   * differently-keyed activity.
   */
  id?: string;
};

/**
 * Map one live-collection row to its shell activity fields, or `null` to
 * exclude the row from the feed.
 *
 * Returning `null` is a first-class signal: a row that maps to `null` is NOT an
 * activity (e.g. a draft the shell should ignore), and a row that STOPS mapping
 * to an activity — flips from a value to `null` — is removed from the shell,
 * exactly as if it had vanished from the collection. This lets the editorial map
 * gate which rows surface without the consumer filtering the collection.
 *
 * @typeParam TData - the row DTO shape carried by the collection.
 */
export type ActivityFeedMap<TData extends object> = (
  row: SmrtWebRow<TData>,
) => ShellActivityInput | null;

/**
 * Options for {@link activityFeed}.
 *
 * @typeParam TData - the row DTO shape carried by {@link collection}.
 */
export interface ActivityFeedOptions<TData extends object> {
  /**
   * The domain live collection to bridge — a `SmrtWebCollection` from
   * `@happyvertical/smrt-web` (e.g. built by the app's `createSmrtCollection`
   * over its `@smrt()` class). Its rows drive the feed.
   */
  collection: SmrtWebCollection<TData>;
  /**
   * The editorial mapping from a row to its shell activity fields (or `null` to
   * exclude the row). See {@link ActivityFeedMap}.
   */
  map: ActivityFeedMap<TData>;
  /** The AdminShell state whose activity registry this feed drives. */
  shell: ShellState;
  /**
   * Forwarded to the underlying {@link liveCollection}: trigger the collection's
   * first load eagerly when the feed is created. Defaults to `true`.
   */
  preload?: boolean;
}

/**
 * A handle to a running {@link activityFeed}. Call {@link dispose} to detach the
 * feed and remove every activity it created; read {@link isDisposed} to check.
 */
export interface ActivityFeedHandle {
  /**
   * Detach the feed: remove every activity this feed still owns from the shell
   * and stop reconciling. Idempotent. The underlying live-query subscription is
   * torn down by Svelte when the hosting component unmounts (that is where
   * `activityFeed` must be called); call this to remove the feed's activities
   * sooner, or when tearing a feed down without unmounting.
   */
  dispose(): void;
  /** True once {@link dispose} has run. */
  readonly isDisposed: boolean;
}

/**
 * A stable, order-independent fingerprint of the shell-relevant fields of a
 * mapped activity, used to detect whether a row's mapping actually CHANGED
 * between reconcile ticks. Only fields the shell renders or keys on are
 * included; the `cancel` callback is compared by identity (functions are not
 * serializable and a new closure each map would otherwise force a spurious
 * update every tick, re-stamping `updatedAt` and re-emitting events).
 *
 * Reconciliation writes to the shell only when this fingerprint differs, so a
 * no-op reactive tick (rows re-observed but unchanged) performs zero shell
 * mutations.
 */
interface ActivityFingerprint {
  readonly signature: string;
  readonly cancel: ShellActivity['cancel'];
}

/** One activity currently owned by the feed: its last input plus fingerprint. */
interface OwnedActivity {
  readonly input: ShellActivityInput & { id: string };
  readonly fingerprint: ActivityFingerprint;
}

/**
 * Compute the change-detection fingerprint for a resolved activity input. The
 * signature is a JSON projection of the shell-relevant fields in a FIXED key
 * order (so key ordering in the mapper output never registers as a change); the
 * non-serializable `cancel` is carried alongside for identity comparison.
 */
function fingerprintOf(
  input: ShellActivityInput & { id: string },
): ActivityFingerprint {
  const signature = JSON.stringify([
    input.id,
    input.label,
    input.kind,
    input.scope,
    input.status,
    input.progress ?? null,
    input.message ?? null,
    input.detailHref ?? null,
    input.edge ?? null,
    input.subject
      ? [input.subject.type, input.subject.id, input.subject.label ?? null]
      : null,
  ]);
  return { signature, cancel: input.cancel };
}

/** Two fingerprints are equal when their signatures AND `cancel` identity match. */
function fingerprintsEqual(
  a: ActivityFingerprint,
  b: ActivityFingerprint,
): boolean {
  return a.signature === b.signature && a.cancel === b.cancel;
}

/**
 * Resolve a mapped input to a fully-keyed activity input, defaulting the
 * activity `id` to the row `id`. Returns `null` when the row has neither a
 * mapped `id` nor a usable row `id` (it cannot be tracked, so it is dropped
 * rather than pushed to the shell under an unstable key).
 */
function resolveInput<TData extends object>(
  row: SmrtWebRow<TData>,
  mapped: ShellActivityInput,
): (ShellActivityInput & { id: string }) | null {
  const id = mapped.id ?? row.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { ...mapped, id };
}

/**
 * Build the update patch for a re-mapped activity so it REPLACES the mapped
 * field set rather than merging over it.
 *
 * `ShellState.updateActivity(id, patch)` merges `{ ...current, ...patch }`, so a
 * key the new mapping OMITS would otherwise retain its stale prior value. To
 * keep the shell activity an exact mirror of the current mapping, every field a
 * map controls is listed EXPLICITLY here — an omitted optional field is carried
 * as `undefined`, which overwrites the stale value on merge. Two consequences:
 *
 *  - Dropped optionals (`message`, `detailHref`, `subject`, `progress`, `cancel`)
 *    are cleared, not kept (codex P2).
 *  - `edge` is passed through as the mapping left it — `undefined` when the map
 *    did not pin an edge — so when a row's `scope` changes without an explicit
 *    `edge`, the merged activity carries `edge: undefined` and `upsertActivity`
 *    RE-DERIVES the edge from the new scope (`edge ?? homeEdgeForScope(scope)`),
 *    re-homing it instead of pinning it to the previous scope's edge (copilot).
 *
 * `id` is deliberately excluded (it is the update key, not a patched field).
 */
function toUpdatePatch(
  input: ShellActivityInput & { id: string },
): Partial<Omit<ShellActivity, 'id'>> {
  return {
    label: input.label,
    kind: input.kind,
    scope: input.scope,
    status: input.status,
    subject: input.subject,
    edge: input.edge,
    progress: input.progress,
    detailHref: input.detailHref,
    message: input.message,
    cancel: input.cancel,
  };
}

/**
 * The pure reconciliation core of {@link activityFeed}: it owns the diff between
 * a set of live rows and the shell's activity registry, with NO Svelte reactive
 * or client-data-engine dependency. {@link activityFeed} wraps one of these in a
 * `$effect` over a {@link liveCollection} view; this split keeps the mapping /
 * create-update-remove / ownership logic testable against a real `ShellState`
 * with plain row arrays (mock only externals — see the `__tests__`).
 *
 * @internal Not part of the public surface — use {@link activityFeed}.
 * @typeParam TData - the row DTO shape being reconciled.
 */
export class ActivityFeedReconciler<TData extends object> {
  /**
   * Activities this feed currently owns, keyed by activity id, each with the
   * last resolved input + fingerprint so a reconcile can tell created / changed
   * / unchanged apart and remove exactly its own set on teardown.
   */
  private readonly owned = new Map<string, OwnedActivity>();
  private disposed = false;

  constructor(
    private readonly shell: ShellState,
    private readonly map: ActivityFeedMap<TData>,
  ) {}

  /** True once {@link dispose} has run. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Reconcile `rows` against the owned activity set: upsert newly-appearing
   * activities, update changed ones, remove vanished ones. A pure diff — an
   * unchanged tick (same rows, same mappings) performs ZERO shell mutations.
   * No-op once disposed.
   */
  reconcile(rows: ReadonlyArray<SmrtWebRow<TData>>): void {
    if (this.disposed) return;

    // Resolve this tick's activities from the rows. A row mapping to `null`, or
    // resolving to no usable id, is simply absent from `next` — which makes the
    // removal pass below retract it if the feed owned it last tick.
    const next = new Map<string, OwnedActivity>();
    for (const row of rows) {
      const mapped = this.map(row);
      if (mapped === null) continue;
      const input = resolveInput(row, mapped);
      if (input === null) continue;
      // Last write wins if two rows resolve to the same activity id — matches
      // the shell's own upsert-by-id semantics.
      next.set(input.id, { input, fingerprint: fingerprintOf(input) });
    }

    // Removals: ids the feed owned last tick but that are gone now.
    for (const id of this.owned.keys()) {
      if (!next.has(id)) {
        this.shell.removeActivity(id);
        this.owned.delete(id);
      }
    }

    // Creates + updates.
    for (const [id, entry] of next) {
      const prior = this.owned.get(id);
      if (!prior) {
        // First appearance: create it (stamps createdAt/updatedAt in the shell).
        this.shell.upsertActivity({ ...entry.input });
        this.owned.set(id, entry);
        continue;
      }
      if (!fingerprintsEqual(prior.fingerprint, entry.fingerprint)) {
        // Changed: patch it, preserving createdAt and letting the shell emit a
        // `transition` when the status changed. The patch lists every mappable
        // field explicitly (see `toUpdatePatch`) so it REPLACES the mapped set
        // rather than merging over it — dropped optionals are cleared and a
        // changed `scope` re-derives the `edge` instead of pinning the old one.
        this.shell.updateActivity(id, toUpdatePatch(entry.input));
        this.owned.set(id, entry);
      }
      // Unchanged: no shell mutation.
    }
  }

  /**
   * Retract exactly this feed's activities from the shell and stop reconciling.
   * Idempotent. Activities owned by other sources are left untouched.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.owned.keys()) this.shell.removeActivity(id);
    this.owned.clear();
  }
}

/**
 * Bridge a `@happyvertical/smrt-web` live collection into an AdminShell's
 * activity registry: each mapped row becomes a {@link ShellActivity} that
 * appears, updates, and disappears in the shell as the collection changes.
 *
 * MUST be called during Svelte component initialization — it delegates to
 * {@link liveCollection} (which installs a `$effect`) and installs its own
 * reconciliation `$effect`. Both bind to the calling component's lifecycle, so
 * the live subscription and reconciliation tear down automatically on unmount.
 * Unmount ALSO auto-retracts the feed's activities from the shell (via an
 * `$effect` teardown), so they never linger after the host component is gone —
 * no manual cleanup required. The returned {@link ActivityFeedHandle.dispose}
 * retracts them SOONER (without unmounting) and is idempotent, so calling it and
 * then unmounting is safe.
 *
 * Lifecycle per row:
 *  - a row that newly maps to an activity → `shell.upsertActivity(...)` (creates
 *    it, stamping `createdAt`);
 *  - an owned row whose mapping changes → `shell.updateActivity(id, patch)`
 *    (preserves `createdAt`, bumps `updatedAt`, and the shell emits a
 *    `transition` event when `status` changed — driving toasts);
 *  - a row that vanishes, or whose mapping flips to `null` →
 *    `shell.removeActivity(id)`.
 *
 * Only activities this feed created are ever touched: activities pushed to the
 * shell by other sources (or a second feed) are left untouched, and `dispose`
 * removes exactly this feed's set.
 *
 * @typeParam TData - the row DTO shape carried by {@link ActivityFeedOptions.collection}.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { activityFeed } from '@happyvertical/smrt-svelte/web';
 *   import { useAdminShell } from '@happyvertical/smrt-svelte/workspace';
 *   import { createSmrtCollection } from '@happyvertical/smrt-web';
 *   import { getCollectionDefinition } from '@happyvertical/smrt-virt-web';
 *
 *   const shell = useAdminShell();
 *   const encodes = createSmrtCollection(getCollectionDefinition('encodes'), {});
 *
 *   // Reconciles `encodes` rows into the shell's Focus scope; disposes on unmount.
 *   activityFeed({
 *     collection: encodes,
 *     shell,
 *     map: (row) => ({
 *       kind: 'video-encode',
 *       scope: 'focus',
 *       label: row.title,
 *       status: row.state,          // 'running' | 'completed' | …
 *       progress: row.progress,
 *     }),
 *   });
 * </script>
 * ```
 */
export function activityFeed<TData extends object>(
  options: ActivityFeedOptions<TData>,
): ActivityFeedHandle {
  const { collection, map, shell, preload = true } = options;

  // Build the runes-reactive live view over the domain collection. This is the
  // sole place the client-data engine is reached (through the `/web` binding),
  // and it MUST run during component init — as must `activityFeed` itself.
  const view = liveCollection<TData>(collection, { preload });

  // The pure diff core: holds ownership + create/update/remove logic, with no
  // reactive or engine dependency (unit-tested directly). This function just
  // feeds it the live rows on every reactive tick.
  const reconciler = new ActivityFeedReconciler<TData>(shell, map);

  // Reconcile whenever the live rows change. `view.rows` is a `$derived`-backed
  // reactive array; reading it inside `$effect` subscribes this effect to it, so
  // every insert/update/delete/rollback surfaced by the live view re-reconciles.
  // The effect binds to the hosting component and tears down on unmount.
  $effect(() => {
    reconciler.reconcile(view.rows);
  });

  // Auto-cleanup on unmount: retract this feed's activities from the shell when
  // the hosting component is destroyed, so they never linger after the UI that
  // created them is gone. This effect reads NO reactive state, so it never
  // re-runs — its teardown fires only when the effect is destroyed (component
  // unmount / `$effect.root` teardown), exactly the unmount hook we want. The
  // returned `dispose()` stays available for callers that want to retract the
  // feed's activities sooner (without unmounting); `dispose` is idempotent, so
  // an explicit call followed by the unmount teardown is safe.
  $effect(() => {
    return () => reconciler.dispose();
  });

  return {
    dispose() {
      reconciler.dispose();
    },
    get isDisposed() {
      return reconciler.isDisposed;
    },
  };
}
