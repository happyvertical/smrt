import { base } from '$app/paths';
import { recipeState } from '../recipes/state.svelte.ts';
import { composeQuery } from './query.ts';
import { selection } from './selection.svelte.ts';

/** The query string carrying the whole shareable app state. */
export function appQuery(): string {
  const { recipes, options } = recipeState.encoded();
  return composeQuery({ packages: selection.ids, recipes, options });
}

/** An in-app path (`/m/commerce/Order/`) carrying the current app state. */
export function appHref(path: string): string {
  return `${base}${path}${appQuery()}`;
}
