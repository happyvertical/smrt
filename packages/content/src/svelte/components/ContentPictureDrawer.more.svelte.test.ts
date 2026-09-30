// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentPictureDrawer, {
  type ContentPicture,
} from './ContentPictureDrawer.svelte';

const PICTURES: ContentPicture[] = [
  { id: 'p-1', title: 'Arena at night', previewUrl: '/p/1' },
  { id: 'p-2', title: 'Council chambers', previewUrl: '/p/2' },
  { id: 'p-3', title: 'Main street', previewUrl: '/p/3' },
];

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

describe('ContentPictureDrawer loading more', () => {
  it('loads more when keyboard focus nears the end, and says how many came', async () => {
    const onLoadMore = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const props = $state({
      pictures: PICTURES,
      hasMore: true,
      loading: false,
      onLoadMore,
    });
    mounted.push(mount(ContentPictureDrawer, { target, props }));
    flushSync();
    onLoadMore.mockClear();
    const lastTile = target.querySelectorAll(
      '.drawer-picture-pick',
    )[2] as HTMLElement;
    lastTile.focus();
    lastTile.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    flushSync();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      'Loading more pictures',
    );

    props.loading = true;
    flushSync();
    props.pictures = [
      ...PICTURES,
      { id: 'p-4', title: 'Rink', previewUrl: '/p/4' },
      { id: 'p-5', title: 'Pool', previewUrl: '/p/5' },
    ];
    props.loading = false;
    props.hasMore = false;
    flushSync();
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      '2 more pictures',
    );
  });
});

describe('ContentPictureDrawer missing pictures', () => {
  it('leaves out a picture whose preview cannot be loaded, with a console warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(ContentPictureDrawer, { target, props: { pictures: PICTURES } }),
    );
    flushSync();
    expect(target.querySelectorAll('.drawer-picture')).toHaveLength(3);

    const broken = target.querySelector('img[src="/p/2"]') as HTMLImageElement;
    broken.dispatchEvent(new Event('error'));
    flushSync();

    const titles = Array.from(
      target.querySelectorAll('.drawer-picture-title'),
    ).map((node) => node.textContent);
    expect(titles).toEqual(['Arena at night', 'Main street']);
    expect(target.textContent).not.toContain('No preview');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be loaded'),
      'p-2',
    );
    warn.mockRestore();
  });
});
