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
  root.append(veil, button);
  let disposed = false;
  let frame = 0;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    view.cancelAnimationFrame(frame);
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
    // Track movement caused by scrolling, resizing or surrounding layout. No
    // animation/interpolation is applied, including under reduced motion.
    frame = view.requestAnimationFrame(update);
  };
  button.addEventListener('click', dismiss);
  update();
  if (!disposed) doc.body.append(root);
  return cleanup;
}
