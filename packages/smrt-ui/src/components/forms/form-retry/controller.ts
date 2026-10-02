/**
 * `createFormRetry()`: the browser half of `runOnce()` for a SvelteKit
 * enhanced form (#3291).
 *
 * One controller per form. It owns the submission key (`submission-key.ts`),
 * the conditional reset (`form-draft.ts`) and, when asked, the
 * restore-after-reload draft (`submitted-draft.ts`), and exposes them as:
 *
 * - `enhance(submit?)` — a submit function in SvelteKit's `SubmitFunction`
 *   shape, for `<form method="POST" use:enhance={retry.enhance()}>`;
 * - `attach` / `action` — an attachment (`{@attach retry.attach}`) or action
 *   (`use:retry.action`) that keeps a hidden key field in the form and puts a
 *   restored draft back into its controls;
 * - `subscribe` — the Svelte store contract, so `$retry.status` and
 *   `$retry.token` are reactive in a component without this module importing
 *   Svelte.
 *
 * It is framework-free TypeScript: no `@sveltejs/kit` and no `svelte` import.
 *
 * ## What happens to one submit
 *
 * 1. A file the restored draft says was chosen, but is not chosen now, refuses
 *    the submit (`status: 'files-required'`) — a native file input cannot be
 *    restored, and sending without it would silently be different content.
 * 2. A submit while another is unresolved is refused (`status: 'busy'`) and
 *    nothing is sent; the form keeps what the person typed.
 * 3. Otherwise the key is written into the outgoing `FormData` (so the body is
 *    right even if a hidden field is stale or missing) and what the person can
 *    see is snapshotted — before the page's own submit function runs, because
 *    kit built the body before calling it. With restore enabled, the submitted
 *    values are then kept beside the key.
 * 4. The result settles the slot:
 *    - `error` (transport failure, lost response, thrown server error): the key,
 *      the form and the draft are all kept, and `update()` is NOT called —
 *      `enhance`'s default would apply the error and can unmount the form. The
 *      unchanged re-submit is the same claim.
 *    - `failure` (validation): applied without rotating; the draft is dropped
 *      because nothing was recorded.
 *    - `success`: the draft is dropped; the form is reset — and the key
 *      rotated — only if the fields are unchanged since the submit. A person who
 *      typed the next entry while the first was in flight keeps it, under the
 *      same key, and sending it is a different claim because its content
 *      differs. With the page's own result callback, the key rotates only if
 *      the form is actually reset while that callback runs.
 *    - `redirect`: a confirmed write only with `redirectConfirmsWrite: true`.
 *    - A late result for a submit already settled is ignored entirely.
 *
 * An aborted request (the page called `controller.abort()`, before or during
 * the request — including from its own submit function) produces no result
 * from `enhance`; it settles like a transport error so the form is not stuck
 * refusing submits.
 *
 * @module
 */

import { draftOf, type FormDraft, formWasCleared } from './form-draft.js';
import {
  beginSubmit,
  type FormRetryStorage,
  isSubmissionKeyPersistent,
  readSubmissionKey,
  rotateSubmissionKey,
  type SubmissionKeyLocation,
  type SubmissionSlot,
  settleSubmit,
  storageBase,
} from './submission-key.js';
import {
  applyDraftToForm,
  clearSubmittedDraft,
  DEFAULT_DRAFT_MAX_AGE_MS,
  describeFormData,
  isChosenFile,
  readSubmittedDraft,
  type SubmittedDraft,
  saveSubmittedDraft,
} from './submitted-draft.js';
import type {
  FormRetryResultCallback,
  FormRetryResultInput,
  FormRetrySubmitFunction,
  FormRetrySubmitInput,
} from './types.js';

/** Where the controller is in a submit's life. */
export type FormRetryStatus =
  /** Nothing submitted yet, or a submit was cancelled by the page. */
  | 'idle'
  /** A submit is in flight. */
  | 'submitting'
  /** A second submit was refused while one is in flight; nothing was sent. */
  | 'busy'
  /** A restored draft had files that are not chosen again; nothing was sent. */
  | 'files-required'
  /** The last submit got no result; send it again unchanged. */
  | 'transport-error'
  /** The last submit failed validation; nothing was written. */
  | 'failure'
  /** The last submit was confirmed written. */
  | 'success'
  /** The last submit redirected without `redirectConfirmsWrite`. */
  | 'redirect';

/** A snapshot of the controller, as `subscribe` delivers it. */
export interface FormRetryState {
  /** The key the next submit carries. */
  token: string;
  /** The key of the unresolved submit, or `null` when idle. */
  inFlight: string | null;
  /** Where the controller is in a submit's life. */
  status: FormRetryStatus;
  /** A submitted draft from before a reload was restored into this form. */
  restored: boolean;
  /**
   * File fields whose file must be chosen again before a submit is allowed:
   * the restored draft says a file was sent, and a file input cannot be
   * restored. Empty when nothing is outstanding.
   */
  filesToReselect: readonly string[];
  /**
   * Whether the key lives in the tab's storage and survives a reload. `false`
   * in a private window or webview that refuses storage: the key then lives in
   * memory for the life of the page.
   */
  persistent: boolean;
}

/** Non-field state to keep beside the submitted values (opt-in restore). */
export interface FormRetryValuesHook<T = unknown> {
  /**
   * What to keep for this submit — values the page holds outside form fields
   * (an uploaded asset's id, a signature capture key, a selection). Must be
   * JSON-serializable: a result that is not keeps no draft for that submit
   * and drops an earlier attempt's. Called after the submit is accepted.
   */
  capture: (formData: FormData) => T;
  /**
   * Put a kept value back after a reload. `value` came from storage: validate
   * it before trusting it, and throw to reject it — the whole draft is then
   * discarded. Called synchronously inside `createFormRetry()`.
   */
  restore: (value: unknown) => void;
}

/** Opt-in restore-after-reload. */
export interface FormRetryRestoreOptions {
  /**
   * A stable id for whoever is signed in (e.g. `tenantId:userId`). A draft is
   * restored only for the owner it was saved by, and never for an empty owner,
   * so one person's draft is never offered to the next on shared hardware.
   */
  owner: string;
  /** Oldest draft that may be restored, in ms. Default one day. */
  maxAgeMs?: number;
  /** A stricter freshness rule (e.g. "same business day"); overrides `maxAgeMs`. */
  fresh?: (savedAt: Date, now: Date) => boolean;
  /** Non-field state to keep and restore. */
  values?: FormRetryValuesHook;
  /** Fields never written to storage (password inputs are always skipped). */
  exclude?: readonly string[];
  /**
   * Exact storage name for the draft, overriding the derived
   * `smrt:form-retry:<form>[:<scope>]:draft`.
   */
  storageKey?: string;
}

/** Options for {@link createFormRetry}. */
export interface FormRetryOptions {
  /** The form's slot. One slot per FORM: two forms on a page need two names. */
  form: string;
  /** One key per record when a form is rendered once per row. */
  scope?: string;
  /** Hidden field that carries the key. Default `submissionKey`. */
  fieldName?: string;
  /** Backing store. Default `sessionStorage`; `null` keeps everything in memory. */
  storage?: FormRetryStorage | null;
  /** Exact storage name for the key (migration from an older name). */
  storageKey?: string;
  /** Mints a key. Default: a random UUID v4. */
  mint?: () => string;
  /**
   * Treat a `redirect` result as a confirmed write (rotate the key, drop the
   * draft). Default `false`: a redirect cannot vouch for a write on its own.
   */
  redirectConfirmsWrite?: boolean;
  /** Opt-in restore-after-reload. */
  restore?: FormRetryRestoreOptions;
  /** Clock seam for draft timestamps and freshness. */
  now?: () => Date;
}

/** A form's retry controller. */
export interface FormRetry {
  /** The key the next submit carries. */
  readonly token: string;
  /** The hidden field name that carries the key. */
  readonly fieldName: string;
  /** The current state. */
  readonly state: FormRetryState;
  /** The draft restored after a reload, or `null`. */
  readonly restored: SubmittedDraft | null;
  /** Svelte store contract: called now and on every change; returns unsubscribe. */
  subscribe(listener: (state: FormRetryState) => void): () => void;
  /**
   * A submit function for `use:enhance`. An optional inner submit function runs
   * after the retry gate (it sees the key in `formData` and may still
   * `cancel()`); its returned callback, if any, replaces the default
   * `update({ reset })` for applied results and receives an `update` whose
   * default `reset` is the safe one. On a success it also decides whether the
   * key retires: only a reset of the form while it runs (through `update()` or
   * `form.reset()`) rotates the key, so values it keeps on screen keep their
   * key. Transport errors and stale results never reach it — observe `status`
   * instead.
   */
  enhance(submit?: FormRetrySubmitFunction): FormRetrySubmitFunction;
  /** Attachment: `{@attach retry.attach}`. Returns its cleanup. */
  attach: (form: HTMLFormElement) => () => void;
  /** Action: `use:retry.action`. */
  action: (form: HTMLFormElement) => { destroy(): void };
  /**
   * Abandon this fill: drop the stored draft and rotate the key, so the next
   * submit is a new submission. For a "start over" control.
   *
   * Refused while a submit is in flight: that request may already have
   * written, and if its response is lost the unchanged resend must still
   * carry its key (and a reload must still find its draft). Returns `false`
   * and changes nothing then; disable the control while
   * `$retry.inFlight` is set, or call it again once the submit settles.
   * Returns `true` when the fill was discarded.
   */
  discard(): boolean;
}

const DEFAULT_FIELD = 'submissionKey';

/** Create the retry controller for one form. */
export function createFormRetry(options: FormRetryOptions): FormRetry {
  const fieldName = options.fieldName ?? DEFAULT_FIELD;
  const now = options.now ?? (() => new Date());
  const location: SubmissionKeyLocation = {
    form: options.form,
    scope: options.scope,
    storage: options.storage,
    storageKey: options.storageKey,
    mint: options.mint,
  };
  const restoreOptions = options.restore;
  const draftName =
    restoreOptions?.storageKey ??
    `${storageBase(options.form, options.scope)}:draft`;
  const exclude = new Set<string>([
    fieldName,
    ...(restoreOptions?.exclude ?? []),
  ]);

  let slot: SubmissionSlot = {
    token: readSubmissionKey(location),
    inFlight: null,
  };

  let restored: SubmittedDraft | null = null;
  if (restoreOptions) {
    const maxAge = restoreOptions.maxAgeMs ?? DEFAULT_DRAFT_MAX_AGE_MS;
    const fresh = (savedAt: Date): boolean => {
      const current = now();
      if (restoreOptions.fresh) return restoreOptions.fresh(savedAt, current);
      const age = current.getTime() - savedAt.getTime();
      return age >= 0 && age <= maxAge;
    };
    restored = readSubmittedDraft(options.storage, draftName, {
      token: slot.token,
      owner: restoreOptions.owner,
      fresh,
    });
    if (restored && restoreOptions.values && restored.values !== undefined) {
      try {
        restoreOptions.values.restore(restored.values);
      } catch {
        // The page rejected the stored value (it is untrusted data): restore
        // nothing rather than half a draft, and never break the page over it.
        clearSubmittedDraft(options.storage, draftName);
        restored = null;
      }
    }
  }
  let appliedRestore = false;

  let state: FormRetryState = {
    token: slot.token,
    inFlight: null,
    status: 'idle',
    restored: restored !== null,
    filesToReselect: uniqueFields(restored),
    persistent: isSubmissionKeyPersistent(location),
  };
  const listeners = new Set<(state: FormRetryState) => void>();

  function setState(patch: Partial<FormRetryState>): void {
    state = {
      ...state,
      ...patch,
      token: slot.token,
      inFlight: slot.inFlight,
      persistent: isSubmissionKeyPersistent(location),
    };
    for (const listener of listeners) listener(state);
  }

  function writeSlot(next: SubmissionSlot): void {
    slot = next;
  }

  function clearDraft(): void {
    if (restoreOptions) clearSubmittedDraft(options.storage, draftName);
  }

  function missingFiles(formData: FormData): string[] {
    return state.filesToReselect.filter(
      (field) => !formData.getAll(field).some(isChosenFile),
    );
  }

  function saveDraft(
    formData: FormData,
    token: string,
    skip: ReadonlySet<string>,
  ): void {
    if (!restoreOptions) return;
    if (!restoreOptions.owner) {
      // A draft can never be restored without an owner, so keeping one would
      // only leave the person's values on shared hardware for nothing.
      clearDraft();
      return;
    }
    const described = describeFormData(formData, skip);
    let values: unknown;
    if (restoreOptions.values) {
      try {
        values = restoreOptions.values.capture(formData);
      } catch {
        values = undefined;
      }
    }
    saveSubmittedDraft(options.storage, draftName, {
      token,
      owner: restoreOptions.owner,
      savedAt: now(),
      fields: described.fields,
      files: described.files,
      values,
    });
  }

  function passwordFields(form: HTMLFormElement): string[] {
    const names: string[] = [];
    for (const element of Array.from(form.elements)) {
      if (
        element instanceof HTMLInputElement &&
        element.type === 'password' &&
        element.name
      ) {
        names.push(element.name);
      }
    }
    return names;
  }

  function enhance(submit?: FormRetrySubmitFunction): FormRetrySubmitFunction {
    return async (input: FormRetrySubmitInput) => {
      const { formData, formElement, cancel, controller } = input;

      const missing = missingFiles(formData);
      if (missing.length > 0) {
        cancel();
        setState({ status: 'files-required', filesToReselect: missing });
        return;
      }

      const begun = beginSubmit(slot);
      if (!begun.start) {
        cancel();
        setState({ status: 'busy' });
        return;
      }
      writeSlot(begun.state);
      const sent = begun.sent;
      formData.set(fieldName, sent);
      // What was sent is what the form held when kit built `formData`, which
      // it did before calling this function. Snapshot it now, before awaiting
      // the page's submit function: an edit made while that is pending was
      // never sent, and must read as an edit when the result arrives.
      const submitted: FormDraft = draftOf(formElement);

      let innerCancelled = false;
      let innerCallback: FormRetryResultCallback | undefined;
      if (submit) {
        try {
          const returned = await submit({
            ...input,
            cancel: () => {
              innerCancelled = true;
              cancel();
            },
          });
          if (typeof returned === 'function') innerCallback = returned;
        } catch (error) {
          // The page's own submit threw before anything was sent: release the
          // slot so the form is not stuck refusing submits.
          cancel();
          writeSlot({ ...slot, inFlight: null });
          setState({ status: 'idle' });
          throw error;
        }
      }
      if (innerCancelled) {
        writeSlot({ ...slot, inFlight: null });
        setState({ status: 'idle' });
        return;
      }

      if (restoreOptions) {
        saveDraft(
          formData,
          sent,
          new Set([...exclude, ...passwordFields(formElement)]),
        );
      }
      setState({ status: 'submitting', filesToReselect: [] });

      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const next = settleSubmit(slot, sent, 'error', {
          formCleared: false,
          mint: () => rotateSubmissionKey(location),
        });
        if (next.disposition === 'ignore') return;
        writeSlot(next.state);
        setState({ status: 'transport-error' });
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      // The page's own submit function may already have aborted (without
      // cancelling): the abort event has fired, and kit will report no result.
      if (controller.signal.aborted) onAbort();

      return async (resultInput: FormRetryResultInput) => {
        controller.signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        const { result } = resultInput;
        const formCleared = formWasCleared(formElement, submitted);
        // The default handling resets an unchanged form on success, so the key
        // retires now. A page's own result callback decides the reset itself
        // (`update({ reset: false })`, or no update at all), and values left on
        // screen must keep their key: then the key retires only if the form is
        // actually reset while the callback runs.
        const retireOnReset =
          innerCallback !== undefined && result.type === 'success';
        const next = settleSubmit(slot, sent, result.type, {
          formCleared: formCleared && !retireOnReset,
          mint: () => rotateSubmissionKey(location),
          redirectConfirmsWrite: options.redirectConfirmsWrite,
        });
        if (next.disposition === 'ignore') return;
        writeSlot(next.state);

        if (next.disposition === 'transport-error') {
          // Keep the key, the form and the draft. Do NOT call update(): on an
          // error result it applies the error and can unmount the form.
          setState({ status: 'transport-error' });
          return;
        }
        if (next.disposition === 'rotate-and-apply') {
          clearDraft();
          setState({
            status: result.type === 'redirect' ? 'redirect' : 'success',
            restored: false,
          });
        } else if (result.type === 'failure') {
          // Nothing was recorded, so there is nothing to retry after a reload.
          clearDraft();
          setState({ status: 'failure', restored: false });
        } else {
          setState({
            status: result.type === 'redirect' ? 'redirect' : 'idle',
          });
        }

        const update = (opts?: { reset?: boolean; invalidateAll?: boolean }) =>
          resultInput.update({ ...opts, reset: opts?.reset ?? formCleared });
        if (!innerCallback) {
          await update();
          return;
        }
        if (!(retireOnReset && formCleared)) {
          await innerCallback({ ...resultInput, update });
          return;
        }
        // Watch for the reset like the capture fields do: capture phase on the
        // document, so a page listener that stops propagation cannot hide it.
        const doc = formElement.ownerDocument;
        const seen: { reset: Event | null } = { reset: null };
        const onReset = (event: Event) => {
          if (event.target === formElement) seen.reset = event;
        };
        doc.addEventListener('reset', onReset, true);
        try {
          await innerCallback({ ...resultInput, update });
        } finally {
          doc.removeEventListener('reset', onReset, true);
          if (seen.reset && !seen.reset.defaultPrevented) {
            writeSlot({
              token: rotateSubmissionKey(location),
              inFlight: slot.inFlight,
            });
            setState({});
          }
        }
      };
    };
  }

  function syncHiddenField(form: HTMLFormElement): HTMLInputElement {
    let field = Array.from(form.elements).find(
      (element): element is HTMLInputElement =>
        element instanceof HTMLInputElement && element.name === fieldName,
    );
    if (!field) {
      field = form.ownerDocument.createElement('input');
      field.type = 'hidden';
      field.name = fieldName;
      form.prepend(field);
    }
    field.value = slot.token;
    return field;
  }

  function attach(form: HTMLFormElement): () => void {
    syncHiddenField(form);
    if (restored && !appliedRestore) {
      appliedRestore = true;
      applyDraftToForm(form, restored, exclude);
    }
    const unsubscribe = subscribe(() => {
      syncHiddenField(form);
    });
    return unsubscribe;
  }

  function subscribe(listener: (state: FormRetryState) => void): () => void {
    listeners.add(listener);
    listener(state);
    return () => {
      listeners.delete(listener);
    };
  }

  function discard(): boolean {
    if (slot.inFlight !== null) return false;
    clearDraft();
    restored = null;
    writeSlot({
      token: rotateSubmissionKey(location),
      inFlight: null,
    });
    setState({ status: 'idle', restored: false, filesToReselect: [] });
    return true;
  }

  return {
    get token() {
      return slot.token;
    },
    fieldName,
    get state() {
      return state;
    },
    get restored() {
      return restored;
    },
    subscribe,
    enhance,
    attach,
    action: (form: HTMLFormElement) => {
      const cleanup = attach(form);
      return { destroy: cleanup };
    },
    discard,
  };
}

function uniqueFields(draft: SubmittedDraft | null): string[] {
  if (!draft) return [];
  return Array.from(new Set(draft.files.map((file) => file.field)));
}
