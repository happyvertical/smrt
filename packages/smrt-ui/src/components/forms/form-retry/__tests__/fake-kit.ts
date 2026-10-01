/**
 * A structural fake of SvelteKit's `use:enhance` and of a form action guarded
 * by `runOnce()`, for the form-retry tests.
 *
 * `fakeEnhance` follows `@sveltejs/kit` 2.x `enhance()`
 * (`src/runtime/app/forms.js`) step for step: build `FormData` from the form,
 * await the submit function with `cancel`/`controller`, stop if cancelled,
 * post, turn a thrown fetch into `{ type: 'error' }` (and return silently on
 * an `AbortError`), then call the returned callback — or the default one —
 * with an `update()` that resets the form on success unless `reset: false`
 * and then applies the result. "Applying" an error result is recorded as
 * `unmounted`, because kit's `applyAction` renders the error boundary and the
 * form goes with it.
 *
 * `fakeRunOnceServer` records rows the way an action using `runOnce()` does:
 * one claim per (key, content digest), replaying the stored row id for a
 * repeat. It digests with the same algorithm `runOnce()` uses.
 */

import { digestSubmissionContent } from '../content-digest.js';
import type {
  FormRetryActionResult,
  FormRetrySubmitFunction,
} from '../types.js';

/** How the fake server answers one request. */
export type ServerBehaviour =
  | 'ok'
  | 'fail'
  | 'redirect'
  /** Commits the write, then the response is lost on the way back. */
  | 'lost-response'
  /** The request never reaches the server. */
  | 'unreachable';

export interface FakeRunOnceServer {
  /** Rows written, in order. */
  rows: Array<{ id: number; fields: Record<string, string[]> }>;
  /** Every request that reached the action. */
  requests: FormData[];
  /** Queue behaviours for the next requests (default `ok`). */
  next(...behaviours: ServerBehaviour[]): void;
  /** Hold the next request until `release()` is called. */
  hold(): { release: () => void };
  handle(
    formData: FormData,
    signal: AbortSignal,
  ): Promise<FormRetryActionResult>;
}

/** A form action whose write is guarded by a runOnce-style claim. */
export function fakeRunOnceServer(
  keyField = 'submissionKey',
): FakeRunOnceServer {
  const claims = new Map<string, number>();
  const rows: FakeRunOnceServer['rows'] = [];
  const requests: FormData[] = [];
  const queue: ServerBehaviour[] = [];
  const holds: Array<Promise<void>> = [];

  return {
    rows,
    requests,
    next(...behaviours) {
      queue.push(...behaviours);
    },
    hold() {
      let release!: () => void;
      holds.push(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return { release };
    },
    async handle(formData, signal) {
      const behaviour = queue.shift() ?? 'ok';
      const held = holds.shift();
      if (held) await held;
      if (signal.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      if (behaviour === 'unreachable') throw new TypeError('Failed to fetch');
      requests.push(formData);
      if (behaviour === 'fail') return { type: 'failure', status: 400 };
      const token = formData.get(keyField);
      if (typeof token !== 'string' || token === '') {
        throw new Error('the form posted no submission key');
      }
      const content = new FormData();
      formData.forEach((value, name) => {
        if (name !== keyField) content.append(name, value);
      });
      const claim = `${token}:${await digestSubmissionContent(content)}`;
      if (!claims.has(claim)) {
        const fields: Record<string, string[]> = {};
        content.forEach((value, name) => {
          const text = typeof value === 'string' ? value : `file:${value.name}`;
          fields[name] = [...(fields[name] ?? []), text];
        });
        const id = rows.length + 1;
        rows.push({ id, fields });
        claims.set(claim, id);
      }
      if (behaviour === 'lost-response') throw new TypeError('network dropped');
      if (behaviour === 'redirect') {
        return { type: 'redirect', status: 303, location: '/done' };
      }
      return { type: 'success', status: 200, data: { id: claims.get(claim) } };
    },
  };
}

export interface FakeEnhanced {
  /**
   * Submit the form as a click on its submit button would. `chosen` stands in
   * for the browser adding files picked in a file input (jsdom cannot set
   * `input.files`).
   */
  submit(chosen?: (formData: FormData) => void): Promise<void>;
  /** Abort controllers of submits in flight, in order. */
  controllers: AbortController[];
  /** Submits cancelled before sending. */
  cancelled: number;
  /** Results applied through `update()`/the default callback. */
  applied: FormRetryActionResult['type'][];
  /** Error results that, in kit, would render the error boundary. */
  unmounted: number;
  /** `update()` calls, with their options. */
  updates: Array<{ reset?: boolean; invalidateAll?: boolean } | undefined>;
  destroy(): void;
}

/** Wire `submit` to `form` the way `use:enhance={submit}` does. */
export function fakeEnhance(
  form: HTMLFormElement,
  submit: FormRetrySubmitFunction,
  server: FakeRunOnceServer,
): FakeEnhanced {
  const action = new URL('http://localhost/report?/create');
  const state: FakeEnhanced = {
    controllers: [],
    cancelled: 0,
    applied: [],
    unmounted: 0,
    updates: [],
    submit: (chosen) => handle(chosen),
    destroy: () => {},
  };

  async function fallback(result: FormRetryActionResult, reset = true) {
    if (result.type === 'success' && reset) {
      HTMLFormElement.prototype.reset.call(form);
    }
    state.applied.push(result.type);
    if (result.type === 'error') state.unmounted += 1;
  }

  async function handle(chosen?: (formData: FormData) => void): Promise<void> {
    const formData = new FormData(form);
    chosen?.(formData);
    const controller = new AbortController();
    let cancelled = false;
    const callback =
      (await submit({
        action,
        cancel: () => {
          cancelled = true;
        },
        controller,
        formData,
        formElement: form,
        submitter: null,
      })) ??
      (async ({ result }: { result: FormRetryActionResult }) =>
        fallback(result));
    if (cancelled) {
      state.cancelled += 1;
      return;
    }
    state.controllers.push(controller);
    let result: FormRetryActionResult;
    try {
      result = await server.handle(formData, controller.signal);
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      result = { type: 'error', error };
    }
    await callback({
      action,
      formData,
      formElement: form,
      result,
      update: async (options) => {
        state.updates.push(options);
        await fallback(result, options?.reset);
      },
    });
  }

  return state;
}
