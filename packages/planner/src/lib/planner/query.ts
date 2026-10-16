import { SELECTION_PARAM } from './selection.ts';

/** The query parameter naming the Planner's active tab: `?tab=layout`. */
export const TAB_PARAM = 'tab';

export interface QueryParts {
  packages: readonly string[];
}

/**
 * The one place the shareable URL state becomes a query string. Only the
 * package selection lives in the URL: recipes, options and the layout are the
 * cookbook, saved in localStorage (`cookbook/`). The Planner's tab is added
 * by `withTab`, only on the Planner page.
 */
export function composeQuery(parts: QueryParts): string {
  return parts.packages.length
    ? `?${SELECTION_PARAM}=${[...parts.packages].sort().join(',')}`
    : '';
}

/** Does this query string carry a package selection? */
export function hasAppState(search: string): boolean {
  return new URLSearchParams(search).has(SELECTION_PARAM);
}

/** Add `?tab=` to a query string, keeping every other parameter. */
export function withTab(query: string, tab: string): string {
  const params = new URLSearchParams(query);
  if (tab === 'recipes') params.delete(TAB_PARAM);
  else params.set(TAB_PARAM, tab);
  const out = params.toString().replace(/%2C/gi, ',');
  return out ? `?${out}` : '';
}
