import { error } from '@sveltejs/kit';

function getItemData<T>(payload: T | { data?: T; result?: T }): T {
  if (payload && typeof payload === 'object' && 'result' in payload) {
    return (payload as { result: T }).result;
  }

  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

export async function load({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch;
  params: { slug: string };
}) {
  const searchParams = new URLSearchParams({
    slug: params.slug,
    status: 'published',
  });

  const contentResponse = await fetch(
    `/api/v1/contents/by-slug?${searchParams.toString()}`,
  );

  if (!contentResponse.ok) {
    throw error(contentResponse.status, 'Failed to load article');
  }

  const contentPayload = await contentResponse.json();
  const content = getItemData<any | null>(contentPayload);

  if (!content?.id) {
    throw error(404, 'Article not found');
  }

  const transparencyResponse = await fetch(
    `/api/v1/contents/${content.id}/transparency`,
  );

  if (!transparencyResponse.ok) {
    throw error(transparencyResponse.status, 'Failed to load transparency');
  }

  const transparencyPayload = await transparencyResponse.json();
  const transparency = getItemData<any | null>(transparencyPayload);

  return {
    content,
    transparency,
  };
}
