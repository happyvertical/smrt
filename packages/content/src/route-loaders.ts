import type {
  LoadPublishedArticleRouteInput,
  PublishedContentArticleRouteData,
} from './svelte/routes/shared.js';

export type ContentRouteLoadError = Error & {
  name: 'ContentRouteLoadError';
  status: number;
  code?: string;
};

function createContentRouteLoadError(
  status: number,
  message: string,
  code?: string,
): ContentRouteLoadError {
  const error = new Error(message) as ContentRouteLoadError;
  error.name = 'ContentRouteLoadError';
  error.status = status;
  error.code = code;
  return error;
}

export function isContentRouteLoadError(
  value: unknown,
): value is ContentRouteLoadError {
  return (
    value instanceof Error &&
    value.name === 'ContentRouteLoadError' &&
    typeof (value as ContentRouteLoadError).status === 'number'
  );
}

function getItemData<T>(payload: T | { data?: T; result?: T }): T {
  if (payload && typeof payload === 'object' && 'result' in payload) {
    return (payload as { result: T }).result;
  }

  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

export async function loadPublishedArticleRouteData({
  fetch,
  slug,
  apiBasePath = '/api/v1',
}: LoadPublishedArticleRouteInput): Promise<PublishedContentArticleRouteData> {
  const searchParams = new URLSearchParams({
    slug,
    status: 'published',
  });

  const contentResponse = await fetch(
    `${apiBasePath}/contents/by-slug?${searchParams.toString()}`,
  );

  if (!contentResponse.ok) {
    throw createContentRouteLoadError(
      contentResponse.status,
      'Failed to load article',
      'content_fetch_failed',
    );
  }

  const contentPayload = await contentResponse.json();
  const content = getItemData<any | null>(contentPayload);

  if (!content?.id) {
    throw createContentRouteLoadError(
      404,
      'Article not found',
      'content_not_found',
    );
  }

  const transparencyResponse = await fetch(
    `${apiBasePath}/contents/${content.id}/transparency`,
  );

  if (!transparencyResponse.ok) {
    throw createContentRouteLoadError(
      transparencyResponse.status,
      'Failed to load transparency',
      'transparency_fetch_failed',
    );
  }

  const transparencyPayload = await transparencyResponse.json();
  const transparency = getItemData<any | null>(transparencyPayload);

  return {
    content,
    transparency,
  };
}
