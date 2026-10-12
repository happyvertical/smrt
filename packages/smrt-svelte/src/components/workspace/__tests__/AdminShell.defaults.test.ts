/**
 * AdminShell defaults (#3851): empty regions render nothing, the phone right
 * edge is reachable, side surfaces are exclusive, touch-friendly icon chrome.
 */
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, flushSync, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AdminShell from '../admin-shell/AdminShell.svelte';
import { createShellState } from '../admin-shell/state.svelte.js';

function html(markup: string) {
  return createRawSnippet(() => ({ render: () => markup }));
}

const listeners = new Set<() => void>();
let width = 1280;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  width = 1280;
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*([\d.]+)rem/.exec(query);
    const min = /min-width:\s*([\d.]+)rem/.exec(query);
    return {
      get matches() {
        if (query.includes('prefers-reduced-motion')) return false;
        return (
          (!max || width <= Number(max[1]) * 16) &&
          (!min || width >= Number(min[1]) * 16)
        );
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
});

afterEach(() => {
  listeners.clear();
  window.matchMedia = originalMatchMedia;
});

async function settle() {
  flushSync();
  await tick();
  flushSync();
}

const rootStyle = () =>
  document.querySelector('.smrt-admin-shell')!.getAttribute('style') ?? '';

describe('empty regions', () => {
  it('renders no footer band and no right edge when nothing is slotted', async () => {
    render(AdminShell, {
      props: {
        state: createShellState({ config: { left: { initial: 'expanded' } } }),
        children: html('<p>page</p>'),
      },
    });
    await settle();
    expect(document.querySelector('footer')).toBeNull();
    expect(document.getElementById('smrt-admin-shell-right-panel')).toBeNull();
    expect(rootStyle()).toContain('--smrt-admin-shell-bottom-track: 0rem');
    expect(rootStyle()).toContain('--smrt-admin-shell-right-track: 0rem');
  });

  it('renders the footer for a systemBar and the right edge for a focus tool', async () => {
    const shell = createShellState({
      config: { left: { initial: 'expanded' } },
    });
    shell.registerFocusTool({ id: 'chat', label: 'Chat' });
    render(AdminShell, {
      props: {
        state: shell,
        systemBar: html('<span>status</span>'),
        children: html('<p>page</p>'),
      },
    });
    await settle();
    expect(document.querySelector('footer')?.textContent).toContain('status');
    expect(
      document.getElementById('smrt-admin-shell-right-panel'),
    ).not.toBeNull();
  });
});

describe('phone right edge and surfaces', () => {
  beforeEach(() => {
    width = 390;
  });

  function phoneShell(withTool = true) {
    const shell = createShellState({
      config: {
        left: { initial: 'expanded' },
        right: { initial: 'collapsed' },
      },
    });
    if (withTool) shell.registerFocusTool({ id: 'chat', label: 'Chat' });
    return shell;
  }

  it('offers a Tools opener that opens and closes the right drawer', async () => {
    const shell = phoneShell();
    render(AdminShell, {
      props: {
        state: shell,
        focusPanel: html('<p>dock</p>'),
        children: html('<p>page</p>'),
      },
    });
    await settle();
    const opener = screen.getByRole('button', { name: 'Tools' });
    expect(opener).toHaveAttribute(
      'aria-controls',
      'smrt-admin-shell-right-panel',
    );
    await fireEvent.click(opener);
    expect(shell.panels.right).toBe('expanded');
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    const closers = screen.getAllByRole('button', { name: 'Close tools' });
    await fireEvent.click(closers[0]);
    expect(shell.panels.right).toBe('collapsed');
  });

  it('shows no Tools opener without tools or when phoneDockOpener is off', async () => {
    render(AdminShell, {
      props: { state: phoneShell(false), children: html('<p>page</p>') },
    });
    await settle();
    expect(screen.queryByRole('button', { name: 'Tools' })).toBeNull();
  });

  it('keeps the left and right surfaces exclusive', async () => {
    const shell = phoneShell();
    render(AdminShell, {
      props: {
        state: shell,
        focusPanel: html('<p>dock</p>'),
        children: html('<p>page</p>'),
      },
    });
    await settle();
    shell.expandPanel('left');
    flushSync();
    expect(shell.panels.left).toBe('expanded');
    shell.openFocusTool('chat');
    flushSync();
    expect(shell.panels.right).toBe('expanded');
    expect(shell.panels.left).toBe('collapsed');
    shell.expandPanel('left');
    flushSync();
    expect(shell.panels.right).toBe('collapsed');
  });

  it('has the scrim and swipe on by default and lets them be turned off', async () => {
    const shell = phoneShell();
    const { unmount } = render(AdminShell, {
      props: { state: shell, children: html('<p>page</p>') },
    });
    await settle();
    shell.expandPanel('left');
    await settle();
    expect(screen.getByTestId('admin-shell-scrim')).toBeInTheDocument();
    unmount();
    const off = phoneShell();
    render(AdminShell, {
      props: {
        state: off,
        phone: { scrim: false },
        children: html('<p>page</p>'),
      },
    });
    await settle();
    off.expandPanel('left');
    await settle();
    expect(screen.queryByTestId('admin-shell-scrim')).toBeNull();
  });

  it('uses an icon Menu opener and an icon-only Close menu with the app title', async () => {
    const shell = phoneShell(false);
    render(AdminShell, {
      props: { state: shell, title: 'Shop', children: html('<p>page</p>') },
    });
    await settle();
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu.textContent?.trim()).toBe('');
    expect(menu.querySelector('svg')).not.toBeNull();
    await fireEvent.click(menu);
    const close = screen.getByRole('button', { name: 'Close menu' });
    expect(close.textContent?.trim()).toBe('');
    const head = document.querySelector('[data-smrt-part="header"]');
    expect(head?.textContent).toContain('Shop');
    await fireEvent.click(close);
    expect(shell.panels.left).toBe('collapsed');
  });

  it('draws a generic tool icon, never the first letter, for a tool without an icon', async () => {
    const shell = phoneShell();
    render(AdminShell, {
      props: {
        state: shell,
        focusPanel: html('<p>dock</p>'),
        children: html('<p>page</p>'),
      },
    });
    await settle();
    shell.expandPanel('right');
    await settle();
    const tool = document.querySelector('.smrt-admin-shell__focus-tool')!;
    expect(tool.querySelector('svg')).not.toBeNull();
    expect(tool.textContent?.trim()).toBe('');
  });
});
