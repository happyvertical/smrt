/**
 * Tests for NavTree's pure active/expanded helpers.
 *
 * The Svelte component itself is a thin renderer over these helpers,
 * so covering the helpers gives us full behavioral coverage of:
 *  - 1-/2-/3-level active detection
 *  - `exact` flag
 *  - `isActive` override
 *  - expansion (default + descendant-driven)
 */

import { describe, expect, it } from 'vitest';
import {
  defaultIsActive,
  isExpanded,
  isItemOrChildActive,
} from '../nav-helpers.js';
import type { NavItem } from '../types.js';

const home: NavItem = {
  href: '/',
  label: 'Home',
  exact: true,
};

const content: NavItem = {
  href: '/content',
  label: 'Content',
  children: [
    { href: '/content/articles', label: 'Articles' },
    {
      href: '/content/media',
      label: 'Media',
      children: [
        { href: '/content/media/images', label: 'Images' },
        { href: '/content/media/videos', label: 'Videos' },
      ],
    },
  ],
};

const settings: NavItem = {
  href: '/settings',
  label: 'Settings',
  defaultExpanded: true,
  children: [{ href: '/settings/users', label: 'Users' }],
};

const _allItems: NavItem[] = [home, content, settings];

describe('defaultIsActive', () => {
  it('matches exact paths', () => {
    expect(defaultIsActive({ href: '/content', label: '' }, '/content')).toBe(
      true,
    );
  });

  it('matches descendant paths when not exact', () => {
    expect(
      defaultIsActive({ href: '/content', label: '' }, '/content/articles'),
    ).toBe(true);
  });

  it('respects the exact flag', () => {
    expect(
      defaultIsActive({ href: '/', label: '', exact: true }, '/content'),
    ).toBe(false);
    expect(defaultIsActive({ href: '/', label: '', exact: true }, '/')).toBe(
      true,
    );
  });

  it('does not match unrelated paths that share a prefix', () => {
    // '/foo' should not match '/foobar' — the '/' boundary matters.
    expect(defaultIsActive({ href: '/foo', label: '' }, '/foobar')).toBe(false);
  });
});

describe('isItemOrChildActive', () => {
  it('returns true when the item itself is active', () => {
    expect(isItemOrChildActive(content, '/content')).toBe(true);
  });

  it('returns true when a deep descendant is active', () => {
    expect(isItemOrChildActive(content, '/content/media/images')).toBe(true);
  });

  it('returns false when neither item nor descendants are active', () => {
    expect(isItemOrChildActive(content, '/settings/users')).toBe(false);
  });

  it('honors a custom isActive override', () => {
    const customIsActive = (item: NavItem, _path: string) =>
      item.href === '/content/media/videos';
    expect(isItemOrChildActive(content, '/anything', customIsActive)).toBe(
      true,
    );
  });
});

describe('isExpanded', () => {
  it('is false for items without children', () => {
    expect(isExpanded({ href: '/x', label: '' }, '/x')).toBe(false);
  });

  it('is true when defaultExpanded is set, regardless of path', () => {
    expect(isExpanded(settings, '/unrelated')).toBe(true);
  });

  it('is true when a descendant is active', () => {
    expect(isExpanded(content, '/content/media/images')).toBe(true);
  });

  it('is false when no descendant is active and not defaultExpanded', () => {
    expect(isExpanded(content, '/unrelated')).toBe(false);
  });
});
