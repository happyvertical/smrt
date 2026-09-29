/**
 * Pure phone-chrome decisions behind AdminShell: hide-on-scroll, keyboard
 * heuristic, viewport classes, the phone top-bar model, and bottom-bar mode.
 */
import { describe, expect, it } from 'vitest';
import {
  bottomBarMode,
  findShellNavTrail,
  keyboardLikelyOpen,
  normalizeShellPath,
  phoneTopBarFor,
  ScrollChrome,
  viewportFor,
} from '../admin-shell/mobile-shell.js';

describe('ScrollChrome (hide on scroll)', () => {
  function run(
    chrome: ScrollChrome,
    ys: number[],
    extra: { pinned?: boolean; maxY?: number } = {},
  ) {
    return ys.map((y) => chrome.update({ y, ...extra }));
  }

  it('stays shown near the top of the page', () => {
    expect(run(new ScrollChrome(), [0, 20, 40, 56])).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('hides after scrolling down and comes back on the first scroll up', () => {
    const chrome = new ScrollChrome();
    expect(run(chrome, [0, 100, 120, 300])).toEqual([false, true, true, true]);
    expect(chrome.update({ y: 295 })).toBe(false);
    expect(run(chrome, [300, 306, 310])).toEqual([false, false, true]);
  });

  it('ignores jitter below the thresholds', () => {
    const chrome = new ScrollChrome();
    run(chrome, [0, 200, 400]);
    expect(chrome.update({ y: 398 })).toBe(true);
  });

  it('always shows at the top and while pinned', () => {
    const chrome = new ScrollChrome();
    run(chrome, [0, 200, 400]);
    expect(chrome.update({ y: 10 })).toBe(false);
    run(chrome, [200, 400]);
    expect(chrome.update({ y: 600, pinned: true })).toBe(false);
    expect(chrome.update({ y: 800, pinned: true })).toBe(false);
  });

  it('does not treat iOS overscroll bounce as a scroll up', () => {
    const chrome = new ScrollChrome();
    run(chrome, [0, 300, 500], { maxY: 500 });
    expect(chrome.update({ y: 540, maxY: 500 })).toBe(true);
    expect(chrome.update({ y: 500, maxY: 500 })).toBe(true);
  });

  it('honours custom tuning and reset', () => {
    const chrome = new ScrollChrome({ revealWithin: 0, hideAfter: 50 });
    expect(run(chrome, [10, 40])).toEqual([false, false]);
    expect(chrome.update({ y: 70 })).toBe(true);
    chrome.reset();
    expect(chrome.hidden).toBe(false);
  });
});

describe('viewportFor', () => {
  it('classifies phone, tablet and desktop', () => {
    expect(viewportFor({ phone: true, desktop: false })).toBe('phone');
    expect(viewportFor({ phone: false, desktop: false })).toBe('tablet');
    expect(viewportFor({ phone: false, desktop: true })).toBe('desktop');
  });
});

describe('keyboardLikelyOpen', () => {
  it('is open when the visual viewport is much shorter', () => {
    expect(keyboardLikelyOpen({ layoutHeight: 844, visualHeight: 500 })).toBe(
      true,
    );
    expect(keyboardLikelyOpen({ layoutHeight: 844, visualHeight: 780 })).toBe(
      false,
    );
  });

  it('does not mistake pinch zoom for a keyboard', () => {
    expect(
      keyboardLikelyOpen({ layoutHeight: 844, visualHeight: 422, scale: 2 }),
    ).toBe(false);
  });
});

describe('nav paths', () => {
  const nav = [
    { href: '/', label: 'Home' },
    {
      href: '/settings',
      label: 'Settings',
      children: [{ href: '/settings/health', label: 'Health' }],
    },
  ];

  it('normalizes trailing slashes', () => {
    expect(normalizeShellPath('/a/b//')).toBe('/a/b');
    expect(normalizeShellPath('/')).toBe('/');
  });

  it('finds the trail to the deepest matching item without the root swallowing everything', () => {
    expect(
      findShellNavTrail(nav, '/settings/health/x').map((item) => item.label),
    ).toEqual(['Settings', 'Health']);
    expect(findShellNavTrail(nav, '/other')).toEqual([]);
  });
});

describe('phoneTopBarFor', () => {
  const navItems = [
    { href: '/sites/alpha/articles', label: 'Articles' },
    {
      href: '/sites/alpha/settings',
      label: 'Settings',
      children: [{ href: '/sites/alpha/settings/health', label: 'Health' }],
    },
  ];
  const base = { homeHref: '/sites/alpha', homeTitle: 'Alpha Times', navItems };

  it('shows the workspace name on section homes', () => {
    expect(phoneTopBarFor({ ...base, path: '/sites/alpha' })).toEqual({
      kind: 'home',
      title: 'Alpha Times',
    });
    expect(
      phoneTopBarFor({ ...base, path: '/sites/alpha/articles/' }).kind,
    ).toBe('home');
    expect(
      phoneTopBarFor({ ...base, path: '/sites/alpha/settings/health' }).kind,
    ).toBe('home');
  });

  it('shows back to the parent list and the page title on detail pages', () => {
    expect(
      phoneTopBarFor({
        ...base,
        path: '/sites/alpha/articles/a1/images',
        pageTitle: 'Fair opens Friday',
      }),
    ).toEqual({
      kind: 'detail',
      title: 'Fair opens Friday',
      backHref: '/sites/alpha/articles',
      backLabel: 'Articles',
    });
  });

  it('falls back to the parent name, then to home', () => {
    expect(
      phoneTopBarFor({ ...base, path: '/sites/alpha/articles/a1' }),
    ).toMatchObject({ title: 'Articles', backHref: '/sites/alpha/articles' });
    expect(
      phoneTopBarFor({ ...base, path: '/sites/alpha/other/thing' }),
    ).toMatchObject({ kind: 'detail', backHref: '/sites/alpha' });
  });

  it('uses a page-provided parent and back label', () => {
    expect(
      phoneTopBarFor({
        ...base,
        path: '/sites/alpha/articles/a1/video/create',
        pageTitle: 'Create video',
        backHref: '/sites/alpha/articles/a1/videos',
        backLabel: 'Videos',
      }),
    ).toEqual({
      kind: 'detail',
      title: 'Create video',
      backHref: '/sites/alpha/articles/a1/videos',
      backLabel: 'Videos',
    });
  });
});

describe('bottomBarMode', () => {
  it('swaps the nav bar for a form bar and hides both with the keyboard', () => {
    expect(bottomBarMode({ formActions: false, keyboardOpen: false })).toBe(
      'nav',
    );
    expect(bottomBarMode({ formActions: true, keyboardOpen: false })).toBe(
      'form',
    );
    expect(bottomBarMode({ formActions: true, keyboardOpen: true })).toBe(
      'none',
    );
    expect(bottomBarMode({ formActions: false, keyboardOpen: true })).toBe(
      'none',
    );
  });
});
