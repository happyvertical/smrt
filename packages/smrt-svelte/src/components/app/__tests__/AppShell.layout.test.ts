import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { cleanup, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import type {
  ShellNavGroup,
  ShellNavItem,
} from '../../workspace/admin-shell/types.js';
import Harness from './shell-layout-harness.svelte';

const nav: ShellNavItem[] = [{ href: '/', label: 'Home' }];
const navGroups: ShellNavGroup[] = [
  {
    heading: 'Content',
    items: [
      { href: '/posts', label: 'Posts' },
      { href: '/pages', label: 'Pages' },
    ],
  },
  {
    heading: 'People',
    items: [
      { href: '/users', label: 'Users' },
      { href: '/roles', label: 'Roles' },
    ],
  },
];
const config = { left: { initial: 'expanded' } } as const;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The shell's own navigation (the editor's preview is a separate, inert one). */
function shellLinks(): string[] {
  const navElement = document.querySelector(
    'nav[aria-label="Application navigation"]',
  );
  return [...(navElement?.querySelectorAll('a') ?? [])].map(
    (a) => a.getAttribute('href') ?? '',
  );
}
function previewLinks(): string[] {
  const frame = document.querySelector('[aria-label="Navigation preview"]');
  return [...(frame?.querySelectorAll('a') ?? [])].map(
    (a) => a.getAttribute('href') ?? '',
  );
}
function shellHeadings(): string[] {
  const navElement = document.querySelector(
    'nav[aria-label="Application navigation"]',
  );
  return [...(navElement?.querySelectorAll('summary') ?? [])].map(
    (s) => s.textContent?.trim() ?? '',
  );
}
const live = () =>
  Array.from(document.querySelectorAll('[aria-live]'))
    .map((e) => e.textContent?.trim())
    .filter(Boolean)
    .join(' | ');

function mountShell(props: Record<string, unknown> = {}): {
  changes: ShellLayout[];
  api: () => ShellLayoutController;
} {
  const changes: ShellLayout[] = [];
  let api: ShellLayoutController | undefined;
  render(Harness, {
    props: {
      nav,
      navGroups,
      config,
      onChange: (next: ShellLayout) => changes.push(next),
      onApi: (value: ShellLayoutController) => {
        api = value;
      },
      ...props,
    },
  });
  return { changes, api: () => api as ShellLayoutController };
}

describe('AppShell layout', () => {
  it('shows the host navigation by default', async () => {
    mountShell();
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual([
        '/',
        '/posts',
        '/pages',
        '/users',
        '/roles',
      ]),
    );
    expect(shellHeadings()).toEqual(['Content', 'People']);
  });

  it('applies a host-owned layout over the navigation', async () => {
    mountShell({
      initial: {
        version: 1,
        sectionOrder: ['People', 'Content'],
        itemOrder: { Content: ['/pages', '/posts'] },
        hidden: ['/roles'],
        moved: { '/home-gone': 'Content', '/users': 'Content' },
      },
    });
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual(['/', '/pages', '/posts', '/users']),
    );
    // People kept /roles hidden and gave /users away: left with nothing.
    expect(shellHeadings()).toEqual(['Content']);
  });

  it('hides an item from the editor, reporting a layout for the host to store', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell();
    await user.click(
      screen.getByRole('button', { name: 'Show Pages in navigation' }),
    );
    expect(changes.at(-1)).toEqual({ version: 1, hidden: ['/pages'] });
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual(['/', '/posts', '/users', '/roles']),
    );
    expect(previewLinks()).toEqual(['/', '/posts', '/users', '/roles']);
  });

  it('hides and shows a whole section', async () => {
    const user = userEvent.setup();
    mountShell();
    await user.click(
      screen.getByRole('button', { name: 'Show People in navigation' }),
    );
    await vi.waitFor(() => expect(shellHeadings()).toEqual(['Content']));
    await user.click(
      screen.getByRole('button', { name: 'Show People in navigation' }),
    );
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['Content', 'People']),
    );
  });

  it('reorders an item with the keyboard', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell();
    screen.getByRole('button', { name: 'Move Posts' }).focus();
    await user.keyboard(' {ArrowDown}');
    expect(live()).toContain('Posts, position 2 of 2 in Content.');
    await user.keyboard('{Enter}');
    expect(changes.at(-1)).toEqual({
      version: 1,
      itemOrder: { Content: ['/pages', '/posts'] },
    });
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual([
        '/',
        '/pages',
        '/posts',
        '/users',
        '/roles',
      ]),
    );
  });

  it('moves an item to another section with the keyboard', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell();
    screen.getByRole('button', { name: 'Move Pages' }).focus();
    await user.keyboard(' {ArrowDown}{Enter}');
    expect(changes.at(-1)).toEqual({
      version: 1,
      moved: { '/pages': 'People' },
      itemOrder: { People: ['/pages', '/users', '/roles'] },
    });
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual([
        '/',
        '/posts',
        '/pages',
        '/users',
        '/roles',
      ]),
    );
  });

  it('moves an item into the top level', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell();
    screen.getByRole('button', { name: 'Move Posts' }).focus();
    await user.keyboard(' {ArrowUp}{Enter}');
    expect(changes.at(-1)).toMatchObject({ moved: { '/posts': '@root' } });
    await vi.waitFor(() =>
      expect(shellLinks().slice(0, 2)).toEqual(['/', '/posts']),
    );
  });

  it('reorders sections with the keyboard', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell();
    screen.getByRole('button', { name: 'Move People' }).focus();
    await user.keyboard(' {ArrowUp}{Enter}');
    expect(changes.at(-1)).toEqual({
      version: 1,
      sectionOrder: ['People', 'Content'],
    });
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['People', 'Content']),
    );
  });

  it('toggles panel visibility and start state, and hides the panel live', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell({ editor: true });
    const left = document.querySelector('[data-edge="left"]') as HTMLElement;
    expect(left).toBeTruthy();
    await vi.waitFor(() =>
      expect(
        document.querySelector('#smrt-admin-shell-left-panel'),
      ).not.toBeNull(),
    );
    await user.click(
      screen.getByRole('switch', { name: 'Start Left sidebar panel expanded' }),
    );
    expect(changes.at(-1)).toEqual({
      version: 1,
      panels: { left: { initial: 'collapsed' } },
    });
    await user.click(
      screen.getByRole('switch', { name: 'Show Left sidebar panel' }),
    );
    expect(changes.at(-1)).toEqual({
      version: 1,
      panels: { left: { initial: 'collapsed', visible: false } },
    });
    await vi.waitFor(() => expect(shellLinks()).toEqual([]));
    expect(
      screen
        .getByRole('switch', { name: 'Start Left sidebar panel expanded' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  const leftState = () =>
    document
      .querySelector('.smrt-admin-shell__edge--left')
      ?.getAttribute('data-state');

  it('applies an edited starting state to the live panel', async () => {
    const user = userEvent.setup();
    mountShell({ edgeToggles: true });
    await vi.waitFor(() => expect(leftState()).toBe('expanded'));
    await user.click(
      screen.getByRole('switch', { name: 'Start Left sidebar panel expanded' }),
    );
    await vi.waitFor(() => expect(leftState()).toBe('collapsed'));
  });

  it('leaves the panel alone when a controlling host ignores the edit', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell({ mode: 'frozen' });
    await vi.waitFor(() => expect(leftState()).toBe('expanded'));
    await user.click(
      screen.getByRole('switch', { name: 'Start Left sidebar panel expanded' }),
    );
    expect(changes).toHaveLength(1);
    expect(leftState()).toBe('expanded');
  });

  it('keeps a stored open/closed toggle when a layout with a start state loads', async () => {
    localStorage.setItem(
      'layout-test',
      JSON.stringify({
        panels: { left: 'collapsed' },
        layout: { version: 1, panels: { left: { initial: 'expanded' } } },
      }),
    );
    mountShell({ mode: 'default', editor: false, edgeToggles: true });
    await vi.waitFor(() => expect(leftState()).toBe('collapsed'));
  });

  it('resets to defaults', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell({
      initial: {
        version: 1,
        hidden: ['/posts'],
        sectionOrder: ['People', 'Content'],
      },
    });
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['People', 'Content']),
    );
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(changes.at(-1)).toEqual({ version: 1 });
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual([
        '/',
        '/posts',
        '/pages',
        '/users',
        '/roles',
      ]),
    );
    expect(
      screen
        .getByRole('button', { name: 'Reset to defaults' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('keeps the edit in memory when the host passes only onlayoutchange', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell({ mode: 'callback' });
    await user.click(
      screen.getByRole('button', { name: 'Show Pages in navigation' }),
    );
    expect(changes).toHaveLength(1);
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual(['/', '/posts', '/users', '/roles']),
    );
  });

  it('stores the layout in the user settings when the host passes neither prop', async () => {
    const user = userEvent.setup();
    const first = mountShell({ mode: 'default' });
    await user.click(
      screen.getByRole('button', { name: 'Show Pages in navigation' }),
    );
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual(['/', '/posts', '/users', '/roles']),
    );
    expect(first.changes).toHaveLength(0);
    await vi.waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem('layout-test') ?? '{}').layout,
      ).toEqual({
        version: 1,
        hidden: ['/pages'],
      }),
    );
    cleanup();
    // A new session reads it back through the settings adapter.
    mountShell({ mode: 'default', editor: false });
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual(['/', '/posts', '/users', '/roles']),
    );
  });

  it('does not store the layout in settings when the host owns it', async () => {
    const user = userEvent.setup();
    mountShell();
    await user.click(
      screen.getByRole('button', { name: 'Show Pages in navigation' }),
    );
    await vi.waitFor(() => expect(shellLinks()).not.toContain('/pages'));
    expect(
      JSON.parse(localStorage.getItem('layout-test') ?? '{}').layout,
    ).toBeUndefined();
  });

  it('ignores ids the host no longer has', async () => {
    mountShell({
      initial: {
        version: 1,
        hidden: ['/gone', 'Vanished'],
        moved: { '/gone': 'Content', '/posts': 'Nowhere' },
        sectionOrder: ['Nope'],
        itemOrder: { Content: ['/gone'] },
      },
    });
    await vi.waitFor(() =>
      expect(shellLinks()).toEqual([
        '/',
        '/posts',
        '/pages',
        '/users',
        '/roles',
      ]),
    );
  });

  it('renders an axe-clean editor', async () => {
    render(Harness, { props: { nav, navGroups, config } });
    await vi.waitFor(() => expect(shellLinks().length).toBeGreaterThan(0));
    const editor = document.querySelector('.smrt-shell-layout-editor');
    expect(editor).not.toBeNull();
    await expectNoA11yViolations(editor as HTMLElement);
  });
});

describe('app-owned sections', () => {
  const nameInput = (label: string) =>
    screen.getByRole('textbox', { name: `Name of section ${label}` });

  it('renames a section inline and updates the nav', async () => {
    const user = userEvent.setup();
    const { changes } = mountShell();
    const input = nameInput('Content');
    await user.clear(input);
    await user.type(input, 'Stuff');
    await user.tab();
    expect(changes.at(-1)).toEqual({
      version: 1,
      sections: { Content: { label: 'Stuff' } },
    });
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['Stuff', 'People']),
    );
  });

  it('snaps a blanked name back to the suggested heading', async () => {
    const user = userEvent.setup();
    mountShell({
      initial: { version: 1, sections: { Content: { label: 'Stuff' } } },
    });
    const input = nameInput('Stuff');
    await user.clear(input);
    await user.tab();
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['Content', 'People']),
    );
    expect((nameInput('Content') as HTMLInputElement).value).toBe('Content');
  });

  it('hides a title and keeps an accessible group name', async () => {
    const user = userEvent.setup();
    mountShell();
    await user.click(
      screen.getByRole('button', { name: 'Show title of People' }),
    );
    await vi.waitFor(() => expect(shellHeadings()).toEqual(['Content']));
    const navElement = document.querySelector(
      'nav[aria-label="Application navigation"]',
    );
    const flat = navElement?.querySelector(
      '[role="group"][aria-label="People"]',
    );
    expect(flat?.querySelectorAll('a')).toHaveLength(2);
    expect(shellLinks()).toContain('/users');
  });

  it('creates a section, moves an item in, and deletes it with confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { changes } = mountShell();
    await user.click(screen.getByRole('button', { name: 'New section' }));
    const created = changes.at(-1)?.customSections?.[0];
    expect(created).toEqual({ id: 'custom:new-section', label: 'New section' });
    // Empty custom sections are editable but not in the nav.
    expect(shellHeadings()).toEqual(['Content', 'People']);

    screen.getByRole('button', { name: 'Move Roles' }).focus();
    await user.keyboard(' {ArrowDown}{Enter}');
    expect(changes.at(-1)?.moved).toEqual({ '/roles': 'custom:new-section' });
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['Content', 'People', 'New section']),
    );

    await user.click(
      screen.getByRole('button', { name: 'Delete section New section' }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(changes.at(-1)).toEqual({ version: 1 });
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['Content', 'People']),
    );
    expect(shellLinks()).toContain('/roles');
  });

  it('keeps a non-empty section when the confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', () => false);
    const { changes } = mountShell({
      initial: {
        version: 1,
        customSections: [{ id: 'custom:a', label: 'A' }],
        moved: { '/posts': 'custom:a' },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Delete section A' }));
    expect(changes).toHaveLength(0);
  });

  it('deletes an empty section without asking', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const { changes } = mountShell({
      initial: { version: 1, customSections: [{ id: 'custom:a', label: 'A' }] },
    });
    await user.click(screen.getByRole('button', { name: 'Delete section A' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(changes.at(-1)).toEqual({ version: 1 });
  });

  it('exposes the same changes through the layout API', async () => {
    const { api } = mountShell({ editor: false });
    await vi.waitFor(() => expect(shellLinks().length).toBeGreaterThan(0));
    expect(api().createSection('  ')).toBeNull();
    expect(api().createSection('Pinned')).toBe('custom:pinned');
    await vi.waitFor(() =>
      expect(api().sections.map((section) => section.id)).toContain(
        'custom:pinned',
      ),
    );
    expect(api().renameSection('Content', 'Stuff')).toBe(true);
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['Stuff', 'People']),
    );
    expect(api().renameSection('Content', 'Stuff')).toBe(false);
    expect(api().renameItem('/users', 'Members')).toBe(true);
    await vi.waitFor(() =>
      expect(
        [
          ...document.querySelectorAll(
            'nav[aria-label="Application navigation"] a',
          ),
        ].map((link) => link.textContent?.trim()),
      ).toContain('Members'),
    );
    expect(api().renameItem('/users', 'Members')).toBe(false);
    expect(api().renameItem('/nope', 'X')).toBe(false);
    expect(api().renameItem('/users', null)).toBe(true);
    expect(api().setSectionTitleVisible('custom:pinned', false)).toBe(true);
    await vi.waitFor(() =>
      expect(api().sections.at(-1)?.titleVisible).toBe(false),
    );
    expect(api().moveItem('/posts', 'custom:pinned')).toBe(true);
    await vi.waitFor(() =>
      expect(
        document.querySelector('nav [role="group"][aria-label="Pinned"]'),
      ).not.toBeNull(),
    );
    expect(api().deleteSection('People')).toBe(false);
    expect(api().deleteSection('custom:pinned')).toBe(true);
    await vi.waitFor(() => expect(shellLinks()).toContain('/posts'));
  });

  it('renders an axe-clean editor with custom sections', async () => {
    mountShell({
      initial: {
        version: 1,
        customSections: [{ id: 'custom:a', label: 'A' }],
        moved: { '/posts': 'custom:a' },
      },
    });
    await expectNoA11yViolations(
      document.querySelector('.smrt-shell-layout-editor') as HTMLElement,
    );
  });
});

describe('layout API', () => {
  it('makes the same changes the editor makes and reports no-ops', async () => {
    const { changes, api } = mountShell({ editor: false });
    await vi.waitFor(() => expect(shellLinks().length).toBeGreaterThan(0));
    expect(api().moveSection('People', 0)).toBe(true);
    await vi.waitFor(() =>
      expect(shellHeadings()).toEqual(['People', 'Content']),
    );
    expect(api().moveSection('People', 0)).toBe(false);
    expect(api().moveItem('/users', 'Content', 0)).toBe(true);
    expect(api().moveItem('/nope', 'Content')).toBe(false);
    expect(api().hide('/posts')).toBe(true);
    expect(api().hide('/posts')).toBe(false);
    expect(api().isHidden('/posts')).toBe(true);
    await vi.waitFor(() => expect(shellLinks()).not.toContain('/posts'));
    expect(api().show('/posts')).toBe(true);
    expect(api().show('/posts')).toBe(false);
    expect(api().setPanel('left', { visible: false })).toBe(true);
    expect(api().panels.find((p) => p.edge === 'left')?.visible).toBe(false);
    expect(api().setPanel('left', { visible: false })).toBe(false);
    expect(api().customized).toBe(true);
    expect(api().reset()).toBe(true);
    expect(api().reset()).toBe(false);
    expect(api().customized).toBe(false);
    expect(changes.length).toBeGreaterThan(5);
  });

  it('cannot bring back a panel the host removed', async () => {
    const { api } = mountShell({
      editor: false,
      config: { right: false },
    });
    await vi.waitFor(() => expect(api()).toBeTruthy());
    expect(api().panels.find((p) => p.edge === 'right')).toMatchObject({
      available: false,
      visible: false,
    });
    expect(api().setPanel('right', { visible: true })).toBe(false);
    expect(api().setPanel('right', { initial: 'expanded' })).toBe(false);
  });

  it('reads and edits a layout passed as null (no customization yet)', async () => {
    const { api } = mountShell({ editor: false, initial: null });
    await vi.waitFor(() => expect(api()).toBeTruthy());
    expect(api().layout).toEqual({ version: 1 });
    expect(api().sections.map((s) => s.id)).toEqual([
      '@root',
      'Content',
      'People',
    ]);
  });
});
