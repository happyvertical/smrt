// The shell's layout, mounted: left sidebar | chat | content, the footer
// controls and user menu, plugin mode and phone width. Runs under
// vitest.dom.config.ts (jsdom).
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRecords } from '../lib/ui/load.ts';
import type { Description } from '../lib/ui/types.ts';
import { page } from '../test/app-state.ts';
import {
  description as draftDescription,
  draftInfo,
} from '../test/draft-fixtures.ts';
import { layoutState } from '../test/layout-state.svelte.ts';
import Layout from './+layout.svelte';

const navigation = vi.hoisted(() => ({
  goto: vi.fn(async () => {}),
  invalidate: vi.fn(async () => {}),
  invalidateAll: vi.fn(async () => {}),
}));
vi.mock('$app/navigation', () => navigation);

let container: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let phone = false;

const OPEN_KEY = 'smrt-app-shell:assistant-open:owner-1';

function data(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      authenticated: true,
      user: { id: 'owner-1', email: 'will@example.com', name: 'Will' },
    },
    description: {
      ...draftDescription('live'),
      draft: null,
      frozen: false,
      pendingApprovals: 2,
    } as Description,
    embedded: false,
    onboardingComplete: true,
    ...overrides,
  };
}

beforeEach(() => {
  phone = false;
  vi.resetAllMocks();
  localStorage.clear();
  page.url = new URL('http://localhost/');
  page.route = { id: '/' };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      if (query.includes('prefers-reduced-motion')) return false;
      return /max-width:\s*48rem/.test(query) ? phone : false;
    },
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  // The panel asks the server about the assistant; a quiet answer is enough.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/status')
        ? { configured: true, engine: 'api', engineLabel: 'a test model' }
        : url.includes('/threads')
          ? { threads: [] }
          : { approvals: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  vi.unstubAllGlobals();
  container.remove();
});

async function render(layoutData = data()) {
  component = mount(Layout, {
    target: container,
    props: {
      data: layoutData,
      children: createRawSnippet(() => ({
        render: () => '<p data-testid="content">Home page</p>',
      })),
    } as never,
  });
  for (let i = 0; i < 6; i++) await tick();
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const panel = () => q('[data-testid="admin-shell-panel"]');
const footer = () => q('[data-slot="leftSidebar.footer"]');
const assistantToggle = () =>
  footer()?.querySelector<HTMLButtonElement>(
    'button[aria-label="Assistant"]',
  ) ?? null;
const voiceToggle = () =>
  footer()?.querySelector<HTMLButtonElement>(
    'button[aria-label^="Voice mode"]',
  ) ?? null;
const trigger = () =>
  q<HTMLButtonElement>('.smrt-workspace-account-menu__trigger');
const menuItems = () => [
  ...container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
const follows = (a: Element | null, b: Element | null) =>
  Boolean(
    a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

describe('desktop layout', () => {
  it('shows the left sidebar, then the chat, then the content', async () => {
    await render();
    const left = q('#smrt-admin-shell-left-panel');
    expect(follows(left, panel())).toBe(true);
    expect(follows(panel(), q('#smrt-admin-shell-main'))).toBe(true);
    expect(panel()?.getAttribute('hidden')).toBeNull();
    expect(panel()?.textContent).toContain('Assistant');
    expect(q('#assistant-input')).toBeTruthy();
    expect(q('[data-testid="content"]')).toBeTruthy();
  });

  it('lists only the person’s app in the sidebar', async () => {
    await render();
    const links = [
      ...container.querySelectorAll<HTMLAnchorElement>('.smrt-tenant-nav a'),
    ].map((a) => a.textContent?.trim());
    expect(links).toEqual(['Home', 'Customers']);
    expect(q('.smrt-tenant-nav a[href="/approvals"]')).toBeNull();
    expect(q('.smrt-tenant-nav a[href="/history"]')).toBeNull();
  });

  it('has no floating Assistant button and no bottom-left theme icon', async () => {
    await render();
    expect(q('.dock')).toBeNull();
    expect(q('.toggle')).toBeNull();
    // The only Assistant button is the pressed toggle in the sidebar footer.
    const buttons = [
      ...container.querySelectorAll<HTMLElement>(
        'button[aria-label="Assistant"]',
      ),
    ];
    expect(buttons).toHaveLength(1);
    expect(footer()?.contains(buttons[0])).toBe(true);
    expect(q('button[aria-label="Dark mode"]')).toBeNull();
    expect(document.body.classList.contains('assistant-open')).toBe(false);
  });

  it('puts voice, the assistant toggle and the user menu in the footer, top to bottom', async () => {
    await render();
    expect(voiceToggle()).toBeTruthy();
    expect(assistantToggle()).toBeTruthy();
    expect(follows(voiceToggle(), assistantToggle())).toBe(true);
    expect(follows(assistantToggle(), trigger())).toBe(true);
    expect(footer()?.contains(trigger())).toBe(true);
  });

  it('shows voice as not available instead of an active control', async () => {
    await render();
    const voice = voiceToggle();
    expect(voice?.getAttribute('aria-disabled')).toBe('true');
    expect(voice?.getAttribute('aria-pressed')).toBeNull();
    expect(voice?.title).toBe('Voice mode is not available yet');
    voice?.click();
    await tick();
    expect(voice?.getAttribute('aria-pressed')).toBeNull();
  });

  it('opens and closes the chat from the toggle and remembers it per owner', async () => {
    await render();
    expect(assistantToggle()?.getAttribute('aria-pressed')).toBe('true');
    assistantToggle()?.click();
    await tick();
    await tick();
    expect(assistantToggle()?.getAttribute('aria-pressed')).toBe('false');
    expect(panel()?.getAttribute('hidden')).not.toBeNull();
    expect(localStorage.getItem(OPEN_KEY)).toBe('0');

    // The choice is read back on the next visit.
    unmount(component as never);
    component = undefined;
    container.innerHTML = '';
    await render();
    expect(assistantToggle()?.getAttribute('aria-pressed')).toBe('false');
    expect(panel()?.getAttribute('hidden')).not.toBeNull();

    assistantToggle()?.click();
    await tick();
    await tick();
    expect(panel()?.getAttribute('hidden')).toBeNull();
    expect(localStorage.getItem(OPEN_KEY)).toBe('1');
  });

  it('keeps another owner’s choice apart', async () => {
    localStorage.setItem('smrt-app-shell:assistant-open:someone-else', '0');
    await render();
    expect(panel()?.getAttribute('hidden')).toBeNull();
  });

  it('opens the chat when the welcome steps ask for it', async () => {
    localStorage.setItem(OPEN_KEY, '0');
    await render();
    expect(panel()?.getAttribute('hidden')).not.toBeNull();
    window.dispatchEvent(new CustomEvent('smrt-app-shell:open-assistant'));
    await tick();
    await tick();
    expect(panel()?.getAttribute('hidden')).toBeNull();
  });

  it('has a resizable separator between the chat and the content', async () => {
    await render();
    const separator = q('[role="separator"][aria-label="Resize Assistant"]');
    expect(separator).toBeTruthy();
    expect(separator?.getAttribute('aria-valuenow')).not.toBeNull();
    expect(separator?.getAttribute('tabindex')).toBe('0');
  });
});

const LAYOUT_KEY = 'smrt-app-shell:layout:owner-1';
const collapseToggle = () =>
  q<HTMLButtonElement>('.smrt-admin-shell__edge-toggle--left');
const railFooter = () => q('.smrt-admin-shell__tenant-rail-footer');
const flush = async () => {
  for (let i = 0; i < 4; i++) await tick();
};

describe('the sidebar collapse control', () => {
  it('is present and starts expanded', async () => {
    await render();
    const toggle = collapseToggle();
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(q('.smrt-admin-shell')?.getAttribute('data-left-state')).toBe(
      'expanded',
    );
    expect(q('.smrt-tenant-nav a[href="/"]')?.textContent).toContain('Home');
  });

  it('collapses to an icon rail: nav icons with tooltips and the footer controls', async () => {
    await render();
    collapseToggle()?.click();
    await flush();
    expect(q('.smrt-admin-shell')?.getAttribute('data-left-state')).toBe(
      'collapsed',
    );
    expect(collapseToggle()?.getAttribute('aria-label')).toBe('Expand sidebar');
    // Nav items stay as links; the label becomes the tooltip.
    const home = q<HTMLAnchorElement>('.smrt-tenant-nav a[href="/"]');
    expect(home?.getAttribute('title')).toBe('Home');
    expect(q('.smrt-tenant-nav--collapsed')).toBeTruthy();
    expect(home?.querySelector('svg')).toBeTruthy();
    // Voice, the assistant toggle and the user menu stay, as icons.
    const rail = railFooter();
    expect(rail).toBeTruthy();
    const voice = rail?.querySelector<HTMLElement>(
      'button[aria-label^="Voice mode"]',
    );
    const assistant = rail?.querySelector<HTMLElement>(
      'button[aria-label="Assistant"]',
    );
    expect(voice).toBeTruthy();
    expect(assistant?.getAttribute('aria-pressed')).toBe('true');
    expect(follows(voice ?? null, assistant ?? null)).toBe(true);
    expect(follows(assistant ?? null, trigger())).toBe(true);
    expect(rail?.contains(trigger())).toBe(true);
  });

  it('keeps the assistant toggle, the chat and the user menu working while collapsed', async () => {
    await render();
    collapseToggle()?.click();
    await flush();
    const toggle = () =>
      railFooter()?.querySelector<HTMLButtonElement>(
        'button[aria-label="Assistant"]',
      );
    toggle()?.click();
    await flush();
    expect(panel()?.getAttribute('hidden')).not.toBeNull();
    toggle()?.click();
    await flush();
    expect(panel()?.getAttribute('hidden')).toBeNull();
    expect(q('[role="separator"][aria-label="Resize Assistant"]')).toBeTruthy();

    trigger()?.click();
    await tick();
    expect(menuItems().map((el) => el.textContent?.trim())).toContain(
      'Approvals2',
    );
    expect(q('[data-smrt-part="trigger-badge"]')?.textContent).toBe('2');
  });

  it('expands again and remembers the choice per owner', async () => {
    await render();
    collapseToggle()?.click();
    await flush();
    expect(
      JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').panels?.left,
    ).toBe('collapsed');

    unmount(component as never);
    component = undefined;
    container.innerHTML = '';
    await render();
    await flush();
    expect(q('.smrt-admin-shell')?.getAttribute('data-left-state')).toBe(
      'collapsed',
    );

    collapseToggle()?.click();
    await flush();
    expect(q('.smrt-admin-shell')?.getAttribute('data-left-state')).toBe(
      'expanded',
    );
    expect(
      JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').panels?.left,
    ).toBe('expanded');
  });

  it('does not leak the collapsed state to another owner', async () => {
    localStorage.setItem(
      'smrt-app-shell:layout:someone-else',
      JSON.stringify({ panels: { left: 'collapsed' } }),
    );
    await render();
    await flush();
    expect(q('.smrt-admin-shell')?.getAttribute('data-left-state')).toBe(
      'expanded',
    );
  });

  it('is also there in a plugin view', async () => {
    await render(data({ embedded: true }));
    expect(collapseToggle()).toBeTruthy();
  });
});

describe('the sidebar footer line', () => {
  // jsdom applies no component CSS, so the opt-out is asserted as the shell's
  // switch (smrt-svelte turns it into the removed hairline).
  it('is switched off, expanded and collapsed', async () => {
    await render();
    const shell = () => q('.smrt-admin-shell');
    expect(shell()?.getAttribute('data-footer-divider')).toBe('off');
    collapseToggle()?.click();
    await flush();
    expect(shell()?.getAttribute('data-footer-divider')).toBe('off');
  });
});

describe('the chat width', () => {
  const separator = () =>
    q<HTMLElement>('[role="separator"][aria-label="Resize Assistant"]');

  it('is resized from the keyboard and remembered per owner', async () => {
    await render();
    const before = Number(separator()?.getAttribute('aria-valuenow'));
    separator()?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await tick();
    const after = Number(separator()?.getAttribute('aria-valuenow'));
    expect(after).toBe(before + 16);
    const stored = JSON.parse(
      localStorage.getItem('smrt-app-shell:layout:owner-1') ?? '{}',
    );
    expect(stored.sizes?.panel).toBe(after);

    unmount(component as never);
    component = undefined;
    container.innerHTML = '';
    await render();
    for (let i = 0; i < 4; i++) await tick();
    expect(Number(separator()?.getAttribute('aria-valuenow'))).toBe(after);
  });

  it('does not leak to another owner', async () => {
    localStorage.setItem(
      'smrt-app-shell:layout:someone-else',
      JSON.stringify({ sizes: { panel: 700 } }),
    );
    await render();
    for (let i = 0; i < 4; i++) await tick();
    expect(Number(separator()?.getAttribute('aria-valuenow'))).not.toBe(700);
  });
});

describe('the user menu', () => {
  it('shows the Approvals count on the closed trigger', async () => {
    await render();
    expect(q('[data-smrt-part="trigger-badge"]')?.textContent).toBe('2');
    expect(trigger()?.textContent).toContain('2 waiting');
  });

  it('shows no count when nothing is waiting', async () => {
    await render(
      data({
        description: { name: 'My app', models: {}, pendingApprovals: 0 },
      }),
    );
    expect(q('[data-smrt-part="trigger-badge"]')).toBeNull();
  });

  it('lists Approvals, History, Theme, Settings, then Sign out', async () => {
    await render();
    trigger()?.click();
    await tick();
    expect(
      menuItems().map((el) => el.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'Approvals2',
      'History',
      'Theme: Light',
      'Settings',
      'Sign out',
    ]);
    expect(menuItems()[0]?.getAttribute('href')).toBe('/approvals');
    expect(menuItems()[1]?.getAttribute('href')).toBe('/history');
    expect(menuItems()[3]?.getAttribute('href')).toBe('/settings');
  });

  it('opens upward from the footer', async () => {
    await render();
    trigger()?.click();
    await tick();
    expect(q('.smrt-workspace-account-menu__popover--top-start')).toBeTruthy();
  });
});

describe('plugin mode', () => {
  it('has no chat, no assistant toggle and no voice toggle', async () => {
    await render(data({ embedded: true }));
    expect(panel()).toBeNull();
    expect(assistantToggle()).toBeNull();
    expect(voiceToggle()).toBeNull();
    expect(q('#assistant-input')).toBeNull();
    expect(q('[role="separator"]')).toBeNull();
  });

  it('keeps the sidebar and the content', async () => {
    await render(data({ embedded: true }));
    expect(q('#smrt-admin-shell-left-panel')).toBeTruthy();
    expect(q('.smrt-tenant-nav a[href="/"]')).toBeTruthy();
    expect(q('[data-testid="content"]')).toBeTruthy();
    expect(trigger()).toBeTruthy();
  });
});

describe('phone width', () => {
  beforeEach(() => {
    phone = true;
  });

  it('starts on the content with the chat one tab away', async () => {
    await render();
    const tab = q<HTMLElement>(
      '[data-testid="phone-bottom-bar"] [data-item="panel"]',
    );
    expect(tab).toBeTruthy();
    expect(tab?.getAttribute('aria-expanded')).toBe('false');
    expect(q('#smrt-admin-shell-main')?.inert).toBe(false);
    expect(q('[role="separator"]')).toBeNull();
  });

  it('switches to the chat as a full-screen view and back', async () => {
    await render();
    const tab = () =>
      q<HTMLElement>('[data-testid="phone-bottom-bar"] [data-item="panel"]');
    tab()?.click();
    await tick();
    await tick();
    expect(panel()?.getAttribute('hidden')).toBeNull();
    expect(q('#smrt-admin-shell-main')?.inert).toBe(true);
    expect(tab()?.getAttribute('aria-expanded')).toBe('true');
    tab()?.click();
    await tick();
    expect(panel()?.getAttribute('hidden')).not.toBeNull();
    expect(q('#smrt-admin-shell-main')?.inert).toBe(false);
  });

  it('keeps the user menu reachable with the Approvals count', async () => {
    await render();
    expect(q('.smrt-workspace-account-menu[data-compact]')).toBeTruthy();
    expect(q('[data-smrt-part="trigger-badge"]')?.textContent).toBe('2');
    trigger()?.click();
    await tick();
    expect(menuItems().length).toBe(5);
  });

  it('has no chat tab in a plugin', async () => {
    await render(data({ embedded: true }));
    expect(q('[data-item="panel"]')).toBeNull();
  });
});

describe('draft controls in the content column', () => {
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    );
  const draftData = (mode: 'live' | 'draft' = 'draft') =>
    data({
      description: draftDescription(mode),
      liveDescription: draftDescription('live'),
    });

  it('offers a quiet Start draft within content when no draft is open', async () => {
    await render();
    expect(button('Start draft')).toBeTruthy();
    expect(
      q('#smrt-admin-shell-main')?.contains(button('Start draft') ?? null),
    ).toBe(true);
    expect(q('.smrt-draft-bar__draft-strip')).toBeNull();
  });

  it('starts a draft and explicitly saves the draft view', async () => {
    await render();
    button('Start draft')?.click();
    await vi.waitFor(() => expect(navigation.invalidateAll).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/draft?target=live',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/draft/view?target=live',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ view: 'draft' }),
      }),
    );
  });

  it('shows the switch, count, actions, warning, sidebar new marker and chat badge', async () => {
    await render(draftData());
    expect(button('Draft')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('Live')?.getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-testid="draft-header"]')?.textContent).toContain(
      '2 changes, not published',
    );
    expect(button('Discard')).toBeTruthy();
    expect(q('a[href="/draft/review"]')?.textContent).toContain(
      'Review and publish',
    );
    expect(q('.smrt-draft-bar__draft-strip')?.textContent).toBe(
      'Draft: a test copy. Records you add here are thrown away when you publish.',
    );
    expect(q('.smrt-tenant-nav a[href="/m/Order"] small')?.textContent).toBe(
      'new',
    );
    expect(q('.smrt-tenant-nav a[href="/m/Customer"] small')).toBeNull();
    expect(panel()?.textContent).toContain('Building in draft');
  });

  it('keeps live navigation and hides the strip in Live view while building in draft', async () => {
    await render(draftData('live'));
    expect(button('Live')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('.smrt-draft-bar__draft-strip')).toBeNull();
    expect(q('.smrt-tenant-nav a[href="/m/Order"]')).toBeNull();
    expect(panel()?.textContent).toContain('Building in draft');
  });

  it('persists switching copies and sends the new target on subsequent data loads', async () => {
    const state = layoutState(draftData());
    const fetcher = vi.mocked(fetch);
    fetcher.mockImplementation(async (path, init) => {
      if (String(path).includes('/draft/view')) {
        expect(JSON.parse(String(init?.body))).toEqual({ view: 'live' });
        return new Response(JSON.stringify({ view: 'live' }));
      }
      return new Response(
        JSON.stringify({ records: [], threads: [], approvals: [] }),
      );
    });
    navigation.invalidateAll.mockImplementation(async () => {
      state.description = draftDescription('live');
      await loadRecords(fetch, 'Customer', 500, state.description.mode);
    });
    await render(state);
    button('Live')?.click();
    await vi.waitFor(() =>
      expect(button('Live')?.getAttribute('aria-pressed')).toBe('true'),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/draft/view?target=live',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/records/Customer?limit=500&target=live',
      expect.anything(),
    );
    expect(q('.smrt-draft-bar__draft-strip')).toBeNull();
  });

  it('preserves the viewed copy if saving the view fails', async () => {
    await render(draftData());
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'View could not be saved' }), {
        status: 409,
      }),
    );
    button('Live')?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('View could not be saved'),
    );
    expect(button('Draft')?.getAttribute('aria-pressed')).toBe('true');
    expect(navigation.invalidateAll).not.toHaveBeenCalled();
  });

  it('confirms discard and sends the specific draft id', async () => {
    await render(draftData());
    button('Discard')?.click();
    await flush();
    expect(container.querySelector('dialog[open]')?.textContent).toContain(
      'Your live app stays unchanged',
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/discard'),
      expect.anything(),
    );
    button('Discard draft')?.click();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/shell/draft/discard?target=live',
        expect.objectContaining({
          body: JSON.stringify({ draftId: draftInfo.id }),
        }),
      ),
    );
  });

  it('explains an unpublishable draft and keeps Discard available', async () => {
    const desc = draftDescription('live');
    desc.draft = {
      ...draftInfo,
      publishable: false,
      problem: 'The data folder moved.',
    };
    await render(data({ description: desc }));
    expect(container.textContent).toContain(
      'This draft cannot be published. The data folder moved.',
    );
    expect(button('Draft')?.disabled).toBe(true);
    expect(button('Discard')?.disabled).toBe(false);
    const review = [...container.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'Review and publish',
    );
    expect(review?.getAttribute('aria-disabled')).toBe('true');
    expect(review?.getAttribute('href')).toBeNull();
  });

  it('keeps the switch, actions and warning inside content at phone width', async () => {
    phone = true;
    await render(draftData());
    const main = q('#smrt-admin-shell-main');
    expect(main?.contains(q('[role="group"][aria-label="View copy"]'))).toBe(
      true,
    );
    expect(main?.contains(q('.smrt-draft-bar__draft-actions'))).toBe(true);
    expect(main?.contains(q('.smrt-draft-bar__draft-strip'))).toBe(true);
  });

  it.each([
    'started',
    'published',
    'discarded',
    'unpublishable',
  ] as const)('refreshes the bar on draft %s without a reload', async (status) => {
    class Source extends EventTarget {
      static latest: Source;
      constructor() {
        super();
        Source.latest = this;
      }
      close() {}
    }
    vi.stubGlobal('EventSource', Source);
    const state = layoutState(status === 'started' ? data() : draftData());
    navigation.invalidate.mockImplementation(async () => {
      state.description =
        status === 'published' || status === 'discarded'
          ? { ...draftDescription('live'), draft: null }
          : {
              ...draftDescription('live'),
              draft: {
                ...draftInfo,
                publishable: status !== 'unpublishable',
                problem:
                  status === 'unpublishable' ? 'The data folder moved.' : null,
              },
            };
    });
    await render(state);
    Source.latest.dispatchEvent(
      new MessageEvent('shell', {
        data: JSON.stringify({
          type: 'draft',
          status,
          id: draftInfo.id,
          name: draftInfo.name,
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(navigation.invalidate).toHaveBeenCalledWith('smrt:shell'),
    );
    await flush();
    if (status === 'published' || status === 'discarded')
      expect(button('Start draft')).toBeTruthy();
    else expect(button('Discard')).toBeTruthy();
    if (status === 'unpublishable')
      expect(container.textContent).toContain('The data folder moved.');
  });

  it('ignores record events from the other copy', async () => {
    class Source extends EventTarget {
      static latest: Source;
      constructor() {
        super();
        Source.latest = this;
      }
      close() {}
    }
    vi.stubGlobal('EventSource', Source);
    await render(draftData());
    Source.latest.dispatchEvent(
      new MessageEvent('shell', {
        data: JSON.stringify({
          type: 'records',
          target: 'live',
          model: 'Customer',
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(navigation.invalidate).not.toHaveBeenCalled();
    Source.latest.dispatchEvent(
      new MessageEvent('shell', {
        data: JSON.stringify({
          type: 'records',
          target: 'draft',
          model: 'Customer',
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(navigation.invalidate).toHaveBeenCalledWith('smrt:records'),
    );
  });
});

describe('onboarding chat visibility', () => {
  it.each([
    '/welcome',
    '/settings/assistant',
  ])('hides the chat while onboarding is unfinished on %s', async (path) => {
    page.url = new URL(path, 'http://localhost');
    await render(data({ onboardingComplete: false }));
    expect(panel()).toBeNull();
    expect(q('#assistant-input')).toBeNull();
    expect(container.textContent).not.toContain('The assistant is off');
    expect(q('[data-testid="content"]')).toBeTruthy();
  });
  it('keeps a revisited welcome page free of chat after onboarding', async () => {
    page.url = new URL('http://localhost/welcome');
    await render();
    expect(panel()).toBeNull();
  });
});

describe('draft bar routes', () => {
  it.each([
    '/welcome',
    '/settings',
    '/settings/assistant',
    '/settings/inference',
    '/settings/appearance',
    '/approvals',
  ])('hides draft controls on %s', async (path) => {
    page.url = new URL(path, 'http://localhost');
    await render();
    expect(container.textContent).not.toContain('Start draft');
    expect(q('[data-testid="draft-header"]')).toBeNull();
  });
  it.each([
    '/',
    '/m/Customer',
    '/m/Customer/new',
    '/m/Customer/record-1',
    '/history',
    '/draft/review',
  ])('shows draft controls on %s', async (path) => {
    page.url = new URL(path, 'http://localhost');
    await render();
    expect(container.textContent).toContain('Start draft');
  });
});

it('starts the phone drawer closed despite a remembered expanded desktop sidebar and shows the app name', async () => {
  phone = true;
  localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({ panels: { left: 'expanded' } }),
  );
  await render();
  const drawer = q<HTMLElement>('#smrt-admin-shell-left-panel');
  expect(drawer?.getAttribute('data-state')).toBe('collapsed');
  expect(drawer?.inert).toBe(true);
  expect(q('[data-slot="header.start"]')?.textContent).toContain('My app');
  q<HTMLButtonElement>('button[aria-label="Menu"]')?.click();
  await flush();
  expect(drawer?.getAttribute('data-state')).toBe('expanded');
  expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').panels.left).toBe(
    'expanded',
  );
});
