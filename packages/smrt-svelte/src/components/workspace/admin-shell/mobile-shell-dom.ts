/**
 * DOM wiring for AdminShell's responsive chrome. Every installer returns a
 * disposer and is a no-op without the browser API it needs, so callers can
 * run them from `onMount` without guards. The decisions live in
 * `./mobile-shell.ts`.
 */
import { isEditableTarget } from './hotkeys.js';
import {
  FORM_ACTION_BAR_SELECTOR,
  keyboardLikelyOpen,
  ScrollChrome,
  type ScrollChromeOptions,
  viewportFor,
} from './mobile-shell.js';
import {
  ADMIN_SHELL_DESKTOP_QUERY,
  ADMIN_SHELL_PHONE_QUERY,
  type ShellState,
} from './state.svelte.js';

/**
 * Keep `shell.viewport` in step with the phone/desktop media queries (which
 * applies each edge's `viewportDefaults` when the class changes).
 */
export function installShellViewport(shell: ShellState): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return () => {};
  }
  const phone = window.matchMedia(ADMIN_SHELL_PHONE_QUERY);
  const desktop = window.matchMedia(ADMIN_SHELL_DESKTOP_QUERY);
  const sync = () =>
    shell.setViewport(
      viewportFor({ phone: phone.matches, desktop: desktop.matches }),
    );
  sync();
  phone.addEventListener('change', sync);
  desktop.addEventListener('change', sync);
  return () => {
    phone.removeEventListener('change', sync);
    desktop.removeEventListener('change', sync);
  };
}

/**
 * Hide-on-scroll for one scroller (AdminShell's main region). Samples once
 * per animation frame and reports changes of the hidden state.
 */
export function installScrollChrome(
  scroller: HTMLElement,
  options: {
    onChange: (hidden: boolean) => void;
    isPinned: () => boolean;
    tuning?: ScrollChromeOptions;
  },
): { recheck: () => void; reset: () => void; destroy: () => void } {
  const chrome = new ScrollChrome(options.tuning);
  let frame = 0;
  let last = false;

  function sample(): void {
    frame = 0;
    const hidden = chrome.update({
      y: scroller.scrollTop,
      maxY: scroller.scrollHeight - scroller.clientHeight,
      pinned: options.isPinned(),
    });
    if (hidden !== last) {
      last = hidden;
      options.onChange(hidden);
    }
  }

  function onScroll(): void {
    if (!frame) frame = requestAnimationFrame(sample);
  }

  scroller.addEventListener('scroll', onScroll, { passive: true });
  return {
    recheck: sample,
    reset(): void {
      chrome.reset();
      if (last) {
        last = false;
        options.onChange(false);
      }
    },
    destroy(): void {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
    },
  };
}

/**
 * Watch for the on-screen keyboard. Sets `data-keyboard-open` on `<html>`
 * (phone bars and `FormActionBar` hide on it) and keeps the focused field in
 * view when the keyboard opens.
 */
export function installKeyboardWatcher(
  onChange: (open: boolean) => void,
): () => void {
  if (typeof window === 'undefined' || !window.visualViewport) {
    return () => {};
  }
  const viewport = window.visualViewport;
  let open = false;

  function sync(): void {
    const next = keyboardLikelyOpen({
      layoutHeight: window.innerHeight,
      visualHeight: viewport.height,
      scale: viewport.scale,
    });
    if (next === open) return;
    open = next;
    if (open) document.documentElement.dataset.keyboardOpen = '';
    else delete document.documentElement.dataset.keyboardOpen;
    onChange(open);
    const active = document.activeElement;
    if (open && active instanceof HTMLElement && isEditableTarget(active)) {
      active.scrollIntoView({ block: 'center' });
    }
  }

  viewport.addEventListener('resize', sync);
  return () => {
    viewport.removeEventListener('resize', sync);
    delete document.documentElement.dataset.keyboardOpen;
  };
}

/**
 * Report whether `container` holds a form action bar
 * (`[data-form-action-bar]`), now and whenever its subtree changes.
 */
export function watchFormActionBar(
  container: HTMLElement,
  onChange: (present: boolean) => void,
): () => void {
  let present = Boolean(container.querySelector(FORM_ACTION_BAR_SELECTOR));
  onChange(present);
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(() => {
    const next = Boolean(container.querySelector(FORM_ACTION_BAR_SELECTOR));
    if (next === present) return;
    present = next;
    onChange(present);
  });
  observer.observe(container, { childList: true, subtree: true });
  return () => observer.disconnect();
}
