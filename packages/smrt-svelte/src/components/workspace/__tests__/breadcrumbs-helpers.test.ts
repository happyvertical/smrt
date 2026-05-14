/**
 * Tests for Breadcrumbs' pure derivation helpers.
 *
 * The Svelte component is a thin renderer over `deriveCrumbsFromNav`,
 * so testing the helper covers:
 *  - explicit pass-through (handled in the component layer)
 *  - auto mode: nav-tree label lookup
 *  - fallback to capitalized segments for unknown paths
 *  - `rootCrumb` prepend
 *  - `startAfter` segment skipping
 */

import { describe, expect, it } from 'vitest';
import {
  capitalizeSegment,
  deriveCrumbsFromNav,
  findLabelInNav,
} from '../breadcrumbs-helpers.js';
import type { NavItem } from '../types.js';

const nav: NavItem[] = [
  {
    href: '/content',
    label: 'Content',
    children: [
      { href: '/content/articles', label: 'Articles' },
      {
        href: '/content/media',
        label: 'Media library',
        children: [{ href: '/content/media/images', label: 'Images' }],
      },
    ],
  },
];

describe('findLabelInNav', () => {
  it('finds a top-level label', () => {
    expect(findLabelInNav(nav, '/content')).toBe('Content');
  });

  it('finds a nested label', () => {
    expect(findLabelInNav(nav, '/content/media/images')).toBe('Images');
  });

  it('returns null when not found', () => {
    expect(findLabelInNav(nav, '/missing')).toBeNull();
  });
});

describe('capitalizeSegment', () => {
  it('uppercases the first letter', () => {
    expect(capitalizeSegment('articles')).toBe('Articles');
  });

  it('replaces dashes and underscores with spaces', () => {
    expect(capitalizeSegment('my-cool-section')).toBe('My cool section');
    expect(capitalizeSegment('snake_case_thing')).toBe('Snake case thing');
  });

  it('handles empty input gracefully', () => {
    expect(capitalizeSegment('')).toBe('');
  });
});

describe('deriveCrumbsFromNav', () => {
  it('builds crumbs from nav matches', () => {
    const crumbs = deriveCrumbsFromNav('/content/articles', nav);
    expect(crumbs).toEqual([
      { label: 'Content', href: '/content' },
      { label: 'Articles', href: '/content/articles' },
    ]);
  });

  it('falls back to capitalized segments for unknown paths', () => {
    const crumbs = deriveCrumbsFromNav('/content/random-thing', nav);
    expect(crumbs).toEqual([
      { label: 'Content', href: '/content' },
      { label: 'Random thing', href: '/content/random-thing' },
    ]);
  });

  it('disables capitalization when capitalize=false', () => {
    const crumbs = deriveCrumbsFromNav('/content/random-thing', nav, {
      capitalize: false,
    });
    expect(crumbs[1]).toEqual({
      label: 'random-thing',
      href: '/content/random-thing',
    });
  });

  it('prepends rootCrumb', () => {
    const crumbs = deriveCrumbsFromNav('/content', nav, {
      rootCrumb: { label: 'My Site', href: '/' },
    });
    expect(crumbs[0]).toEqual({ label: 'My Site', href: '/' });
    expect(crumbs[1]).toEqual({ label: 'Content', href: '/content' });
  });

  it('skips segments before startAfter and resolves remaining against nav', () => {
    const siteNav: NavItem[] = [
      {
        href: '/sites/foo/content',
        label: 'Content',
        children: [{ href: '/sites/foo/content/articles', label: 'Articles' }],
      },
    ];
    const crumbs = deriveCrumbsFromNav('/sites/foo/content/articles', siteNav, {
      rootCrumb: { label: 'Foo', href: '/sites/foo' },
      startAfter: 'sites/foo',
    });
    expect(crumbs).toEqual([
      { label: 'Foo', href: '/sites/foo' },
      { label: 'Content', href: '/sites/foo/content' },
      { label: 'Articles', href: '/sites/foo/content/articles' },
    ]);
  });

  it('returns only rootCrumb when startAfter is not present in pathname', () => {
    const crumbs = deriveCrumbsFromNav('/other/path', nav, {
      rootCrumb: { label: 'Root', href: '/' },
      startAfter: 'sites/foo',
    });
    expect(crumbs).toEqual([{ label: 'Root', href: '/' }]);
  });

  it('returns an empty array for an empty pathname with no rootCrumb', () => {
    expect(deriveCrumbsFromNav('', nav)).toEqual([]);
  });

  it('handles a leading-slash startAfter the same as no leading slash', () => {
    const siteNav: NavItem[] = [
      { href: '/sites/foo/content', label: 'Content' },
    ];
    const a = deriveCrumbsFromNav('/sites/foo/content', siteNav, {
      startAfter: '/sites/foo',
    });
    const b = deriveCrumbsFromNav('/sites/foo/content', siteNav, {
      startAfter: 'sites/foo',
    });
    expect(a).toEqual(b);
  });

  // Regression for #1231: multi-segment startAfter must match the full
  // contiguous sequence in the pathname, not just the last token. Previous
  // implementation used `segments.indexOf(lastStartSegment)` which would
  // find the wrong offset when an earlier segment repeated the last token.
  it('matches the full contiguous startAfter sequence even when its trailing token appears earlier in the path', () => {
    const siteNav: NavItem[] = [
      { href: '/sites/sites/content', label: 'Content' },
    ];
    const crumbs = deriveCrumbsFromNav('/sites/sites/content', siteNav, {
      startAfter: 'sites/sites',
    });
    // If the helper anchored on the first `sites`, basePath would be
    // `/sites` and we'd emit two extra crumbs (`sites`, `content`). The
    // correct behavior is to anchor on the second `sites` and emit only
    // the trailing `content` crumb.
    expect(crumbs).toEqual([
      { label: 'Content', href: '/sites/sites/content' },
    ]);
  });
});
