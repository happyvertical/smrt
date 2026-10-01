/**
 * The per-form submission key: the browser half of `runOnce()` (#3291).
 *
 * `runOnce()` (`@happyvertical/smrt-core`, #3080) makes a write exactly-once
 * when a retry carries the same claim. The claim is derived from the session's
 * tenant and actor, this key, and a digest of the submitted content, so two
 * submits carrying the same key and the same content record one row, and a
 * submit carrying the same key with DIFFERENT content is a new submission
 * (#3136).
 *
 * ## Why the key outlives the component
 *
 * The failure the key exists for is a lost response, and `enhance`'s error
 * path can unmount the form. A key held only in component state would be
 * re-minted on the way back and the retry would record a duplicate — the whole
 * bug. So the key lives in storage: per tab (`sessionStorage`), per form (one
 * slot per form, optionally scoped per record), cleared as soon as a submit is
 * confirmed recorded, and gone when the tab closes.
 *
 * It is never `localStorage`: a tablet or kiosk is shared hardware, and one
 * person's key must not still be sitting there for the next. (A key that does
 * outlive one person's visit is harmless — the claim also covers actor and
 * content — but there is no reason to keep it.)
 *
 * ## Every storage access is wrapped
 *
 * `sessionStorage` throws in private windows, with site data blocked, and in
 * some embedded webviews; even reading the `sessionStorage` property can throw
 * a `SecurityError`. Every access is guarded, and a refused write falls back
 * to an in-memory store. In the browser that store is module-level, so the key
 * still survives a remount for the life of the page — only a full reload loses
 * it, which is less idempotent, never wrong. During SSR there is no shared
 * store at all — neither the module-level memory nor the default storage (Node
 * 25+ has a process-wide `sessionStorage` global): either would hand one
 * request's key to another, so each read off the browser mints a fresh,
 * unshared key.
 *
 * ## One unresolved submit per key
 *
 * One key per form is only meaningful while at most one submission is
 * unresolved under it. Without that, a person can submit A, change the form,
 * and submit B before A answers: both carry key K, A's answer rotates the slot
 * to K2, and B — a genuinely different write — is left holding a key nothing
 * will reconcile; if B commits and loses its response, its retry carries K2,
 * takes a different claim, and records a second row. So {@link beginSubmit}
 * refuses a second submit while one is unresolved. That cancels the
 * submission itself rather than hoping a disabled attribute was flushed in
 * time, and it holds for a second DIFFERENT submission, not just a double tap.
 *
 * @module
 */

/** The storage operations the helper uses: a subset of the DOM `Storage`. */
export interface FormRetryStorage {
  /** Read a value, or `null` when nothing is stored. May throw. */
  getItem(key: string): string | null;
  /** Store a value. May throw (private window, quota). */
  setItem(key: string, value: string): void;
  /** Remove a value. May throw. */
  removeItem(key: string): void;
}

/**
 * Where a form's key and submitted draft live.
 *
 * `storage` is the backing store (default: this tab's `sessionStorage`,
 * resolved lazily on every access because even reading the property can
 * throw); pass `null` to keep everything in memory.
 */
export interface SubmissionKeyLocation {
  /** One slot per FORM, not per page: two forms on one page hold two keys. */
  form: string;
  /**
   * One key per record within a form kind (a form rendered once per row).
   * One record's confirmed write must never rotate the key another record's
   * unresolved retry still carries.
   */
  scope?: string;
  /** Backing store. Defaults to `sessionStorage`; `null` means memory only. */
  storage?: FormRetryStorage | null;
  /**
   * Exact storage name for the key, overriding the derived
   * `smrt:form-retry:<form>[:<scope>]:key`. For migrating an existing app
   * whose tablets hold keys under an older name: renaming silently loses
   * every unresolved key, and the next retry records a duplicate.
   */
  storageKey?: string;
  /** Mints a new key. Defaults to {@link mintSubmissionKey} (UUID v4). */
  mint?: () => string;
}

const PREFIX = 'smrt:form-retry';

/** True in a browser, where a module-level memory store is per-person. */
function inBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * The in-memory fallback. Module-level in the browser so a key survives a
 * remount; never shared on a server (see the module doc).
 */
const browserMemory = new Map<string, string>();

function memoryStore(): Map<string, string> | null {
  return inBrowser() ? browserMemory : null;
}

/** Test seam: forget every in-memory key and draft. */
export function resetFormRetryMemory(): void {
  browserMemory.clear();
}

/**
 * This tab's `sessionStorage`, or `null` where reading it throws — and `null`
 * off the browser: Node 25+ exposes a process-wide in-memory `sessionStorage`
 * global, which during SSR would hand one request's key to another.
 */
function defaultStorage(): FormRetryStorage | null {
  if (!inBrowser()) return null;
  try {
    return (
      (globalThis as { sessionStorage?: FormRetryStorage }).sessionStorage ??
      null
    );
  } catch {
    return null;
  }
}

function resolveStorage(
  storage: FormRetryStorage | null | undefined,
): FormRetryStorage | null {
  return storage === undefined ? defaultStorage() : storage;
}

/**
 * Read `key` from `storage`, then from memory. Memory is consulted second so a
 * value whose storage write was refused (quota) is still found.
 * @internal
 */
export function guardedGet(
  storage: FormRetryStorage | null | undefined,
  key: string,
): string | null {
  const store = resolveStorage(storage);
  if (store) {
    try {
      const value = store.getItem(key);
      if (value !== null && value !== undefined) return value;
    } catch {
      // Refused: fall through to memory.
    }
  }
  return memoryStore()?.get(key) ?? null;
}

/**
 * Write `key`, falling back to memory when storage refuses. Returns whether the
 * value reached the backing store (it survives a reload).
 * @internal
 */
export function guardedSet(
  storage: FormRetryStorage | null | undefined,
  key: string,
  value: string,
): boolean {
  const store = resolveStorage(storage);
  if (store) {
    try {
      store.setItem(key, value);
      memoryStore()?.delete(key);
      return true;
    } catch {
      // Refused: fall through to memory.
    }
  }
  memoryStore()?.set(key, value);
  return false;
}

/** Remove `key` from storage and memory alike. @internal */
export function guardedRemove(
  storage: FormRetryStorage | null | undefined,
  key: string,
): void {
  memoryStore()?.delete(key);
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // Nothing stored means nothing to clear.
  }
}

/** The derived storage base for a form (and scope). @internal */
export function storageBase(form: string, scope?: string): string {
  const base = `${PREFIX}:${encodeURIComponent(form)}`;
  return scope === undefined ? base : `${base}:${encodeURIComponent(scope)}`;
}

function keyName(location: SubmissionKeyLocation): string {
  return (
    location.storageKey ?? `${storageBase(location.form, location.scope)}:key`
  );
}

/**
 * A random v4 UUID from `crypto.getRandomValues` — unguessable, and accepted
 * by a server-side UUID parser.
 */
export function mintSubmissionKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * This tab's key for a form, minting and storing one on first use. The same
 * value comes back across a remount or a reload until it is cleared, so every
 * retry of one filled-in form carries one key.
 */
export function readSubmissionKey(location: SubmissionKeyLocation): string {
  const name = keyName(location);
  const existing = guardedGet(location.storage, name);
  if (existing) return existing;
  const minted = (location.mint ?? mintSubmissionKey)();
  guardedSet(location.storage, name, minted);
  return minted;
}

/**
 * Whether the form's key currently lives in the backing store (and so
 * survives a reload), rather than only in memory.
 */
export function isSubmissionKeyPersistent(
  location: SubmissionKeyLocation,
): boolean {
  const store = resolveStorage(location.storage);
  if (!store) return false;
  try {
    return store.getItem(keyName(location)) !== null;
  } catch {
    return false;
  }
}

/**
 * Drop the key once its submit is confirmed recorded, so the next fill of the
 * form starts a claim of its own. This is the boundary between a resubmission
 * and a deliberate repeat: adding the same line twice on purpose is a new fill
 * and takes a new key; a double tap, a retry after a lost response, and two
 * concurrent requests carry the key the form still holds.
 *
 * Call it only on a result the server confirmed recorded — never on a
 * validation failure, whose submit wrote nothing and whose key is still free.
 */
export function clearSubmissionKey(location: SubmissionKeyLocation): void {
  guardedRemove(location.storage, keyName(location));
}

/**
 * Clear the key and mint the next one, returning it — for an inline form that
 * stays on screen after a confirmed write.
 */
export function rotateSubmissionKey(location: SubmissionKeyLocation): string {
  clearSubmissionKey(location);
  return readSubmissionKey(location);
}

/**
 * One form's submission state: the key the next submit carries, and the key of
 * the submit that has not answered yet (`null` when idle).
 */
export interface SubmissionSlot {
  /** The key the next submit carries. */
  token: string;
  /** The key of the unresolved submit, or `null` when the form is idle. */
  inFlight: string | null;
}

/**
 * Start a submit, or refuse it because one is still unresolved.
 *
 * `start: false` means the caller must `cancel()` the submission: nothing has
 * been sent and the form keeps its content. A double tap lands here too — the
 * second activation is cancelled in the browser, which costs nothing, because
 * the server-side claim still covers every request the browser or the network
 * retries on its own.
 */
export function beginSubmit(state: SubmissionSlot): {
  state: SubmissionSlot;
  start: boolean;
  sent: string;
} {
  if (state.inFlight !== null) {
    return { state, start: false, sent: state.inFlight };
  }
  return {
    state: { ...state, inFlight: state.token },
    start: true,
    sent: state.token,
  };
}

/** What a result means for the form. */
export type SubmitDisposition =
  | 'ignore'
  | 'transport-error'
  | 'rotate-and-apply'
  | 'apply';

/** The outcome kinds a result can have (SvelteKit's `ActionResult['type']`). */
export type SubmitOutcome = 'success' | 'failure' | 'redirect' | 'error';

/**
 * The rotation policy as one pure function.
 *
 * `sent` is the key the submit carried; `live` is the key of the slot's
 * unresolved submit, or `null` when it has none left to settle.
 *
 * - **A stale result is ignored outright.** A double tap can send two requests
 *   under one key, so two results come back, and by the time the second lands
 *   the first has already settled the slot. Acting on it would reset the form
 *   and rotate AGAIN, out from under a submission started since.
 * - **A transport error keeps the key and the form.** It wrote nothing that
 *   the browser can know about, and the claim covers the content, so the
 *   unchanged re-submit must be able to reproduce it.
 * - **A confirmed write applies**, and retires the key only if the form is
 *   cleared by that apply — see {@link settleSubmit}.
 * - **A validation failure applies without rotating**: nothing was written, so
 *   the key is still free and the corrected re-submit keeps the same key.
 * - **A redirect** is a confirmed write only when the caller says so
 *   (`redirectConfirmsWrite`); otherwise it is treated like a validation
 *   result, because it cannot vouch for a write (a redirect to a sign-in page
 *   wrote nothing).
 */
export function submitDisposition(
  sent: string,
  live: string | null,
  outcome: SubmitOutcome,
  options: { redirectConfirmsWrite?: boolean } = {},
): SubmitDisposition {
  if (live === null || sent !== live) return 'ignore';
  if (outcome === 'error') return 'transport-error';
  if (outcome === 'success') return 'rotate-and-apply';
  if (outcome === 'redirect' && options.redirectConfirmsWrite) {
    return 'rotate-and-apply';
  }
  return 'apply';
}

/**
 * Settle one result against the slot, returning the new slot and what to do.
 *
 * ## A key is retired when its FORM IS CLEARED, not merely on success
 *
 * Rotating on success alone leaves a window where the form still SHOWS
 * content that is already recorded while holding a fresh key — after an edit
 * the conditional reset preserved, or after a remount put the submitted values
 * back. A further submit from that form would then take a new claim and record
 * a genuine second row from content nobody re-entered. Keeping the key instead
 * is right, and safe because the claim covers the CONTENT too:
 *
 * - the form still shows what was recorded, so re-submitting it derives the
 *   SAME claim and collapses onto the row that already exists;
 * - the form shows something genuinely different, so it derives a DIFFERENT
 *   claim and is recorded, which is what it should be.
 *
 * Only an emptied form has nothing left to reconcile, so only then does the
 * next entry deserve a key of its own.
 */
export function settleSubmit(
  state: SubmissionSlot,
  sent: string,
  outcome: SubmitOutcome,
  options: {
    formCleared: boolean;
    mint: () => string;
    redirectConfirmsWrite?: boolean;
  },
): { state: SubmissionSlot; disposition: SubmitDisposition } {
  const disposition = submitDisposition(sent, state.inFlight, outcome, {
    redirectConfirmsWrite: options.redirectConfirmsWrite,
  });
  if (disposition === 'ignore') return { state, disposition };
  if (disposition === 'rotate-and-apply' && options.formCleared) {
    return { state: { token: options.mint(), inFlight: null }, disposition };
  }
  return { state: { ...state, inFlight: null }, disposition };
}
