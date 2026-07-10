/** DOM adapter helpers shared by addressable control Implementations. */

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
