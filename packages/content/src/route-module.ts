/**
 * Internal content route module
 *
 * Keeps the package's own page shells and loader helpers aligned without
 * publishing a public `./routes` package contract.
 *
 * @example Package-local SvelteKit wrapper
 * ```ts
 * // src/routes/articles/[slug]/+page.ts
 * import { error } from '@sveltejs/kit';
 * import { CONTENT_ROUTE_MODULE, isContentRouteLoadError } from '../route-module.js';
 *
 * export async function load(event) {
 *   try {
 *     return await CONTENT_ROUTE_MODULE.routes.article.load?.({
 *       fetch: event.fetch,
 *       slug: event.params.slug,
 *       apiBasePath: '/api/v1',
 *     });
 *   } catch (cause) {
 *     if (isContentRouteLoadError(cause)) {
 *       throw error(cause.status, cause.message);
 *     }
 *     throw cause;
 *   }
 * }
 * ```
 */

import type {
  SmrtRouteDefinition,
  SmrtRouteModule,
} from '@happyvertical/smrt-types';
import {
  type ContentRouteLoadError,
  isContentRouteLoadError,
  loadPublishedArticleRouteData,
} from './route-loaders.js';
import {
  ContentContributionsRoute,
  ContentGovernanceRoute,
  ContentWorkspaceRoute,
  PublishedArticleRoute,
} from './svelte/routes/index.js';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  CONTENT_ROUTE_META,
  type ContentRouteId,
  type ContentRouteNavigationItem,
  createContentRouteNavigation,
  type LoadPublishedArticleRouteInput,
  type PublishedContentArticleRouteData,
} from './svelte/routes/shared.js';

export {
  ContentContributionsRoute,
  ContentGovernanceRoute,
  ContentWorkspaceRoute,
  PublishedArticleRoute,
};
export {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  CONTENT_ROUTE_META,
  createContentRouteNavigation,
  isContentRouteLoadError,
  loadPublishedArticleRouteData,
};
export type {
  ContentRouteId,
  ContentRouteLoadError,
  ContentRouteNavigationItem,
  LoadPublishedArticleRouteInput,
  PublishedContentArticleRouteData,
};

export interface ContentRouteDefinitions {
  workspace: SmrtRouteDefinition;
  governance: SmrtRouteDefinition;
  contributions: SmrtRouteDefinition;
  article: SmrtRouteDefinition<
    PublishedContentArticleRouteData,
    LoadPublishedArticleRouteInput
  >;
}

export type ContentRouteModule = Omit<SmrtRouteModule, 'routes'> & {
  routes: ContentRouteDefinitions;
};

export const CONTENT_ROUTE_MODULE: ContentRouteModule = {
  packageName: '@happyvertical/smrt-content',
  displayName: 'Content',
  description:
    'Package-owned route surfaces for authoring, governance, contributions, and published article rendering.',
  routes: {
    workspace: {
      ...CONTENT_ROUTE_META.workspace,
      component: ContentWorkspaceRoute,
      tags: ['content', 'authoring', 'admin'],
    },
    governance: {
      ...CONTENT_ROUTE_META.governance,
      component: ContentGovernanceRoute,
      tags: ['content', 'governance', 'admin'],
    },
    contributions: {
      ...CONTENT_ROUTE_META.contributions,
      component: ContentContributionsRoute,
      tags: ['content', 'contributions', 'admin'],
    },
    article: {
      ...CONTENT_ROUTE_META.article,
      component: PublishedArticleRoute,
      load: loadPublishedArticleRouteData,
      tags: ['content', 'article', 'public'],
    },
  },
};

export default CONTENT_ROUTE_MODULE;
