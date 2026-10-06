import { base } from '$app/paths';
import { composeQuery } from './query.ts';
import { selection } from './selection.svelte.ts';

/** The query string carrying the shareable URL state (the package selection). */
export function appQuery(): string {
  return composeQuery({ packages: selection.ids });
}

/** An in-app path (`/m/commerce/Order/`) carrying the current app state. */
export function appHref(path: string): string {
  return `${base}${path}${appQuery()}`;
}
