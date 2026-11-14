import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './app-shell-panel-harness.svelte';

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
const q = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const panel = () => q('[data-testid="admin-shell-panel"]');
const footer = () => q('[data-slot="leftSidebar.footer"]');
const toggle = () => q<HTMLButtonElement>('button[aria-label="Assistant"]');
const follows = (a: Element | null, b: Element | null) =>
  Boolean(
    a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

describe('AppShell docked panel', () => {
  it('renders sidebar, panel, then content (opt in only)', async () => {
    await render();
    expect(follows(q('#smrt-admin-shell-left-panel'), panel())).toBe(true);
    expect(follows(panel(), q('#smrt-admin-shell-main'))).toBe(true);
    expect(panel()).toHaveAccessibleName('Assistant chat');
    expect(q('[data-testid="chat-body"]')).toBeTruthy();
  });

  it('draws the sidebar footer divider unless the host opts out', async () => {
    await render();
    expect(q('.smrt-admin-shell')).not.toHaveAttribute('data-footer-divider');
    unmount(component as never);
    component = undefined;
    container.innerHTML = '';
    await render({ sidebarFooterDivider: false });
    expect(q('.smrt-admin-shell')).toHaveAttribute(
      'data-footer-divider',
      'off',
    );
  });

  it('adds nothing without a panel', async () => {
    await render({ withPanel: false });
    expect(panel()).toBeNull();
    expect(toggle()).toBeNull();
  });

  it('puts voice, the panel toggle and the account in the footer, in that order', async () => {
    await render();
    const voice = footer()?.querySelector('button[aria-label="Voice"]') ?? null;
    const account =
      footer()?.querySelector('.smrt-workspace-account-menu') ?? null;
    expect(voice).toBeTruthy();
    expect(toggle()).toBeTruthy();
    expect(footer()?.contains(toggle())).toBe(true);
    expect(follows(voice, toggle())).toBe(true);
    expect(follows(toggle(), account)).toBe(true);
  });

  it('toggles the panel with aria-pressed and a bindable open state', async () => {
    await render({ panelOpen: true });
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(panel()).not.toHaveAttribute('hidden');
    toggle()?.click();
    await tick();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(panel()).toHaveAttribute('hidden');
    // Still mounted: its content (and any chat state) survives.
    expect(q('[data-testid="chat-body"]')).toBeTruthy();
    toggle()?.click();
    await tick();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(panel()).not.toHaveAttribute('hidden');
  });

  it('starts closed when told so', async () => {
    await render({ panelOpen: false });
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(panel()).toHaveAttribute('hidden');
  });

  it('keeps the footer icons as icons in the collapsed rail', async () => {
    await render({
      config: { left: { initial: 'collapsed' } },
      edgeToggles: true,
    });
    const rail = q('.smrt-admin-shell__tenant-rail-footer');
    expect(rail?.querySelector('button[aria-label="Voice"]')).toBeTruthy();
    expect(rail?.querySelector('button[aria-label="Assistant"]')).toBeTruthy();
    expect(rail?.querySelector('[data-compact]')).toBeTruthy();
    expect(
      follows(toggle(), rail?.querySelector('[data-compact]') ?? null),
    ).toBe(true);
    toggle()?.click();
    await tick();
    expect(panel()).toHaveAttribute('hidden');
  });
});

describe('AppShell voice toggle', () => {
  const voice = () =>
    footer()?.querySelector<HTMLButtonElement>('button[aria-label^="Voice"]') ??
    null;

  it('is a pressed-state toggle that calls onpress', async () => {
    const onvoice = vi.fn();
    await render({ voiceState: 'on', onvoice });
    expect(voice()?.getAttribute('aria-pressed')).toBe('true');
    expect(voice()?.getAttribute('aria-disabled')).toBeNull();
    voice()?.click();
    await tick();
    expect(onvoice).toHaveBeenCalledTimes(1);
  });

  it('shows off as a not-pressed toggle', async () => {
    await render({ voiceState: 'off' });
    expect(voice()?.getAttribute('aria-pressed')).toBe('false');
    expect(voice()?.getAttribute('aria-label')).toBe('Voice');
  });

  it('shows unavailable as dimmed, disabled-looking, never pressed, and inert', async () => {
    const onvoice = vi.fn();
    await render({ voiceState: 'unavailable', onvoice });
    expect(voice()?.getAttribute('aria-disabled')).toBe('true');
    expect(voice()?.getAttribute('aria-pressed')).toBeNull();
    expect(voice()?.getAttribute('aria-label')).toBe(
      'Voice (not available yet)',
    );
    expect(voice()?.title).toBe('Voice (not available yet)');
    expect(footer()?.querySelector('[data-state="unavailable"]')).toBeTruthy();
    voice()?.click();
    await tick();
    expect(onvoice).not.toHaveBeenCalled();
  });
});

describe('AppShell account menu items', () => {
  const trigger = () =>
    q<HTMLButtonElement>('.smrt-workspace-account-menu__trigger');
  const items = () => [
    ...container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ];

  it('lists Approvals, History, Theme, Settings in order with a count badge', async () => {
    await render();
    trigger()?.click();
    await tick();
    expect(
      items().map((el) => el.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Approvals3', 'History', 'Theme: Light', 'Settings']);
    expect(items()[0]).toHaveAttribute('href', '/approvals');
    expect(
      items()[0].querySelector('[data-smrt-part="item-badge"]'),
    ).toHaveAccessibleName('3 waiting');
  });

  it('shows the pending count on the closed trigger', async () => {
    await render();
    const badge = q('[data-smrt-part="trigger-badge"]');
    expect(badge?.textContent).toBe('3');
    expect(trigger()?.textContent).toContain('3 waiting');
  });

  it('shows no badge when nothing is waiting', async () => {
    await render({
      accountMenu: {
        items: [
          { id: 'approvals', label: 'Approvals', href: '/approvals', badge: 0 },
        ],
      },
    });
    expect(q('[data-smrt-part="trigger-badge"]')).toBeNull();
  });

  it('the Theme item switches the color scheme', async () => {
    await render();
    trigger()?.click();
    await tick();
    const theme = items().find((el) => el.textContent?.startsWith('Theme'));
    theme?.click();
    await tick();
    trigger()?.click();
    await tick();
    expect(items().some((el) => el.textContent?.trim() === 'Theme: Dark')).toBe(
      true,
    );
  });
});

describe('AppShell docked panel on a phone', () => {
  beforeEach(() => {
    phone = true;
  });

  it('starts on the content, with a panel tab in the tab bar', async () => {
    await render({ phoneTabBar: true, panelOpen: true });
    const bar = q('[data-testid="phone-bottom-bar"]');
    const tab = bar?.querySelector<HTMLElement>('[data-item="panel"]');
    expect(tab).toBeTruthy();
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    expect(q('#smrt-admin-shell-main')?.inert).toBe(false);
    // The footer toggle is not duplicated on phones with the bar.
    expect(
      footer()?.querySelector('button[aria-label="Assistant"]'),
    ).toBeNull();
  });

  it('switches to a full-size chat view and back', async () => {
    await render({ phoneTabBar: true });
    const tab = () =>
      q<HTMLElement>('[data-testid="phone-bottom-bar"] [data-item="panel"]');
    tab()?.click();
    await tick();
    expect(panel()).not.toHaveAttribute('hidden');
    expect(q('#smrt-admin-shell-main')?.inert).toBe(true);
    expect(tab()).toHaveAttribute('aria-expanded', 'true');
    tab()?.click();
    await tick();
    expect(panel()).toHaveAttribute('hidden');
    expect(q('#smrt-admin-shell-main')?.inert).toBe(false);
  });

  it('keeps the account menu reachable (compact, with the badge)', async () => {
    await render({ phoneTabBar: true });
    expect(q('.smrt-workspace-account-menu[data-compact]')).toBeTruthy();
    expect(q('[data-smrt-part="trigger-badge"]')?.textContent).toBe('3');
  });
});
