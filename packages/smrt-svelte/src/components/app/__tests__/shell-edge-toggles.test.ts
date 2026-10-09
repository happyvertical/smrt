import { cleanup, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import Harness from './shell-edit-harness.svelte';

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

const zone = (name: string) =>
  document.querySelector<HTMLElement>(`[data-smrt-edit-zone="${name}"]`);
const slot = (name: string) =>
  document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const editToggle = () => screen.getByRole('button', { name: 'Edit layout' });
const press = (code: string) =>
  window.dispatchEvent(
    new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }),
  );

describe('edge toggles are opt-in (default off)', () => {
  it('draws no edge toggle buttons or hotkey hints', () => {
    render(Harness, { edgeToggles: false });
    expect(document.querySelector('.smrt-admin-shell__edge-toggle')).toBeNull();
    expect(
      document.querySelector('.smrt-admin-shell__edge-toggle-kbd'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /^Header/ })).toBeNull();
  });

  it('ignores WASD and ? when no edge has a toggle', () => {
    render(Harness, {});
    const states = () => ({
      top: document
        .querySelector('.smrt-admin-shell__edge--top')
        ?.getAttribute('data-state'),
      left: document
        .querySelector('.smrt-admin-shell__edge--left')
        ?.getAttribute('data-state'),
    });
    const before = states();
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) press(code);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '?', shiftKey: true, code: 'Slash' }),
    );
    expect(states()).toEqual(before);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('lays regions out inline: the left sidebar is open and the header is a plain band', () => {
    render(Harness, {
      config: { left: { initial: 'collapsed' }, top: { initial: 'collapsed' } },
    });
    const left = document.querySelector('.smrt-admin-shell__edge--left');
    expect(left?.getAttribute('data-state')).toBe('expanded');
    expect(slot('leftSidebar.header')).toBeNull();
    expect(document.querySelector('a[href="/posts"]')).toBeTruthy();
    // The header band carries its slots with no drop-down drawer.
    expect(document.querySelector('.smrt-admin-shell__drawer--top')).toBeNull();
    expect(slot('header.end')).toBeTruthy();
  });

  it('draws toggles and honours hotkeys when edgeToggles is true', async () => {
    render(Harness, {
      edgeToggles: true,
      config: { left: { initial: 'expanded' } },
    });
    expect(
      document.querySelectorAll('.smrt-admin-shell__edge-toggle').length,
    ).toBeGreaterThan(1);
    expect(
      document.querySelector('.smrt-admin-shell__edge-toggle-kbd'),
    ).toBeTruthy();
    press('KeyW');
    await vi.waitFor(() =>
      expect(
        document
          .querySelector('.smrt-admin-shell__edge--top')
          ?.getAttribute('data-state'),
      ).toBe('expanded'),
    );
  });

  it('accepts a per-edge map', () => {
    render(Harness, { edgeToggles: { bottom: true } });
    expect(
      document.querySelectorAll('.smrt-admin-shell__edge-toggle'),
    ).toHaveLength(1);
    expect(
      document.querySelector('footer .smrt-admin-shell__edge-toggle'),
    ).toBeTruthy();
  });
});

describe('brand is a movable header item', () => {
  it('renders in header.start by default', () => {
    render(Harness, { title: 'Planner' });
    expect(slot('header.start')?.textContent).toContain('Planner');
  });

  it('moves with placements', () => {
    render(Harness, {
      title: 'Planner',
      initial: {
        version: 1,
        placements: { 'item:brand': 'footer.start' },
      } satisfies ShellLayout,
    });
    expect(slot('header.start')?.textContent ?? '').not.toContain('Planner');
    expect(slot('footer.start')?.textContent).toContain('Planner');
  });

  it('shows inside header.start in edit mode with nothing else outside the cells', async () => {
    const user = userEvent.setup();
    render(Harness, { title: 'Planner' });
    await user.click(editToggle());
    const start = zone('header.start') as HTMLElement;
    expect(start.textContent).toContain('Planner');
    expect(
      within(start).getByRole('button', { name: 'Move App title' }),
    ).toBeTruthy();
    const band = document.querySelector('.smrt-admin-shell__band--top');
    const outside = [...(band?.children ?? [])].filter(
      (child) =>
        !child.hasAttribute('data-smrt-edit-zone') &&
        !child.hasAttribute('data-region-edit'),
    );
    expect(outside).toEqual([]);
    expect(band?.querySelector('.smrt-admin-shell__edge-toggle')).toBeNull();
  });
});

describe('hiding a visible region from edit mode', () => {
  const hideButton = (region: string) =>
    screen.getByRole('button', { name: `Hide ${region}` });

  it('hides it, shows the strip, and Show restores it', async () => {
    const user = userEvent.setup();
    render(Harness, {});
    await user.click(editToggle());
    expect(hideButton('Left sidebar').getAttribute('title')).toBe(
      'Hide Left sidebar',
    );
    await user.click(hideButton('Left sidebar'));
    const show = await screen.findByRole('button', {
      name: 'Show Left sidebar',
    });
    expect(
      document.querySelector('[data-region-strip="leftSidebar"]'),
    ).toBeTruthy();
    expect(zone('leftSidebar.header')).toBeNull();
    await user.click(show);
    await vi.waitFor(() => expect(zone('leftSidebar.header')).toBeTruthy());
    expect(
      screen.queryByRole('button', { name: 'Show Left sidebar' }),
    ).toBeNull();
  });

  it('keeps the edit toggle reachable after hiding the header that holds it', async () => {
    const user = userEvent.setup();
    render(Harness, {});
    await user.click(editToggle());
    await user.click(hideButton('Header'));
    await screen.findByRole('button', { name: 'Show Header' });
    expect(slot('header.end')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit layout' })).toBeTruthy();
  });

  it('disables hiding the last visible region, with an explanation', async () => {
    const user = userEvent.setup();
    render(Harness, {
      initial: {
        version: 1,
        panels: {
          left: { visible: false },
          right: { visible: false },
          bottom: { visible: false },
        },
      } satisfies ShellLayout,
    });
    await user.click(editToggle());
    const hide = hideButton('Header') as HTMLButtonElement;
    expect(hide.disabled).toBe(true);
    expect(hide.getAttribute('title')).toContain('at least one region');
  });
});
