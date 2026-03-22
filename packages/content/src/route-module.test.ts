import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  CONTENT_ROUTE_MODULE,
  createContentRouteNavigation,
  isContentRouteLoadError,
  loadPublishedArticleRouteData,
} from './route-module.js';

describe('content route module', () => {
  it('exports stable package-owned route definitions', () => {
    expect(CONTENT_ROUTE_MODULE.packageName).toBe(
      '@happyvertical/smrt-content',
    );
    expect(Object.keys(CONTENT_ROUTE_MODULE.routes)).toEqual([
      'workspace',
      'governance',
      'contributions',
      'article',
    ]);
    expect(CONTENT_ROUTE_MODULE.routes.article.defaultPath).toBe(
      '/articles/[slug]',
    );
    expect(CONTENT_ROUTE_MODULE.routes.article.loadKind).toBe('page');
  });

  it('builds navigation with overrideable mount paths', () => {
    expect(CONTENT_DEFAULT_ROUTE_NAVIGATION.map((item) => item.label)).toEqual([
      'Workspace',
      'Governance',
      'Contributions',
    ]);

    const navigation = createContentRouteNavigation({
      [CONTENT_ROUTE_IDS.workspace]: '/[siteSlug]/content',
      [CONTENT_ROUTE_IDS.governance]: '/[siteSlug]/content/governance',
    });

    expect(
      navigation.find((item) => item.routeId === CONTENT_ROUTE_IDS.workspace)
        ?.href,
    ).toBe('/[siteSlug]/content');
    expect(
      navigation.find((item) => item.routeId === CONTENT_ROUTE_IDS.governance)
        ?.href,
    ).toBe('/[siteSlug]/content/governance');
  });

  it('loads published article route data through the package helper', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const href = String(input);

      if (href.includes('/contents/by-slug')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'content-1',
              slug: 'hello-world',
              title: 'Hello world',
            },
          }),
          { status: 200 },
        );
      }

      if (href.includes('/contents/content-1/transparency')) {
        return new Response(
          JSON.stringify({
            data: {
              generatedAt: '2026-03-21T12:00:00.000Z',
              sources: [],
            },
          }),
          { status: 200 },
        );
      }

      return new Response('Not found', { status: 404 });
    });

    const result = await loadPublishedArticleRouteData({
      fetch: fetch as unknown as typeof globalThis.fetch,
      slug: 'hello-world',
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.content.id).toBe('content-1');
    expect(result.transparency?.generatedAt).toBe('2026-03-21T12:00:00.000Z');
  });

  it('throws an adapter-friendly route load error when an article is missing', async () => {
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    await expect(
      loadPublishedArticleRouteData({
        fetch: fetch as unknown as typeof globalThis.fetch,
        slug: 'missing-article',
      }),
    ).rejects.toSatisfy((cause) => {
      expect(isContentRouteLoadError(cause)).toBe(true);
      expect((cause as { status: number }).status).toBe(404);
      return true;
    });
  });
});
