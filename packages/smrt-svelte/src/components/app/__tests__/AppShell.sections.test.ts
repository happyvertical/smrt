import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { cleanup, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import Harness from './shell-sections-harness.svelte';

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

function mount(props: Record<string, unknown> = {}) {
  const changes: ShellLayout[] = [];
  let api: ShellLayoutController | undefined;
  render(Harness, {
    ...props,
    onChange: (layout: ShellLayout) => changes.push(layout),
    onApi: (a: ShellLayoutController) => {
      api = a;
    },
  });
  return { changes, api: () => api as ShellLayoutController };
}

const sidebar = () =>
  screen.getByRole('navigation', { name: 'Application navigation' });
const menu = () => screen.getByRole('list', { name: 'Content entries' });
const edit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Edit layout' }));

describe('section menu cards', () => {
  it('renders a grid of single-link cards with description, meta and a separate action', async () => {
    mount({ cards: true });
    const cards = within(menu()).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    const first = cards[0];
    const links = within(first).getAllByRole('link');
    // The title link, plus the separate New action (never nested).
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/posts',
      '/new',
    ]);
    expect(links[0].contains(links[1])).toBe(false);
    expect(first.textContent).toContain('Everything you publish.');
    expect(within(first).getByTestId('meta-posts')).toBeTruthy();
    expect(
      first.querySelector('.smrt-section-menu__card-icon svg'),
    ).not.toBeNull();
    await expectNoA11yViolations(menu());
  });

  it('keeps the edit chrome in cards mode', async () => {
    const user = userEvent.setup();
    mount({ cards: true });
    await edit(user);
    expect(
      screen.getAllByRole('button', { name: /^Move /i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /Rename/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /^Show /i }).length,
    ).toBeGreaterThan(0);
  });
});

describe('section menu row icons', () => {
  it('draws an entry icon on rows that have one, decoratively', () => {
    mount();
    const rows = within(menu()).getAllByRole('listitem');
    const icon = rows[0].querySelector('.smrt-shell-section-icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('svg')).not.toBeNull();
    expect(rows[1].querySelector('.smrt-shell-section-icon')).toBeNull();
  });
});

describe('navMode sections (sidebar)', () => {
  it('lists only sections, one link each, with no entries', () => {
    mount();
    const nav = within(sidebar());
    const links = nav.getAllByRole('link');
    expect(links.map((l) => l.textContent?.trim())).toEqual([
      'Content',
      'People',
    ]);
    expect(links[0].getAttribute('href')).toBe('/s/content');
    // sectionHref supplies the page for a group without an href.
    expect(links[1].getAttribute('href')).toBe('/s/people');
    expect(nav.queryByText('Posts')).toBeNull();
    expect(links[0].querySelector('svg')).not.toBeNull();
  });

  it('marks the section current on its page and on an entry page', () => {
    mount({ currentHref: '/s/content' });
    expect(
      within(sidebar())
        .getByRole('link', { name: 'Content' })
        .getAttribute('aria-current'),
    ).toBe('page');
    cleanup();
    mount({ currentHref: '/media' });
    const link = within(sidebar()).getByRole('link', { name: 'Content' });
    expect(link.getAttribute('aria-current')).toBe('true');
    expect(
      within(sidebar())
        .getByRole('link', { name: 'People' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('a collapsed rail keeps the names reachable with tooltips', () => {
    mount({ collapsed: true });
    const link = within(sidebar()).getByRole('link', { name: 'Content' });
    expect(link.getAttribute('title')).toBe('Content');
  });

  it('edit mode edits sections only, with an icon picker', async () => {
    const user = userEvent.setup();
    const { changes, api } = mount();
    await edit(user);
    const nav = sidebar();
    expect(within(nav).queryByText('Posts')).toBeNull();
    expect(
      within(nav).queryByRole('button', { name: 'Move Posts' }),
    ).toBeNull();
    expect(
      within(nav).getByRole('button', { name: 'Move Content' }),
    ).toBeTruthy();

    await user.click(
      within(nav).getByRole('button', { name: 'Edit section Content' }),
    );
    const trigger = within(nav).getByRole('button', {
      name: 'Icon of Content',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(
      within(nav).queryByRole('button', { name: /^Show title of/ }),
    ).toBeNull();
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const picker = within(nav).getByRole('group', { name: 'Icon of Content' });
    expect(
      within(picker)
        .getByRole('button', { name: 'Use book icon' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(
      within(picker).getByRole('button', { name: 'Use truck icon' }),
    );
    expect(changes.at(-1)?.sections?.content?.icon).toBe('truck');
    expect(api().sections.find((s) => s.id === 'content')?.icon).toBe('truck');
    expect(
      within(nav).queryByRole('group', { name: 'Icon of Content' }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes the picker first, then the toolbar', async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    const nav = sidebar();
    await user.click(
      within(nav).getByRole('button', { name: 'Edit section Content' }),
    );
    await user.click(
      within(nav).getByRole('button', { name: 'Icon of Content' }),
    );
    await user.keyboard('{Escape}');
    expect(
      within(nav).queryByRole('group', { name: 'Icon of Content' }),
    ).toBeNull();
    expect(within(nav).getByTestId('section-toolbar')).toBeTruthy();
  });

  it('setSectionIcon(null) restores the host icon', async () => {
    const { api } = mount();
    api().setSectionIcon('content', 'truck');
    expect(api().sections.find((s) => s.id === 'content')?.icon).toBe('truck');
    api().setSectionIcon('content', null);
    expect(api().sections.find((s) => s.id === 'content')?.icon).toBe('book');
  });
});

describe('ShellSectionMenu', () => {
  it('lists the section entries with meta and actions, in order', () => {
    mount();
    const rows = within(menu()).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const first = within(rows[0]);
    expect(
      first.getByRole('link', { name: 'Posts' }).getAttribute('href'),
    ).toBe('/posts');
    expect(first.getByTestId('meta-posts').textContent).toBe('3 records');
    expect(
      first.getByRole('link', { name: 'New Posts' }).getAttribute('href'),
    ).toBe('/new');
  });

  it('follows the layout: renames, order and hidden entries', async () => {
    const { api } = mount();
    api().renameItem('pages', 'Articles');
    api().moveItem('media', 'content', 0);
    api().hide('posts');
    await tick();
    const labels = within(menu())
      .getAllByRole('listitem')
      .map((r) => within(r).getAllByRole('link')[0].textContent?.trim());
    expect(labels).toEqual(['Media', 'Articles']);
  });

  it('moves entries with the keyboard in edit mode', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    await edit(user);
    const grip = screen.getByRole('button', { name: 'Move Posts' });
    grip.focus();
    await user.keyboard(' {ArrowDown}{Enter}');
    const order = api()
      .sections.find((s) => s.id === 'content')
      ?.items.map((i) => i.id);
    expect(order).toEqual(['pages', 'posts', 'media']);
  });

  it('renames and hides entries inline in edit mode', async () => {
    const user = userEvent.setup();
    const { api, changes } = mount();
    await edit(user);
    // Rows are not links while editing.
    expect(screen.queryByRole('link', { name: 'Posts' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Rename Posts' }));
    const input = screen.getByRole('textbox', { name: 'Name of item Posts' });
    await user.clear(input);
    await user.type(input, 'Stories{Enter}');
    expect(changes.at(-1)?.items?.posts?.label).toBe('Stories');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Rename Stories' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Reset Stories to Posts' }),
    );
    expect(api().layout.items).toBeUndefined();

    await user.click(
      screen.getByRole('button', { name: 'Show Pages in navigation' }),
    );
    expect(api().layout.hidden).toContain('pages');
    // Hidden entries stay visible (muted) while editing so they can be shown.
    expect(
      screen
        .getByRole('button', { name: 'Show Pages in navigation' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    await edit(user);
    expect(within(menu()).queryByText('Pages')).toBeNull();
  });

  it('is axe-clean in view and edit mode', async () => {
    const user = userEvent.setup();
    const { container } = render(Harness, {});
    await expectNoA11yViolations(container);
    await edit(user);
    await expectNoA11yViolations(container);
  });

  it('shows an empty message for an unknown or empty section', () => {
    mount({ menuSection: 'nope' });
    expect(screen.getByText('No entries in this section.')).toBeTruthy();
  });
});
