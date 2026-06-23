import type { Action } from 'svelte/action';

/**
 * Svelte action to add a Material 3 ripple effect to an element.
 *
 * Uses the canonical `--smrt-color-primary` token (the SMRT theme system only
 * ever emits `--smrt-color-*`; the legacy `--md-sys-*` namespace is not produced
 * by the canonical providers), falling back to `currentColor`.
 *
 * Respects `prefers-reduced-motion`: when the user requests reduced motion the
 * ripple is skipped entirely. On `destroy()` all pending ripple spans, their
 * removal timeouts, and the window pointer-up listeners are cleaned up so an
 * unmount mid-press cannot leak DOM nodes or listeners.
 */
export const ripple: Action<HTMLElement> = (node) => {
  const prefersReducedMotion = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Track in-flight ripples so destroy() can tear them down deterministically.
  const activeSpans = new Set<HTMLElement>();
  const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  const pendingPointerUp = new Set<() => void>();

  const handleStart = (e: MouseEvent | TouchEvent) => {
    // Honor reduced-motion: no ripple animation at all.
    if (prefersReducedMotion()) return;

    const rect = node.getBoundingClientRect();
    const clientX =
      'touches' in e
        ? (e as TouchEvent).touches[0].clientX
        : (e as MouseEvent).clientX;
    const clientY =
      'touches' in e
        ? (e as TouchEvent).touches[0].clientY
        : (e as MouseEvent).clientY;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const diameter = Math.max(rect.width, rect.height) * 2.5;
    const radius = diameter / 2;

    const rippleEl = document.createElement('span');

    // Inline critical styles
    rippleEl.style.position = 'absolute';
    rippleEl.style.borderRadius = '50%';
    rippleEl.style.pointerEvents = 'none';
    rippleEl.style.width = rippleEl.style.height = `${diameter}px`;
    rippleEl.style.left = `${x - radius}px`;
    rippleEl.style.top = `${y - radius}px`;
    rippleEl.style.backgroundColor = 'var(--smrt-color-primary, currentColor)';
    rippleEl.style.opacity = '0.12';
    rippleEl.style.transform = 'scale(0)';
    rippleEl.style.transition =
      'transform 600ms cubic-bezier(0.4, 0, 0.2, 1), opacity 600ms linear';

    rippleEl.classList.add('smrt-ripple');

    node.appendChild(rippleEl);
    activeSpans.add(rippleEl);

    // Trigger animation
    requestAnimationFrame(() => {
      rippleEl.style.transform = 'scale(1)';
    });

    // Bound to this ripple so the pointer-up handler and its timeout can be
    // forgotten once they run (or torn down early in destroy()).
    let removeRipple: () => void;

    const detachPointerUp = () => {
      window.removeEventListener('mouseup', removeRipple);
      window.removeEventListener('touchend', removeRipple);
      pendingPointerUp.delete(removeRipple);
    };

    removeRipple = () => {
      detachPointerUp();
      rippleEl.style.opacity = '0';
      const timeout = setTimeout(() => {
        pendingTimeouts.delete(timeout);
        activeSpans.delete(rippleEl);
        if (rippleEl.parentNode === node) {
          node.removeChild(rippleEl);
        }
      }, 600);
      pendingTimeouts.add(timeout);
    };

    pendingPointerUp.add(removeRipple);
    window.addEventListener('mouseup', removeRipple, { once: true });
    window.addEventListener('touchend', removeRipple, { once: true });
  };

  node.addEventListener('mousedown', handleStart);
  node.addEventListener('touchstart', handleStart, { passive: true });

  // Ensure node is prepared (and remember prior values so destroy() can restore).
  const originalPosition = node.style.position;
  const originalOverflow = node.style.overflow;

  if (!node.style.position || node.style.position === 'static') {
    node.style.position = 'relative';
  }
  node.style.overflow = 'hidden';

  return {
    destroy() {
      node.removeEventListener('mousedown', handleStart);
      node.removeEventListener('touchstart', handleStart);

      // Cancel pending removal timeouts.
      for (const timeout of pendingTimeouts) clearTimeout(timeout);
      pendingTimeouts.clear();

      // Detach any window pointer-up listeners still waiting for a release.
      for (const handler of pendingPointerUp) {
        window.removeEventListener('mouseup', handler);
        window.removeEventListener('touchend', handler);
      }
      pendingPointerUp.clear();

      // Remove any ripple spans still appended to the node.
      for (const span of activeSpans) {
        if (span.parentNode === node) node.removeChild(span);
      }
      activeSpans.clear();

      // Restore the node's original inline layout styles.
      node.style.position = originalPosition;
      node.style.overflow = originalOverflow;
    },
  };
};
