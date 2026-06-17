/**
 * Shared Vitest setup for Svelte component tests (Sweep S11, #1416).
 *
 * Add to a package's `setupFiles` to enable the component-test harness:
 *   - jest-dom matchers (`toBeInTheDocument`, `toHaveAttribute`, `toBeDisabled`, …)
 *   - Testing Library auto-cleanup after each test (unmounts components so the
 *     jsdom document doesn't leak between tests)
 *   - a `<dialog>` `showModal`/`close` polyfill (jsdom omits the modal methods)
 *
 * It is **safe to register globally** alongside node-environment tests: the
 * Testing-Library bits only load when a DOM is present (`document` exists), so a
 * package that mixes node DB tests with jsdom component tests can list this once
 * in `setupFiles`. Component test files opt into the DOM with a per-file
 * `// @vitest-environment jsdom` pragma (or a jsdom test project).
 *
 * Pair with the `expectNoA11yViolations` helper from
 * `@happyvertical/smrt-vitest/a11y`.
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  // jest-dom matchers + Testing Library cleanup — DOM-only, so import lazily to
  // keep this file importable under the `node` environment.
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/svelte');
  afterEach(() => {
    cleanup();
  });

  // jsdom does not implement the native <dialog> modal methods, so components
  // that drive a dialog via showModal()/close() (Modal, ConfirmDialog, …) throw
  // on mount. Polyfill the minimum: toggle `open` (jsdom reflects it to the
  // attribute, giving the element its `dialog` role) and emit the close event.
  if (typeof HTMLDialogElement !== 'undefined') {
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function showModal(
        this: HTMLDialogElement,
      ) {
        this.open = true;
      };
    }
    if (!HTMLDialogElement.prototype.close) {
      HTMLDialogElement.prototype.close = function close(
        this: HTMLDialogElement,
      ) {
        this.open = false;
        this.dispatchEvent(new Event('close'));
      };
    }
  }
}
