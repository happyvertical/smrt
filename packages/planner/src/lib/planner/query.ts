import { SELECTION_PARAM } from './selection.ts';

export interface QueryParts {
  packages: readonly string[];
}

/**
 * The one place the shareable URL state becomes a query string. Only the
 * package selection lives in the URL: recipes, options and the layout are the
 * blueprint, saved in localStorage (`blueprint/`).
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
