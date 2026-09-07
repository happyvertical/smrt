/**
 * Vitest setup for smrt-svelte component tests (Sweep L4, #1423).
 *
 * Registered via `setupFiles` in vitest.config.ts (the smrt-vitest plugin
 * appends its own setup alongside this one). Provides:
 *   - jest-dom matchers (`toBeInTheDocument`, `toHaveAttribute`, `toBeDisabled`, …)
 *   - Testing Library auto-cleanup after each test (unmounts mounted components
 *     so the jsdom document doesn't leak between tests).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

// Vitest leaves Node 26's host `localStorage` accessor on the test global.
// It is configurable but returns undefined without Node's storage-file flag.
// Vitest retains the original JSDOM instance at `globalThis.jsdom`.
const jsdomStorage = (
  globalThis as typeof globalThis & { jsdom: { window: Window } }
).jsdom.window.localStorage;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: jsdomStorage,
  writable: true,
});

afterEach(() => {
  cleanup();
});

// jsdom does not implement the native <dialog> modal methods, so components
// that drive a dialog via showModal()/close() (e.g. Modal, ConfirmDialog) throw
// on mount. Polyfill the minimum: toggle the `open` property (which jsdom
// reflects to the attribute, giving the element its `dialog` role) and emit the
// matching events.
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
