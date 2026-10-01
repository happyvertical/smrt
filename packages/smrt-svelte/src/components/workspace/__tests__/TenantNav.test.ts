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

  it('marks items that need attention with a labelled dot', () => {
    const component = mount(TenantNav, {
      target: container,
      props: {
        currentHref: '/admin/tasks',
        items: [
          { href: '/admin/tasks', label: 'Tasks' },
          {
            href: '/admin/jobs',
            label: 'Jobs',
            attention: 'A background job failed recently',
          },
          { href: '/admin/health', label: 'Health', attention: true },
        ],
      },
    });

    try {
      const links = [...container.querySelectorAll('a')];
      expect(links[0].querySelector('[data-attention]')).toBeNull();
      expect(links[1].querySelector('[data-attention]')).not.toBeNull();
      expect(
        links[1].querySelector('[data-attention]')?.getAttribute('aria-hidden'),
      ).toBe('true');
      expect(links[1].textContent).toContain(
        '(A background job failed recently)',
      );
      expect(links[2].textContent).toContain('(Needs attention)');
    } finally {
      unmount(component);
    }
  });

  it('keeps the attention dot on a collapsed icon link', () => {
    const component = mount(TenantNav, {
      target: container,
      props: {
        collapsed: true,
        iconComponent: TestIcon,
        items: [
          { href: '/admin/jobs', icon: 'jobs', label: 'Jobs', attention: true },
        ],
      },
    });

    try {
      const link = container.querySelector('a');
      expect(link?.querySelector('[data-attention]')).not.toBeNull();
      expect(link?.textContent).toContain('Jobs');
      expect(link?.textContent).toContain('(Needs attention)');
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
