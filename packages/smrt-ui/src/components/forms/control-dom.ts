import { paintControlSpotlight } from './control-spotlight.js';

/** DOM adapter helpers shared by addressable control Implementations. */

const focusableControlSelector = [
  'input:not([type="hidden"]):not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'button:not(:disabled)',
  'a[href]',
  '[tabindex]:not([tabindex="-1"]):not([type="hidden"])',
  '[contenteditable="true"]',
].join(',');

export function focusControl(node: HTMLElement): void {
  const target = node.matches(focusableControlSelector)
    ? node
    : node.querySelector<HTMLElement>(focusableControlSelector);
  target?.focus();
}

export function revealControl(node: HTMLElement): void {
  node.scrollIntoView({
    block: 'center',
    inline: 'nearest',
    behavior: 'smooth',
  });
}

/** Existing control descriptors keep their void return contract. */
export function highlightControl(node: HTMLElement, durationMs?: number): void;
export function highlightControl(
  node: HTMLElement,
  durationMs: number,
  options: { presentation: 'outline' },
): void;
export function highlightControl(
  node: HTMLElement,
  durationMs: number,
  options: {
    presentation: 'spotlight';
    dismissLabel: string;
    onDismiss?: () => void;
  },
): () => void;
export function highlightControl(
  node: HTMLElement,
  durationMs = 1600,
  options?:
    | { presentation: 'outline' }
    | {
        presentation: 'spotlight';
        dismissLabel: string;
        onDismiss?: () => void;
      },
): () => void {
  let disposed = false;
  const remove =
    options?.presentation === 'spotlight'
      ? paintControlSpotlight(node, options)
      : (() => {
          node.dataset.smrtHighlighted = 'true';
          return () => {
            delete node.dataset.smrtHighlighted;
          };
        })();
  const timer = globalThis.setTimeout(() => cleanup(), durationMs);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    globalThis.clearTimeout(timer);
    remove();
  };
  return cleanup;
}

export function emitControlChange(node: HTMLElement): void {
  queueMicrotask(() => {
    if (!node.isConnected) return;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
