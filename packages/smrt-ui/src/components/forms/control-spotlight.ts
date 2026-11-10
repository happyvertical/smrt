/** Passive viewport veil around an actual control; no guide/navigation state. */
export function paintControlSpotlight(
  node: HTMLElement,
  options: { dismissLabel: string; onDismiss?: () => void },
): () => void {
  const doc = node.ownerDocument;
  const view = doc.defaultView;
  if (!view || !node.isConnected) return () => {};
  const root = doc.createElement('div');
  root.dataset.smrtComponent = 'ControlSpotlight';
  const tokens = view.getComputedStyle(node);
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: tokens.getPropertyValue('--smrt-z-index-overlay').trim() || '1200',
  });
  const veil = doc.createElement('div');
  veil.dataset.smrtSpotlightVeil = '';
  veil.setAttribute('aria-hidden', 'true');
  Object.assign(veil.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    // Spotlight is a guidance veil, matching the contact spotlight rather
    // than the theme's lighter modal scrim. Other overlays keep their tokens.
    background: 'rgba(3, 5, 9, 0.72)',
  });
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = options.dismissLabel;
  button.setAttribute('aria-label', options.dismissLabel);
  Object.assign(button.style, {
    position: 'absolute',
    insetInlineEnd: '1rem',
    pointerEvents: 'auto',
    cursor: 'pointer',
    padding: '0.5rem 1rem',
    borderRadius:
      tokens.getPropertyValue('--smrt-radius-medium').trim() || '0.5rem',
    background:
      tokens.getPropertyValue('--smrt-color-surface').trim() || '#fff',
    color: tokens.getPropertyValue('--smrt-color-on-surface').trim() || '#111',
    border:
      tokens.getPropertyValue('--smrt-hairline').trim() ||
      '1px solid currentColor',
    font: 'inherit',
  });
  // An arrow beside the cutout makes a small target easy to find. It sits on
  // the roomier side and bobs gently, unless the visitor reduces motion.
  const arrow = doc.createElement('div');
  arrow.dataset.smrtSpotlightArrow = '';
  arrow.setAttribute('aria-hidden', 'true');
  const ARROW = 40;
  Object.assign(arrow.style, {
    position: 'absolute',
    inlineSize: `${ARROW}px`,
    blockSize: `${ARROW}px`,
    pointerEvents: 'none',
    color: tokens.getPropertyValue('--smrt-color-warning').trim() || '#fbbf24',
    filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6))',
  });
  arrow.innerHTML =
    '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" stroke="rgba(3, 5, 9, 0.85)" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2 21 12h-5v10H8V12H3z"/></svg>';
  const reduce = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let bob: Animation | undefined;
  let direction: 'up' | 'down' | '' = '';
  root.append(veil, arrow, button);
  let disposed = false;
  let frame = 0;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    view.cancelAnimationFrame(frame);
    bob?.cancel();
    root.remove();
    button.removeEventListener('click', dismiss);
  };
  const dismiss = () => {
    cleanup();
    options.onDismiss?.();
  };
  const update = () => {
    if (disposed) return;
    // The shell exposes its occupied phone footer track on descendants.
    // Read it live: a guide can remain active while the viewport crosses to phone.
    const footerTrack = view
      .getComputedStyle(node)
      .getPropertyValue('--smrt-admin-shell-phone-bar-track')
      .trim();
    button.style.insetBlockEnd = `calc(1rem + ${footerTrack || 'env(safe-area-inset-bottom, 0px)'})`;
    const r = node.getBoundingClientRect();
    if (
      !node.isConnected ||
      node.closest('[hidden],[inert],[aria-hidden="true"]') ||
      (typeof node.checkVisibility === 'function' && !node.checkVisibility()) ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.right <= 0 ||
      r.bottom <= 0 ||
      r.left >= view.innerWidth ||
      r.top >= view.innerHeight
    ) {
      dismiss();
      return;
    }
    const x1 = Math.max(0, Math.round(r.left - 8));
    const y1 = Math.max(0, Math.round(r.top - 8));
    const x2 = Math.min(view.innerWidth, Math.round(r.right + 8));
    const y2 = Math.min(view.innerHeight, Math.round(r.bottom + 8));
    veil.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;
    const next = (r.top + r.bottom) / 2 < view.innerHeight / 2 ? 'up' : 'down';
    const left = Math.min(
      Math.max(0, Math.round((r.left + r.right) / 2 - ARROW / 2)),
      Math.max(0, view.innerWidth - ARROW),
    );
    arrow.style.left = `${left}px`;
    arrow.style.top = `${next === 'up' ? y2 + 6 : Math.max(0, y1 - ARROW - 6)}px`;
    if (next !== direction) {
      direction = next;
      arrow.dataset.direction = next;
      arrow.style.transform = next === 'up' ? '' : 'rotate(180deg)';
      bob?.cancel();
      const lift = next === 'up' ? '6px' : '-6px';
      const turn = next === 'up' ? '' : ' rotate(180deg)';
      bob =
        !reduce && typeof arrow.animate === 'function'
          ? arrow.animate(
              [
                { transform: `translateY(0)${turn}` },
                { transform: `translateY(${lift})${turn}` },
              ],
              {
                duration: 600,
                iterations: Number.POSITIVE_INFINITY,
                direction: 'alternate',
                easing: 'ease-in-out',
              },
            )
          : undefined;
      // Cancellation rejects finished; observe it before dismiss or direction change.
      void bob?.finished.catch((error: unknown) => {
        if (
          !(error instanceof view.DOMException && error.name === 'AbortError')
        ) {
          throw error;
        }
      });
    }
    // Track movement caused by scrolling, resizing or surrounding layout. No
    // animation/interpolation is applied, including under reduced motion.
    frame = view.requestAnimationFrame(update);
  };
  button.addEventListener('click', dismiss);
  update();
  if (!disposed) doc.body.append(root);
  return cleanup;
}
