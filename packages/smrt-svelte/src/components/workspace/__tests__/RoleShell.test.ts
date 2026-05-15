/**
 * Tests for RoleShell — issue happyvertical/smrt#1226 (Phase 4b).
 *
 * Verifies the thin RoleConfig-driven wrapper composes WorkspaceShell +
 * NavTree + Breadcrumbs correctly, propagates the role color as a CSS
 * custom property, and surfaces the bindable mobile-drawer state.
 */

import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RoleShell from '../RoleShell.svelte';
import type { RoleConfig } from '../types.js';
import BindHarness from './role-shell-bind-harness.svelte';

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

const superRole: RoleConfig = {
  id: 'super',
  label: 'Super Admin',
  description: 'Cross-network operations',
  icon: '⌘',
  color: 'blue',
  sections: [
    {
      href: '/super/tenants',
      label: 'Tenants',
      icon: '◌',
      description: 'Tenant hierarchy',
    },
    {
      href: '/super/users',
      label: 'Users',
      icon: '◎',
      description: 'Global user directory',
    },
  ],
};

const advertiserRole: RoleConfig = {
  id: 'advertiser',
  label: 'Advertiser',
  description: 'Self-service ad management',
  icon: '📢',
  color: 'purple',
  sections: [
    {
      href: '/advertiser',
      label: 'Overview',
      icon: '◉',
    },
    {
      href: '/advertiser/campaigns',
      label: 'Campaigns',
      icon: '▣',
    },
  ],
};

const ROLES: RoleConfig[] = [superRole, advertiserRole];

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe('RoleShell', () => {
  it("renders the current role's label as the WorkspaceShell title", () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super/tenants',
        children: textSnippet('main content'),
      },
    });

    try {
      const brand = container.querySelector('.brand');
      expect(brand?.textContent).toContain('Super Admin');
      expect(brand?.textContent).toContain('Cross-network operations');
    } finally {
      unmount(component);
    }
  });

  it("renders the current role's sections in the nav tree", () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super/tenants',
        children: textSnippet('content'),
      },
    });

    try {
      const navItems = container.querySelectorAll('.smrt-nav-tree .nav-item');
      const labels = Array.from(navItems).map((el) => el.textContent ?? '');
      // The nav-item textContent includes the icon glyph + label, so match
      // with substring contains rather than strict equality.
      expect(labels.some((l) => l.includes('Tenants'))).toBe(true);
      expect(labels.some((l) => l.includes('Users'))).toBe(true);
      // Should NOT render the other role's sections.
      expect(labels.some((l) => l.includes('Campaigns'))).toBe(false);
    } finally {
      unmount(component);
    }
  });

  it('throws a descriptive error in dev when currentRole does not match any role.id', async () => {
    // vitest runs with NODE_ENV=test which `esm-env` treats as
    // development (DEV === true), so the dev-throw branch fires here.
    // In production builds (`NODE_ENV=production`), the shell falls back
    // to `roles[0]` rather than crashing — see the DEV check inside
    // RoleShell's `$derived.by`. The fallback path is statically
    // wired against esm-env's resolution and can't be cleanly faked in
    // vitest, so we only assert the loud-error contract here.
    const { DEV } = await import('esm-env');
    expect(DEV).toBe(true);
    expect(() =>
      mount(RoleShell, {
        target: container,
        props: {
          roles: ROLES,
          currentRole: 'nonexistent',
          currentPath: '/',
          children: textSnippet('content'),
        },
      }),
    ).toThrow(/No role found for id "nonexistent"/);
  });

  it('sets --smrt-role-color CSS custom property when role.color is provided', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        children: textSnippet('content'),
      },
    });

    try {
      const wrapper = container.querySelector<HTMLElement>('.smrt-role-shell');
      expect(wrapper).not.toBeNull();
      // The style attribute on the wrapper sets the custom property; we
      // assert on the inline style string rather than computed style
      // because jsdom's CSS engine doesn't always resolve custom props.
      expect(wrapper?.getAttribute('style')).toContain('--smrt-role-color');
      expect(wrapper?.getAttribute('style')).toContain('blue');
    } finally {
      unmount(component);
    }
  });

  it('omits the --smrt-role-color style when role.color is not set', () => {
    const colorlessRoles: RoleConfig[] = [
      {
        id: 'plain',
        label: 'Plain',
        sections: [{ href: '/plain', label: 'Home' }],
      },
    ];
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: colorlessRoles,
        currentRole: 'plain',
        currentPath: '/plain',
        children: textSnippet('content'),
      },
    });

    try {
      const wrapper = container.querySelector<HTMLElement>('.smrt-role-shell');
      expect(wrapper?.getAttribute('style')).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('uses the title override when provided', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        title: 'Custom Title',
        subtitle: 'Custom Subtitle',
        children: textSnippet('content'),
      },
    });

    try {
      const brand = container.querySelector('.brand');
      expect(brand?.textContent).toContain('Custom Title');
      expect(brand?.textContent).toContain('Custom Subtitle');
      expect(brand?.textContent).not.toContain('Super Admin');
    } finally {
      unmount(component);
    }
  });

  it('renders breadcrumbs by default with the role label as root', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super/tenants',
        children: textSnippet('content'),
      },
    });

    try {
      const crumbs = container.querySelector('.smrt-breadcrumbs');
      expect(crumbs).not.toBeNull();
      // The first crumb is the rootCrumb (role label).
      const items = crumbs?.querySelectorAll('.crumb-item');
      expect(items?.[0]?.textContent).toContain('Super Admin');
    } finally {
      unmount(component);
    }
  });

  it('hides breadcrumbs when showBreadcrumbs is false', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super/tenants',
        showBreadcrumbs: false,
        children: textSnippet('content'),
      },
    });

    try {
      expect(container.querySelector('.smrt-breadcrumbs')).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('passes through the brand snippet to WorkspaceShell', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        brand: textSnippet('MyBrand'),
        children: textSnippet('content'),
      },
    });

    try {
      const brand = container.querySelector('.brand');
      expect(brand?.textContent).toContain('MyBrand');
      // The brand snippet should override the default title rendering.
      expect(brand?.textContent).not.toContain('Super Admin');
    } finally {
      unmount(component);
    }
  });

  it('passes through the sidebarFooter and topbarActions snippets', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        sidebarFooter: textSnippet('account-menu'),
        topbarActions: textSnippet('action-button'),
        children: textSnippet('content'),
      },
    });

    try {
      const footer = container.querySelector('.sidebar-footer');
      expect(footer?.textContent).toContain('account-menu');
      const actions = container.querySelector('.topbar-actions');
      expect(actions?.textContent).toContain('action-button');
    } finally {
      unmount(component);
    }
  });

  it('passes through the inspectorRail snippet', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        inspectorRail: textSnippet('rail-button'),
        children: textSnippet('content'),
      },
    });

    try {
      const rail = container.querySelector('.smrt-workspace-inspector-rail');
      expect(rail?.textContent).toContain('rail-button');
    } finally {
      unmount(component);
    }
  });

  it('renders the inspector snippet only when showInspector is true', () => {
    // The inspector passthrough requires both the snippet AND
    // `showInspector` because WorkspaceShell gates rendering on the latter.
    // Regression for happyvertical/smrt#1238 — the original RoleShell
    // forwarded only the snippet, making the inspector silently
    // un-renderable through this wrapper.
    const componentHidden = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        inspector: textSnippet('inspector-body'),
        children: textSnippet('content'),
      },
    });
    try {
      expect(container.querySelector('.smrt-workspace-inspector')).toBeNull();
    } finally {
      unmount(componentHidden);
    }

    // Mount a second instance with showInspector: true into the same
    // container — the inspector should now render.
    const componentShown = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        inspector: textSnippet('inspector-body'),
        showInspector: true,
        children: textSnippet('content'),
      },
    });
    try {
      const inspector = container.querySelector(
        '.smrt-workspace-inspector .inspector-body',
      );
      expect(inspector?.textContent).toContain('inspector-body');
    } finally {
      unmount(componentShown);
    }
  });

  it('forwards collapsed + onToggleCollapsed to WorkspaceShell', () => {
    let toggled = 0;
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        collapsed: true,
        onToggleCollapsed: () => {
          toggled += 1;
        },
        children: textSnippet('content'),
      },
    });

    try {
      // The collapse state surfaces as a class on the shell root.
      const shell = container.querySelector('.smrt-workspace-shell');
      expect(shell?.classList.contains('sidebar-collapsed')).toBe(true);

      // The toggle button only renders when `onToggleCollapsed` is provided —
      // clicking it should invoke our callback.
      const toggle =
        container.querySelector<HTMLButtonElement>('.shell-toggle');
      expect(toggle).not.toBeNull();
      toggle?.click();
      expect(toggled).toBe(1);
    } finally {
      unmount(component);
    }
  });

  it('forwards mode/eyebrow props to the WorkspaceShell topbar', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        eyebrow: 'EYE',
        modeLabel: 'Local-first mode',
        modeStatus: 'local-only',
        modeDetail: 'detail line',
        children: textSnippet('content'),
      },
    });

    try {
      const topbar = container.querySelector('.smrt-workspace-topbar');
      expect(topbar?.textContent).toContain('Local-first mode');
      expect(topbar?.textContent).toContain('detail line');
      const badge = topbar?.querySelector<HTMLElement>('.mode-badge');
      expect(badge?.dataset.status).toBe('local-only');
      // The eyebrow appears in the topbar's eyebrow slot.
      expect(topbar?.querySelector('.topbar-eyebrow')?.textContent).toContain(
        'EYE',
      );
    } finally {
      unmount(component);
    }
  });

  it('uses rootCrumb override when provided', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/dashboard/super/tenants',
        rootCrumb: { label: 'Dashboard', href: '/dashboard' },
        breadcrumbStartAfter: 'dashboard',
        children: textSnippet('content'),
      },
    });

    try {
      const crumbs = container.querySelector('.smrt-breadcrumbs');
      expect(crumbs).not.toBeNull();
      const first = crumbs?.querySelector<HTMLAnchorElement>(
        '.crumb-item:first-child .crumb-link',
      );
      expect(first?.textContent).toBe('Dashboard');
      expect(first?.getAttribute('href')).toBe('/dashboard');
      // With startAfter=dashboard, the auto-walk skips the `dashboard`
      // prefix and the resulting trail should NOT contain a duplicate
      // `Dashboard` fallback crumb.
      const labels = Array.from(
        crumbs?.querySelectorAll('.crumb-item') ?? [],
      ).map((el) => el.textContent ?? '');
      const dashboardCrumbs = labels.filter((l) => l.includes('Dashboard'));
      expect(dashboardCrumbs.length).toBe(1);
    } finally {
      unmount(component);
    }
  });

  it('renders role.icon in the default brand area when no brand snippet is provided', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        children: textSnippet('content'),
      },
    });

    try {
      const icon = container.querySelector('.smrt-role-shell-icon');
      expect(icon).not.toBeNull();
      // RoleConfig.icon is a string glyph — render as text content.
      expect(icon?.textContent).toContain('⌘');
    } finally {
      unmount(component);
    }
  });

  it('omits role.icon when a consumer brand snippet is provided', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        brand: textSnippet('CustomBrand'),
        children: textSnippet('content'),
      },
    });

    try {
      expect(container.querySelector('.smrt-role-shell-icon')).toBeNull();
      const brand = container.querySelector('.brand');
      expect(brand?.textContent).toContain('CustomBrand');
    } finally {
      unmount(component);
    }
  });

  it('forwards navIconComponent to the inner NavTree', async () => {
    // Use a tiny stub component so we can assert the icon-rendering branch
    // fired. NavTree renders `<IconComponent name=... size=... />` in the
    // icon slot when this prop is provided.
    const TestIcon = (await import('./test-icon.svelte')).default;
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        navIconComponent: TestIcon,
        children: textSnippet('content'),
      },
    });

    try {
      const iconStub = container.querySelector(
        '.smrt-nav-tree [data-testid="custom-icon"]',
      );
      expect(iconStub).not.toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('invokes the composed onNavigate callback alongside closing the drawer', async () => {
    let called = 0;
    let controls!: {
      setMobileNavOpen: (next: boolean) => void;
      getMobileNavOpen: () => boolean;
    };
    const component = mount(BindHarness, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'super',
        currentPath: '/super',
        initial: true,
        onNavigate: () => {
          called += 1;
        },
        onReady: (c) => {
          controls = c;
        },
      },
    });

    try {
      await tick();
      expect(controls.getMobileNavOpen()).toBe(true);

      const navLink = container.querySelector<HTMLAnchorElement>(
        '.smrt-nav-tree .nav-item',
      );
      navLink?.addEventListener('click', (e) => e.preventDefault());
      navLink?.click();
      await tick();

      // The internal close still fires AND the consumer callback ran.
      expect(controls.getMobileNavOpen()).toBe(false);
      expect(called).toBe(1);
    } finally {
      unmount(component);
    }
  });

  it('exposes data-role-id on the wrapper', () => {
    const component = mount(RoleShell, {
      target: container,
      props: {
        roles: ROLES,
        currentRole: 'advertiser',
        currentPath: '/advertiser',
        children: textSnippet('content'),
      },
    });

    try {
      const wrapper = container.querySelector('.smrt-role-shell');
      expect(wrapper?.getAttribute('data-role-id')).toBe('advertiser');
    } finally {
      unmount(component);
    }
  });

  describe('bindable mobileNavOpen', () => {
    it('reflects external state changes into the WorkspaceShell drawer class', async () => {
      let controls!: {
        setMobileNavOpen: (next: boolean) => void;
        getMobileNavOpen: () => boolean;
      };
      const component = mount(BindHarness, {
        target: container,
        props: {
          roles: ROLES,
          currentRole: 'super',
          currentPath: '/super',
          onReady: (c) => {
            controls = c;
          },
        },
      });

      try {
        await tick();
        const shell = container.querySelector('.smrt-workspace-shell');
        expect(shell?.classList.contains('nav-open')).toBe(false);

        controls.setMobileNavOpen(true);
        await tick();
        expect(shell?.classList.contains('nav-open')).toBe(true);
        expect(controls.getMobileNavOpen()).toBe(true);

        controls.setMobileNavOpen(false);
        await tick();
        expect(shell?.classList.contains('nav-open')).toBe(false);
      } finally {
        unmount(component);
      }
    });

    it('closes the drawer when a nav link is clicked', async () => {
      let controls!: {
        setMobileNavOpen: (next: boolean) => void;
        getMobileNavOpen: () => boolean;
      };
      const component = mount(BindHarness, {
        target: container,
        props: {
          roles: ROLES,
          currentRole: 'super',
          currentPath: '/super',
          initial: true,
          onReady: (c) => {
            controls = c;
          },
        },
      });

      try {
        await tick();
        expect(controls.getMobileNavOpen()).toBe(true);

        const navLink = container.querySelector<HTMLAnchorElement>(
          '.smrt-nav-tree .nav-item',
        );
        expect(navLink).not.toBeNull();
        // Prevent jsdom from actually navigating away while clicking.
        navLink?.addEventListener('click', (e) => e.preventDefault());
        navLink?.click();
        await tick();
        expect(controls.getMobileNavOpen()).toBe(false);
      } finally {
        unmount(component);
      }
    });
  });

  it('re-renders with the new role sections when currentRole changes', async () => {
    let setCurrentRole!: (id: string) => void;

    // Build a small switcher harness inline using a wrapper component is
    // overkill — instead, drive currentRole via component prop updates.
    // Svelte 5's `mount` returns the component instance; reassignments
    // happen via $state in a parent, so we use a tiny inline harness.
    const Harness = (await import('./role-shell-switch-harness.svelte'))
      .default;

    const component = mount(Harness, {
      target: container,
      props: {
        roles: ROLES,
        initialRole: 'super',
        currentPath: '/super',
        onReady: (controls: { setCurrentRole: (id: string) => void }) => {
          setCurrentRole = controls.setCurrentRole;
        },
      },
    });

    try {
      await tick();
      let labels = Array.from(
        container.querySelectorAll('.smrt-nav-tree .nav-item'),
      ).map((el) => el.textContent ?? '');
      expect(labels.some((l) => l.includes('Tenants'))).toBe(true);
      expect(labels.some((l) => l.includes('Campaigns'))).toBe(false);

      setCurrentRole('advertiser');
      await tick();
      labels = Array.from(
        container.querySelectorAll('.smrt-nav-tree .nav-item'),
      ).map((el) => el.textContent ?? '');
      expect(labels.some((l) => l.includes('Campaigns'))).toBe(true);
      expect(labels.some((l) => l.includes('Tenants'))).toBe(false);

      // role-color should have changed too.
      const wrapper = container.querySelector<HTMLElement>('.smrt-role-shell');
      expect(wrapper?.getAttribute('style')).toContain('purple');
      expect(wrapper?.getAttribute('data-role-id')).toBe('advertiser');
    } finally {
      unmount(component);
    }
  });
});
