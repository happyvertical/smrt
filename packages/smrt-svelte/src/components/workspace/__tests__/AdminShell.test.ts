import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminShell from '../admin-shell/AdminShell.svelte';
import adminShellSource from '../admin-shell/AdminShell.svelte?raw';
import { createShellState } from '../admin-shell/state.svelte.js';
import type { ShellFocusTool } from '../admin-shell/types.js';

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

function activeToolSnippet() {
  return createRawSnippet<[{ tool: ShellFocusTool | null }]>((context) => ({
    render: () => `<span>${context().tool?.id ?? 'none'} panel</span>`,
  }));
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  vi.unstubAllGlobals();
  container.remove();
});

describe('AdminShell', () => {
  it('keeps a consumer header and default phone menu opener when the top edge is unavailable', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      addEventListener() {},
      removeEventListener() {},
    }));
    const state = createShellState({
      viewport: 'phone',
      config: {
        top: { initial: 'hidden' },
        left: { initial: 'collapsed' },
      },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        header: textSnippet('consumer header'),
        children: textSnippet('main'),
        tenantPanel: textSnippet('tenant navigation'),
      },
    });
    try {
      await tick();
      const menu = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Menu"]',
      );
      expect(menu).not.toBeNull();
      expect(
        container.querySelector('[data-testid="admin-shell-header"]'),
      ).toHaveTextContent('consumer header');
      expect(menu).toHaveAttribute('aria-expanded', 'false');
      expect(menu).toHaveAttribute(
        'aria-controls',
        'smrt-admin-shell-left-panel',
      );
      menu?.click();
      await tick();
      expect(menu).toHaveAttribute('aria-expanded', 'true');
      expect(state.panels.left).toBe('expanded');
    } finally {
      unmount(component);
    }
  });

  it('keeps a single tenant footer reachable when the left edge collapses or hides', async () => {
    const state = createShellState({
      config: { left: { initial: 'collapsed' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        tenantFooter: textSnippet('Dana account'),
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(container.querySelector('header')?.textContent).toContain(
        'Dana account',
      );
      state.setPanelState('left', 'expanded');
      flushSync();
      expect(container.querySelector('header')?.textContent).not.toContain(
        'Dana account',
      );
      expect(
        container.querySelector('.smrt-admin-shell__tenant-footer')
          ?.textContent,
      ).toContain('Dana account');
      state.setPanelState('left', 'hidden');
      flushSync();
      expect(container.querySelector('header')?.textContent).toContain(
        'Dana account',
      );
      expect(container.textContent?.match(/Dana account/g)).toHaveLength(1);
    } finally {
      await unmount(component);
    }
  });

  it('keeps sidebar-only branding and a rail footer reachable in both left states', async () => {
    const state = createShellState({
      config: { top: false, left: { initial: 'collapsed' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        edgeToggles: { left: true },
        title: 'Workshop',
        homeHref: '/app',
        tenantRail: textSnippet('compact navigation'),
        tenantPanel: textSnippet('full navigation'),
        tenantFooter: textSnippet('full account'),
        tenantRailFooter: textSnippet('compact account'),
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(container.querySelector('#smrt-admin-shell-top-panel')).toBeNull();
      expect(
        container.querySelector('.smrt-admin-shell__brand.compact'),
      ).toHaveAttribute('href', '/app');
      expect(
        container.querySelector('.smrt-admin-shell__tenant-rail-footer')
          ?.textContent,
      ).toContain('compact account');
      expect(container.textContent?.match(/account/g)).toHaveLength(1);

      state.expandPanel('left');
      await tick();
      expect(
        container.querySelector('.smrt-admin-shell__brand:not(.compact)')
          ?.textContent,
      ).toContain('Workshop');
      expect(
        container.querySelector('.smrt-admin-shell__tenant-footer')
          ?.textContent,
      ).toContain('full account');
      expect(
        container.querySelector('.smrt-admin-shell__tenant-rail-footer'),
      ).toBeNull();
      expect(container.textContent?.match(/account/g)).toHaveLength(1);
    } finally {
      await unmount(component);
    }
  });

  it('restores the ordinary footer to the header when the rail becomes unreachable', async () => {
    const state = createShellState({
      config: { left: { initial: 'collapsed' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        state,
        edgeToggles: { left: true },
        tenantFooter: textSnippet('full account'),
        tenantRailFooter: textSnippet('compact account'),
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(container.querySelector('header')?.textContent).not.toContain(
        'full account',
      );
      expect(
        container.querySelector('.smrt-admin-shell__tenant-rail-footer')
          ?.textContent,
      ).toContain('compact account');

      state.setPanelState('left', 'hidden');
      flushSync();
      expect(container.querySelector('header')?.textContent).toContain(
        'full account',
      );
      expect(
        container.querySelector('.smrt-admin-shell__tenant-rail-footer'),
      ).toBeNull();

      state.setPanelState('left', 'collapsed');
      flushSync();
      expect(container.querySelector('header')?.textContent).not.toContain(
        'full account',
      );
      expect(
        container.querySelector('.smrt-admin-shell__tenant-rail-footer')
          ?.textContent,
      ).toContain('compact account');
    } finally {
      await unmount(component);
    }
  });

  it('assigns a footer-only collapsed rail to the bottom grid row', () => {
    expect(adminShellSource).toMatch(
      /\.smrt-admin-shell__tenant-rail-footer\s*\{[^}]*grid-row:\s*2;/s,
    );
  });

  it('keeps an explicit account slot in a custom app bar regardless of left state', async () => {
    const state = createShellState({
      config: { left: { initial: 'expanded' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        account: textSnippet('Dana account'),
        appBar: textSnippet('Custom title'),
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(container.querySelector('header')?.textContent).toContain(
        'Dana account',
      );
    } finally {
      await unmount(component);
    }
  });

  it('keeps the left collapse control with supplied navigation and permits opt-out', async () => {
    for (const showTenantToggle of [true, false]) {
      const state = createShellState({
        config: { left: { initial: 'expanded' } },
      });
      const component = mount(AdminShell, {
        target: container,
        props: {
          state,
          showTenantToggle,
          tenantPanel: textSnippet('supplied nav'),
          children: textSnippet('main'),
        },
      });
      try {
        await tick();
        const toggle = container.querySelector<HTMLButtonElement>(
          '.smrt-admin-shell__edge--left .smrt-admin-shell__edge-toggle',
        );
        expect(!!toggle).toBe(showTenantToggle);
        if (toggle) {
          toggle.click();
          flushSync();
          expect(state.panels.left).toBe('collapsed');
        }
      } finally {
        await unmount(component);
      }
    }
  });

  it('preserves the system toggle when a custom system bar has a system panel', async () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        systemBar: textSnippet('custom status'),
        systemPanel: textSnippet('status detail'),
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(
        container.querySelector('footer .smrt-admin-shell__edge-toggle'),
      ).not.toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('draws no bottom toggle for a system bar with no system panel', async () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        systemBar: textSnippet('custom status'),
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(container.querySelector('footer')?.textContent).toContain(
        'custom status',
      );
      expect(
        container.querySelector('footer .smrt-admin-shell__edge-toggle'),
      ).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('keeps the default bottom toggle when neither system slot is supplied', async () => {
    const component = mount(AdminShell, {
      target: container,
      props: { edgeToggles: true, children: textSnippet('main') },
    });
    try {
      await tick();
      expect(
        container.querySelector('footer .smrt-admin-shell__edge-toggle'),
      ).not.toBeNull();
      expect(
        container.querySelector('header .smrt-admin-shell__edge-toggle'),
      ).not.toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('links full and compact branding home with an accessible title', async () => {
    const state = createShellState({
      config: { left: { initial: 'collapsed' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        title: 'Shop',
        homeHref: '/home',
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      const links = container.querySelectorAll<HTMLAnchorElement>(
        '.smrt-admin-shell__brand-link',
      );
      expect(links).toHaveLength(2);
      expect([...links].map((link) => link.getAttribute('href'))).toEqual([
        '/home',
        '/home',
      ]);
      expect([...links].map((link) => link.getAttribute('aria-label'))).toEqual(
        ['Shop', 'Shop'],
      );
      expect(links[1].textContent?.trim()).toBe('S');
    } finally {
      unmount(component);
    }
  });

  it('renders a logo and keeps default branding unlinked without homeHref', async () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        title: 'Shop',
        logoSrc: '/shop.svg',
        logoAlt: 'Shop mark',
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        '/shop.svg',
      );
      expect(container.querySelector('img')?.getAttribute('alt')).toBe(
        'Shop mark',
      );
      expect(
        container.querySelector('.smrt-admin-shell__brand-link'),
      ).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('passes full and compact context to custom brand snippets', async () => {
    const brand = createRawSnippet<[{ compact: boolean }]>((context) => ({
      render: () =>
        `<span>${context().compact ? 'Compact mark' : 'Full mark'}</span>`,
    }));
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        title: 'Shop',
        homeHref: '/',
        brand,
        children: textSnippet('main'),
      },
    });
    try {
      await tick();
      expect(container.textContent).toContain('Full mark');
      expect(container.textContent).toContain('Compact mark');
    } finally {
      unmount(component);
    }
  });

  it('renders the four edge shell and body content', () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        title: 'Ops',
        children: textSnippet('main work'),
      },
    });

    try {
      expect(container.querySelector('.smrt-admin-shell')).not.toBeNull();
      expect(container.querySelector('header')?.textContent).toContain('Ops');
      expect(container.querySelector('main')?.textContent).toContain(
        'main work',
      );
      // The left sidebar is a labelled complementary region; it only contains a
      // navigation landmark when it actually renders navigation (aria-allowed-role).
      const left = container.querySelector('#smrt-admin-shell-left-panel');
      expect(left?.tagName).toBe('ASIDE');
      expect(left?.getAttribute('role')).toBeNull();
      expect(left?.getAttribute('aria-label')).toBeTruthy();
    } finally {
      unmount(component);
    }
  });

  it('pins the shell to the viewport so long workspace content scrolls inside main', () => {
    expect(adminShellSource).toMatch(
      /\.smrt-admin-shell\s*\{[^}]*\bblock-size:\s*100svh\s*;/,
    );
  });

  it('toggles a physical-code panel hotkey', async () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        children: textSnippet('main work'),
      },
    });

    try {
      const shell = container.querySelector('.smrt-admin-shell');
      expect(shell?.getAttribute('data-top-state')).toBe('collapsed');

      await tick();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      flushSync();

      expect(shell?.getAttribute('data-top-state')).toBe('expanded');
    } finally {
      unmount(component);
    }
  });

  it('hides hotkey badges when shell hotkeys are disabled', () => {
    const state = createShellState({
      settings: { hotkeysEnabled: false },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
      },
    });

    try {
      expect(
        container.querySelector('.smrt-admin-shell__edge-toggle-kbd'),
      ).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('keeps the focus rail visible when the right panel is expanded', () => {
    const state = createShellState({
      config: {
        right: {
          initial: 'expanded',
        },
      },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
        focusRail: textSnippet('focus rail'),
        focusPanel: textSnippet('focus panel'),
      },
    });

    try {
      const right = container.querySelector('.smrt-admin-shell__edge--right');
      const rail = right?.querySelector('.smrt-admin-shell__rail');
      const panel = right?.querySelector('.smrt-admin-shell__panel--right');

      expect(right?.getAttribute('data-state')).toBe('expanded');
      expect(rail?.textContent).toContain('focus rail');
      expect(panel?.textContent).toContain('focus panel');
    } finally {
      unmount(component);
    }
  });

  it('renders the active registered focus tool after switching tools', async () => {
    const state = createShellState({
      config: { right: { initial: 'expanded' } },
    });
    state.registerFocusTool({
      id: 'usage',
      label: 'Usage',
    });
    state.registerFocusTool({
      id: 'tasks',
      label: 'Tasks',
    });

    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
        focusPanel: activeToolSnippet(),
      },
    });

    try {
      const panel = container.querySelector('.smrt-admin-shell__panel--right');
      expect(panel?.textContent).toContain('usage panel');

      state.openFocusTool('tasks');
      await tick();

      expect(panel?.textContent).toContain('tasks panel');
      expect(panel?.textContent).not.toContain('usage panel');
    } finally {
      unmount(component);
    }
  });

  it('keeps a keepMounted focus panel (and its draft) mounted while collapsed', async () => {
    const state = createShellState({
      config: { right: { initial: 'expanded', keepMounted: true } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
        focusPanel: createRawSnippet(() => ({
          render: () => '<textarea aria-label="Message"></textarea>',
        })),
      },
    });

    try {
      const draft = container.querySelector('textarea');
      if (!draft) throw new Error('focus panel did not render');
      draft.value = 'half-typed question';

      state.collapsePanel('right');
      await tick();
      const panel = container.querySelector<HTMLElement>(
        '.smrt-admin-shell__panel--right',
      );
      expect(panel?.hidden).toBe(true);
      expect(container.querySelector('textarea')).toBe(draft);

      state.expandPanel('right');
      await tick();
      expect(panel?.hidden).toBe(false);
      expect(container.querySelector('textarea')).toBe(draft);
      expect(draft.value).toBe('half-typed question');
    } finally {
      unmount(component);
    }
  });

  it('unmounts a collapsed panel without keepMounted', async () => {
    const state = createShellState({
      config: { right: { initial: 'expanded' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
        focusPanel: textSnippet('focus panel'),
      },
    });

    try {
      expect(
        container.querySelector('.smrt-admin-shell__panel--right'),
      ).not.toBeNull();
      state.collapsePanel('right');
      await tick();
      expect(
        container.querySelector('.smrt-admin-shell__panel--right'),
      ).toBeNull();
    } finally {
      unmount(component);
    }
  });

  it('keeps a keepMounted tenant panel beside the collapsed rail', async () => {
    const state = createShellState({
      config: { left: { initial: 'collapsed', keepMounted: true } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
        tenantRail: textSnippet('tenant rail'),
        tenantPanel: textSnippet('tenant navigation'),
      },
    });

    try {
      const stack = container.querySelector<HTMLElement>(
        '.smrt-admin-shell__tenant-stack',
      );
      expect(stack?.hidden).toBe(true);
      expect(stack?.textContent).toContain('tenant navigation');
      const rail = container.querySelector('.smrt-admin-shell__rail');
      expect(rail?.textContent).toContain('tenant rail');

      state.expandPanel('left');
      await tick();
      expect(container.querySelector('.smrt-admin-shell__tenant-stack')).toBe(
        stack,
      );
      expect(stack?.hidden).toBe(false);
      expect(rail?.textContent).not.toContain('tenant rail');
    } finally {
      unmount(component);
    }
  });

  it('pins a tenant footer below the scrolling tenant panel', () => {
    const state = createShellState({
      config: { left: { initial: 'expanded' } },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
        tenantPanel: textSnippet('tenant navigation'),
        tenantFooter: textSnippet('account menu'),
      },
    });

    try {
      expect(
        container.querySelector('.smrt-admin-shell__tenant-content')
          ?.textContent,
      ).toContain('tenant navigation');
      expect(
        container.querySelector('.smrt-admin-shell__tenant-footer')
          ?.textContent,
      ).toContain('account menu');
    } finally {
      unmount(component);
    }
  });

  it('publishes collapsed side sizes for stable top and bottom chrome', () => {
    const state = createShellState({
      config: {
        left: {
          collapsedSize: '5rem',
          expandedSize: '20rem',
          initial: 'expanded',
        },
        right: {
          collapsedSize: '6rem',
          expandedSize: '24rem',
          initial: 'expanded',
        },
      },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
      },
    });

    try {
      const shell = container.querySelector('.smrt-admin-shell');
      const style = shell?.getAttribute('style');

      expect(style).toContain('--smrt-admin-shell-left-track: 20rem');
      expect(style).toContain('--smrt-admin-shell-right-track: 24rem');
      expect(style).toContain('--smrt-admin-shell-left-collapsed: 5rem');
      expect(style).toContain('--smrt-admin-shell-right-collapsed: 6rem');
    } finally {
      unmount(component);
    }
  });

  it('does not reserve chrome corner space for hidden side edges', () => {
    const state = createShellState({
      config: {
        left: false,
        right: false,
      },
    });
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        state,
        children: textSnippet('main work'),
      },
    });

    try {
      const shell = container.querySelector('.smrt-admin-shell');
      const style = shell?.getAttribute('style');

      expect(style).toContain('--smrt-admin-shell-left-track: 0rem');
      expect(style).toContain('--smrt-admin-shell-right-track: 0rem');
      expect(style).toContain('--smrt-admin-shell-left-collapsed: 0rem');
      expect(style).toContain('--smrt-admin-shell-right-collapsed: 0rem');
    } finally {
      unmount(component);
    }
  });

  it('collapses corner tracks when no corner snippets are mounted', () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        title: 'Ops',
        children: textSnippet('main work'),
      },
    });

    try {
      const topEdge = container.querySelector(
        '.smrt-admin-shell__edge--top',
      ) as HTMLElement;
      const band = container.querySelector(
        '.smrt-admin-shell__band--top',
      ) as HTMLElement;
      expect(topEdge.style.getPropertyValue('--edge-columns').trim()).toBe(
        '0px minmax(0, 1fr) 0px',
      );
      expect(band.style.getPropertyValue('--band-column').trim()).toBe('2');
    } finally {
      unmount(component);
    }
  });

  it('renders a default focus rail from registered tools when no focusRail snippet is given', async () => {
    const state = createShellState();
    state.registerFocusTool({ id: 'chat', label: 'Chat' });
    state.registerFocusTool({ id: 'files', label: 'Files' });
    const component = mount(AdminShell, {
      target: container,
      props: { state, children: textSnippet('main work') },
    });

    try {
      const buttons = container.querySelectorAll(
        '.smrt-admin-shell__focus-tool',
      );
      expect(buttons.length).toBe(2);
      expect(buttons[0].getAttribute('aria-label')).toBe('Chat');

      // Clicking a tool opens the panel; clicking the active one closes it.
      (buttons[0] as HTMLButtonElement).click();
      const { tick } = await import('svelte');
      await tick();
      expect(
        container
          .querySelector('.smrt-admin-shell__edge--right')
          ?.getAttribute('data-state'),
      ).toBe('expanded');
      (buttons[0] as HTMLButtonElement).click();
      await tick();
      expect(
        container
          .querySelector('.smrt-admin-shell__edge--right')
          ?.getAttribute('data-state'),
      ).toBe('collapsed');
    } finally {
      unmount(component);
    }
  });

  it('reserves corner tracks only for mounted corner snippets', () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        title: 'Ops',
        topLeftCorner: textSnippet('corner'),
        children: textSnippet('main work'),
      },
    });

    try {
      const topEdge = container.querySelector(
        '.smrt-admin-shell__edge--top',
      ) as HTMLElement;
      const band = container.querySelector(
        '.smrt-admin-shell__band--top',
      ) as HTMLElement;
      const columns = topEdge.style.getPropertyValue('--edge-columns');
      expect(columns).toContain('--smrt-admin-shell-left-collapsed');
      expect(columns).not.toContain('--smrt-admin-shell-right-collapsed');
      expect(band.style.getPropertyValue('--band-column').trim()).toBe('2');
    } finally {
      unmount(component);
    }
  });

  it('keeps a right-only corner in the explicit third grid track', () => {
    const component = mount(AdminShell, {
      target: container,
      props: {
        edgeToggles: true,
        title: 'Ops',
        topRightCorner: textSnippet('right corner'),
        children: textSnippet('main work'),
      },
    });

    try {
      const topEdge = container.querySelector(
        '.smrt-admin-shell__edge--top',
      ) as HTMLElement;
      const band = container.querySelector(
        '.smrt-admin-shell__band--top',
      ) as HTMLElement;
      const columns = topEdge.style.getPropertyValue('--edge-columns').trim();
      expect(columns).toBe(
        '0px minmax(0, 1fr) var(--smrt-admin-shell-right-collapsed)',
      );
      expect(band.style.getPropertyValue('--band-column').trim()).toBe('2');
      expect(
        container.querySelector('.smrt-admin-shell__corner--top-right'),
      ).not.toBeNull();
    } finally {
      unmount(component);
    }
  });
});
