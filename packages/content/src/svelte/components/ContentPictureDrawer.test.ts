// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentPictureDrawer, {
  CONTENT_PICTURE_DRAG_TYPE,
  type ContentPicture,
  filterPictures,
} from './ContentPictureDrawer.svelte';

const PICTURES: ContentPicture[] = [
  {
    id: 'p-1',
    title: 'Arena at night',
    previewUrl: '/p/1',
    keywords: 'hockey',
  },
  { id: 'p-2', title: 'Council chambers', previewUrl: '/p/2' },
  { id: 'p-3', title: 'Main street', previewUrl: '/p/3' },
];

const mounted: Array<ReturnType<typeof mount>> = [];

function render(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ContentPictureDrawer, { target, props }));
  flushSync();
  return target;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

afterEach(() => {
  while (mounted.length > 0) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

describe('filterPictures', () => {
  it('matches every word against title and keywords', () => {
    expect(filterPictures(PICTURES, 'arena').map((p) => p.id)).toEqual(['p-1']);
    expect(filterPictures(PICTURES, 'hockey night').map((p) => p.id)).toEqual([
      'p-1',
    ]);
    expect(filterPictures(PICTURES, '  ')).toHaveLength(3);
  });
});

describe('ContentPictureDrawer', () => {
  it('uses plain labels and no technical words', () => {
    const root = render({ pictures: PICTURES, onUpload: vi.fn() });
    const text = root.textContent ?? '';
    expect(text).toContain('Add pictures');
    expect(text).toContain('Upload pictures');
    for (const word of [
      'Asset',
      'Gallery',
      'Orientation',
      'External URL',
      'image/',
    ]) {
      expect(text).not.toContain(word);
    }
    expect(root.querySelectorAll('img')).toHaveLength(3);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('/p/1');
  });

  it('picks several pictures and inserts them in pick order', () => {
    const onInsert = vi.fn();
    const root = render({ pictures: PICTURES, onInsert });
    const tiles = root.querySelectorAll<HTMLButtonElement>(
      '.drawer-picture-pick',
    );
    tiles[2].click();
    tiles[0].click();
    flushSync();
    expect(tiles[2].getAttribute('aria-pressed')).toBe('true');
    buttonByText(root, 'Insert 2 pictures').click();
    flushSync();
    expect(onInsert).toHaveBeenCalledWith([PICTURES[2], PICTURES[0]]);
    expect(root.querySelector('.drawer-actions')).toBeNull();
  });

  it('drags the picked pictures together, or just the one dragged', () => {
    const root = render({ pictures: PICTURES, onInsert: vi.fn() });
    const items = root.querySelectorAll<HTMLLIElement>('.drawer-picture');
    const drag = (item: HTMLLIElement) => {
      const data = new Map<string, string>();
      const event = new Event('dragstart', { bubbles: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          effectAllowed: 'none',
          setData: (type: string, value: string) => data.set(type, value),
        },
      });
      item.dispatchEvent(event);
      return JSON.parse(data.get(CONTENT_PICTURE_DRAG_TYPE) ?? '[]');
    };

    expect(drag(items[1]).map((p: { id: string }) => p.id)).toEqual(['p-2']);

    root.querySelectorAll<HTMLButtonElement>('.drawer-picture-pick')[0].click();
    root.querySelectorAll<HTMLButtonElement>('.drawer-picture-pick')[2].click();
    flushSync();
    const payload = drag(items[2]);
    expect(payload.map((p: { id: string }) => p.id)).toEqual(['p-1', 'p-3']);
    expect(payload[0]).toMatchObject({
      name: 'Arena at night',
      sourceUri: '/p/1',
    });
  });

  it('shows the main picture and lets the person choose or reset it', () => {
    const onUseAsMain = vi.fn();
    const onClearMainChoice = vi.fn();
    const root = render({
      pictures: PICTURES,
      mainPictureId: 'p-2',
      mainPictureMode: 'chosen',
      inStoryIds: ['p-1', 'p-2'],
      onUseAsMain,
      onClearMainChoice,
    });
    const items = root.querySelectorAll('.drawer-picture');
    expect(items[1].textContent).toContain('Main picture');
    expect(items[0].textContent).toContain('In the story');
    buttonByText(root, 'Use the first picture instead').click();
    expect(onClearMainChoice).toHaveBeenCalled();
    // "Use as main picture" shows for one picked picture that is not the main one.
    expect(root.textContent).not.toContain('Use as main picture');
    const tiles = root.querySelectorAll<HTMLButtonElement>(
      '.drawer-picture-pick',
    );
    tiles[1].click();
    flushSync();
    expect(root.textContent).not.toContain('Use as main picture');
    tiles[1].click();
    tiles[2].click();
    flushSync();
    buttonByText(root, 'Use as main picture').click();
    flushSync();
    expect(onUseAsMain).toHaveBeenCalledWith(PICTURES[2]);
  });

  it('filters by search and says when nothing matches', () => {
    const root = render({ pictures: PICTURES });
    const search = root.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    search.value = 'council';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(root.querySelectorAll('.drawer-picture')).toHaveLength(1);
    search.value = 'zebra';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(root.textContent).toContain('No pictures match.');
  });

  it('hands search to a searching host and shows its results as they are', () => {
    const onSearch = vi.fn();
    const root = render({ pictures: PICTURES, onSearch });
    const search = root.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    search.value = 'council';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(onSearch).toHaveBeenLastCalledWith('council');
    // The host re-queries; the drawer does not filter what it was given.
    expect(root.querySelectorAll('.drawer-picture')).toHaveLength(3);
  });

  it('says nothing matches a host search with no results, and shows loading first', () => {
    const loadingRoot = render({
      pictures: [],
      loading: true,
      query: 'zebra',
      onSearch: vi.fn(),
    });
    expect(loadingRoot.textContent).toContain('Loading pictures');
    const root = render({ pictures: [], query: 'zebra', onSearch: vi.fn() });
    expect(root.textContent).toContain('No pictures match.');
  });

  it('has no "Show more" button: scrolling near the end loads more', () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      targets: Element[];
    }> = [];
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      targets: Element[] = [];
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    try {
      const onLoadMore = vi.fn();
      const root = render({ pictures: PICTURES, hasMore: true, onLoadMore });
      expect(root.textContent).not.toContain('Show more');
      expect(root.querySelector('button')?.textContent).not.toContain('more');
      const observer = observers.at(-1);
      expect(observer?.targets[0]?.classList.contains('drawer-more')).toBe(
        true,
      );
      onLoadMore.mockClear();
      observer?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      expect(onLoadMore).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('uploads only picture files', () => {
    const onUpload = vi.fn();
    const root = render({ pictures: [], onUpload });
    expect(root.textContent).toContain('No pictures yet');
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;
    const photo = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const doc = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', {
      value: [photo, doc],
      configurable: true,
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onUpload).toHaveBeenCalledWith([photo]);
  });
});
