/**
 * Structural types for SvelteKit's `use:enhance` contract (#3291).
 *
 * smrt-ui is the dependency leaf of the Svelte stack and must not depend on
 * `@sveltejs/kit`, so the form-retry helper describes the `SubmitFunction`
 * shape it relies on instead of importing it. The shapes below mirror
 * `SubmitFunction` / `ActionResult` from `@sveltejs/kit` 2.x field for field,
 * narrowed only where the helper needs less: a function of type
 * {@link FormRetrySubmitFunction} is assignable to kit's `SubmitFunction`, so
 * `<form method="POST" use:enhance={retry.enhance()}>` type-checks in any
 * SvelteKit app without smrt-ui knowing about kit.
 */

/** A value or a promise of it. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The result of a SvelteKit form action, as `enhance` reports it.
 *
 * - `success`: the action returned normally — a write it vouches for.
 * - `failure`: the action returned `fail(...)` — validation; nothing written.
 * - `redirect`: the action redirected; whether it wrote is the app's to say
 *   (see `redirectConfirmsWrite`).
 * - `error`: the request never produced an action result — the network
 *   dropped, the server threw, or the response was lost.
 */
export type FormRetryActionResult =
  | { type: 'success'; status: number; data?: unknown }
  | { type: 'failure'; status: number; data?: unknown }
  | { type: 'redirect'; status: number; location: string }
  | { type: 'error'; status?: number; error: unknown };

/** What `enhance` passes to a submit function before it sends anything. */
export interface FormRetrySubmitInput {
  /** The URL the form posts to. */
  action: URL;
  /** The body about to be sent; mutations here are what the server receives. */
  formData: FormData;
  /** The `<form>` element being submitted. */
  formElement: HTMLFormElement;
  /** Aborting it abandons the request without a result. */
  controller: AbortController;
  /** The button that submitted the form, if any. */
  submitter: HTMLElement | null;
  /** Prevent the submission; nothing is sent. */
  cancel: () => void;
}

/** Options accepted by `enhance`'s default result handler. */
export interface FormRetryUpdateOptions {
  /** `false` keeps the form's values after a successful submission. */
  reset?: boolean;
  /** `false` skips `invalidateAll()` after a successful submission. */
  invalidateAll?: boolean;
}

/** What `enhance` passes to the result callback once a result arrives. */
export interface FormRetryResultInput {
  /** The body that was sent. */
  formData: FormData;
  /** The `<form>` element that was submitted. */
  formElement: HTMLFormElement;
  /** The URL the form posted to. */
  action: URL;
  /** The action's result. */
  result: FormRetryActionResult;
  /** `enhance`'s default handling: reset on success, invalidate, apply. */
  update: (options?: FormRetryUpdateOptions) => Promise<void>;
}

/** The callback a submit function may return to handle the result. */
export type FormRetryResultCallback = (
  input: FormRetryResultInput,
) => MaybePromise<void>;

/**
 * A submit function in SvelteKit's `SubmitFunction` shape: what
 * `use:enhance={...}` accepts.
 */
export type FormRetrySubmitFunction = (
  input: FormRetrySubmitInput,
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors kit's SubmitFunction, whose submit function may return nothing.
) => MaybePromise<void | FormRetryResultCallback>;
