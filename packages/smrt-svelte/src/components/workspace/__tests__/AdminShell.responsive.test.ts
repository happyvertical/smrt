/**
 * AdminShell's responsive chrome: header row, viewport defaults, phone top
 * and bottom bars, form action bars, scrim, navigation, phone presentations
 * of the right edge, and resizable side edges.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet, flushSync, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminShell from '../admin-shell/AdminShell.svelte';
import { createShellState } from '../admin-shell/state.svelte.js';
import type {
  ShellPanelDefaults,
  ShellSettingsDelta,
} from '../admin-shell/types.js';
import { ADMIN_SHELL_REGION_IDS } from '../admin-shell/types.js';

function html(markup: string) {
  return createRawSnippet(() => ({ render: () => markup }));
}

const listeners = new Set<() => void>();
let width = 1280;
const originalMatchMedia = window.matchMedia;

function setWidth(next: number) {
  width = next;
  for (const listener of listeners) listener();
}

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
      addEventListener: (_: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        listeners.delete(listener),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
});

afterEach(() => {
  listeners.clear();
  window.matchMedia = originalMatchMedia;
});

const config: ShellPanelDefaults = {
  top: false,
  left: {
    label: 'Navigation',
    initial: 'expanded',
    hotkey: null,
    viewportDefaults: {
      phone: 'collapsed',
      tablet: 'collapsed',
      desktop: 'expanded',
    },
  },
  right: { label: 'Assistant', initial: 'collapsed', hotkey: null },
  bottom: false,
};

async function settle() {
  flushSync();
  await tick();
  flushSync();
}

function shellRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.smrt-admin-shell')!;
}

describe('AdminShell header and viewport', () => {
  it('renders a header row above the edges on desktop, with public region ids', async () => {
    const shell = createShellState({ config });
    render(AdminShell, {
      props: {
        edgeToggles: true,
        state: shell,
        header: createRawSnippet<[{ viewport: string }]>((ctx) => ({
          render: () => `<span>Header ${ctx().viewport}</span>`,
        })),
        phoneTopBar: html('<span>phone top</span>'),
        phoneBottomBar: html('<nav>phone bar</nav>'),
        children: html('<p>page</p>'),
      },
    });
    await settle();
    const header = document.getElementById(ADMIN_SHELL_REGION_IDS.header);
    expect(header?.textContent).toContain('Header desktop');
    expect(document.getElementById(ADMIN_SHELL_REGION_IDS.main)?.tagName).toBe(
      'MAIN',
    );
    expect(document.getElementById(ADMIN_SHELL_REGION_IDS.left)).not.toBeNull();
    expect(shellRoot().dataset.viewport).toBe('desktop');
    expect(shellRoot().getAttribute('style')).toContain(
      '--smrt-admin-shell-header-track: var(--smrt-admin-shell-header-size)',
    );
    expect(screen.queryByTestId('admin-shell-phone-top')).toBeNull();
    expect(screen.queryByTestId('admin-shell-phone-bar')).toBeNull();
    expect(shell.panels.left).toBe('expanded');
  });

  it('follows viewport classes: tablet collapses the nav, desktop reopens it', async () => {
    const shell = createShellState({ config });
    render(AdminShell, {
      props: {
        state: shell,
        edgeToggles: true,
        children: html('<p>page</p>'),
      },
    });
    await settle();
    setWidth(900);
    flushSync();
    expect(shell.viewport).toBe('tablet');
    expect(shell.panels.left).toBe('collapsed');
    setWidth(1400);
    flushSync();
    expect(shell.panels.left).toBe('expanded');
  });
});

describe('AdminShell on a phone', () => {
  beforeEach(() => setWidth(390));

  function renderPhone(
    extra: Record<string, unknown> = {},
    page = '<p>page</p>',
  ) {
    const shell = createShellState({ config });
    const result = render(AdminShell, {
      props: {
        edgeToggles: true,
        state: shell,
        header: html('<span>desktop header</span>'),
        phoneTopBar: createRawSnippet<[{ hidden: boolean }]>((ctx) => ({
          render: () => `<span>top ${ctx().hidden ? 'hidden' : 'shown'}</span>`,
        })),
        phoneBottomBar: html('<nav aria-label="Main">bar</nav>'),
        phone: { scrim: true, swipeToClose: true },
        path: '/a',
        children: html(page),
        ...extra,
      },
    });
    return { shell, ...result };
  }

  it('swaps the header for the phone top bar and shows the bottom bar', async () => {
    const { shell } = renderPhone();
    await settle();
    expect(shell.viewport).toBe('phone');
    expect(shell.panels.left).toBe('collapsed');
    expect(screen.queryByTestId('admin-shell-header')).toBeNull();
    expect(screen.getByTestId('admin-shell-phone-top').textContent).toContain(
      'top shown',
    );
    expect(screen.getByTestId('admin-shell-phone-bar')).toBeInTheDocument();
    expect(shellRoot().dataset.bottomBar).toBe('nav');
    expect(shellRoot().hasAttribute('data-phone-top')).toBe(true);
  });

  it('lets a form action bar replace the bottom bar', async () => {
    renderPhone(
      {},
      '<form><div data-form-action-bar><button>Save</button></div></form>',
    );
    await settle();
    expect(screen.queryByTestId('admin-shell-phone-bar')).toBeNull();
    expect(shellRoot().dataset.bottomBar).toBe('form');
  });

  it('dims the page behind an open drawer; the scrim closes it', async () => {
    const { shell } = renderPhone();
    await settle();
    expect(screen.queryByTestId('admin-shell-scrim')).toBeNull();
    shell.expandPanel('left');
    flushSync();
    const scrim = screen.getByTestId('admin-shell-scrim');
    expect(scrim).toHaveAttribute('aria-label', 'Close Navigation');
    await fireEvent.click(scrim);
    expect(shell.panels.left).toBe('collapsed');
  });

  it('keeps a closed phone drawer out of the tab order and away from screen readers', async () => {
    const { shell } = renderPhone();
    await settle();
    const left = document.getElementById('smrt-admin-shell-left-panel')!;
    expect(left.inert).toBe(true);
    shell.expandPanel('left');
    flushSync();
    expect(left.inert).toBe(false);
    setWidth(1280);
    await settle();
    expect(left.inert).toBe(false);
  });

  it('moves focus into the phone drawer without animation enumeration', async () => {
    const { shell } = renderPhone({
      tenantPanel: html('<a href="/phone-target">Phone navigation target</a>'),
    });
    await settle();
    const left = document.getElementById('smrt-admin-shell-left-panel')!;
    Object.defineProperty(left, 'getAnimations', { value: undefined });
    shell.expandPanel('left');
    await settle();
    await waitFor(() =>
      expect(left.contains(document.activeElement)).toBe(true),
    );
  });

  it('closes an open drawer when the path changes', async () => {
    const { shell, rerender } = renderPhone();
    await settle();
    shell.expandPanel('left');
    flushSync();
    await rerender({ path: '/b' });
    await settle();
    expect(shell.panels.left).toBe('collapsed');
  });

  it('does not render a phone-hidden right edge and renders a sheet with a grabber', async () => {
    const hiddenShell = createShellState({
      config: {
        ...config,
        right: { label: 'Assistant', phone: 'hidden', initial: 'expanded' },
      },
    });
    const first = render(AdminShell, {
      props: { state: hiddenShell, children: html('<p>page</p>') },
    });
    await settle();
    expect(document.getElementById(ADMIN_SHELL_REGION_IDS.right)).toBeNull();
    first.unmount();

    const sheetShell = createShellState({
      config: {
        ...config,
        right: { label: 'Assistant', phone: 'sheet', initial: 'expanded' },
      },
    });
    render(AdminShell, {
      props: {
        edgeToggles: true,
        state: sheetShell,
        focusPanel: html('<p>chat</p>'),
        phone: { scrim: true },
        children: html('<p>page</p>'),
      },
    });
    await settle();
    const aside = document.getElementById(ADMIN_SHELL_REGION_IDS.right)!;
    expect(aside.dataset.phone).toBe('sheet');
    expect(
      aside.querySelector('.smrt-admin-shell__sheet-grabber'),
    ).not.toBeNull();
    expect(screen.getByTestId('admin-shell-scrim')).toHaveAttribute(
      'aria-label',
      'Close Assistant',
    );
  });

  it('renders host overlays with the viewport and bottom bar mode', async () => {
    renderPhone({
      overlays: createRawSnippet<[{ viewport: string; bottomBar: string }]>(
        (ctx) => ({
          render: () =>
            `<div data-testid="overlay">${ctx().viewport}/${ctx().bottomBar}</div>`,
        }),
      ),
    });
    await settle();
    expect(screen.getByTestId('overlay').textContent).toBe('phone/nav');
  });
});

describe('AdminShell resizable edges', () => {
  function storeAdapter() {
    const writes: ShellSettingsDelta[] = [];
    return {
      writes,
      read: () => null,
      write: (delta: ShellSettingsDelta) => {
        writes.push(JSON.parse(JSON.stringify(delta)));
      },
    };
  }

  function renderResizable(overrides: ShellPanelDefaults = {}) {
    const adapter = storeAdapter();
    const shell = createShellState({
      config: {
        ...config,
        right: {
          label: 'Assistant',
          initial: 'expanded',
          expandedSize: '28rem',
          resizable: { min: 320, max: 640, step: 10 },
          hotkey: null,
        },
        ...overrides,
      },
      settingsAdapter: adapter,
    });
    const view = render(AdminShell, {
      props: {
        edgeToggles: true,
        state: shell,
        focusPanel: html('<p>chat</p>'),
        children: html('<p>page</p>'),
      },
    });
    flushSync();
    return { shell, adapter, view };
  }

  it('does not render a separator unless the edge is resizable (backward compatible)', () => {
    const shell = createShellState({
      config: { right: { initial: 'expanded' } },
    });
    render(AdminShell, {
      props: { state: shell, children: html('<p>page</p>') },
    });
    expect(document.querySelector('[role="separator"]')).toBeNull();
  });

  it('exposes an accessible, keyboard-resizable separator', async () => {
    const { shell, adapter } = renderResizable();
    const separator = screen.getByRole('separator', {
      name: 'Resize Assistant',
    });
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute(
      'aria-controls',
      ADMIN_SHELL_REGION_IDS.right,
    );
    expect(separator).toHaveAttribute('aria-valuemin', '320');
    expect(separator).toHaveAttribute('aria-valuemax', '640');
    expect(separator).toHaveAttribute('aria-valuenow', '448');
    expect(separator).toHaveAttribute('tabindex', '0');

    await fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(shell.panelSize('right')).toBe(458);
    expect(separator).toHaveAttribute('aria-valuenow', '458');
    await fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    expect(shell.panelSize('right')).toBe(418);
    await fireEvent.keyDown(separator, { key: 'End' });
    expect(shell.panelSize('right')).toBe(640);
    await fireEvent.keyDown(separator, { key: 'Home' });
    expect(shell.panelSize('right')).toBe(320);
    expect(adapter.writes.at(-1)?.sizes).toEqual({ right: 320 });
    expect(shellRoot().getAttribute('style')).toContain(
      '--smrt-admin-shell-right-track: 320px',
    );
    await fireEvent.keyDown(separator, { key: 'Enter' });
    expect(shell.panelSize('right')).toBeNull();
    expect(separator).toHaveAttribute('aria-valuenow', '448');
  });

  it('resizes by dragging, persisting once at the end, and resets on double-click', async () => {
    const { shell, adapter } = renderResizable();
    const separator = screen.getByTestId('admin-shell-resizer-right');
    const before = adapter.writes.length;
    await fireEvent.pointerDown(separator, { button: 0, clientX: 800 });
    expect(shellRoot().dataset.resizing).toBe('right');
    await fireEvent.pointerMove(separator, { clientX: 760 });
    expect(shell.panelSize('right')).toBe(488);
    await fireEvent.pointerMove(separator, { clientX: 700 });
    expect(shell.panelSize('right')).toBe(548);
    expect(adapter.writes.length).toBe(before);
    await fireEvent.pointerUp(separator, { clientX: 700 });
    expect(shellRoot().dataset.resizing).toBeUndefined();
    expect(adapter.writes.length).toBe(before + 1);
    expect(adapter.writes.at(-1)?.sizes).toEqual({ right: 548 });

    await fireEvent.dblClick(separator);
    expect(shell.panelSize('right')).toBeNull();
  });

  it('ends the drag when pointer capture is lost, persisting once', async () => {
    const { shell, adapter } = renderResizable();
    const separator = screen.getByTestId('admin-shell-resizer-right');
    const before = adapter.writes.length;
    await fireEvent.pointerDown(separator, { button: 0, clientX: 800 });
    await fireEvent.pointerMove(separator, { clientX: 760 });
    expect(shellRoot().dataset.resizing).toBe('right');
    // The browser took the capture away (a system gesture, a window switch)
    // without a pointerup.
    await fireEvent(separator, new Event('lostpointercapture'));
    expect(shellRoot().dataset.resizing).toBeUndefined();
    expect(adapter.writes.length).toBe(before + 1);
    await fireEvent.pointerMove(separator, { clientX: 600 });
    expect(shell.panelSize('right')).toBe(488);
    await fireEvent.pointerUp(separator, { clientX: 600 });
    expect(adapter.writes.length).toBe(before + 1);
  });

  it('drops an in-flight drag when the shell unmounts', async () => {
    const { shell, view } = renderResizable();
    const separator = screen.getByTestId('admin-shell-resizer-right');
    await fireEvent.pointerDown(separator, { button: 0, clientX: 800 });
    await fireEvent.pointerMove(separator, { clientX: 760 });
    expect(shell.panelSize('right')).toBe(488);
    view.unmount();
    // The detached handle no longer drives the (still live) shell state.
    await fireEvent.pointerMove(separator, { clientX: 600 });
    expect(shell.panelSize('right')).toBe(488);
  });

  it('grows a left edge to the right', async () => {
    const { shell } = renderResizable({
      left: {
        label: 'Navigation',
        initial: 'expanded',
        expandedSize: '16rem',
        resizable: true,
      },
    });
    const separator = screen.getByRole('separator', {
      name: 'Resize Navigation',
    });
    await fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(shell.panelSize('left')).toBe(272);
  });

  it('hides the separator while collapsed and on phones', async () => {
    const { shell } = renderResizable();
    shell.collapsePanel('right');
    flushSync();
    expect(screen.queryByRole('separator')).toBeNull();
    shell.expandPanel('right');
    flushSync();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    setWidth(390);
    flushSync();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('keeps the size out of storage when the edge opts out', async () => {
    const { shell, adapter } = renderResizable({
      right: {
        label: 'Assistant',
        initial: 'expanded',
        resizable: true,
        persist: { size: false },
      },
    });
    await fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    expect(shell.panelSize('right')).toBe(720);
    expect(adapter.writes.at(-1)?.sizes).toBeUndefined();
  });
});

describe('AdminShell overlay edges (overlayMedia)', () => {
  function overlayShell() {
    return createShellState({
      config: {
        ...config,
        right: {
          label: 'Assistant',
          initial: 'collapsed',
          hotkey: null,
          collapsedSize: '0rem',
          expandedSize: '28rem',
          resizable: { min: 320, max: 640 },
          overlayMedia: '(max-width: 99.9375rem)',
        },
      },
    });
  }

  function rightEdge(): HTMLElement {
    return document.getElementById(ADMIN_SHELL_REGION_IDS.right)!;
  }

  it('slides over the page below the query and docks above it', async () => {
    setWidth(1280);
    const shell = overlayShell();
    render(AdminShell, {
      props: { state: shell, children: html('<button>page action</button>') },
    });
    await settle();
    shell.expandPanel('right');
    await settle();

    expect(shell.presentationFor('right')).toBe('overlay');
    expect(rightEdge().dataset.presentation).toBe('overlay');
    // The page keeps its width: the right track stays collapsed.
    expect(shellRoot().getAttribute('style')).toContain(
      '--smrt-admin-shell-right-track: 0rem',
    );
    expect(screen.getByTestId('admin-shell-overlay-scrim')).toBeTruthy();
    expect(document.getElementById('smrt-admin-shell-main')?.inert).toBe(true);
    expect(screen.queryByTestId('admin-shell-resizer-right')).toBeNull();

    setWidth(1600);
    await settle();
    expect(shell.presentationFor('right')).toBe('push');
    expect(rightEdge().dataset.presentation).toBe('push');
    expect(shellRoot().getAttribute('style')).toContain(
      '--smrt-admin-shell-right-track: 28rem',
    );
    expect(screen.queryByTestId('admin-shell-overlay-scrim')).toBeNull();
    expect(document.getElementById('smrt-admin-shell-main')?.inert).toBe(false);
    expect(screen.getByTestId('admin-shell-resizer-right')).toBeTruthy();
  });

  it('closes on a scrim click or Escape, moving focus in and back', async () => {
    setWidth(1100);
    const shell = overlayShell();
    render(AdminShell, {
      props: { state: shell, children: html('<p>page</p>') },
    });
    await settle();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    shell.expandPanel('right');
    await settle();
    expect(document.activeElement).toBe(rightEdge());
    await fireEvent.keyDown(window, { key: 'Escape' });
    await settle();
    expect(shell.panels.right).toBe('collapsed');
    expect(document.activeElement).toBe(opener);
    opener.remove();

    shell.expandPanel('right');
    await settle();
    await fireEvent.click(screen.getByTestId('admin-shell-overlay-scrim'));
    await settle();
    expect(shell.panels.right).toBe('collapsed');

    shell.expandPanel('right');
    await settle();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await settle();
    expect(shell.panels.right).toBe('collapsed');
  });

  it('does not open an overlay on load, but still restores a docked edge', async () => {
    const stored: ShellSettingsDelta = { panels: { right: 'expanded' } };
    const adapter = { read: () => stored, write: vi.fn() };
    const make = () =>
      createShellState({
        config: {
          ...config,
          right: {
            label: 'Assistant',
            initial: 'collapsed',
            hotkey: null,
            overlayMedia: '(max-width: 99.9375rem)',
          },
        },
        settingsAdapter: adapter,
      });

    setWidth(1280);
    const narrow = make();
    const first = render(AdminShell, {
      props: { state: narrow, children: html('<p>page</p>') },
    });
    await settle();
    await settle();
    expect(narrow.panels.right).toBe('collapsed');
    expect(adapter.write).not.toHaveBeenCalled();
    first.unmount();

    setWidth(1700);
    const wide = make();
    render(AdminShell, {
      props: { state: wide, children: html('<p>page</p>') },
    });
    await settle();
    await settle();
    expect(wide.panels.right).toBe('expanded');
  });

  it('slides a closed overlay back out before hiding it', async () => {
    vi.useFakeTimers();
    try {
      setWidth(1100);
      const shell = overlayShell();
      render(AdminShell, {
        props: { state: shell, children: html('<p>page</p>') },
      });
      await settle();
      shell.expandPanel('right');
      await settle();
      shell.collapsePanel('right');
      await settle();

      // Closed at once for the page (not inert), still shown while it slides.
      expect(document.getElementById('smrt-admin-shell-main')?.inert).toBe(
        false,
      );
      expect(rightEdge().dataset.state).toBe('expanded');
      expect(rightEdge().hasAttribute('data-closing')).toBe(true);
      expect(rightEdge().inert).toBe(true);
      const scrim = screen.getByTestId('admin-shell-overlay-scrim');
      expect(scrim.hasAttribute('data-closing')).toBe(true);
      await fireEvent.click(scrim);
      expect(shell.panels.right).toBe('collapsed');

      vi.advanceTimersByTime(700);
      await settle();
      expect(rightEdge().dataset.state).toBe('collapsed');
      expect(rightEdge().hasAttribute('data-closing')).toBe(false);
      expect(screen.queryByTestId('admin-shell-overlay-scrim')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the slide-out when reduced motion is preferred', async () => {
    setWidth(1100);
    const base = window.matchMedia;
    window.matchMedia = ((query: string) =>
      query.includes('prefers-reduced-motion')
        ? ({
            matches: true,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
          } as unknown as MediaQueryList)
        : base(query)) as typeof window.matchMedia;
    const shell = overlayShell();
    render(AdminShell, {
      props: { state: shell, children: html('<p>page</p>') },
    });
    await settle();
    shell.expandPanel('right');
    await settle();
    shell.collapsePanel('right');
    await settle();
    expect(rightEdge().dataset.state).toBe('collapsed');
    expect(screen.queryByTestId('admin-shell-overlay-scrim')).toBeNull();
  });

  it('keeps the phone presentation on phones', async () => {
    setWidth(390);
    const shell = overlayShell();
    render(AdminShell, {
      props: { state: shell, children: html('<p>page</p>') },
    });
    await settle();
    shell.expandPanel('right');
    await settle();
    expect(shell.presentationFor('right')).toBe('push');
    expect(screen.queryByTestId('admin-shell-overlay-scrim')).toBeNull();
  });
});

describe('AdminShell backward compatibility', () => {
  it('adds no header, phone chrome, overlays, or scrim without the new props', async () => {
    setWidth(390);
    const shell = createShellState({
      config: { left: { initial: 'expanded' } },
    });
    render(AdminShell, {
      props: { state: shell, children: html('<p>page</p>') },
    });
    await settle();
    expect(screen.queryByTestId('admin-shell-header')).toBeNull();
    expect(screen.queryByTestId('admin-shell-phone-top')).toBeNull();
    expect(screen.queryByTestId('admin-shell-phone-bar')).toBeNull();
    expect(screen.queryByTestId('admin-shell-scrim')).toBeNull();
    expect(document.querySelector('.smrt-admin-shell__overlays')).toBeNull();
    // Without viewport defaults the left edge keeps its configured state.
    expect(shell.panels.left).toBe('expanded');
    expect(shellRoot().getAttribute('style')).toContain(
      '--smrt-admin-shell-header-track: 0rem',
    );
  });

  it('still renders a system bar in the bottom edge', () => {
    const shell = createShellState();
    render(AdminShell, {
      props: {
        edgeToggles: true,
        state: shell,
        systemBar: html('<span>system chips</span>'),
        children: html('<p>page</p>'),
      },
    });
    expect(
      document.getElementById(ADMIN_SHELL_REGION_IDS.bottom)?.textContent,
    ).toContain('system chips');
  });
});

vi.setConfig({ testTimeout: 30000 });
