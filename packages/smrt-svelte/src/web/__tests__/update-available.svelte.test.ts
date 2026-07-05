/**
 * Behavior tests for the Svelte 5 `useUpdateAvailable` binding (#1764).
 *
 * The binding wires SvelteKit's `updated` boolean (the bundle signal) into
 * smrt-web's framework-free `UpdateState`, and surfaces both signals reactively.
 * Here the `UpdateState` is a small in-memory stub (a real one would open
 * IndexedDB; the RUNE's reactivity — subscription sync + `updated` watcher — is
 * what these tests pin), and the binding runs inside a host component so its
 * `$effect`s have a genuine component-init scope, matching this package's other
 * runes-composable tests.
 *
 * NOTE: Svelte-package tests may not run under the local Darwin/vite8 toolchain
 * (CI is the gate). The binding is additionally covered by typecheck.
 */

import type {
  UpdateAvailableState,
  UpdateState,
} from '@happyvertical/smrt-web';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateAvailableView } from '../update-available.svelte.js';
import Harness from './update-available-harness.svelte';

/**
 * A minimal in-memory UpdateState: drives `bundle`/`contract` and fans out to
 * subscribers, exactly like the real primitive but with no IndexedDB. Lets a
 * test flip the contract signal and push the bundle signal deterministically.
 */
function makeStubState(): UpdateState & {
  fireContract(): void;
} {
  let bundle = false;
  let contract = false;
  const subs = new Set<(s: UpdateAvailableState) => void>();
  const snapshot = (): UpdateAvailableState => ({
    bundle,
    contract,
    updateAvailable: bundle || contract,
  });
  const notify = () => {
    for (const cb of [...subs]) cb(snapshot());
  };
  return {
    get: snapshot,
    subscribe(cb) {
      subs.add(cb);
      cb(snapshot());
      return () => {
        subs.delete(cb);
      };
    },
    notifyBundleUpdated() {
      if (bundle) return;
      bundle = true;
      notify();
    },
    ready: Promise.resolve(),
    dispose() {
      subs.clear();
    },
    fireContract() {
      if (contract) return;
      contract = true;
      notify();
    },
  };
}

const mounted: Array<Record<string, unknown>> = [];
function render(
  state: UpdateState,
  initialUpdated = false,
): {
  view: UpdateAvailableView;
  setUpdated: (v: boolean) => void;
} {
  let view!: UpdateAvailableView;
  let setUpdated!: (v: boolean) => void;
  const target = document.createElement('div');
  const component = mount(Harness, {
    target,
    props: {
      state,
      initialUpdated,
      onReady: (v: UpdateAvailableView, set: (value: boolean) => void) => {
        view = v;
        setUpdated = set;
      },
    },
  });
  mounted.push(component as unknown as Record<string, unknown>);
  flushSync();
  return { view, setUpdated };
}

afterEach(() => {
  for (const c of mounted) {
    void unmount(c as never);
  }
  mounted.length = 0;
});

describe('useUpdateAvailable (#1764)', () => {
  it('starts with no update available and reflects the initial state', () => {
    const state = makeStubState();
    const { view } = render(state);
    expect(view.bundle).toBe(false);
    expect(view.contract).toBe(false);
    expect(view.updateAvailable).toBe(false);
  });

  it('reacts to the CONTRACT signal fired by the primitive', () => {
    const state = makeStubState();
    const { view } = render(state);

    state.fireContract();
    flushSync();

    expect(view.contract).toBe(true);
    expect(view.updateAvailable).toBe(true);
    expect(view.bundle).toBe(false);
  });

  it('pushes the BUNDLE signal when SvelteKit `updated` flips true', () => {
    const state = makeStubState();
    // `setUpdated` mutates a REACTIVE $state in the harness (mirrors SvelteKit's
    // reactive `updated` store) — a plain closure variable would not be tracked
    // by the rune's $effect, so the bundle signal would never fire.
    const { view, setUpdated } = render(state);
    expect(view.updateAvailable).toBe(false);

    // Simulate SvelteKit detecting a new deployment.
    setUpdated(true);
    flushSync();

    expect(view.bundle).toBe(true);
    expect(view.updateAvailable).toBe(true);
  });

  it('updateAvailable is the union: either signal alone makes it true', () => {
    const stateA = makeStubState();
    const a = render(stateA);
    stateA.fireContract();
    flushSync();
    expect(a.view.updateAvailable).toBe(true);

    const stateB = makeStubState();
    const b = render(stateB);
    b.setUpdated(true);
    flushSync();
    expect(b.view.updateAvailable).toBe(true);
  });
});
