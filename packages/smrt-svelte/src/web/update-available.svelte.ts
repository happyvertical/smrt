/**
 * Svelte 5 reactive binding for smrt-web's `updateAvailable` primitive (#1764).
 *
 * Turns the framework-free {@link UpdateState} from `@happyvertical/smrt-web`
 * into runes-reactive state a component can read directly to drive a toast /
 * reload prompt, and wires SvelteKit's native `updated` store (the BUNDLE
 * signal) into it. The contract signal (a manifest-hash change across loads) is
 * detected inside the smrt-web primitive under the build-time-inject decision;
 * this binding just surfaces both, plus the derived `updateAvailable = bundle ||
 * contract`.
 *
 * ## Why the caller passes `updated` in
 *
 * SvelteKit's `updated` store lives in `$app/state` / `$app/stores`, which only
 * resolve inside a SvelteKit app — a library that imported it could not build or
 * test standalone. So the consumer passes the CURRENT bundle-updated boolean via
 * {@link UseUpdateAvailableOptions.updated} (e.g. `() => updated.current` on
 * modern SvelteKit, or a `$derived` over the legacy `$updated` store). This
 * keeps the binding browser-safe and SvelteKit-version-agnostic, matching how
 * this package's other `/web` adapters take runtime input as parameters rather
 * than importing app-only modules.
 *
 * MUST be called during Svelte component initialization (it installs a
 * `$effect`), like this package's other `use*` composables. The subscription to
 * the primitive and the `updated` watcher are torn down automatically when the
 * component unmounts.
 *
 * Engine-free / TanStack-free: this binding names no `@tanstack/*` type — it
 * only touches the SMRT-owned `UpdateState` surface.
 */

import type { UpdateState } from '@happyvertical/smrt-web';

/**
 * A runes-reactive view of the two update signals. Read the fields directly in
 * markup — they update as either signal fires. Do NOT destructure (Svelte 5
 * reactivity is lost on destructure); read through the object, e.g.
 * `update.updateAvailable`.
 */
export interface UpdateAvailableView {
  /** True once the client bundle changed on the server (SvelteKit `updated`). */
  readonly bundle: boolean;
  /** True once the API contract (manifest hash) changed across this load. */
  readonly contract: boolean;
  /** `bundle || contract` — either means an update is available. */
  readonly updateAvailable: boolean;
}

/** Options for {@link useUpdateAvailable}. */
export interface UseUpdateAvailableOptions {
  /**
   * The smrt-web primitive holding the two signals, from `createUpdateState()`.
   * Construct ONE per app (it owns the durable last-seen-hash bookkeeping) and
   * pass it here.
   */
  state: UpdateState;
  /**
   * A reactive accessor for SvelteKit's bundle-updated boolean — call it inside
   * this function so the returned `$effect` tracks it. Typically `() =>
   * updated.current` (modern `$app/state`) or a `$derived` over the legacy
   * `$updated` store. When it flips `true`, the BUNDLE signal is pushed into the
   * primitive. Omit to wire no bundle source (contract-only).
   */
  updated?: () => boolean;
}

/**
 * Create a runes-reactive {@link UpdateAvailableView} over a smrt-web
 * {@link UpdateState}, wiring SvelteKit's `updated` store as the bundle signal.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { updated } from '$app/state';
 *   import { createUpdateState } from '@happyvertical/smrt-web';
 *   import { useUpdateAvailable } from '@happyvertical/smrt-svelte/web';
 *   import { manifestHash } from '@happyvertical/smrt-virt-web';
 *
 *   // One primitive per app — owns the durable last-seen-hash compare.
 *   const state = createUpdateState({
 *     manifestHash,
 *     namespace: { apiBase: '/api/v1', manifestHash: 'apiv1' },
 *   });
 *   const update = useUpdateAvailable({ state, updated: () => updated.current });
 * </script>
 *
 * {#if update.updateAvailable}
 *   <div role="alert">
 *     A new version is available.
 *     <button onclick={() => location.reload()}>Reload</button>
 *   </div>
 * {/if}
 * ```
 */
export function useUpdateAvailable(
  options: UseUpdateAvailableOptions,
): UpdateAvailableView {
  const { state, updated } = options;

  // Seed from the primitive's current state, then keep it in sync via its
  // subscription (fires immediately + on every transition).
  let bundle = $state(state.get().bundle);
  let contract = $state(state.get().contract);

  $effect(() => {
    const unsubscribe = state.subscribe((s) => {
      bundle = s.bundle;
      contract = s.contract;
    });
    return unsubscribe;
  });

  // Push the bundle signal when SvelteKit reports a new deployment. Reading
  // `updated()` inside the effect makes it a reactive dependency, so a flip to
  // true re-runs and forwards it. The primitive's bundle signal is idempotent,
  // so re-forwarding is harmless.
  if (updated) {
    $effect(() => {
      if (updated()) state.notifyBundleUpdated();
    });
  }

  const updateAvailable = $derived(bundle || contract);

  return {
    get bundle() {
      return bundle;
    },
    get contract() {
      return contract;
    },
    get updateAvailable() {
      return updateAvailable;
    },
  };
}
