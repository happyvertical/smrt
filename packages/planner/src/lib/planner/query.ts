import { SELECTION_PARAM } from './selection.ts';

/** Recipes the visitor added: `?r=commerce.customers,commerce.sales`. */
export const RECIPE_PARAM = 'r';
/** Saved recipe options (policy rows), encoded; see `recipes/encoding.ts`. */
export const OPTIONS_PARAM = 'o';

export interface QueryParts {
  packages: readonly string[];
  recipes: readonly string[];
  /** Already-encoded options, or `''`. */
  options: string;
}

/** The one place the shareable app state becomes a query string. */
export function composeQuery(parts: QueryParts): string {
  const params: string[] = [];
  if (parts.packages.length) {
    params.push(`${SELECTION_PARAM}=${[...parts.packages].sort().join(',')}`);
  }
  if (parts.recipes.length) {
    params.push(`${RECIPE_PARAM}=${[...parts.recipes].sort().join(',')}`);
  }
  if (parts.options) params.push(`${OPTIONS_PARAM}=${parts.options}`);
  return params.length ? `?${params.join('&')}` : '';
}

/** Does this query string carry any shareable app state? */
export function hasAppState(search: string): boolean {
  const params = new URLSearchParams(search);
  return [SELECTION_PARAM, RECIPE_PARAM, OPTIONS_PARAM].some((key) =>
    params.has(key),
  );
}

export function readRecipeIds(search: string): string[] {
  return (new URLSearchParams(search).get(RECIPE_PARAM) ?? '')
    .split(',')
    .filter(Boolean);
}

export function readOptions(search: string): string {
  return new URLSearchParams(search).get(OPTIONS_PARAM) ?? '';
}
