import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import TenantNav from '../admin-shell/TenantNav.svelte';
import NamedIcon from './named-icon.svelte';
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

  describe('item action', () => {
    const groups = [
      {
        heading: 'Sales',
        items: [
          {
            href: '/sales',
            label: 'Sales Orders',
            action: {
              href: '/sales/options',
              label: 'Sales options',
              visibility: 'active' as const,
            },
          },
          { href: '/sales/reports', label: 'Reports' },
        ],
      },
      { heading: 'Stock', items: [{ href: '/stock', label: 'Stock' }] },
    ];

    function render(props: Record<string, unknown>) {
      return mount(TenantNav, { target: container, props });
    }

    it('renders a separate link with its accessible name and tooltip', () => {
      const component = render({
        currentHref: '/sales',
        items: [
          {
            href: '/home',
            label: 'Home',
            action: { href: '/home/settings', label: 'Home settings' },
          },
        ],
      });
      try {
        const action = container.querySelector('a[aria-label="Home settings"]');
        expect(action).toHaveAttribute('href', '/home/settings');
        expect(action).toHaveAttribute('title', 'Home settings');
        expect(action?.closest('a[href="/home"]')).toBeNull();
        // Default icon is an SVG gear (no text glyph) when no iconComponent is given.
        expect(action?.textContent?.trim()).toBe('');
        expect(action?.querySelector('svg path')).not.toBeNull();
      } finally {
        unmount(component);
      }
    });

    it('uses the icon component with the default or supplied icon name', () => {
      const component = render({
        iconComponent: NamedIcon,
        items: [
          {
            href: '/a',
            label: 'A',
            action: { href: '/a/x', label: 'A default' },
          },
          {
            href: '/b',
            label: 'B',
            action: { href: '/b/x', label: 'B custom', icon: 'wrench' },
          },
        ],
      });
      try {
        const html = (label: string) =>
          container.querySelector(`a[aria-label="${label}"]`)?.innerHTML;
        expect(html('A default')).toContain('data-icon="settings"');
        expect(html('B custom')).toContain('data-icon="wrench"');
      } finally {
        unmount(component);
      }
    });

    it("hides a visibility 'active' action until the group is current", () => {
      const away = render({ currentHref: '/stock', groups });
      try {
        expect(
          container.querySelector('[aria-label="Sales options"]'),
        ).toBeNull();
      } finally {
        unmount(away);
      }
      const sibling = render({ currentHref: '/sales/reports', groups });
      try {
        expect(
          container.querySelector('a[aria-label="Sales options"]'),
        ).not.toBeNull();
      } finally {
        unmount(sibling);
      }
    });

    it('marks the action current on its own page', () => {
      const component = render({ currentHref: '/sales/options', groups });
      try {
        expect(
          container.querySelector('a[aria-label="Sales options"]'),
        ).toHaveAttribute('aria-current', 'page');
        expect(
          container.querySelector('a[href="/sales/reports"]'),
        ).not.toHaveAttribute('aria-current');
      } finally {
        unmount(component);
      }
    });

    it('shows a top-level active action when a child is current', () => {
      const items = [
        {
          href: '/orders',
          label: 'Orders',
          children: [{ href: '/orders/open', label: 'Open' }],
          action: {
            href: '/orders-settings',
            label: 'Orders settings',
            visibility: 'active' as const,
          },
        },
      ];
      const away = render({ currentHref: '/other', items });
      try {
        expect(
          container.querySelector('[aria-label="Orders settings"]'),
        ).toBeNull();
      } finally {
        unmount(away);
      }
      const child = render({ currentHref: '/orders/open', items });
      try {
        expect(
          container.querySelector('a[aria-label="Orders settings"]'),
        ).not.toBeNull();
      } finally {
        unmount(child);
      }
    });

    it('omits actions from the collapsed nav', () => {
      const component = render({
        currentHref: '/sales',
        collapsed: true,
        groups,
        items: [
          {
            href: '/home',
            label: 'Home',
            action: { href: '/home/settings', label: 'Home settings' },
          },
        ],
      });
      try {
        expect(container.querySelector('[aria-label$="options"]')).toBeNull();
        expect(
          container.querySelector('[aria-label="Home settings"]'),
        ).toBeNull();
        expect(container.querySelector('a[href="/sales/options"]')).toBeNull();
      } finally {
        unmount(component);
      }
    });
  });
});
