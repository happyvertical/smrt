/**
 * View Transitions helpers for hosts. Plain functions: no SvelteKit, no
 * `$app/*`, usable from a hash router or any non-SvelteKit host.
 *
 * While a transition runs, `<html data-smrt-view-transition>` is set. The
 * shell assigns these `view-transition-name`s only during that window (so the
 * names never create containing blocks the rest of the time), and each must be
 * unique per document: hosts must not reuse them.
 *
 * - `smrt-shell-brand` the brand
 * - `smrt-shell-nav`   the left sidebar navigation
 * - `smrt-shell-dock`  the right dock
 */

export const VIEW_TRANSITION_ATTRIBUTE = 'data-smrt-view-transition';

export interface RunViewTransitionOptions {
  /** Run `update` without a transition. */
  skip?: boolean;
}

interface ViewTransitionLike {
  ready?: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
  finished: Promise<unknown>;
}

type StartViewTransition = (
  update: () => void | Promise<void>,
) => ViewTransitionLike;

let active = 0;

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Runs `update` inside `document.startViewTransition` when the API exists and
 * reduced motion is off; otherwise just awaits `update()`. Resolves once the
 * DOM update has been applied (not when the animation ends). An aborted or
 * skipped transition never throws; an error thrown by `update` itself does.
 */
export async function runViewTransition(
  update: () => void | Promise<void>,
  options: RunViewTransitionOptions = {},
): Promise<void> {
  const doc = typeof document === 'undefined' ? undefined : document;
  const start = (
    doc as unknown as { startViewTransition?: StartViewTransition }
  )?.startViewTransition;
  if (!doc || options.skip || typeof start !== 'function' || reducedMotion()) {
    await update();
    return;
  }

  let transition: ViewTransitionLike;
  active += 1;
  doc.documentElement.setAttribute(VIEW_TRANSITION_ATTRIBUTE, '');
  const release = () => {
    active = Math.max(0, active - 1);
    if (active === 0)
      doc.documentElement.removeAttribute(VIEW_TRANSITION_ATTRIBUTE);
  };
  try {
    transition = start.call(doc, update);
  } catch {
    release();
    await update();
    return;
  }
  // Aborts reject `ready` / `finished`; they are not errors.
  transition.ready?.catch(() => {});
  void Promise.resolve(transition.finished).then(release, release);
  await transition.updateCallbackDone;
}

/** The slice of SvelteKit's `Navigation` the adapter needs. */
export interface ViewTransitionNavigation {
  complete: Promise<unknown>;
  type?: string;
  willUnload?: boolean;
}

/**
 * Adapter for SvelteKit's `onNavigate`:
 *
 * ```ts
 * onNavigate(createOnNavigateViewTransition());
 * ```
 *
 * Returns a promise that resolves once the transition has captured the old
 * view, which is what `onNavigate` awaits before updating the DOM.
 */
export function createOnNavigateViewTransition(
  options: RunViewTransitionOptions = {},
): (navigation: ViewTransitionNavigation) => Promise<void> | void {
  return (navigation) => {
    if (navigation.willUnload || navigation.type === 'leave') return;
    return new Promise<void>((resolve) => {
      runViewTransition(async () => {
        resolve();
        await navigation.complete;
      }, options).then(resolve, resolve);
    });
  };
}
