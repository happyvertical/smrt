/**
 * @happyvertical/smrt-web — the framework-free `updateAvailable` primitive (#1764).
 *
 * A tiny pub/sub carrying an app's "an update is available" state, driven by TWO
 * INDEPENDENT signals so the presentation (a toast / reload prompt, shipped as a
 * Svelte binding in smrt-svelte) can react to either:
 *
 *  - **bundle** — the client BUNDLE changed on the server (a new deploy of the
 *    front-end assets). SvelteKit already detects this via its native `updated`
 *    store (version.json polling); the consumer/smrt-svelte binding pushes it in
 *    here through {@link UpdateState.notifyBundleUpdated}. This module owns no
 *    polling — it just holds the state and fans out.
 *  - **contract** — the API CONTRACT changed: the manifest hash, which only SMRT
 *    knows. Detected here under the BUILD-TIME-INJECT decision (#1764): on init
 *    we compare the RUNNING build's `manifestHash` (passed in by the consumer,
 *    imported from `@happyvertical/smrt-virt-web`) against a persisted
 *    "last-seen manifestHash" in durable storage. If they differ, the contract
 *    changed across this load → the `contract` signal fires and the new value is
 *    stored. So a returning user whose app was rebuilt against a new schema is
 *    told to reload.
 *
 * `updateAvailable` is simply `bundle || contract` — either signal means "an
 * update is available".
 *
 * ## Scope: load-time contract detection only (documented follow-up)
 *
 * Contract detection here fires at MOST once per load (the compare-on-init).
 * LIVE-while-open contract detection — learning mid-session that the server
 * redeployed a new contract, via the `_events` SSE manifest frame — pushes the
 * same sticky `contract` signal through {@link UpdateState.notifyContractUpdated}.
 *
 * ## Durable last-seen storage + logout wipe
 *
 * The last-seen hash lives in the version-meta store
 * (update-state/meta-store.ts) under the durable-store namespace, registered as
 * a durable resource so a logout {@link wipeDurableStore} clears it too (the AC
 * "wipe clears the last-seen-hash record"). If IndexedDB is unavailable the
 * primitive still works for the bundle signal; contract detection degrades to a
 * no-op (no durable baseline to compare against) rather than throwing.
 *
 * Engine-free (no `@tanstack/*` import) and framework-free (no Svelte/DOM) — the
 * reactive binding is a separate smrt-svelte adapter (#1764 PART E).
 */

import {
  type DurableStoreKey,
  durableStoreNamespace,
  registerDurableResource,
} from './durable-store.js';
import {
  LAST_SEEN_MANIFEST_HASH_KEY,
  openVersionMetaStore,
  type VersionMetaStore,
} from './update-state/meta-store.js';

/** The two independent update signals plus their derived union. */
export interface UpdateAvailableState {
  /** The client bundle changed on the server (SvelteKit `updated`). */
  readonly bundle: boolean;
  /** The API contract (manifest hash) changed across this load. */
  readonly contract: boolean;
  /** `bundle || contract` — either means an update is available. */
  readonly updateAvailable: boolean;
}

/** Configuration for {@link createUpdateState}. */
export interface UpdateStateConfig {
  /**
   * The RUNNING build's web-collection shape digest — the `manifestHash`
   * constant the generated `@happyvertical/smrt-virt-web` module exports
   * (#1764). Compared against the persisted last-seen value to detect a contract
   * change across loads. Omit to disable contract detection (bundle-only).
   */
  manifestHash?: string;
  /**
   * The durable-store identity the last-seen manifest hash is namespaced under —
   * folds api base / tenant / identity (and, yes, the manifest hash itself, but
   * see below). Shared with persistence/outbox so one {@link wipeDurableStore}
   * clears the last-seen record too.
   *
   * NOTE the namespace's OWN `manifestHash` segment should be a STABLE value
   * (e.g. the app's api-version or a constant), NOT the running build hash —
   * otherwise a contract change would move the namespace and the compare would
   * never find the prior value (always "first run"). Contract change is detected
   * by the STORED VALUE under a stable namespace, not by the namespace moving.
   */
  namespace: DurableStoreKey;
}

/** The framework-free update-available primitive. */
export interface UpdateState {
  /** The current signal state (a fresh immutable snapshot). */
  get(): UpdateAvailableState;
  /**
   * Subscribe to state changes; the callback fires immediately with the current
   * state and again on every transition. Returns an unsubscribe function.
   */
  subscribe(callback: (state: UpdateAvailableState) => void): () => void;
  /**
   * Push the BUNDLE signal — call from the consumer/smrt-svelte binding when
   * SvelteKit's `updated` store flips true. Idempotent: once set it stays set
   * (a bundle update does not un-happen).
   */
  notifyBundleUpdated(): void;
  /**
   * Push the API CONTRACT signal — call when a live transport observes a server
   * `manifestHash` that differs from this running build (#1859). Idempotent:
   * once set it stays set (a contract mismatch does not un-happen).
   */
  notifyContractUpdated(): void;
  /**
   * Resolves once the async contract detection has settled (compared the running
   * hash against the persisted last-seen value and fired the signal if needed).
   * Primarily for tests/SSR; UI code just subscribes.
   */
  readonly ready: Promise<void>;
  /** Detach the durable resource (does NOT wipe — that's wipeDurableStore). */
  dispose(): void;
}

/**
 * Create the framework-free `updateAvailable` primitive. Kicks off async
 * contract detection immediately (compare running vs. persisted manifest hash);
 * {@link UpdateState.notifyBundleUpdated} feeds the bundle signal, and
 * {@link UpdateState.notifyContractUpdated} feeds the live contract signal. A
 * change to EITHER signal notifies subscribers.
 */
export function createUpdateState(config: UpdateStateConfig): UpdateState {
  const namespace = durableStoreNamespace(config.namespace);
  let bundle = false;
  let contract = false;
  const subscribers = new Set<(state: UpdateAvailableState) => void>();

  // The open meta store + its durable-resource unregister, so dispose() can
  // detach and a wipe can clear the last-seen hash.
  let metaStore: VersionMetaStore | undefined;
  let unregister: (() => void) | undefined;
  let disposed = false;

  const snapshot = (): UpdateAvailableState => ({
    bundle,
    contract,
    updateAvailable: bundle || contract,
  });

  const notify = (): void => {
    const state = snapshot();
    for (const callback of [...subscribers]) {
      try {
        callback(state);
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep (TanStack-only); a throwing update subscriber surfaces via console.warn by design (#1764)
        console.warn('[smrt-web] updateAvailable subscriber threw', error);
      }
    }
  };

  const setBundle = (): void => {
    if (bundle) return;
    bundle = true;
    notify();
  };
  const setContract = (): void => {
    if (contract) return;
    contract = true;
    notify();
  };

  // Async contract detection under BUILD-TIME INJECT (#1764): compare the
  // running build's manifestHash against the persisted last-seen value. On a
  // mismatch fire `contract` and store the new value; on first-ever run just
  // store it (no signal). Degrades to a no-op if IndexedDB is unavailable or no
  // running hash was supplied.
  const ready: Promise<void> = (async () => {
    const runningHash = config.manifestHash;
    if (runningHash === undefined) return;
    let store: VersionMetaStore;
    try {
      store = await openVersionMetaStore(namespace);
    } catch {
      // No durable baseline available → cannot detect a contract change. The
      // bundle signal still works; this is a graceful degrade, not an error.
      return;
    }
    if (disposed) {
      store.close();
      return;
    }
    metaStore = store;
    // Register so a logout wipe clears the last-seen hash too (shared namespace
    // with persistence + outbox).
    unregister = registerDurableResource(namespace, {
      kind: 'persisted-collection',
      clear: () => store.clear(),
    });
    let lastSeen: string | undefined;
    try {
      lastSeen = await store.get(LAST_SEEN_MANIFEST_HASH_KEY);
    } catch {
      lastSeen = undefined;
    }
    if (disposed) return;
    if (lastSeen !== undefined && lastSeen !== runningHash) {
      // The contract changed across this load — signal, then persist the new
      // baseline so a subsequent load does not re-fire for the same change.
      setContract();
    }
    if (lastSeen !== runningHash) {
      try {
        await store.set(LAST_SEEN_MANIFEST_HASH_KEY, runningHash);
      } catch {
        /* best-effort */
      }
    }
  })();

  return {
    get: snapshot,
    subscribe(callback) {
      subscribers.add(callback);
      // Fire immediately with the current state (store-like ergonomics).
      try {
        callback(snapshot());
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep (TanStack-only); a throwing update subscriber surfaces via console.warn by design (#1764)
        console.warn('[smrt-web] updateAvailable subscriber threw', error);
      }
      return () => {
        subscribers.delete(callback);
      };
    },
    notifyBundleUpdated: setBundle,
    notifyContractUpdated: setContract,
    ready,
    dispose() {
      disposed = true;
      unregister?.();
      unregister = undefined;
      metaStore?.close();
      metaStore = undefined;
      subscribers.clear();
    },
  };
}
