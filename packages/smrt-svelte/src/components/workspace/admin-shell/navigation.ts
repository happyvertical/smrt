/**
 * "Something in the dock just navigated the page" (#4100).
 *
 * A dock card that opens a page (an approved report, a created record) calls
 * `announceShellNavigation(element)` after navigating. `AdminShell` listens:
 * when the dock is currently laid OVER the page (a slide-over below the
 * `overlayMedia` breakpoint, or a phone sheet/drawer) and the right edge's
 * `closeOnNavigate` is not false, it closes the dock so the page is visible;
 * a dock sitting beside the page stays open. Either way focus moves to the
 * opened page's heading (`focus`, else the main region's first heading).
 * Pure DOM: any package inside the dock can announce without importing the
 * shell.
 */

/** The bubbling DOM event a dock card dispatches after navigating. */
export const SHELL_NAVIGATED_EVENT = 'smrt-shell-navigated';

export interface ShellNavigatedDetail {
  /** Selector of the element to focus once it appears (default: the page heading). */
  focus?: string;
}

/** Announce from `from` (inside the dock) that the page navigated. */
export function announceShellNavigation(
  from: Element,
  detail: ShellNavigatedDetail = {},
): void {
  from.dispatchEvent(
    new CustomEvent<ShellNavigatedDetail>(SHELL_NAVIGATED_EVENT, {
      bubbles: true,
      composed: true,
      detail,
    }),
  );
}

/** The heading a navigation lands on when the announcer names none. */
export const SHELL_PAGE_HEADING = 'h1, h2';

/**
 * Focus the first `selector` match inside `root` that was NOT already on the
 * page when called (the navigation may not have finished: the outgoing page's
 * heading must not take focus), polling for up to `timeoutMs` while the new
 * page loads. A heading that is not focusable gets `tabindex="-1"` first.
 * Returns a cancel function.
 */
export function focusWhenReady(
  root: ParentNode,
  selector: string,
  timeoutMs = 3000,
): () => void {
  const started = Date.now();
  const outgoing = new Set(root.querySelectorAll(selector));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = () => {
    const target = [...root.querySelectorAll<HTMLElement>(selector)].find(
      (element) => !outgoing.has(element),
    );
    if (target) {
      if (!target.hasAttribute('tabindex') && target.tabIndex < 0) {
        target.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: false });
      return;
    }
    if (Date.now() - started < timeoutMs) timer = setTimeout(attempt, 50);
  };
  timer = setTimeout(attempt, 0);
  return () => {
    if (timer) clearTimeout(timer);
  };
}
