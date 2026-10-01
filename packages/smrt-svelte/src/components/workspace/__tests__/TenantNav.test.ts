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
  it('renders named groups alongside flat links and keeps grouped active children', () => {
    const component = mount(TenantNav, {
      target: container,
      props: {
        'aria-label': 'Shop navigation',
        currentHref: '/orders/open',
        items: [{ href: '/home', label: 'Home' }],
        groups: [
          {
            heading: 'Floor',
            items: [
              {
                href: '/orders',
                label: 'Orders',
                children: [{ href: '/orders/open', label: 'Open orders' }],
              },
            ],
          },
          { heading: 'Office', items: [] },
        ],
      },
    });
    try {
      expect(container.querySelector('nav')).toHaveAttribute(
        'aria-label',
        'Shop navigation',
      );
      expect(
        container.querySelector('details[aria-label="Floor"]'),
      ).not.toBeNull();
      expect(container.querySelectorAll('details')).toHaveLength(2);
      expect(container.querySelector('a[href="/orders/open"]')).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(container.querySelectorAll('a')).toHaveLength(3);
    } finally {
      unmount(component);
    }
  });
  it('keeps collapsed group summaries named and independent of navigation links', () => {
    const component = mount(TenantNav, {
      target: container,
      props: {
        items: [],
        collapsed: true,
        groups: [
          { heading: 'Floor', items: [{ href: '/tasks', label: 'Tasks' }] },
        ],
      },
    });
    try {
      const summary = container.querySelector('summary');
      expect(summary?.textContent).toContain('Floor');
      expect(container.querySelector('details')).toHaveAttribute('open');
      expect(container.querySelectorAll('a')).toHaveLength(1);
    } finally {
      unmount(component);
    }
  });

  it('accepts per-instance touch density while leaving the default inherited', () => {
    const component = mount(TenantNav, {
      target: container,
      props: { density: 'touch', items: [{ href: '/tasks', label: 'Tasks' }] },
    });
    try {
      expect(container.querySelector('nav')).toHaveAttribute(
        'data-density',
        'touch',
      );
    } finally {
      unmount(component);
    }
  });

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
