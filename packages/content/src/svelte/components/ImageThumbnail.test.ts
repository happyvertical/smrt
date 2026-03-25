// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearThumbnailCache,
  THUMBNAIL_FAILURE_TTL_MS,
} from './ImageThumbnail.cache';
import ImageThumbnail from './ImageThumbnail.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderThumbnail(props: { assetId: string; apiBaseUrl?: string }) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ImageThumbnail, {
    target,
    props,
  });

  mountedComponents.push(component);
  flushSync();

  return target;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  clearThumbnailCache();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('ImageThumbnail component', () => {
  it('loads image metadata from the default content API base', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        sourceUri: 'https://example.com/default-thumbnail.jpg',
      }),
    } as Response);

    const target = renderThumbnail({ assetId: 'image-123' });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/images/image-123',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      ),
    );

    await vi.waitFor(() => {
      const image = target.querySelector('img') as HTMLImageElement | null;
      expect(image?.getAttribute('src')).toBe(
        'https://example.com/default-thumbnail.jpg',
      );
    });
  });

  it('uses a custom apiBaseUrl for image metadata requests', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        url: 'https://example.com/custom-thumbnail.jpg',
      }),
    } as Response);

    renderThumbnail({
      assetId: 'image-tenant-123',
      apiBaseUrl: '/tenant/site-a/api/v2/',
    });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/tenant/site-a/api/v2/images/image-tenant-123',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      ),
    );
  });

  it('renders an unavailable state when the asset metadata request fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => null,
    } as Response);

    const target = renderThumbnail({ assetId: 'missing-image' });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/images/missing-image',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      ),
    );

    await vi.waitFor(() => {
      const fallback = target.querySelector(
        '.smrt-thumbnail-missing',
      ) as HTMLElement | null;
      expect(fallback?.textContent).toContain('Preview unavailable');
    });
  });

  it('retries failed thumbnail lookups after the failure cache TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T00:00:00.000Z'));

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => null,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sourceUri: 'https://example.com/retry-thumbnail.jpg',
        }),
      } as Response);

    const firstTarget = renderThumbnail({ assetId: 'retry-image' });

    await vi.waitFor(() => {
      const fallback = firstTarget.querySelector(
        '.smrt-thumbnail-missing',
      ) as HTMLElement | null;
      expect(fallback?.textContent).toContain('Preview unavailable');
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    const secondTarget = renderThumbnail({ assetId: 'retry-image' });
    flushSync();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      secondTarget.querySelector('.smrt-thumbnail-missing'),
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(THUMBNAIL_FAILURE_TTL_MS + 1);
    const thirdTarget = renderThumbnail({ assetId: 'retry-image' });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const image = thirdTarget.querySelector('img') as HTMLImageElement | null;
      expect(image?.getAttribute('src')).toBe(
        'https://example.com/retry-thumbnail.jpg',
      );
    });
  });
});
