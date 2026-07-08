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
      expect(
        container.querySelector('a[href="/admin/resume"]'),
      ).toHaveAttribute('aria-current', 'page');
      expect(
        container.querySelector('a[href="/admin/resume"]'),
      ).toHaveAttribute('title', 'Career');
    } finally {
      unmount(component);
    }
  });
});
