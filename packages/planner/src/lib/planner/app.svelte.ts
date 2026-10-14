import { composeQuery } from './query.ts';
import { selection } from './selection.svelte.ts';

/**
 * Where the planner's pages live: `''` at the site root, `/planner` under a
 * sub-path. The static app sets it from SvelteKit's `base`; a host that mounts
 * the `Planner` component passes its own `basePath`. Kept here, not read from
 * `$app/paths`, so the planner needs no SvelteKit router to build its links.
 */
let basePath = '';

/**
 * How in-app links are written. The static app serves `/m/...` pages under
 * `basePath`; the mounted `Planner` routes by URL fragment (`#/m/...`) and
 * serves nothing from the host's paths, so its links are hashes and carry no
 * query (the mount keeps its selection in memory).
 */
export type LinkMode = 'path' | 'hash';

let linkMode: LinkMode = 'path';

export function setBasePath(path: string, links: LinkMode = 'path'): void {
  basePath = path.replace(/\/+$/, '');
  linkMode = links;
}

export function getBasePath(): string {
  return basePath;
}

/** The query string carrying the shareable URL state (the package selection). */
export function appQuery(): string {
  return composeQuery({ packages: selection.ids });
}

/**
 * An in-app path (`/m/commerce/Order/`) as a link: under the base path with
 * the current app state, or, in a mounted `Planner`, as its fragment route.
 */
export function appHref(path: string): string {
  if (linkMode === 'hash') return `#${path}`;
  const query = appQuery();
  // A path may carry its own query ("View all": `?customerId=<id>`).
  const joined =
    query && path.includes('?') ? `${path}&${query.slice(1)}` : path + query;
  return `${basePath}${joined}`;
}
