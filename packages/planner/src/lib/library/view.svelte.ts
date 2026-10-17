import { tick } from 'svelte';
import { runViewTransition } from '../motion/view-transition.ts';

/** The query parameter naming the open cookbook: `?tab=cookbooks&cookbook=mechanic`. */
export const COOKBOOK_PARAM = 'cookbook';

/**
 * How a host keeps the open cookbook in its address, so browser Back returns
 * to the grid and a link opens the detail. The static app pushes a shallow
 * history entry (`?cookbook=`); the mounted Planner a fragment route
 * (`#/configure/cookbooks/<id>/`). Each one ends by calling `cookbookView.set`.
 */
export interface CookbookNavigator {
  open(id: string): void;
  close(): void;
}

/**
 * The Cookbooks tab's view: the grid, or one cookbook's detail in its place.
 * A UI note like the active tab, never part of the cookbook document.
 */
class CookbookView {
  /** The cookbook whose detail is shown; null shows the grid. */
  open = $state<string | null>(null);
  /** The card the visitor opened, to take focus back to on the way out. */
  returnTo = $state<string | null>(null);
  /** Set by a host that keeps the open cookbook in its address. */
  navigator: CookbookNavigator | null = null;

  /** Open a cookbook's detail in place of the grid. */
  show(id: string): void {
    this.returnTo = id;
    if (this.navigator) this.navigator.open(id);
    else void this.set(id);
  }

  /** Back to the grid. */
  back(): void {
    // A link that opened the detail came from no card: its own card it is.
    if (this.open) this.returnTo = this.open;
    if (this.navigator) this.navigator.close();
    else void this.set(null);
  }

  /**
   * Swap the view. A view transition crossfades the grid and the detail (the
   * shell's helper: none under reduced motion, an instant swap). `transition:
   * false` for a host whose own router already runs one, and for a page load.
   */
  async set(id: string | null, transition = true): Promise<void> {
    if (this.open === id) return;
    if (!transition) {
      this.open = id;
      return;
    }
    await runViewTransition(async () => {
      this.open = id;
      await tick();
    });
  }
}

export const cookbookView = new CookbookView();

/** The cookbook a query string opens (`?cookbook=`), when it is one of `ids`. */
export function cookbookFromSearch(
  search: string,
  ids: readonly string[],
): string | null {
  const id = new URLSearchParams(search).get(COOKBOOK_PARAM);
  return id && ids.includes(id) ? id : null;
}

/** Set or drop `?cookbook=` in a query string, keeping every other parameter. */
export function withCookbook(query: string, id: string | null): string {
  const params = new URLSearchParams(query);
  if (id) params.set(COOKBOOK_PARAM, id);
  else params.delete(COOKBOOK_PARAM);
  const out = params.toString().replace(/%2C/gi, ',');
  return out ? `?${out}` : '';
}
