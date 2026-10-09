import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import Harness from './shell-edit-harness.svelte';
import EditorHarness from './shell-layout-harness.svelte';

let hover = false;
beforeEach(() => {
  localStorage.clear();
  hover = false;
  vi.stubGlobal('matchMedia', () => ({
    matches: hover,
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

const toggle = () => screen.getByRole('button', { name: 'Edit layout' });
const zone = (name: string) =>
  document.querySelector<HTMLElement>(`[data-smrt-edit-zone="${name}"]`);
const shellSlot = (name: string) =>
  document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const live = () =>
  Array.from(document.querySelectorAll('[aria-live]'))
    .map((e) => e.textContent?.trim())
    .filter(Boolean)
    .join(' | ');

async function edit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(toggle());
}

describe('layout edit toggle', () => {
  it('is the same pencil button in header.end, pressed while editing', async () => {
    const user = userEvent.setup();
    mount();
    expect(shellSlot('header.end')?.contains(toggle())).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await edit(user);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('aria-label')).toBe('Edit layout');
    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.queryByText('Editing layout')).toBeNull();
    expect(live()).toContain('Layout editing on');
    await edit(user);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toBe('Edit layout');
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('Escape exits edit mode when no toolbar is open', async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{Escape}');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-smrt-edit-zone]')).toBeNull();
  });

  it('Escape closes an open section toolbar first, then exits', async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    await user.click(
      screen.getByRole('button', { name: 'Edit section People' }),
    );
    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('group', { name: /Options for section/ }),
    ).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{Escape}');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('is absent, and edit mode refused, when the prop is off', () => {
    const { api } = mount({ layoutEditing: false });
    expect(screen.queryByRole('button', { name: 'Edit layout' })).toBeNull();
    expect(api().editable).toBe(false);
    expect(api().setEditing(true)).toBe(false);
    expect(api().editing).toBe(false);
    expect(document.querySelector('[data-smrt-edit-zone]')).toBeNull();
  });

  it('can be driven from useShellLayout()', async () => {
    const { api } = mount();
    expect(api().setEditing(true)).toBe(true);
    await vi.waitFor(() => expect(zone('header.start')).toBeTruthy());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(api().setEditing(true)).toBe(false);
    expect(api().setEditing(false)).toBe(true);
  });

  it('follows the hidden-region fallback like any shell item', () => {
    mount({ initial: { version: 1, panels: { top: { visible: false } } } });
    expect(shellSlot('header.end')).toBeNull();
    expect(toggle()).toBeTruthy();
  });
});

describe('drop zones', () => {
  it('render only in edit mode, labelled, including empty ones', async () => {
    const user = userEvent.setup();
    mount();
    expect(document.querySelector('[data-smrt-edit-zone]')).toBeNull();
    await edit(user);
    for (const name of [
      'header.start',
      'header.center',
      'header.end',
      'footer.start',
      'leftSidebar.header',
      'leftSidebar.footer',
    ]) {
      expect(zone(name), name).toBeTruthy();
    }
    expect(zone('header.center')?.textContent).toContain('Header · Middle');
    expect(zone('leftSidebar.footer')?.textContent).toContain(
      'Left sidebar · Footer',
    );
    // The collapsed right sidebar is revealed while editing.
    expect(zone('rightSidebar.header')).toBeTruthy();
    expect(zone('rightSidebar.footer')).toBeTruthy();
    // Items keep the site look (label), plus a grip.
    expect(
      within(zone('header.end') as HTMLElement).getByRole('button', {
        name: 'Move Assistant',
      }),
    ).toBeTruthy();
    expect(
      zone('header.end')?.querySelector('[data-dock-tool="assistant"]'),
    ).toBeTruthy();
    expect(
      zone('header.start')?.querySelector('[data-testid="clock"]'),
    ).toBeTruthy();
  });

  it('moves an item between zones with the keyboard and announces it', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await edit(user);
    screen.getByRole('button', { name: 'Move Clock' }).focus();
    await user.keyboard(' ');
    expect(live()).toContain('Picked up Clock');
    await user.keyboard('{ArrowDown}');
    expect(zone('header.center')?.hasAttribute('data-drop-target')).toBe(true);
    await user.keyboard('{Enter}');
    expect(changes.at(-1)?.placements).toEqual({
      'host:clock': 'header.center',
    });
    await vi.waitFor(() =>
      expect(
        zone('header.center')?.querySelector('[data-testid="clock"]'),
      ).toBeTruthy(),
    );
    expect(live()).toContain('Moved Clock to Header · Middle');
  });

  it('Escape cancels a keyboard move', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await edit(user);
    screen.getByRole('button', { name: 'Move Clock' }).focus();
    await user.keyboard(' {ArrowDown}{Escape}');
    expect(changes).toHaveLength(0);
    expect(document.querySelector('[data-drop-target]')).toBeNull();
  });

  it('the fixed toggle has no grip; moves persist after leaving edit mode', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await edit(user);
    expect(
      screen.queryByRole('button', { name: 'Move Edit layout' }),
    ).toBeNull();
    screen.getByRole('button', { name: 'Move Assistant' }).focus();
    await user.keyboard(' {ArrowDown}{Enter}');
    expect(changes.at(-1)?.placements?.['dock:assistant']).toBeTruthy();
    await edit(user);
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-dock-tool="assistant"]'),
      ).toBeTruthy(),
    );
    expect(document.querySelector('[data-smrt-edit-zone]')).toBeNull();
  });
});

describe('right sidebar (dock)', () => {
  const regionButton = (name: string) =>
    within(
      document.querySelector(
        '[data-region-edit="rightSidebar"]',
      ) as HTMLElement,
    ).getByRole('button', { name });

  it('has a hide control, hides to a strip, and shows again', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await edit(user);
    await user.click(regionButton('Hide Right sidebar'));
    expect(changes.at(-1)?.panels?.right?.visible).toBe(false);
    const strip = document.querySelector<HTMLElement>(
      '[data-region-strip="rightSidebar"]',
    ) as HTMLElement;
    expect(strip.textContent).toContain('Right sidebar · hidden');
    expect(zone('rightSidebar.header')).toBeNull();
    await user.click(
      within(strip).getByRole('button', { name: 'Show Right sidebar' }),
    );
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-region-strip="rightSidebar"]'),
      ).toBeNull(),
    );
    expect(regionButton('Hide Right sidebar')).toBeTruthy();
  });

  it('hiding it leaves the dock unavailable, so dock toggles are inert', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    await edit(user);
    await user.click(regionButton('Hide Right sidebar'));
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-region-strip="rightSidebar"]'),
      ).toBeTruthy(),
    );
    const tool = document.querySelector<HTMLElement>(
      '[data-dock-tool="assistant"]',
    ) as HTMLElement;
    expect(tool.getAttribute('aria-disabled')).toBe('true');
    await user.click(tool);
    expect(tool.getAttribute('aria-pressed')).toBe('false');
    expect(api().panels.find((p) => p.edge === 'right')?.visible).toBe(false);
  });

  it('does not persist the sidebar edit mode reveals, and restores it on exit', async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const stored = () => localStorage.getItem('smrt-app-shell');
    const before = stored();
    mount();
    await edit(user);
    expect(
      document
        .querySelector('#smrt-admin-shell-right-panel')
        ?.getAttribute('data-state'),
    ).toBe('expanded');
    await tick();
    expect(stored()).toBe(before);
    expect(
      setItem.mock.calls.filter(([key]) => key === 'smrt-app-shell'),
    ).toHaveLength(0);
    await edit(user);
    expect(
      document
        .querySelector('#smrt-admin-shell-right-panel')
        ?.getAttribute('data-state'),
    ).toBe('collapsed');
    await tick();
    expect(stored()).toBe(before);
    expect(
      setItem.mock.calls.filter(([key]) => key === 'smrt-app-shell'),
    ).toHaveLength(0);
    setItem.mockRestore();
  });

  it('restores the collapsed sidebar when edit mode ends', async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    expect(zone('rightSidebar.header')).toBeTruthy();
    await edit(user);
    expect(zone('rightSidebar.header')).toBeNull();
    expect(
      document
        .querySelector('#smrt-admin-shell-right-panel')
        ?.getAttribute('data-state'),
    ).toBe('collapsed');
  });
});

describe('railless edge in edit mode', () => {
  const railless = {
    left: { initial: 'expanded' },
    right: { initial: 'collapsed', rail: false, presentation: 'overlay' },
  } as const;
  const rightState = () =>
    document
      .querySelector('#smrt-admin-shell-right-panel')
      ?.getAttribute('data-state');
  const indicator = () =>
    document.querySelector<HTMLButtonElement>('[data-edit-indicator="right"]');

  it('stays closed when edit mode starts and offers an indicator tab', async () => {
    const user = userEvent.setup();
    mount({ config: railless, withDock: true });
    expect(indicator()).toBeNull();
    await edit(user);
    expect(rightState()).toBe('collapsed');
    const tab = screen.getByRole('button', { name: 'Open Assistant' });
    expect(tab).toBe(indicator());
    expect(tab.getAttribute('aria-expanded')).toBe('false');
    expect(tab.getAttribute('aria-controls')).toBe(
      'smrt-admin-shell-right-panel',
    );
    await expectNoA11yViolations(document.body);
  });

  it('has no indicator without content, and none outside edit mode', async () => {
    const user = userEvent.setup();
    mount({ config: railless });
    await edit(user);
    expect(indicator()).toBeNull();
  });

  it('the indicator opens the edge and edit exit closes it again', async () => {
    const user = userEvent.setup();
    const handle = mount({ config: railless, withDock: true });
    await edit(user);
    await user.click(screen.getByRole('button', { name: 'Open Assistant' }));
    expect(rightState()).toBe('expanded');
    expect(indicator()).toBeNull();
    // The overlay makes the page inert, so leave edit mode through the API.
    const { api } = handle;
    api().setEditing(false);
    await tick();
    await tick();
    // An overlay slides out first (animationend never fires in jsdom).
    expect(
      document
        .querySelector('#smrt-admin-shell-right-panel')
        ?.hasAttribute('data-closing'),
    ).toBe(true);
  });

  it('an already-open railless edge stays open through edit mode', async () => {
    const user = userEvent.setup();
    mount({
      config: {
        ...railless,
        right: { ...railless.right, initial: 'expanded' },
      },
      withDock: true,
    });
    await edit(user);
    expect(rightState()).toBe('expanded');
    await edit(user);
    expect(rightState()).toBe('expanded');
  });
});

describe('hidden regions', () => {
  it('render as strips with a Show control', async () => {
    const user = userEvent.setup();
    const { changes } = mount({
      initial: { version: 1, panels: { bottom: { visible: false } } },
    });
    expect(document.querySelector('[data-region-strip]')).toBeNull();
    await edit(user);
    const strip = document.querySelector<HTMLElement>(
      '[data-region-strip="footer"]',
    ) as HTMLElement;
    expect(strip.textContent).toContain('Footer · hidden');
    await user.click(
      within(strip).getByRole('button', { name: 'Show Footer' }),
    );
    expect(changes.at(-1)?.panels?.bottom).toBeUndefined();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-region-strip="footer"]')).toBeNull(),
    );
    expect(zone('footer.start')).toBeTruthy();
  });
});

describe('section overlay and toolbar', () => {
  it('hides and shows a section and its title with icon toggles', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await edit(user);
    const people = screen.getByRole('button', {
      name: 'Show People in navigation',
    });
    expect(people.getAttribute('aria-pressed')).toBe('true');
    await user.click(people);
    expect(changes.at(-1)?.hidden).toContain('People');
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Show People in navigation' })
          .getAttribute('aria-pressed'),
      ).toBe('false'),
    );
    await user.click(
      screen.getByRole('button', { name: 'Show title of Content' }),
    );
    expect(changes.at(-1)?.sections?.Content?.showTitle).toBe(false);
  });

  it('renders host section actions in the overlay', async () => {
    const user = userEvent.setup();
    mount({ withActions: true });
    await edit(user);
    expect(
      screen.getByRole('button', { name: 'Options for Content' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Options for People' }),
    ).toBeTruthy();
  });

  it('renames through the toolbar, opened by click', async () => {
    const user = userEvent.setup();
    const { changes } = mount({ withActions: true });
    await edit(user);
    await user.click(
      screen.getByRole('button', { name: 'Edit section People' }),
    );
    const toolbar = screen.getByRole('group', {
      name: 'Options for section People',
    });
    const input = within(toolbar).getByRole('textbox', {
      name: 'Name of section People',
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await user.clear(input);
    await user.type(input, 'Team{Enter}');
    expect(changes.at(-1)?.sections?.People?.label).toBe('Team');
    expect(
      within(toolbar).getByRole('button', { name: /Options for/ }),
    ).toBeTruthy();
    expect(
      within(toolbar).queryByRole('button', { name: /Delete section/ }),
    ).toBeNull();
  });

  it('Escape closes the toolbar and returns focus; only one is open', async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    await user.click(
      screen.getByRole('button', { name: 'Edit section People' }),
    );
    expect(
      screen.getAllByRole('group', { name: /Options for section/ }),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole('button', { name: 'Edit section Content' }),
    );
    const open = screen.getAllByRole('group', { name: /Options for section/ });
    expect(open).toHaveLength(1);
    expect(open[0].getAttribute('aria-label')).toContain('Content');
    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('group', { name: /Options for section/ }),
    ).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Edit section Content' }),
    );
  });

  it('opens on hover with a fine pointer and on click only otherwise', async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    const heading = screen.getByRole('button', { name: 'Edit section People' });

    hover = false; // touch / no hover
    await fireEvent.pointerEnter(heading);
    expect(
      screen.queryByRole('group', { name: /Options for section/ }),
    ).toBeNull();
    await user.click(heading);
    expect(
      screen.getByRole('group', { name: /Options for section/ }),
    ).toBeTruthy();
    await user.keyboard('{Escape}');

    hover = true; // desktop
    await fireEvent.pointerEnter(heading);
    expect(
      screen.getByRole('group', { name: 'Options for section People' }),
    ).toBeTruthy();
    await fireEvent.pointerLeave(
      heading.closest('[data-nav-section]') as Element,
    );
    expect(
      screen.queryByRole('group', { name: /Options for section/ }),
    ).toBeNull();
    // A click pins it: leaving does not close it.
    await user.click(heading);
    await fireEvent.pointerLeave(
      heading.closest('[data-nav-section]') as Element,
    );
    expect(
      screen.getByRole('group', { name: 'Options for section People' }),
    ).toBeTruthy();
  });

  it('creates a custom section and deletes it from the toolbar', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await edit(user);
    await user.click(screen.getByRole('button', { name: 'New section' }));
    expect(changes.at(-1)?.customSections).toHaveLength(1);
    const toolbar = await screen.findByRole('group', {
      name: 'Options for section New section',
    });
    await user.click(
      within(toolbar).getByRole('button', {
        name: 'Delete section New section',
      }),
    );
    expect(changes.at(-1)?.customSections ?? []).toHaveLength(0);
    expect(
      screen.queryByRole('group', { name: /Options for section/ }),
    ).toBeNull();
  });
});

describe('renaming a navigation item in place', () => {
  const rename = () => screen.getByRole('button', { name: 'Rename Users' });

  it('Enter saves, Escape cancels, reset restores the original', async () => {
    const user = userEvent.setup();
    const { changes } = mount();
    await edit(user);
    await user.click(rename());
    const input = screen.getByRole('textbox', { name: 'Name of item Users' });
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await user.clear(input);
    await user.type(input, 'Members{Enter}');
    expect(changes.at(-1)?.items).toEqual({ '/users': { label: 'Members' } });
    expect(screen.queryByRole('textbox', { name: /Name of item/ })).toBeNull();
    // Edit mode stays on; the original is the tooltip.
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Members').getAttribute('title')).toBe('Users');

    await user.click(screen.getByRole('button', { name: 'Rename Members' }));
    const again = screen.getByRole('textbox', { name: 'Name of item Members' });
    await user.clear(again);
    await user.type(again, 'Nope{Escape}');
    expect(changes.at(-1)?.items).toEqual({ '/users': { label: 'Members' } });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    await user.click(
      screen.getByRole('button', { name: 'Reset Members to Users' }),
    );
    expect(changes.at(-1)).toEqual({ version: 1 });
    expect(screen.getByText('Users')).toBeTruthy();
  });

  it('has no axe violations while renaming', async () => {
    const user = userEvent.setup();
    render(Harness, {
      initial: { version: 1, items: { '/posts': { label: 'Articles' } } },
    });
    await edit(user);
    await user.click(rename());
    await expectNoA11yViolations(
      document.querySelector('.smrt-admin-shell') as HTMLElement,
    );
  });
});

describe('accessibility', () => {
  it('edit mode has no axe violations with a toolbar open', async () => {
    const user = userEvent.setup();
    render(Harness, { withActions: true });
    await edit(user);
    await user.click(
      screen.getByRole('button', { name: 'Edit section People' }),
    );
    // Whole shell, including the left sidebar region (its former invalid
    // role="navigation" on <aside> is fixed).
    await expectNoA11yViolations(
      document.querySelector('.smrt-admin-shell') as HTMLElement,
    );
  });
});

describe('ShellLayoutEditor', () => {
  it('no longer has a Placement section', () => {
    render(EditorHarness, { initial: null });
    expect(screen.queryByText('Placement')).toBeNull();
    expect(screen.queryByTestId('shell-placement')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reset to defaults' }),
    ).toBeTruthy();
  });
});

describe('placement API', () => {
  it('moves and resets items and ignores unknown ones', async () => {
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
});

describe('floating layout edit toggle', () => {
  const floating = { layoutEditing: { floating: true } };
  const fixedToggle = () =>
    document.querySelector<HTMLElement>('.smrt-layout-toggle--floating');

  it('renders a fixed round button that is not a placeable item', () => {
    const { api } = mount(floating);
    expect(fixedToggle()).toBeTruthy();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(
      document.querySelector('[data-slot] .smrt-layout-toggle'),
    ).toBeNull();
    expect(api().placementItems.some((i) => i.id === 'item:layout-edit')).toBe(
      false,
    );
  });

  it('toggles editing and shows the pressed state, with no grip', async () => {
    const user = userEvent.setup();
    const { api } = mount(floating);
    await edit(user);
    expect(api().editing).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(fixedToggle()?.querySelector('.smrt-edit-item__grip')).toBeNull();
    expect(
      document.querySelector('[data-smrt-edit-zone] .smrt-layout-toggle'),
    ).toBeNull();
    await edit(user);
    expect(api().editing).toBe(false);
  });

  it('stays put when the header is hidden and reserves room instead', async () => {
    mount({
      ...floating,
      initial: { version: 1, panels: { top: { visible: false } } },
    });
    expect(fixedToggle()).toBeTruthy();
    expect(toggle()).toBeTruthy();
    const root = document.querySelector<HTMLElement>('.smrt-admin-shell');
    await vi.waitFor(() =>
      expect(
        root?.style.getPropertyValue('--smrt-shell-floating-reserve-block'),
      ).not.toBe('0px'),
    );
    expect(
      root?.style.getPropertyValue('--smrt-shell-floating-reserve-inline'),
    ).toBe('0px');
  });

  it('reserves room at the top of main when header and right sidebar are hidden', async () => {
    mount({
      ...floating,
      initial: {
        version: 1,
        panels: { top: { visible: false }, right: { visible: false } },
      },
    });
    const root = document.querySelector<HTMLElement>('.smrt-admin-shell');
    await vi.waitFor(() =>
      expect(
        root?.style.getPropertyValue('--smrt-shell-floating-reserve-main'),
      ).not.toBe('0px'),
    );
    expect(
      root?.style.getPropertyValue('--smrt-shell-floating-reserve-block'),
    ).toBe('0px');
    expect(
      root?.style.getPropertyValue('--smrt-shell-floating-reserve-inline'),
    ).toBe('0px');
  });

  it('keeps the reserve when the shell re-renders its own style', async () => {
    const user = userEvent.setup();
    mount({
      ...floating,
      initial: {
        version: 1,
        panels: { top: { visible: false }, right: { visible: false } },
      },
    });
    const root = document.querySelector<HTMLElement>('.smrt-admin-shell');
    const reserve = () =>
      root?.style.getPropertyValue('--smrt-shell-floating-reserve-main');
    await vi.waitFor(() => expect(reserve()).not.toBe('0px'));
    // Edit mode changes the shell's layout tracks (a root style re-render).
    await edit(user);
    await edit(user);
    expect(reserve()).not.toBe('0px');
  });

  it('has no axe violations', async () => {
    const { container } = render(Harness, floating);
    await expectNoA11yViolations(container);
  });
});
