import { cleanup, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import Harness from './shell-placement-harness.svelte';

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
    config: { left: { initial: 'expanded' } },
    ...props,
    onChange: (layout: ShellLayout) => changes.push(layout),
    onApi: (a: ShellLayoutController) => {
      api = a;
    },
  });
  return { changes, api: () => api as ShellLayoutController };
}

/** The shell's own slot (the editor's map has none with data-slot). */
const shellSlot = (name: string) =>
  document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const map = () => within(screen.getByTestId('shell-placement'));
const mapSlot = (name: string) =>
  screen
    .getByTestId('shell-placement')
    .querySelector<HTMLElement>(`[data-smrt-sortable-container-id="${name}"]`)!;
const live = () =>
  Array.from(document.querySelectorAll('[aria-live]'))
    .map((e) => e.textContent?.trim())
    .filter(Boolean)
    .join(' | ');

describe('AppShell item placement', () => {
  it('renders items in default slots and lists them in the map', () => {
    mount();
    expect(
      shellSlot('header.start')?.querySelector('[data-testid="clock"]'),
    ).toBeTruthy();
    expect(
      shellSlot('header.end')?.querySelector('[data-dock-tool="assistant"]'),
    ).toBeTruthy();
    expect(shellSlot('footer.center')?.textContent).toContain('Legacy');
    expect(within(mapSlot('header.end')).getByText('Assistant')).toBeTruthy();
    expect(within(mapSlot('header.start')).getByText('Clock')).toBeTruthy();
    expect(
      within(mapSlot('footer.center')).getByText('Footer, middle content'),
    ).toBeTruthy();
  });

  it('renders no placement section without movable items', () => {
    mount({ toggles: [], withHostSlot: false, initial: null });
    // the host clock item is always present, so the map stays
    expect(screen.queryByTestId('shell-placement')).toBeTruthy();
  });

  it('moves a toggle with the Move to select and updates the shell', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Move Assistant to' }),
      'footer.end',
    );
    expect(changes.at(-1)).toEqual({
      version: 1,
      placements: { 'dock:assistant': 'footer.end' },
    });
    await vi.waitFor(() => {
      expect(
        shellSlot('footer.end')?.querySelector('[data-dock-tool="assistant"]'),
      ).toBeTruthy();
      expect(shellSlot('header.end')).toBeNull();
    });
    expect(within(mapSlot('footer.end')).getByText('Assistant')).toBeTruthy();
  });

  it('moves an item between slots with the keyboard and announces it', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    screen.getByRole('button', { name: 'Move Clock' }).focus();
    await user.keyboard(' {ArrowDown}');
    expect(live()).toContain('Clock');
    await user.keyboard('{Enter}');
    expect(changes.at(-1)?.placements).toBeDefined();
    const slot = changes.at(-1)?.placements?.['host:clock'];
    expect(slot).toBeTruthy();
    expect(slot).not.toBe('header.start');
    await vi.waitFor(() =>
      expect(
        shellSlot(slot as string)?.querySelector('[data-testid="clock"]'),
      ).toBeTruthy(),
    );
  });

  it('resets a moved item to its default slot', async () => {
    const user = userEvent.setup();
    const { changes } = mount({
      initial: { version: 1, placements: { 'dock:assistant': 'footer.start' } },
    });
    expect(
      shellSlot('footer.start')?.querySelector('[data-dock-tool="assistant"]'),
    ).toBeTruthy();
    await user.click(
      screen.getByRole('button', {
        name: 'Reset Assistant to its default slot',
      }),
    );
    expect(changes.at(-1)).toEqual({ version: 1 });
    await vi.waitFor(() =>
      expect(
        shellSlot('header.end')?.querySelector('[data-dock-tool="assistant"]'),
      ).toBeTruthy(),
    );
  });

  it('dims hidden regions and falls their items back', () => {
    mount({
      config: { left: { initial: 'expanded' } },
      initial: {
        version: 1,
        panels: { bottom: { visible: false } },
        placements: { 'dock:assistant': 'footer.end' },
      },
    });
    const hiddenSlot = mapSlot('footer.end');
    expect(hiddenSlot.querySelector('[data-region-hidden]')).toBeTruthy();
    expect(
      mapSlot('header.end').querySelector('[data-region-hidden]'),
    ).toBeNull();
    expect(map().getAllByText(/Footer is hidden/).length).toBeGreaterThan(0);
    // The toggle falls back to the nearest visible slot instead of vanishing.
    expect(
      document.querySelector('[data-slot] [data-dock-tool="assistant"]'),
    ).toBeTruthy();
    expect(shellSlot('footer.end')).toBeNull();
    // The editor still lists the item under its chosen slot.
    expect(within(hiddenSlot).getByText('Assistant')).toBeTruthy();
  });

  it('the layout API moves and resets items and ignores unknown ones', async () => {
    const { changes, api } = mount();
    expect(api().placeItem('dock:assistant', 'leftSidebar.footer')).toBe(true);
    expect(api().placeItem('dock:assistant', 'leftSidebar.footer')).toBe(false);
    expect(api().placeItem('dock:nope', 'footer.end')).toBe(false);
    expect(api().placeItem('dock:assistant', 'nowhere' as never)).toBe(false);
    expect(changes.at(-1)?.placements).toEqual({
      'dock:assistant': 'leftSidebar.footer',
    });
    await vi.waitFor(() =>
      expect(
        api().placementItems.find((i) => i.id === 'dock:assistant')?.slot,
      ).toBe('leftSidebar.footer'),
    );
    expect(api().resetItem('dock:assistant')).toBe(true);
    expect(api().resetItem('dock:assistant')).toBe(false);
  });

  it('keeps layouts without placements working', () => {
    mount({ initial: { version: 1, hidden: ['/x'] } });
    expect(
      shellSlot('header.end')?.querySelector('[data-dock-tool="assistant"]'),
    ).toBeTruthy();
  });
});
