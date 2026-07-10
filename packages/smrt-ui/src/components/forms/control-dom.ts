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

export function highlightControl(node: HTMLElement, durationMs = 1600): void {
  node.dataset.smrtHighlighted = 'true';
  globalThis.setTimeout(() => {
    if (node.isConnected) delete node.dataset.smrtHighlighted;
  }, durationMs);
}

export function emitControlChange(node: HTMLElement): void {
  queueMicrotask(() => {
    if (!node.isConnected) return;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
