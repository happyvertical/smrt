import { composeQuery } from './query.ts';
import { selection } from './selection.svelte.ts';

/**
 * Where the planner's pages live: `''` at the site root, `/planner` under a
 * sub-path. The static app sets it from SvelteKit's `base`; a host that mounts
 * the `Planner` component passes its own `basePath`. Kept here, not read from
 * `$app/paths`, so the planner needs no SvelteKit router to build its links.
 */
let basePath = '';

export function setBasePath(path: string): void {
  basePath = path.replace(/\/+$/, '');
}

export function getBasePath(): string {
  return basePath;
}

/** The query string carrying the shareable URL state (the package selection). */
export function appQuery(): string {
  return composeQuery({ packages: selection.ids });
}

/** An in-app path (`/m/commerce/Order/`) carrying the current app state. */
export function appHref(path: string): string {
  return `${basePath}${path}${appQuery()}`;
}
