/**
 * @happyvertical/smrt-web — Web Locks leader election for the outbox (#1762).
 *
 * With multiple tabs open, exactly ONE must replay the shared outbox queue, or
 * two tabs would POST the same batch concurrently. The mechanism is the native
 * Web Locks API (`navigator.locks`): a tab requests an EXCLUSIVE lock keyed by
 * the durable-store namespace and holds it — via a promise that resolves only on
 * release — for as long as it should be leader. The browser grants the lock to
 * exactly one waiter at a time and AUTO-RELEASES it on tab crash/close/navigation
 * with no heartbeat, so the next waiting tab becomes leader instantly and there
 * is never a stuck lock.
 *
 * Why Web Locks over a BroadcastChannel election (v1 decision, locked): Web
 * Locks gives crash-safe, race-free, browser-arbitrated exclusion for free —
 * a hand-rolled BroadcastChannel election has to solve liveness (heartbeats,
 * takeover on a silent crash) itself. BroadcastChannel is a possible future
 * enhancement (cross-tab state fan-out), not the election primitive.
 *
 * ## Single-tab fallback (documented gap)
 *
 * When `navigator.locks` is absent (older Safari, non-browser hosts), this warns
 * ONCE and falls back to acquiring leadership immediately and unconditionally.
 * The outbox STILL replays — a lone tab is trivially the only replayer — but the
 * multi-tab exactly-one-replayer guarantee does not hold across tabs that all
 * took the fallback. This is a deliberate v1 limitation, NOT masked by a
 * BroadcastChannel shim.
 *
 * Engine-free: no `@tanstack/*` import — stays inside the boundary (#1761).
 */

/**
 * A handle to relinquish leadership: call it to release the Web Lock (or cancel
 * a still-pending request). Idempotent.
 */
export type LeadershipHandle = () => void;

/** Structural view of the Web Locks API surface this module uses. */
interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal; mode?: 'exclusive' | 'shared' },
    callback: () => Promise<unknown>,
  ): Promise<unknown>;
}

/** Detect the Web Locks API on the current `navigator`. */
function getLockManager(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  const locks = nav?.locks as LockManagerLike | undefined;
  if (locks && typeof locks.request === 'function') return locks;
  return undefined;
}

/** Gate so the single-tab-fallback warning is logged at most once per session. */
let warnedNoLocks = false;

/**
 * Acquire cross-tab leadership for `lockName` (the outbox's
 * `smrt-web-outbox-leader:<namespace>`).
 *
 * When the lock is granted this tab becomes leader and `onAcquired()` fires; the
 * tab stays leader — holding the lock — until the returned handle is called (or
 * the tab dies, when the browser auto-releases). On release, `onReleased()`
 * fires. Requesting is non-blocking: this returns synchronously with the
 * release handle while the request waits in the background for its turn.
 *
 * Contract:
 * - The lock is requested EXCLUSIVE; the callback returns a promise that stays
 *   pending until the release handle resolves it, so the browser considers the
 *   lock held for exactly that window.
 * - Calling the handle before the lock is even granted aborts the pending
 *   request (via `AbortSignal`) so a torn-down engine never becomes leader
 *   later. `onReleased` still fires so callers can settle their own state.
 * - No Web Locks support → single-tab fallback: `onAcquired()` fires on the next
 *   microtask (leadership is immediate and unconditional), the handle just fires
 *   `onReleased()`.
 */
export function acquireLeadership(
  lockName: string,
  onAcquired: () => void,
  onReleased: () => void,
): LeadershipHandle {
  const locks = getLockManager();

  // --- Single-tab fallback: no Web Locks in this environment. ---
  if (!locks) {
    if (!warnedNoLocks) {
      warnedNoLocks = true;
      // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep (TanStack-only); the single-tab-fallback gap is surfaced via a one-time console.warn by design (#1762)
      console.warn(
        '[smrt-web] Web Locks API unavailable — the offline outbox falls back to single-tab leadership; the multi-tab exactly-one-replayer guarantee does not hold across tabs.',
      );
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      onReleased();
    };
    // Grant leadership asynchronously so callers can wire state before it fires,
    // matching the Web-Locks path (never synchronous inside the constructor).
    queueMicrotask(() => {
      if (!released) onAcquired();
    });
    return release;
  }

  // --- Web Locks path. ---
  const controller = new AbortController();
  // The promise the lock callback returns; it resolves ONLY when we release, so
  // the browser holds the lock for exactly the leadership window.
  let releaseHeldLock: (() => void) | undefined;
  let released = false;
  let acquired = false;

  const release: LeadershipHandle = () => {
    if (released) return;
    released = true;
    if (acquired && releaseHeldLock) {
      // We hold the lock: resolve the callback's promise to release it.
      releaseHeldLock();
    } else {
      // Still waiting in the queue: abort the pending request so we never
      // become leader after teardown.
      controller.abort();
    }
    onReleased();
  };

  void locks
    .request(lockName, { signal: controller.signal, mode: 'exclusive' }, () => {
      // Granted — we are now leader. Hold the lock until release() resolves this.
      acquired = true;
      // If release() already ran while the request was pending, the abort above
      // fired instead and this callback never runs; guard anyway.
      if (released) return Promise.resolve();
      onAcquired();
      return new Promise<void>((resolve) => {
        releaseHeldLock = resolve;
      });
    })
    .catch((error: unknown) => {
      // An AbortError is the expected outcome when release() cancels a pending
      // request — not a fault. Any other rejection means the lock could not be
      // held; surface it so a lock subsystem problem is visible, and ensure
      // onReleased still fires so callers settle.
      const name = (error as { name?: string })?.name;
      if (name !== 'AbortError') {
        // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep; a lock-request failure is surfaced via console.warn (#1762)
        console.warn('[smrt-web] outbox leader lock request failed', error);
      }
      if (!released) {
        released = true;
        onReleased();
      }
    });

  return release;
}
