import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import TenantNav from '../admin-shell/TenantNav.svelte';
import TestIcon from './test-icon.svelte';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe('TenantNav', () => {
  it('renders custom icon components for nav items', () => {
    const component = mount(TenantNav, {
      target: container,
      props: {
        currentHref: '/admin/tasks',
        iconComponent: TestIcon,
        items: [
          { href: '/admin/tasks', icon: 'tasks', label: 'Tasks' },
          {
            href: '/admin/opportunities',
            icon: 'briefcase',
            label: 'Opportunities',
          },
        ],
      },
    });

    try {
      expect(
        container.querySelectorAll('[data-testid="custom-icon"]'),
      ).toHaveLength(2);
      expect(
        container.querySelector('a[aria-current="page"]')?.textContent,
      ).toContain('Tasks');
    } finally {
      unmount(component);
    }
  });

  it('uses top-level icon links when collapsed', () => {
    const component = mount(TenantNav, {
      target: container,
      props: {
        collapsed: true,
        currentHref: '/admin/experience',
        iconComponent: TestIcon,
        items: [
          {
            href: '/admin/resume',
            icon: 'file-text',
            label: 'Career',
            children: [
              {
                href: '/admin/experience',
                icon: 'briefcase',
                label: 'Experience',
              },
            ],
          },
        ],
      },
    });

    try {
      expect(
        container.querySelector('.smrt-tenant-nav--collapsed'),
      ).not.toBeNull();
      expect(
        container.querySelectorAll('[data-testid="custom-icon"]'),
      ).toHaveLength(1);
      expect(container.querySelector('a[href="/admin/experience"]')).toBeNull();
      const parentLink = container.querySelector('a[href="/admin/resume"]');
      expect(parentLink).not.toHaveAttribute('aria-current');
      expect(parentLink).toHaveClass('smrt-tenant-nav__link--visible-active');
      expect(
        container.querySelector('a[href="/admin/resume"]'),
      ).toHaveAttribute('title', 'Career');
    } finally {
      unmount(component);
    }
  });

  it('renders a visible fallback glyph for iconless collapsed items', () => {
    const component = mount(TenantNav, {
      target: container,
      props: {
        collapsed: true,
        currentHref: '/admin/memory',
        items: [{ href: '/admin/memory', label: 'Memory' }],
      },
    });

    try {
      const link = container.querySelector('a[href="/admin/memory"]');
      const fallback = link?.querySelector('.smrt-tenant-nav__icon--fallback');

      expect(fallback?.textContent?.trim()).toBe('M');
      expect(link).toHaveAttribute('aria-current', 'page');
    } finally {
      unmount(component);
    }
  });
});
