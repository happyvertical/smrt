/**
 * AdminShell's docked panel: the region between the left sidebar and the main
 * area (sidebar, panel, content), its separator, and its stored width.
 */

import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, flushSync, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AdminShell from '../admin-shell/AdminShell.svelte';
import { sanitizeShellSettingsDelta } from '../admin-shell/settings-delta.js';
import { createShellState } from '../admin-shell/state.svelte.js';
import type {
  ShellPanelDefaults,
  ShellSettingsDelta,
} from '../admin-shell/types.js';

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
  left: { label: 'Navigation', initial: 'expanded', hotkey: null },
  right: false,
  bottom: false,
};

function storeAdapter() {
  const writes: ShellSettingsDelta[] = [];
  let stored: ShellSettingsDelta | null = null;
  return {
    writes,
    read: () => stored,
    write: (delta: ShellSettingsDelta) => {
      stored = JSON.parse(JSON.stringify(delta));
      writes.push(JSON.parse(JSON.stringify(delta)));
    },
  };
}

function renderPanel(
  props: Record<string, unknown> = {},
  adapter = storeAdapter(),
) {
  const shell = createShellState({ config, settingsAdapter: adapter });
  const view = render(AdminShell, {
    props: {
      state: shell,
      tenantPanel: html('<nav>menu</nav>'),
      panel: html('<p>chat</p>'),
      panelLabel: 'Assistant',
      children: html('<p>page</p>'),
      ...props,
    },
  });
  flushSync();
  return { shell, adapter, view };
}

const separator = () =>
  screen.getByRole('separator', { name: 'Resize Assistant' });
const panelEl = () => screen.getByTestId('admin-shell-panel');
const shellRoot = () =>
  document.querySelector<HTMLElement>('.smrt-admin-shell') as HTMLElement;

describe('AdminShell docked panel', () => {
  it('renders nothing extra without a panel (backward compatible)', () => {
    const shell = createShellState({ config });
    render(AdminShell, {
      props: { state: shell, children: html('<p>page</p>') },
    });
    expect(screen.queryByTestId('admin-shell-panel')).toBeNull();
    expect(document.querySelector('.smrt-admin-shell__body')).toBeNull();
  });

  it('orders left sidebar, panel and main', () => {
    renderPanel();
    const left = document.getElementById('smrt-admin-shell-left-panel');
    const main = document.getElementById('smrt-admin-shell-main');
    const follows = (a: Element | null, b: Element | null) =>
      Boolean(
        a &&
          b &&
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    expect(follows(left, panelEl())).toBe(true);
    expect(follows(panelEl(), main)).toBe(true);
    expect(panelEl()).toHaveAccessibleName('Assistant');
    expect(panelEl().textContent).toContain('chat');
  });

  it('hides the panel when closed but keeps it mounted', async () => {
    const { view } = renderPanel({ panelOpen: false });
    expect(panelEl()).toHaveAttribute('hidden');
    expect(panelEl().textContent).toContain('chat');
    expect(
      screen.queryByRole('separator', { name: 'Resize Assistant' }),
    ).toBeNull();
    await view.rerender({ panelOpen: true });
    expect(panelEl()).not.toHaveAttribute('hidden');
    expect(separator()).toBeTruthy();
  });

  it('exposes an accessible separator with value, bounds and tabindex', () => {
    renderPanel({ panelSize: 400 });
    expect(separator()).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator()).toHaveAttribute('aria-valuemin', '280');
    expect(separator()).toHaveAttribute('aria-valuemax', '800');
    expect(separator()).toHaveAttribute('aria-valuenow', '400');
    expect(separator()).toHaveAttribute('tabindex', '0');
    expect(panelEl().getAttribute('style')).toContain(
      '--smrt-admin-shell-panel-width: 400px',
    );
  });

  it('resizes with the arrow keys, Home, End and Enter, clamped and persisted', async () => {
    const { shell, adapter } = renderPanel({ panelSize: 400 });
    await fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(shell.panelSize('panel')).toBe(416);
    expect(separator()).toHaveAttribute('aria-valuenow', '416');
    await fireEvent.keyDown(separator(), { key: 'ArrowLeft', shiftKey: true });
    expect(shell.panelSize('panel')).toBe(352);
    await fireEvent.keyDown(separator(), { key: 'End' });
    expect(shell.panelSize('panel')).toBe(800);
    await fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(shell.panelSize('panel')).toBe(800);
    await fireEvent.keyDown(separator(), { key: 'Home' });
    expect(shell.panelSize('panel')).toBe(280);
    await fireEvent.keyDown(separator(), { key: 'ArrowLeft', shiftKey: true });
    expect(shell.panelSize('panel')).toBe(280);
    expect(adapter.writes.at(-1)?.sizes).toEqual({ panel: 280 });
    expect(panelEl().getAttribute('style')).toContain(
      '--smrt-admin-shell-panel-width: 280px',
    );
    await fireEvent.keyDown(separator(), { key: 'Enter' });
    expect(shell.panelSize('panel')).toBeNull();
    expect(separator()).toHaveAttribute('aria-valuenow', '400');
  });

  it('resizes by dragging, persists once on release, and resets on double-click', async () => {
    const { shell, adapter } = renderPanel({ panelSize: 400 });
    const before = adapter.writes.length;
    await fireEvent.pointerDown(separator(), { button: 0, clientX: 700 });
    expect(shellRoot().dataset.resizing).toBe('panel');
    await fireEvent.pointerMove(separator(), { clientX: 760 });
    expect(shell.panelSize('panel')).toBe(460);
    await fireEvent.pointerMove(separator(), { clientX: 1700 });
    // Clamped to the maximum while dragging.
    expect(shell.panelSize('panel')).toBe(800);
    await fireEvent.pointerMove(separator(), { clientX: 650 });
    expect(shell.panelSize('panel')).toBe(350);
    expect(adapter.writes.length).toBe(before);
    await fireEvent.pointerUp(separator(), { clientX: 650 });
    expect(shellRoot().dataset.resizing).toBeUndefined();
    expect(adapter.writes.length).toBe(before + 1);
    expect(adapter.writes.at(-1)?.sizes).toEqual({ panel: 350 });

    await fireEvent.dblClick(separator());
    expect(shell.panelSize('panel')).toBeNull();
    expect(separator()).toHaveAttribute('aria-valuenow', '400');
  });

  it('restores the stored width in a new shell (persisted per owner)', async () => {
    const adapter = storeAdapter();
    const first = renderPanel({ panelSize: 400 }, adapter);
    await fireEvent.keyDown(separator(), { key: 'ArrowRight', shiftKey: true });
    expect(first.shell.panelSize('panel')).toBe(464);
    first.view.unmount();

    renderPanel({ panelSize: 400 }, adapter);
    await tick();
    await tick();
    flushSync();
    expect(separator()).toHaveAttribute('aria-valuenow', '464');
    expect(panelEl().getAttribute('style')).toContain(
      '--smrt-admin-shell-panel-width: 464px',
    );
  });

  it('keeps the content a minimum width through CSS and never renders a separator when fixed', () => {
    renderPanel({ panelResize: false, panelSize: 360 });
    expect(
      screen.queryByRole('separator', { name: 'Resize Assistant' }),
    ).toBeNull();
    expect(panelEl().getAttribute('style')).toContain(
      '--smrt-admin-shell-panel-width: 360px',
    );
  });

  it('honours custom limits', async () => {
    const { shell } = renderPanel({
      panelResize: { min: 300, max: 500, step: 20 },
      panelSize: 900,
    });
    // The initial width is clamped into the limits.
    expect(separator()).toHaveAttribute('aria-valuenow', '500');
    await fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    expect(shell.panelSize('panel')).toBe(480);
  });

  it('is a full-size view over main on a phone, without a separator', async () => {
    width = 400;
    renderPanel();
    await tick();
    flushSync();
    expect(shellRoot().dataset.viewport).toBe('phone');
    expect(
      screen.queryByRole('separator', { name: 'Resize Assistant' }),
    ).toBeNull();
    expect(document.getElementById('smrt-admin-shell-main')?.inert).toBe(true);
  });

  it('only accepts the panel key for stored sizes', () => {
    expect(
      sanitizeShellSettingsDelta({ sizes: { panel: 420, left: 300 } }).delta,
    ).toEqual({ sizes: { panel: 420, left: 300 } });
    const bad = sanitizeShellSettingsDelta({ sizes: { sideways: 420 } });
    expect(bad.delta).toEqual({});
    expect(bad.issues[0]?.path).toBe('sizes.sideways');
  });
});
