import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from '../CommandPalette.svelte';
import { createCommandPalette } from '../controller.svelte.js';
import type { PaletteItem } from '../types.js';
import ShellHarness from './palette-shell-harness.svelte';

const item = (id: string, title: string, extra: Partial<PaletteItem> = {}) => ({
  id,
  title,
  ...extra,
});

function makePalette(navigate = vi.fn()) {
  const run = vi.fn();
  const palette = createCommandPalette({
    navigate,
    searchDebounceMs: 0,
    providers: [
      {
        id: 'nav',
        label: 'Go to',
        order: 1,
        items: () => [
          item('inv', 'Invoices', {
            href: '/invoices',
            icon: 'receipt',
            subtitle: 'Sales',
          }),
          item('cus', 'Customers', { href: '/customers' }),
        ],
      },
      {
        id: 'cmd',
        label: 'Actions',
        order: 2,
        items: () => [
          item('new', 'New invoice', {
            run,
            shortcut: 'Mod+N',
            keywords: ['create'],
          }),
          item('lock', 'Delete everything', { disabled: 'Not allowed' }),
        ],
      },
      {
        id: 'rec',
        label: 'Records',
        order: 3,
        search: async (query: string) => [
          item(`r-${query}`, `Acme ${query}`, {
            href: `/records/${query}`,
            kind: 'record',
          }),
        ],
      },
    ],
  });
  return { palette, run, navigate };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CommandPalette', () => {
  it('renders a trigger with its shortcut hint and keeps the dialog closed', () => {
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette } });
    const trigger = screen.getByRole('button', { name: 'Search' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.querySelector('kbd')?.textContent).toBe('Ctrl+K');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('opens from the trigger and from Mod+K, and Mod+K closes it again', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette } });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(palette.isOpen).toBe(true);
    expect(await screen.findByRole('combobox')).toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    expect(palette.isOpen).toBe(false);
    await user.keyboard('{Meta>}k{/Meta}');
    expect(palette.isOpen).toBe(true);
  });

  it('opens from Mod+K while typing in a field, but a bare "/" only outside one', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette, hotkeys: ['Mod+K', '/'] } });
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    await user.keyboard('/');
    expect(palette.isOpen).toBe(false);
    await user.keyboard('{Control>}k{/Control}');
    expect(palette.isOpen).toBe(true);
    palette.close();
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    field.remove();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('/');
    expect(palette.isOpen).toBe(true);
  });

  it('installs no shortcut with hotkeys={false}', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette, hotkeys: false } });
    await user.keyboard('{Control>}k{/Control}');
    expect(palette.isOpen).toBe(false);
    expect(screen.getByRole('button', { name: 'Search' })).not.toHaveAttribute(
      'aria-keyshortcuts',
    );
  });

  it('follows the combobox pattern: groups, options, active descendant', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette } });
    palette.open();
    const box = await screen.findByRole('combobox', {
      name: 'Search or run a command',
    });
    const list = screen.getByRole('listbox', { name: 'Results' });
    expect(box).toHaveAttribute('aria-controls', list.id);
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(box).toHaveAttribute('aria-autocomplete', 'list');
    expect(
      within(list)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-labelledby')),
    ).toHaveLength(2);
    const options = within(list).getAllByRole('option');
    expect(
      options.map((o) => o.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'Invoices Sales',
      'Customers',
      'New invoice Ctrl+N',
      'Delete everything Unavailable',
    ]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', options[0].id);

    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', options[1].id);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    // The disabled row is skipped: wraps to the first.
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[3]).toHaveAttribute('aria-disabled', 'true');
    expect(options[3]).toHaveAttribute('title', 'Not allowed');
    await user.keyboard('{ArrowUp}');
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('filters while typing, highlights the match and announces the count', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette } });
    palette.open();
    const box = await screen.findByRole('combobox');
    await user.type(box, 'inv');
    const options = screen.getAllByRole('option');
    const titles = () =>
      screen
        .getAllByRole('option')
        .map((o) =>
          o.querySelector('.smrt-command-palette__title')?.textContent?.trim(),
        );
    // Local matches first, then the remote provider's answer (zero debounce).
    await waitFor(() =>
      expect(titles()).toEqual(['Invoices', 'New invoice', 'Acme inv']),
    );
    expect(options[0].querySelector('mark')?.textContent).toBe('Inv');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/3 results/),
    );
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette } });
    palette.open();
    const box = await screen.findByRole('combobox');
    await user.type(box, 'q');
    // 'q' is below the remote provider's minimum and matches no local row.
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getAllByText('No results for "q".').length).toBeGreaterThan(
      0,
    );
  });

  it('Enter navigates to the active row and closes', async () => {
    const user = userEvent.setup();
    const { palette, navigate } = makePalette();
    render(CommandPalette, { props: { palette } });
    palette.open();
    await screen.findByRole('combobox');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(navigate).toHaveBeenCalledWith(
      '/customers',
      expect.objectContaining({ id: 'cus' }),
    );
    expect(palette.isOpen).toBe(false);
  });

  it('clicking a row runs it; clicking a disabled row does nothing', async () => {
    const user = userEvent.setup();
    const { palette, run } = makePalette();
    render(CommandPalette, { props: { palette } });
    palette.open();
    await screen.findByRole('combobox');
    await user.click(screen.getByRole('option', { name: /Delete everything/ }));
    expect(palette.isOpen).toBe(true);
    await user.click(screen.getByRole('option', { name: /New invoice/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(palette.isOpen).toBe(false);
  });

  it('Escape closes and clears the query', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    render(CommandPalette, { props: { palette } });
    palette.open();
    const box = await screen.findByRole('combobox');
    await user.type(box, 'cus');
    await user.keyboard('{Escape}');
    expect(palette.isOpen).toBe(false);
    expect(palette.query).toBe('');
  });

  it('is axe-clean open, with and without a query', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    const { baseElement } = render(CommandPalette, { props: { palette } });
    await expectNoA11yViolations(baseElement);
    palette.open();
    const box = await screen.findByRole('combobox');
    await expectNoA11yViolations(baseElement);
    await user.type(box, 'inv');
    await expectNoA11yViolations(baseElement);
    await user.clear(box);
    await user.type(box, 'zzzz');
    await expectNoA11yViolations(baseElement);
  });

  it('works when it is the only thing mounted: owns a palette built from props', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(CommandPalette, {
      props: {
        providers: [
          {
            id: 'p',
            label: 'P',
            items: () => [item('a', 'Alpha', { href: '/a' })],
          },
        ],
        navigate,
      },
    });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('combobox');
    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith('/a', expect.anything());
  });

  it('hideTrigger leaves only the dialog and shortcut; compact shows a glyph', () => {
    const { palette } = makePalette();
    const first = render(CommandPalette, {
      props: { palette, hideTrigger: true },
    });
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    first.unmount();
    render(CommandPalette, { props: { palette, compact: true } });
    expect(
      screen.getByRole('button', { name: 'Search' }).querySelector('kbd'),
    ).toBeNull();
  });
});

describe('CommandPalette in an AppShell slot', () => {
  it('renders the trigger in the header center slot and opens from it', async () => {
    const user = userEvent.setup();
    const { palette } = makePalette();
    const { container } = render(ShellHarness, { props: { palette } });
    const trigger = screen.getByRole('button', { name: 'Search' });
    expect(
      trigger.closest('[data-slot], .smrt-admin-shell__header, header'),
    ).not.toBeNull();
    expect(container.contains(trigger)).toBe(true);
    await user.click(trigger);
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });

  it('lets a descendant register a provider through context', async () => {
    const { palette } = makePalette();
    render(ShellHarness, { props: { palette, withChild: true } });
    palette.open();
    await screen.findByRole('combobox');
    expect(
      screen.getByRole('option', { name: /From child/ }),
    ).toBeInTheDocument();
  });
});
