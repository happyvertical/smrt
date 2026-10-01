/**
 * Swipe-to-dismiss for phone surfaces: a drawer closes on a swipe left, a
 * bottom sheet on a swipe down.
 *
 * `swipeDismisses` is the pure decision (unit-testable, DOM-free);
 * `swipeDismiss` is the Svelte action that feeds it touch events. Touch only:
 * mouse drags keep selecting text. Never bind a left-edge swipe to anything —
 * mobile browsers use it for Back.
 */

/** The direction a surface is swiped to dismiss it. */
export type SwipeDirection = 'left' | 'right' | 'down';

/** Minimum travel (px) that counts as a dismissing swipe. */
export const SWIPE_DISMISS_THRESHOLD = 64;

/**
 * Whether a drag of (`dx`, `dy`) px dismisses a surface swiped in `direction`.
 * The drag must travel at least `threshold` px and be clearly more along the
 * dismiss axis than across it (1.5x), so a vertical scroll never closes a
 * drawer and a sideways pan never closes a sheet.
 */
export function swipeDismisses(
  dx: number,
  dy: number,
  direction: SwipeDirection,
  threshold = SWIPE_DISMISS_THRESHOLD,
): boolean {
  if (direction === 'left') {
    return -dx >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5;
  }
  if (direction === 'right') {
    return dx >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5;
  }
  return dy >= threshold && Math.abs(dy) > Math.abs(dx) * 1.5;
}

/** Options for the {@link swipeDismiss} action. */
export interface SwipeDismissOptions {
  /** Direction that dismisses the surface. */
  direction: SwipeDirection;
  /** Called once a swipe in `direction` passes the threshold. */
  onDismiss: () => void;
  /** Set `false` to ignore swipes (e.g. only enable on phones). */
  enabled?: boolean;
  /** Minimum travel in px (default {@link SWIPE_DISMISS_THRESHOLD}). */
  threshold?: number;
}

/**
 * Svelte action: dismiss a drawer or sheet with a touch swipe.
 *
 * @example
 * <div use:swipeDismiss={{ direction: 'down', onDismiss: close }}>…</div>
 */
export function swipeDismiss(
  node: HTMLElement,
  initial: SwipeDismissOptions,
): {
  update: (next: SwipeDismissOptions) => void;
  destroy: () => void;
} {
  let options = initial;
  let start: { x: number; y: number } | null = null;

  function onStart(event: TouchEvent): void {
    if (options.enabled === false || event.touches.length !== 1) return;
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY };
  }

  function onEnd(event: TouchEvent): void {
    if (!start) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start = null;
    if (swipeDismisses(dx, dy, options.direction, options.threshold)) {
      options.onDismiss();
    }
  }

  function onCancel(): void {
    start = null;
  }

  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchend', onEnd);
  node.addEventListener('touchcancel', onCancel);
  return {
    update(next: SwipeDismissOptions): void {
      options = next;
    },
    destroy(): void {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onCancel);
    },
  };
}
