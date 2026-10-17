import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import Harness from './app-shell-header-items-harness.svelte';

let container: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let phone = false;

beforeEach(() => {
  phone = false;
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      if (query.includes('prefers-reduced-motion')) return false;
      return /max-width:\s*48rem/.test(query) ? phone : false;
    },
    media: query,
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

async function render(props: Record<string, unknown> = {}) {
  component = mount(Harness, { target: container, props });
  for (let i = 0; i < 4; i++) await tick();
}
const slot = (name: string) =>
  container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const trigger = () =>
  container.querySelector<HTMLButtonElement>(
    '.smrt-workspace-account-menu__trigger',
  );
const menuItems = () => [
  ...container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
const follows = (a: Element | null, b: Element | null) =>
  Boolean(
    a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

describe('item:account', () => {
  it('renders in leftSidebar.footer with the full identity', async () => {
    await render();
    const footer = slot('leftSidebar.footer');
    expect(footer?.querySelector('.smrt-workspace-account-menu')).toBeTruthy();
    expect(footer?.querySelector('[data-compact]')).toBeNull();
    expect(footer?.textContent).toContain('Ada Lovelace');
  });

  it('renders nothing without a user, or when opted out', async () => {
    await render({ user: null });
    expect(container.querySelector('.smrt-workspace-account-menu')).toBeNull();
    unmount(component as never);
    container.innerHTML = '';
    await render({ accountMenu: false });
    expect(container.querySelector('.smrt-workspace-account-menu')).toBeNull();
  });

  it('honours { slot } and a stored placement', async () => {
    await render({ accountMenu: { slot: 'header.end' } });
    expect(slot('header.end')?.querySelector('[data-compact]')).toBeTruthy();
    unmount(component as never);
    container.innerHTML = '';
    await render({
      layout: {
        version: 1,
        placements: { 'item:account': 'footer.start' },
      } satisfies ShellLayout,
    });
    expect(
      slot('footer.start')?.querySelector('.smrt-workspace-account-menu'),
    ).toBeTruthy();
    expect(slot('leftSidebar.footer')).toBeNull();
  });

  it('opens with name, email, Settings and a Sign out callback; focus enters the menu', async () => {
    const onSignOut = vi.fn();
    await render({ onSignOut });
    const button = trigger() as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    for (let i = 0; i < 3; i++) await tick();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const popover = container.querySelector(
      '.smrt-workspace-account-menu__popover',
    );
    expect(popover?.textContent).toContain('Ada Lovelace');
    expect(popover?.textContent).toContain('ada@example.com');
    const items = menuItems();
    expect(items.map((el) => el.textContent?.trim())).toEqual([
      'Settings',
      'Sign out',
    ]);
    expect(items[0].getAttribute('href')).toBe('/settings');
    expect(document.activeElement).toBe(items[0]);
    items[1].click();
    await tick();
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders Sign out as a link for signOutHref', async () => {
    await render({ signOutHref: '/logout' });
    trigger()?.click();
    for (let i = 0; i < 3; i++) await tick();
    const out = menuItems().find((el) => el.textContent?.trim() === 'Sign out');
    expect(out?.getAttribute('href')).toBe('/logout');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    await render({ onSignOut: vi.fn() });
    const button = trigger() as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 3; i++) await tick();
    menuItems()[0].dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('opens upward from a sidebar footer on phones', async () => {
    phone = true;
    await render({
      onSignOut: vi.fn(),
      accountMenu: { slot: 'leftSidebar.footer' },
    });
    (trigger() as HTMLButtonElement).click();
    for (let i = 0; i < 3; i++) await tick();
    expect(
      container.querySelector(
        '.smrt-workspace-account-menu__popover--top-start',
      ),
    ).toBeTruthy();
  });

  it('places the menu from the rendered slot when its region is hidden', async () => {
    phone = true;
    await render({
      onSignOut: vi.fn(),
      layout: {
        version: 1,
        placements: { 'item:account': 'footer.start' },
        panels: { bottom: { visible: false } },
      } satisfies ShellLayout,
    });
    // footer.start falls back to leftSidebar.footer first (slotFallbackChain),
    // and a sidebar footer opens upward.
    expect(slot('footer.start')).toBeNull();
    expect(
      slot('leftSidebar.footer')?.querySelector('.smrt-workspace-account-menu'),
    ).toBeTruthy();
    (trigger() as HTMLButtonElement).click();
    for (let i = 0; i < 3; i++) await tick();
    expect(
      container.querySelector(
        '.smrt-workspace-account-menu__popover--top-start',
      ),
    ).toBeTruthy();
  });

  it('is the compact avatar at the end of the header band on phones', async () => {
    phone = true;
    await render({ onSignOut: vi.fn() });
    const end = slot('header.end');
    expect(end).toBeTruthy();
    expect(end?.lastElementChild?.matches('[data-compact]')).toBe(true);
    expect(end?.querySelector('.smrt-workspace-account-menu')).toBeTruthy();
    expect(slot('leftSidebar.footer')).toBeNull();
  });
});

describe('left sidebar order: nav, chevron, footer', () => {
  const orderOf = () => {
    const nav = container.querySelector('a[href="/posts"]');
    const chevron = container.querySelector(
      '.smrt-admin-shell__edge--left .smrt-admin-shell__edge-toggle--left',
    );
    const account = container.querySelector(
      '.smrt-admin-shell__edge--left .smrt-workspace-account-menu',
    );
    return { nav, chevron, account };
  };

  it('expanded: chevron follows the nav and precedes the footer account', async () => {
    await render({ edgeToggles: { left: true } });
    const { nav, chevron, account } = orderOf();
    expect(chevron).toBeTruthy();
    expect(account).toBeTruthy();
    expect(follows(nav, chevron)).toBe(true);
    expect(follows(chevron, account)).toBe(true);
    const rail = container.querySelector(
      '.smrt-admin-shell__edge--left .smrt-admin-shell__rail',
    );
    expect(rail?.lastElementChild).not.toBe(chevron);
    expect(chevron?.parentElement?.className).toContain('tenant-utilities');
    expect(chevron?.parentElement?.parentElement?.className).toContain(
      'tenant-stack',
    );
  });

  it('collapsed: nav, chevron, then the compact avatar last', async () => {
    await render({
      edgeToggles: { left: true },
      config: { left: { initial: 'collapsed' } },
    });
    const { chevron, account } = orderOf();
    expect(chevron).toBeTruthy();
    expect(account?.hasAttribute('data-compact')).toBe(true);
    expect(follows(chevron, account)).toBe(true);
    const stack = container.querySelector(
      '.smrt-admin-shell__tenant-rail-stack',
    );
    const kids = [...(stack?.children ?? [])];
    expect(kids).toHaveLength(3);
    expect(
      kids[0].classList.contains('smrt-admin-shell__tenant-rail-content'),
    ).toBe(true);
    expect(kids[1].classList).toContain('smrt-admin-shell__tenant-utilities');
    expect(kids[1].lastElementChild).toBe(chevron);
    expect(
      kids[2].classList.contains('smrt-admin-shell__tenant-rail-footer'),
    ).toBe(true);
    // The account is not duplicated into another region.
    expect(
      container.querySelectorAll('.smrt-workspace-account-menu'),
    ).toHaveLength(1);
    expect(slot('footer.start')).toBeNull();
  });
});

describe('item:color-scheme', () => {
  const toggleWrap = () =>
    container.querySelector<HTMLElement>(
      '[data-smrt-component="ShellColorSchemeToggle"]',
    );
  const toggle = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-smrt-component="ShellColorSchemeToggle"] button',
    );
  const utilities = () =>
    container.querySelector<HTMLElement>(
      '.smrt-admin-shell__edge--left .smrt-admin-shell__tenant-utilities',
    );

  it('is an icon button in the expanded sidebar, beside the chevron and above the account', async () => {
    await render({ edgeToggles: { left: true } });
    const row = utilities();
    expect(row?.parentElement?.classList).toContain(
      'smrt-admin-shell__tenant-stack',
    );
    expect(row?.contains(toggleWrap())).toBe(true);
    // Toggle first, the chevron keeps the row's inner edge.
    expect(row?.firstElementChild).toBe(toggleWrap());
    expect(row?.lastElementChild?.classList).toContain(
      'smrt-admin-shell__edge-toggle--left',
    );
    const nav = container.querySelector('a[href="/posts"]');
    const account = container.querySelector(
      '.smrt-admin-shell__edge--left .smrt-workspace-account-menu',
    );
    expect(follows(nav, toggle())).toBe(true);
    expect(follows(toggle(), account)).toBe(true);
    // Not in the header, not in the footer slot, rendered once.
    expect(
      slot('header.end')?.querySelector(
        '[data-smrt-component="ShellColorSchemeToggle"]',
      ) ?? null,
    ).toBeNull();
    expect(
      slot('leftSidebar.footer')?.querySelector(
        '[data-smrt-component="ShellColorSchemeToggle"]',
      ) ?? null,
    ).toBeNull();
    expect(
      container.querySelectorAll(
        '[data-smrt-component="ShellColorSchemeToggle"]',
      ),
    ).toHaveLength(1);
    // Icon only: no visible text.
    expect(toggle()?.textContent?.trim()).toBe('');
    expect(toggle()?.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it('renders in the utility row even without the chevron', async () => {
    await render();
    expect(utilities()?.contains(toggleWrap())).toBe(true);
    expect(
      container.querySelector('.smrt-admin-shell__edge-toggle--left'),
    ).toBeNull();
  });

  it('stays a compact icon in the collapsed rail: nav, toggle and chevron, then the avatar', async () => {
    await render({
      edgeToggles: { left: true },
      config: { left: { initial: 'collapsed' } },
    });
    const stack = container.querySelector(
      '.smrt-admin-shell__tenant-rail-stack',
    );
    const row = utilities();
    expect(row?.parentElement).toBe(stack);
    expect(row?.contains(toggleWrap())).toBe(true);
    const chevron = container.querySelector(
      '.smrt-admin-shell__edge-toggle--left',
    );
    const account = container.querySelector('.smrt-workspace-account-menu');
    expect(follows(toggle(), chevron)).toBe(true);
    expect(follows(chevron, account)).toBe(true);
    expect(account?.hasAttribute('data-compact')).toBe(true);
    expect(
      container.querySelectorAll(
        '[data-smrt-component="ShellColorSchemeToggle"]',
      ),
    ).toHaveLength(1);
    expect(slot('footer.start')).toBeNull();
    expect(
      slot('header.start')?.querySelector(
        '[data-smrt-component="ShellColorSchemeToggle"]',
      ) ?? null,
    ).toBeNull();
  });

  it('has an accessible name, tooltip and pressed state, and flips the scheme', async () => {
    await render({ colorScheme: 'light' });
    const button = toggle() as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Dark mode');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe('Switch to dark mode');
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'light',
    );

    button.click();
    for (let i = 0; i < 3; i++) await tick();
    expect(toggle()?.getAttribute('aria-label')).toBe('Dark mode');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle()?.title).toBe('Switch to light mode');
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );

    (toggle() as HTMLButtonElement).click();
    for (let i = 0; i < 3; i++) await tick();
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'light',
    );
  });

  it('opts out with colorSchemeToggle={false}', async () => {
    await render({ colorSchemeToggle: false });
    expect(toggleWrap()).toBeNull();
  });

  it('stays reachable on phones as an icon in the header band', async () => {
    phone = true;
    await render();
    const wrap = slot('header.end')?.querySelector(
      '[data-smrt-component="ShellColorSchemeToggle"]',
    );
    expect(wrap).toBeTruthy();
    expect(wrap?.querySelector('button[aria-label="Dark mode"]')).toBeTruthy();
    expect(utilities()).toBeNull();
  });

  it('honours { slot } and stored placements', async () => {
    await render({ colorSchemeToggle: { slot: 'header.end' } });
    expect(
      slot('header.end')?.querySelector(
        '[data-smrt-component="ShellColorSchemeToggle"]',
      ),
    ).toBeTruthy();
    expect(utilities()).toBeNull();
    unmount(component as never);
    container.innerHTML = '';
    await render({
      layout: {
        version: 1,
        placements: { 'item:color-scheme': 'footer.end' },
      } satisfies ShellLayout,
    });
    expect(
      slot('footer.end')?.querySelector(
        '[data-smrt-component="ShellColorSchemeToggle"]',
      ),
    ).toBeTruthy();
  });
});

describe('item:command-palette', () => {
  it('is absent unless configured', async () => {
    await render();
    expect(container.querySelector('.smrt-command-palette-trigger')).toBeNull();
  });

  it('renders the trigger in header.center when configured', async () => {
    await render({
      commandPalette: { providers: [], placeholder: 'Find anything' },
    });
    const trigger = slot('header.center')?.querySelector(
      '.smrt-command-palette-trigger',
    );
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.textContent).toContain('Search');
  });

  it('is a glyph-only button on phones', async () => {
    phone = true;
    await render({ commandPalette: { providers: [] } });
    const trigger = slot('header.center')?.querySelector(
      '.smrt-command-palette-trigger',
    );
    expect(trigger?.getAttribute('aria-label')).toBe('Search');
    expect(
      trigger?.querySelector('.smrt-command-palette-trigger__label'),
    ).toBeNull();
  });
});
