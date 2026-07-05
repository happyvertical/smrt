/**
 * Integration tests for the framework-free `updateAvailable` primitive (#1764).
 *
 * The durable last-seen store is a REAL `fake-indexeddb`; nothing is mocked. The
 * two signals are exercised independently: the BUNDLE signal via
 * `notifyBundleUpdated`, and the CONTRACT signal via the build-time-inject
 * compare (a persisted last-seen manifest hash vs the running build's), modeled
 * by constructing successive primitives against the SAME namespace with
 * DIFFERENT running hashes (a redeploy across loads).
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';
import {
  createUpdateState,
  type DurableStoreKey,
  durableStoreNamespace,
  registerDurableResource,
  type UpdateState,
  wipeDurableStore,
} from './index.js';
import {
  LAST_SEEN_MANIFEST_HASH_KEY,
  openVersionMetaStore,
} from './update-state/meta-store.js';

let counter = 0;
/** A stable namespace per test — the manifestHash segment is a CONSTANT (the
 * app api-version), NOT the running build hash, so contract change is detected
 * by the STORED value, not by the namespace moving. */
function stableNamespace(): DurableStoreKey {
  counter += 1;
  return { apiBase: `/api/v1/upd-${counter}`, manifestHash: 'apiv1' };
}

const disposables: UpdateState[] = [];
function track(s: UpdateState): UpdateState {
  disposables.push(s);
  return s;
}
afterEach(() => {
  for (const s of disposables) s.dispose();
  disposables.length = 0;
});

describe('createUpdateState (#1764) — bundle signal', () => {
  it('fires updateAvailable when the bundle signal is pushed', async () => {
    const state = track(
      createUpdateState({ namespace: stableNamespace(), manifestHash: 'h1' }),
    );
    await state.ready;

    const seen: boolean[] = [];
    state.subscribe((s) => seen.push(s.updateAvailable));
    // Immediate fire on subscribe: currently no update.
    expect(state.get().updateAvailable).toBe(false);
    expect(state.get().bundle).toBe(false);

    state.notifyBundleUpdated();

    expect(state.get().bundle).toBe(true);
    expect(state.get().updateAvailable).toBe(true);
    // Subscriber saw the transition (last value true).
    expect(seen.at(-1)).toBe(true);
  });

  it('the bundle signal is idempotent (stays set)', async () => {
    const state = track(
      createUpdateState({ namespace: stableNamespace(), manifestHash: 'h1' }),
    );
    await state.ready;
    let notifications = 0;
    state.subscribe(() => {
      notifications += 1;
    });
    const afterSubscribe = notifications; // 1 (immediate)
    state.notifyBundleUpdated();
    state.notifyBundleUpdated(); // no-op second time
    // Exactly one transition notification beyond the immediate subscribe fire.
    expect(notifications).toBe(afterSubscribe + 1);
    expect(state.get().bundle).toBe(true);
  });
});

describe('createUpdateState (#1764) — contract signal (build-time inject)', () => {
  it('does NOT fire on the first-ever run (no prior last-seen hash), but records the hash', async () => {
    const namespace = stableNamespace();
    const first = track(
      createUpdateState({ namespace, manifestHash: 'hashA' }),
    );
    await first.ready;
    // First run: nothing to compare against → no contract signal.
    expect(first.get().contract).toBe(false);
    expect(first.get().updateAvailable).toBe(false);

    // But it persisted the running hash for next time.
    const store = await openVersionMetaStore(durableStoreNamespace(namespace));
    expect(await store.get(LAST_SEEN_MANIFEST_HASH_KEY)).toBe('hashA');
    store.close();
  });

  it('FIRES the contract signal on a reload whose build hash differs from the last-seen (a redeploy)', async () => {
    const namespace = stableNamespace();
    // Load 1: records hashA.
    const first = track(
      createUpdateState({ namespace, manifestHash: 'hashA' }),
    );
    await first.ready;
    expect(first.get().contract).toBe(false);
    first.dispose();

    // Load 2 after a redeploy: the running build is now hashB, last-seen is
    // hashA → the API contract changed across this load → contract fires.
    const second = track(
      createUpdateState({ namespace, manifestHash: 'hashB' }),
    );
    await second.ready;
    expect(second.get().contract).toBe(true);
    expect(second.get().updateAvailable).toBe(true);

    // And it updated the baseline so a THIRD load on hashB does not re-fire.
    second.dispose();
    const third = track(
      createUpdateState({ namespace, manifestHash: 'hashB' }),
    );
    await third.ready;
    expect(third.get().contract).toBe(false);
  });

  it('does not fire when the build hash is unchanged across loads', async () => {
    const namespace = stableNamespace();
    const first = track(createUpdateState({ namespace, manifestHash: 'same' }));
    await first.ready;
    first.dispose();
    const second = track(
      createUpdateState({ namespace, manifestHash: 'same' }),
    );
    await second.ready;
    expect(second.get().contract).toBe(false);
  });

  it('degrades to bundle-only when no running manifestHash is supplied', async () => {
    const state = track(createUpdateState({ namespace: stableNamespace() }));
    await state.ready;
    expect(state.get().contract).toBe(false);
    // Bundle still works.
    state.notifyBundleUpdated();
    expect(state.get().updateAvailable).toBe(true);
  });
});

describe('createUpdateState (#1764) — logout wipe clears the last-seen hash', () => {
  it('wipeDurableStore clears the persisted last-seen manifest hash (so a re-login does not falsely detect a contract change)', async () => {
    const namespace = stableNamespace();
    const ns = durableStoreNamespace(namespace);
    const state = track(
      createUpdateState({ namespace, manifestHash: 'hashA' }),
    );
    await state.ready;

    // Sanity: the hash is persisted.
    const store = await openVersionMetaStore(ns);
    expect(await store.get(LAST_SEEN_MANIFEST_HASH_KEY)).toBe('hashA');
    store.close();

    // Co-register an outbox stub under the same namespace to prove one wipe
    // clears the version meta AND other durable resources together.
    let outboxCleared = false;
    registerDurableResource(ns, {
      kind: 'outbox',
      clear: async () => {
        outboxCleared = true;
      },
    });

    await wipeDurableStore(ns);
    expect(outboxCleared).toBe(true);

    // The last-seen hash is gone.
    const after = await openVersionMetaStore(ns);
    expect(await after.get(LAST_SEEN_MANIFEST_HASH_KEY)).toBeUndefined();
    after.close();
  });
});
