import type {
  ContentData,
  ContentTransparencyData,
} from './mock-smrt-client.js';
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

function getItemData<T>(payload: unknown): T {
  if (!payload || typeof payload !== 'object') {
    return payload as T;
  }

  const wrappedPayload = payload as { data?: unknown; result?: unknown };
  if ('result' in wrappedPayload) {
    return wrappedPayload.result as T;
  }

  if ('data' in wrappedPayload) {
    return wrappedPayload.data as T;
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
  const content = getItemData<ContentData | null>(contentPayload);

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
  const transparency = getItemData<ContentTransparencyData | null>(
    transparencyPayload,
  );

  return {
    content,
    transparency,
  };
}
