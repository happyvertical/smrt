import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../AppShell.svelte';
import AppShellDockHarness from './app-shell-dock-harness.svelte';
import AppShellWebMcpHarness from './app-shell-webmcp-harness.svelte';

const text = (value: string) =>
  createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

const open = { left: { initial: 'expanded' } } as const;
let container: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

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
  if (component) unmount(component);
  component = undefined;
  vi.unstubAllGlobals();
  container.remove();
});

function render(props: Record<string, unknown>) {
  component = mount(AppShell, {
    target: container,
    props: { children: text('page body'), ...props } as never,
  });
  return tick();
}

describe('AppShell', () => {
  it('shows the logo before the title in the brand, linked home', async () => {
    await render({
      title: 'Planner',
      logoSrc: '/mark.svg',
      homeHref: '/',
      config: open,
    });
    const logo = container.querySelector<HTMLImageElement>(
      'img.smrt-admin-shell__logo',
    );
    expect(logo?.getAttribute('src')).toBe('/mark.svg');
    expect(logo?.getAttribute('alt')).toBe('');
    const link = logo?.closest('a');
    expect(link?.getAttribute('href')).toBe('/');
    expect(link?.textContent).toContain('Planner');
    // Logo + title with no subtitle: the title is a wordmark.
    expect(
      container.querySelector('.smrt-admin-shell__brand-text.wordmark'),
    ).not.toBeNull();
  });

  it('renders the shell with and without navigation', async () => {
    await render({ title: 'Acme', config: open });
    expect(container.textContent).toContain('page body');
    expect(container.querySelector('nav')).toBeNull();
    unmount(component as never);
    component = undefined;
    container.innerHTML = '';

    await render({
      title: 'Acme',
      config: open,
      currentHref: '/settings',
      nav: [
        { href: '/', label: 'Items' },
        { href: '/settings', label: 'Settings' },
      ],
    });
    const nav = container.querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe('Application navigation');
    const links = [...container.querySelectorAll('nav a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toEqual(['/', '/settings']);
  });

  it('wraps content in the theme provider so theme variables are scoped', async () => {
    await render({ preset: 'smrt', colorScheme: 'dark' });
    const root = container.querySelector('[data-theme]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-theme')).toBe('smrt');
  });

  it('ships the theme stylesheets with the component (variables are not left unresolved)', async () => {
    const source = (await import('../AppShell.svelte?raw')).default;
    expect(source).toContain("'@happyvertical/smrt-ui/themes/styles/all.css'");
    expect(source).toContain(
      "'@happyvertical/smrt-ui/themes/styles/fonts.css'",
    );
  });

  it('renders a dock tool only when a dock snippet is supplied', async () => {
    await render({});
    expect(
      container.querySelector('button[aria-label="Assistant"]'),
    ).toBeNull();
    unmount(component as never);
    component = undefined;
    container.innerHTML = '';

    component = mount(AppShellDockHarness, { target: container });
    await tick();
    expect(
      container.querySelector('button[aria-label="Assistant"]'),
    ).not.toBeNull();
  });

  it('hands the dock snippet the registry the mounted routes register on', async () => {
    const seen: unknown[] = [];
    let routeUi: { dataSurfaceRegistry: unknown } | null = null;
    component = mount(AppShellDockHarness, {
      target: container,
      props: {
        webmcp: true,
        onRegistry: (registry: unknown) => seen.push(registry),
        onUi: (ui: unknown) => {
          routeUi = ui as typeof routeUi;
        },
      },
    });
    await tick();
    await tick();
    expect(routeUi).not.toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    for (const registry of seen) {
      expect(registry).toBe(routeUi!.dataSurfaceRegistry);
    }
    const registry = seen[0] as {
      list(): Array<{ identity: { surfaceId: string } }>;
    };
    expect(registry.list().map((d) => d.identity.surfaceId)).toContain(
      'route-items',
    );
  });

  it('shows the settings link only when settingsHref is given', async () => {
    await render({
      settingsHref: '/settings',
      edgeToggles: true,
      config: { top: { initial: 'expanded' } },
    });
    const link = [...container.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'Shell settings',
    );
    expect(link?.getAttribute('href')).toBe('/settings');
  });

  it('passes webmcp options through to the Provider', async () => {
    const seen: { value: unknown } = { value: undefined };
    component = mount(AppShellWebMcpHarness, {
      target: container,
      props: {
        webmcp: { ui: {} },
        onUi: (ui: unknown) => {
          seen.value = ui;
        },
      },
    });
    await tick();
    expect(seen.value).not.toBeNull();
    expect((seen.value as { enabled: boolean }).enabled).toBe(true);
  });

  it('leaves WebMCP UI off when webmcp is not configured', async () => {
    const seen: { value: unknown } = { value: 'unset' };
    component = mount(AppShellWebMcpHarness, {
      target: container,
      props: {
        webmcp: false,
        onUi: (ui: unknown) => {
          seen.value = ui;
        },
      },
    });
    await tick();
    expect(seen.value).toBeNull();
  });

  it('registers diagnostics only when runtimeDiagnostics is true', async () => {
    const registerTool = vi.fn();
    Object.defineProperty(document, 'modelContext', {
      value: { registerTool },
      configurable: true,
    });
    try {
      await render({});
      expect(registerTool).not.toHaveBeenCalled();
      unmount(component as never);
      component = undefined;
      await render({ runtimeDiagnostics: true });
      expect(registerTool).toHaveBeenCalledOnce();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test cleanup
      delete (document as any).modelContext;
    }
  });
});
