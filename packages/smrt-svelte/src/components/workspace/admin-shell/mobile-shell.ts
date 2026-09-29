/**
 * Pure logic behind AdminShell's phone chrome: the hide-on-scroll state
 * machine, the on-screen keyboard heuristic, the phone top-bar model, and the
 * bottom-bar mode. DOM-free and SSR-safe so it can be unit tested; the DOM
 * wiring lives in `./mobile-shell-dom.ts`.
 */
import type { Component, ComponentType, SvelteComponent } from 'svelte';
import type { ShellViewport } from './types.js';

/** Classify a viewport from the phone and desktop media-query matches. */
export function viewportFor(matches: {
  phone: boolean;
  desktop: boolean;
}): ShellViewport {
  if (matches.phone) return 'phone';
  return matches.desktop ? 'desktop' : 'tablet';
}

// ---- Hide on scroll -------------------------------------------------------

/** Tuning for {@link ScrollChrome}. */
export interface ScrollChromeOptions {
  /** Always show the chrome within this many px of the top (default 56). */
  revealWithin?: number;
  /** Downward travel in px before the chrome hides (default 12). */
  hideAfter?: number;
  /** Upward travel in px before it comes back (default 4, "first scroll up"). */
  showAfter?: number;
}

/** One scroll position fed to {@link ScrollChrome.update}. */
export interface ScrollSample {
  /** Current scrollTop. */
  y: number;
  /** Largest reachable scrollTop, to ignore iOS overscroll bounce. */
  maxY?: number;
  /** Keep the chrome shown (a banner is visible, a drawer is open, …). */
  pinned?: boolean;
}

/**
 * Hide-on-scroll state machine for the phone top bar (and anything that
 * slides with it). Feed it every scroll position; read `hidden`. Travel
 * accumulates in one direction and resets when the direction reverses.
 */
export class ScrollChrome {
  hidden = false;
  #lastY = 0;
  #travel = 0;
  readonly #revealWithin: number;
  readonly #hideAfter: number;
  readonly #showAfter: number;

  constructor(options: ScrollChromeOptions = {}) {
    this.#revealWithin = options.revealWithin ?? 56;
    this.#hideAfter = options.hideAfter ?? 12;
    this.#showAfter = options.showAfter ?? 4;
  }

  /** Feed a scroll sample; returns whether the chrome is now hidden. */
  update(sample: ScrollSample): boolean {
    const max = sample.maxY ?? Number.POSITIVE_INFINITY;
    const y = Math.min(Math.max(sample.y, 0), Math.max(max, 0));

    if (sample.pinned || y <= this.#revealWithin) {
      this.hidden = false;
      this.#lastY = y;
      this.#travel = 0;
      return this.hidden;
    }

    const delta = y - this.#lastY;
    this.#lastY = y;
    if (delta === 0) return this.hidden;

    this.#travel =
      Math.sign(delta) === Math.sign(this.#travel)
        ? this.#travel + delta
        : delta;
    if (this.#travel >= this.#hideAfter) this.hidden = true;
    else if (-this.#travel >= this.#showAfter) this.hidden = false;
    return this.hidden;
  }

  /** Show the chrome and forget the scroll history (e.g. after navigating). */
  reset(): void {
    this.hidden = false;
    this.#lastY = 0;
    this.#travel = 0;
  }
}

// ---- On-screen keyboard ---------------------------------------------------

/**
 * `visualViewport` heuristic: the keyboard is open when the visible viewport
 * is much shorter than the layout viewport. `scale` undoes pinch zoom, which
 * also shrinks `visualViewport.height`.
 */
export function keyboardLikelyOpen(input: {
  layoutHeight: number;
  visualHeight: number;
  scale?: number;
  threshold?: number;
}): boolean {
  const visible = input.visualHeight * (input.scale ?? 1);
  return input.layoutHeight - visible > (input.threshold ?? 150);
}

// ---- Paths and nav trails -------------------------------------------------

/** A nav entry as far as path matching is concerned. */
export interface ShellNavPathItem {
  href: string;
  exact?: boolean;
  children?: ShellNavPathItem[];
}

/** Drop trailing slashes (`/` stays `/`). */
export function normalizeShellPath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/** Whether `path` is the item's page or (unless `exact`) below it. */
export function shellNavItemMatches(
  item: ShellNavPathItem,
  path: string,
): boolean {
  const href = normalizeShellPath(item.href);
  const current = normalizeShellPath(path);
  if (href === current) return true;
  if (item.exact || href === '/') return false;
  return current.startsWith(`${href}/`);
}

/** The chain of nav items from the top level down to the one matching `path`. */
export function findShellNavTrail<T extends ShellNavPathItem>(
  items: T[],
  path: string,
): T[] {
  for (const item of items) {
    const childTrail = item.children
      ? findShellNavTrail(item.children as T[], path)
      : [];
    if (childTrail.length > 0) return [item, ...childTrail];
    if (shellNavItemMatches(item, path)) return [item];
  }
  return [];
}

// ---- Page trail (breadcrumbs + phone back) --------------------------------

/** One ancestor of the current page: a breadcrumb and a possible back target. */
export interface ShellCrumb {
  label: string;
  href: string;
}

/** Input for {@link shellPageTrailFor}. */
export interface ShellPageTrailInput<
  T extends ShellNavPathItem & { label: string },
> {
  /** Current pathname. */
  path: string;
  /** The workspace home (overview) page. */
  homeHref: string;
  /** Workspace name: the first ancestor of every non-home page. */
  homeTitle: string;
  /** The workspace nav. */
  navItems: T[];
  /**
   * Ancestors deeper than the nav knows (an article above its video, a
   * council above its meeting), nearest last. They follow the nav trail.
   */
  parents?: readonly ShellCrumb[] | null;
}

/** Where a page sits: a section home, or a page with ancestors. */
export interface ShellPageTrail {
  /** The home page or a top-level nav page (and no page-given parents). */
  sectionHome: boolean;
  /** Ancestors only, never the current page; empty on section homes. */
  crumbs: ShellCrumb[];
  /** The nav item for the current page itself, if it is one. */
  current: { label: string; href: string } | null;
}

/**
 * The single source for a page's place in the workspace: breadcrumbs on
 * wider screens and the phone top bar's back target both come from here.
 *
 * Section homes (the home page and top-level nav pages) have no ancestors.
 * Anything else lists the workspace home, the nav items above it (a nested
 * nav page's parent item counts, even when its URL is not below it), then the
 * page-given `parents`. The current page is never a crumb.
 */
export function shellPageTrailFor<
  T extends ShellNavPathItem & { label: string },
>(input: ShellPageTrailInput<T>): ShellPageTrail {
  const path = normalizeShellPath(input.path);
  const home = normalizeShellPath(input.homeHref);
  const parents = [...(input.parents ?? [])];
  const trail = findShellNavTrail(input.navItems, path);
  const last = trail.at(-1);
  const currentItem =
    last && normalizeShellPath(last.href) === path ? last : null;
  const current = currentItem
    ? { label: currentItem.label, href: currentItem.href }
    : null;

  const topLevelHome =
    path === home ||
    input.navItems.some((item) => normalizeShellPath(item.href) === path);
  if (topLevelHome && parents.length === 0) {
    return { sectionHome: true, crumbs: [], current };
  }

  const crumbs: ShellCrumb[] = [
    { label: input.homeTitle, href: input.homeHref },
  ];
  for (const item of trail) {
    if (item === currentItem) continue;
    const href = normalizeShellPath(item.href);
    if (href === home || href === path) continue;
    crumbs.push({ label: item.label, href: item.href });
  }
  for (const parent of parents) {
    if (normalizeShellPath(parent.href) === path) continue;
    crumbs.push({ label: parent.label, href: parent.href });
  }
  return { sectionHome: false, crumbs, current };
}

// ---- Phone top bar --------------------------------------------------------

/**
 * What the phone top bar shows: the workspace name on section home pages, or
 * a back arrow (to the parent, never `history.back()`) plus the page's
 * title on every other page.
 */
export type PhoneTopBarModel =
  | { kind: 'home'; title: string }
  | { kind: 'detail'; title: string; backHref: string; backLabel: string };

/** Input for {@link phoneTopBarFor}. */
export interface PhoneTopBarInput<
  T extends ShellNavPathItem & { label: string },
> extends ShellPageTrailInput<T> {
  /** Title the page provided (article headline, person's name, …). */
  pageTitle?: string | null;
  /**
   * Explicit back target. Prefer `parents` (the same ancestors the page's
   * breadcrumbs show); this overrides the last one.
   */
  backHref?: string | null;
  /** Back label used with an explicit `backHref` (default "Back"). */
  backLabel?: string;
}

/**
 * Section homes (see {@link shellPageTrailFor}) show the workspace name.
 * Every other page shows a back arrow to its nearest ancestor (the last
 * breadcrumb) and the page's title.
 */
export function phoneTopBarFor<T extends ShellNavPathItem & { label: string }>(
  input: PhoneTopBarInput<T>,
): PhoneTopBarModel {
  const trail = shellPageTrailFor(input);
  if (trail.sectionHome && !input.backHref) {
    return { kind: 'home', title: input.homeTitle };
  }

  const parent = trail.crumbs.at(-1) ?? {
    label: input.homeTitle,
    href: input.homeHref,
  };
  const backHref = input.backHref ?? parent.href;
  const backLabel = input.backHref ? (input.backLabel ?? 'Back') : parent.label;
  const title = input.pageTitle?.trim() || trail.current?.label || parent.label;
  return { kind: 'detail', title, backHref, backLabel };
}

// ---- Phone bottom bar -----------------------------------------------------

/**
 * What sits at the bottom of a phone screen: the nav bar, a form's own
 * action bar (which replaces it), or nothing while the keyboard is open.
 */
export type BottomBarMode = 'nav' | 'form' | 'none';

/** Decide the {@link BottomBarMode}. */
export function bottomBarMode(input: {
  formActions: boolean;
  keyboardOpen: boolean;
}): BottomBarMode {
  if (input.keyboardOpen) return 'none';
  return input.formActions ? 'form' : 'nav';
}

/** Selector a form's action row carries to replace the phone bottom bar. */
export const FORM_ACTION_BAR_SELECTOR = '[data-form-action-bar]';

/**
 * An icon component: a Svelte 5 function component or a legacy class
 * component (e.g. lucide-svelte icons).
 */
export type ShellIcon =
  | Component<{ size?: number | string }>
  | ComponentType<SvelteComponent<{ size?: number | string }>>;

/** One phone bottom bar entry: a link (`href`; `onclick` also runs) or a button. */
export interface PhoneBottomBarItem {
  id: string;
  label: string;
  icon: ShellIcon;
  href?: string;
  onclick?: () => void;
  active?: boolean;
  /** Count badge (hidden at 0). */
  badge?: number;
  /** Small dot, e.g. an unread reply. */
  dot?: boolean;
  /** Accessible description of the dot (default "new"). */
  dotLabel?: string;
  /** For items that open a panel: its expanded state and id. */
  expanded?: boolean;
  controls?: string;
}
