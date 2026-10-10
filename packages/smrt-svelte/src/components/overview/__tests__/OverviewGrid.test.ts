import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverviewController } from '../controller.svelte.js';
import type { OverviewOverride } from '../types.js';
import { coreRegistry, definition, loadedFor } from './app-fixtures.js';
import Harness from './overview-harness.svelte';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function mount(
  extra: {
    editing?: boolean;
    override?: unknown;
    canCustomize?: boolean;
    loadWidget?: (widget: never) => Promise<unknown>;
    onchange?: (override: OverviewOverride | null) => void;
  } = {},
) {
  const registry = coreRegistry();
  const loaded = await loadedFor(registry, extra.override ?? null);
  let api: OverviewController | undefined;
  const result = render(Harness, {
    props: {
      options: {
        definition,
        registry,
        override:
          extra.override === undefined ? undefined : () => extra.override,
        canCustomize:
          extra.canCustomize === undefined
            ? undefined
            : () => extra.canCustomize === true,
        onchange: extra.onchange,
        loaded,
        loadWidget: extra.loadWidget as never,
      },
      gridProps: {
        editing: extra.editing ?? false,
        models: [
          { value: 'events:Event', label: 'Events' },
          { value: 'events:Venue', label: 'Venues' },
        ],
      },
      onApi: (controller: OverviewController) => {
        api = controller;
      },
    },
  });
  return { ...result, controller: api as OverviewController, registry };
}

const titles = () =>
  Array.from(document.querySelectorAll('.smrt-overview__title')).map((node) =>
    node.textContent?.trim(),
  );

describe('OverviewGrid (view)', () => {
  it('renders every widget from the loaded data, in order, with no edit chrome', async () => {
    await mount();
    expect(titles()).toEqual(['Metric', 'Chart', 'Welcome', 'Record list']);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('count of events:Event')).toBeInTheDocument();
    expect(screen.getByText('Spring gala').closest('a')).toHaveAttribute(
      'href',
      '/events/r1',
    );
    // a javascript: href is never linked
    expect(screen.getByText('Board meeting').closest('a')).toBeNull();
    expect(screen.getByText('Hi').tagName).toBe('STRONG');
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('exposes spans as data attributes and a CSS variable', async () => {
    await mount();
    const items = Array.from(
      document.querySelectorAll('[data-smrt-overview-item]'),
    );
    expect(items.map((el) => el.getAttribute('data-span'))).toEqual([
      '1',
      '2',
      '1',
      '2',
    ]);
    expect((items[1] as HTMLElement).style.getPropertyValue('--span')).toBe(
      '2',
    );
  });

  it('draws loading before data when a widget has none yet, and error with retry', async () => {
    const registry = coreRegistry();
    const loadWidget = vi.fn(() => new Promise(() => {}));
    render(Harness, {
      props: { options: { definition, registry, loadWidget } },
    });
    // no loaded data and a loader: every data widget is loading
    await waitFor(() =>
      expect(screen.getAllByText('Loading').length).toBeGreaterThan(0),
    );
  });

  it('shows an error tile for a failed load and retries it', async () => {
    const registry = coreRegistry();
    const loaded = await loadedFor(registry);
    loaded.widgets[0] = {
      ...loaded.widgets[0],
      status: 'error',
      data: undefined,
      error: { code: 'load_failed' },
    };
    const loadWidget = vi.fn(async () => ({ value: 5 }));
    render(Harness, {
      props: { options: { definition, registry, loaded, loadWidget } },
    });
    expect(
      screen.getByText('This widget could not be loaded.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument());
    expect(loadWidget).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = await mount();
    await expectNoA11yViolations(container);
  });
});

describe('OverviewGrid (edit)', () => {
  it('does not enter edit mode for a viewer who may not customize', async () => {
    await mount({ editing: true, canCustomize: false });
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('shows icon-only controls, a slider and the toolbar while editing', async () => {
    await mount({ editing: true });
    expect(
      screen.getByRole('toolbar', { name: 'Customize overview' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Move Welcome' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Configure Welcome' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove Welcome' }),
    ).toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: 'Resize Welcome' });
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    expect(slider).toHaveAttribute('aria-valuetext', '1 of 4 columns');
    expect(
      screen.getByRole('button', { name: 'Reset overview to default' }),
    ).toBeDisabled();
  });

  it('reorders from the keyboard and reports the sparse override', async () => {
    const onchange = vi.fn();
    const { controller } = await mount({ editing: true, onchange });
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Move Metric' }).focus();
    await user.keyboard(' ');
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Picked up Metric',
    );
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    expect(controller.document.widgets.map((x) => x.id)).toEqual([
      'w2',
      'w3',
      'w1',
      'w4',
    ]);
    expect(onchange).toHaveBeenCalledWith({
      version: 1,
      order: ['w2', 'w3', 'w1', 'w4'],
    });
    await waitFor(() =>
      expect(titles()).toEqual(['Chart', 'Welcome', 'Metric', 'Record list']),
    );
    expect(
      screen.getByRole('button', { name: 'Reset overview to default' }),
    ).toBeEnabled();
  });

  it('escape cancels a keyboard move without changing the order', async () => {
    const onchange = vi.fn();
    await mount({ editing: true, onchange });
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Move Metric' }).focus();
    await user.keyboard(' {ArrowRight}{Escape}');
    expect(onchange).not.toHaveBeenCalled();
    expect(titles()[0]).toBe('Metric');
  });

  it('resizes by span from the keyboard, within the widget range', async () => {
    const onchange = vi.fn();
    const { controller } = await mount({ editing: true, onchange });
    const user = userEvent.setup();
    const slider = screen.getByRole('slider', { name: 'Resize Welcome' });
    slider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(controller.document.widgets[2].span).toBe(3);
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuenow', '3'));
    expect(slider).toHaveAttribute('aria-valuetext', '3 of 4 columns');
    await user.keyboard('{End}');
    expect(controller.document.widgets[2].span).toBe(4);
    await user.keyboard('{ArrowRight}');
    expect(controller.document.widgets[2].span).toBe(4);
    await user.keyboard('{Home}');
    expect(controller.document.widgets[2].span).toBe(1);
    expect(onchange).toHaveBeenLastCalledWith(null);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Welcome is now 1 of 4 columns wide.',
    );
  });

  it('removes a widget and resets back to the defaults', async () => {
    const { controller } = await mount({ editing: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove Welcome' }));
    expect(controller.document.widgets.map((x) => x.id)).toEqual([
      'w1',
      'w2',
      'w4',
    ]);
    await user.click(
      screen.getByRole('button', { name: 'Reset overview to default' }),
    );
    expect(controller.document.widgets.map((x) => x.id)).toEqual([
      'w1',
      'w2',
      'w3',
      'w4',
    ]);
    expect(controller.customized).toBe(false);
  });

  it('configures a widget through its option form and rejects invalid options', async () => {
    const { controller } = await mount({ editing: true });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Configure Record list' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Configure Record list',
    });
    const rows = within(dialog).getByLabelText('Rows');
    await user.clear(rows);
    await user.type(rows, '99');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('This value is out of range.'),
    ).toBeInTheDocument();
    expect(controller.document.widgets[3].options.limit).toBe(5);
    await user.clear(rows);
    await user.type(rows, '8');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(controller.document.widgets[3].options.limit).toBe(8),
    );
  });

  it('adds a widget; one with required options opens the form first', async () => {
    const { controller } = await mount({ editing: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    const add = await screen.findByRole('dialog', { name: 'Add a widget' });
    await user.click(within(add).getByRole('button', { name: /Note/ }));
    expect(controller.document.widgets.map((x) => x.type)).toEqual([
      'metric',
      'chart',
      'note',
      'records',
      'note',
    ]);
    expect(controller.document.widgets[4].id).toBe('w5');

    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    const again = await screen.findByRole('dialog', { name: 'Add a widget' });
    await user.click(within(again).getByRole('button', { name: /Metric/ }));
    const form = await screen.findByRole('dialog', { name: 'Add Metric' });
    // the model is required and has no default
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText('This field is required.'),
    ).toBeInTheDocument();
    await user.selectOptions(
      within(form).getByLabelText(/Model/),
      'events:Venue',
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(controller.document.widgets).toHaveLength(6));
    expect(controller.document.widgets[5].options.model).toBe('events:Venue');
  });

  it('loads data for a widget whose options changed', async () => {
    const loadWidget = vi.fn(async () => ({ value: 1234 }));
    const registry = coreRegistry();
    const loaded = await loadedFor(registry);
    let api: OverviewController | undefined;
    render(Harness, {
      props: {
        options: { definition, registry, loaded, loadWidget },
        gridProps: { editing: true },
        onApi: (c: OverviewController) => {
          api = c;
        },
      },
    });
    expect(loadWidget).not.toHaveBeenCalled();
    api?.setOptions('w1', { model: 'events:Venue', measure: 'count' });
    await waitFor(() => expect(screen.getByText('1,234')).toBeInTheDocument());
    expect(loadWidget).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations in edit mode', async () => {
    const { container } = await mount({ editing: true });
    await expectNoA11yViolations(container);
  });
});
