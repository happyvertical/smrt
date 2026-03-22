// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
