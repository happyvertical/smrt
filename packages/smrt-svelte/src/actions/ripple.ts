import type { Action } from 'svelte/action';

/**
 * Svelte action to add a Material 3 ripple effect to an element.
 * Respects CSS variables defined by ThemeProvider.
 */
export const ripple: Action<HTMLElement> = (node) => {
  const handleStart = (e: MouseEvent | TouchEvent) => {
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
    rippleEl.style.backgroundColor =
      'var(--md-sys-color-primary, currentColor)';
    rippleEl.style.opacity = '0.12';
    rippleEl.style.transform = 'scale(0)';
    rippleEl.style.transition =
      'transform 600ms cubic-bezier(0.4, 0, 0.2, 1), opacity 600ms linear';

    rippleEl.classList.add('smrt-ripple');

    node.appendChild(rippleEl);

    // Trigger animation
    requestAnimationFrame(() => {
      rippleEl.style.transform = 'scale(1)';
    });

    const removeRipple = () => {
      rippleEl.style.opacity = '0';
      setTimeout(() => {
        if (rippleEl.parentNode === node) {
          node.removeChild(rippleEl);
        }
      }, 600);
    };

    window.addEventListener('mouseup', removeRipple, { once: true });
    window.addEventListener('touchend', removeRipple, { once: true });
  };

  node.addEventListener('mousedown', handleStart);
  node.addEventListener('touchstart', handleStart, { passive: true });

  // Ensure node is prepared
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
      // Restore styles if necessary, though usually fine to keep for UI components
    },
  };
};
