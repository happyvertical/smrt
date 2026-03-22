import { error } from '@sveltejs/kit';
import {
  CONTENT_ROUTE_MODULE,
  isContentRouteLoadError,
} from '../../../route-module.js';

export async function load({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch;
  params: { slug: string };
}) {
  const articleRoute = CONTENT_ROUTE_MODULE.routes.article;
  if (!articleRoute.load) {
    throw error(500, 'Content article route is missing its load handler');
  }

  try {
    return await articleRoute.load({
      fetch,
      slug: params.slug,
    });
  } catch (cause) {
    if (isContentRouteLoadError(cause)) {
      throw error(cause.status, cause.message);
    }
    throw cause;
  }
}
