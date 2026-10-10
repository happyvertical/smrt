import { createToaster } from '@happyvertical/smrt-ui/feedback';
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOverviewAssistant,
  type OverviewAssistant,
} from '../assistant.svelte.js';
import { createOverview } from '../controller.svelte.js';
import type { OverviewOverride } from '../types.js';
import { coreRegistry, definition, loadedFor } from './app-fixtures.js';
import Harness from './assistant-harness.svelte';

const make = (extra: Record<string, unknown> = {}) => {
  const onchange = vi.fn();
  const controller = createOverview({
    definition,
    registry: coreRegistry(),
    onchange,
    ...extra,
  });
  return {
    controller,
    onchange,
    assistant: createOverviewAssistant(controller),
  };
};

/** The Undo affordance's own live region (the grid has another). */
const undoStatus = (container: HTMLElement): HTMLElement =>
  container.querySelector(
    '.smrt-overview-assistant-undo [role="status"]',
  ) as HTMLElement;

const tool = (
  tools: Map<string, ReturnType<OverviewAssistant['tools']>[number]>,
  name: string,
) => {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const parse = (value: string) => JSON.parse(value) as Record<string, unknown>;

describe('OverviewAssistant', () => {
  it('applies a batch through the controller so the grid updates live', () => {
    const { controller, assistant, onchange } = make();
    const result = assistant.apply([
      { op: 'add', type: 'note', options: { body: 'Hi' } },
      { op: 'remove', id: 'w2' },
    ]);
    expect(result).toMatchObject({ ok: true, batchId: expect.any(String) });
    expect(controller.document.widgets.map((w) => w.id)).toEqual([
      'w1',
      'w3',
      'w4',
      'w5',
    ]);
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(assistant.lastBatch).toMatchObject({
      before: null,
      counts: { add: 1, remove: 1 },
    });
  });

  it('applies nothing when one operation is invalid', () => {
    const { controller, assistant, onchange } = make();
    const result = assistant.apply([
      { op: 'remove', id: 'w1' },
      { op: 'add', type: 'metric', options: { model: 'billing:Invoice' } },
    ]);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(controller.override).toBeNull();
    expect(onchange).not.toHaveBeenCalled();
    expect(assistant.lastBatch).toBeNull();
  });

  it('refuses when the viewer may not customize', () => {
    const { assistant, onchange } = make({ canCustomize: () => false });
    expect(assistant.apply([{ op: 'remove', id: 'w1' }])).toMatchObject({
      ok: false,
      reason: 'not_allowed',
    });
    expect(onchange).not.toHaveBeenCalled();
  });

  it('undo restores the exact override from before the batch', () => {
    const { controller, assistant } = make();
    controller.resize('w1', 3);
    const before = controller.override;
    expect(before).not.toBeNull();
    const applied = assistant.apply([
      {
        op: 'configure',
        id: 'w1',
        options: { measure: 'sum', field: 'total' },
      },
      { op: 'move', id: 'w4', index: 0 },
    ]);
    if (!applied.ok || !applied.batchId) throw new Error('expected a batch');
    expect(controller.override).not.toEqual(before);
    expect(assistant.undo('other')).toEqual({
      ok: false,
      reason: 'nothing_to_undo',
    });
    expect(assistant.undo(applied.batchId)).toEqual({ ok: true });
    expect(controller.override).toEqual(before);
    expect(assistant.lastBatch).toBeNull();
    expect(assistant.undo()).toEqual({ ok: false, reason: 'nothing_to_undo' });
  });

  it('does not undo over an edit the person made afterwards', () => {
    const { controller, assistant } = make();
    assistant.apply([{ op: 'remove', id: 'w2' }]);
    controller.resize('w1', 2);
    const edited = controller.override;
    expect(assistant.undo()).toEqual({ ok: false, reason: 'changed_since' });
    expect(controller.override).toEqual(edited);
  });

  it('offers no undo for a batch that changes nothing', () => {
    const { assistant, onchange } = make();
    expect(assistant.apply([{ op: 'move', id: 'w1', index: 0 }])).toEqual({
      ok: true,
      batchId: null,
      results: [{ index: 0, op: 'move', id: 'w1' }],
    });
    expect(onchange).not.toHaveBeenCalled();
    expect(assistant.lastBatch).toBeNull();
  });

  it('exposes describe/apply/undo as page tools with JSON results', async () => {
    const { assistant, controller } = make();
    const tools = new Map(assistant.tools().map((tool) => [tool.name, tool]));
    expect([...tools.keys()]).toEqual([
      'overview_describe',
      'overview_apply',
      'overview_undo',
    ]);
    expect(tools.get('overview_describe')?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(tools.get('overview_apply')?.annotations?.destructiveHint).toBe(
      false,
    );
    const described = parse(await tool(tools, 'overview_describe').execute({}));
    expect(described.id).toBe('events.home');

    const rejected = parse(
      await tool(tools, 'overview_apply').execute({
        operations: [{ op: 'add', type: 'map' }],
      }),
    );
    expect(rejected).toMatchObject({
      ok: false,
      issues: [{ index: 0, code: 'unknown_type' }],
    });
    const applied = parse(
      await tool(tools, 'overview_apply').execute({
        operations: [{ op: 'remove', id: 'w3' }],
      }),
    );
    expect(applied).toMatchObject({ ok: true, changed: true });
    expect(controller.document.widgets.map((w) => w.id)).not.toContain('w3');
    const undone = parse(
      await tool(tools, 'overview_undo').execute({
        undoToken: applied.undoToken,
      }),
    );
    expect(undone.ok).toBe(true);
    expect(controller.override).toBeNull();
  });

  it('rejects an invalid tool prefix', () => {
    const { controller } = make();
    expect(() =>
      createOverviewAssistant(controller, { toolPrefix: 'Bad Name' }),
    ).toThrow(/toolPrefix/);
  });

  it('shows a toast whose action undoes the batch', async () => {
    const toaster = createToaster();
    const controller = createOverview({ definition, registry: coreRegistry() });
    const assistant = createOverviewAssistant(controller, { toaster });
    const seen: Array<{ message: string; label?: string }> = [];
    toaster.subscribe((toasts) => {
      for (const toast of toasts) {
        seen.push({ message: toast.message, label: toast.action?.label });
      }
    });
    assistant.apply([{ op: 'remove', id: 'w1' }]);
    expect(seen.at(-1)).toEqual({
      message: 'The assistant updated this overview.',
      label: 'Undo',
    });
    let current: Parameters<Parameters<typeof toaster.subscribe>[0]>[0] = [];
    toaster.subscribe((toasts) => {
      current = toasts;
    });
    await current[0]?.action?.run();
    expect(controller.override).toBeNull();
    expect(current).toEqual([]);
    toaster.clear();
  });
});

describe('OverviewAssistantUndo', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function mount(onchange = vi.fn()) {
    const registry = coreRegistry();
    let api: OverviewAssistant | undefined;
    const result = render(Harness, {
      props: {
        options: {
          definition,
          registry,
          onchange,
          loaded: await loadedFor(registry),
        },
        onApi: (assistant: OverviewAssistant) => {
          api = assistant;
        },
      },
    });
    return { ...result, assistant: api as OverviewAssistant, onchange };
  }

  it('offers Undo after an assistant batch and restores the overview', async () => {
    const user = userEvent.setup();
    const { assistant, container, onchange } = await mount();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();

    assistant.apply([{ op: 'remove', id: 'w3' }]);
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undoStatus(container).textContent).toContain(
      'The assistant updated this overview.',
    );
    // The grid re-rendered without the removed note.
    await waitFor(() =>
      expect(
        container.querySelector('[data-smrt-overview-item="w3"]'),
      ).toBeNull(),
    );
    await expectNoA11yViolations(container);

    await user.click(undo);
    expect(onchange).toHaveBeenLastCalledWith(null);
    expect(assistant.lastBatch).toBeNull();
    await waitFor(() =>
      expect(undoStatus(container).textContent).toContain(
        'The assistant change was undone.',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('says so when the overview changed after the batch', async () => {
    const user = userEvent.setup();
    const { assistant, container } = await mount();
    assistant.apply([{ op: 'remove', id: 'w3' }]);
    const undo = await screen.findByRole('button', { name: 'Undo' });
    assistant.controller.resize('w1', 2);
    await user.click(undo);
    await waitFor(() =>
      expect(undoStatus(container).textContent).toContain(
        'The overview changed after the assistant edit',
      ),
    );
  });

  it('dismisses without undoing', async () => {
    const user = userEvent.setup();
    const onchange = vi.fn<(override: OverviewOverride | null) => void>();
    const { assistant } = await mount(onchange);
    assistant.apply([{ op: 'remove', id: 'w3' }]);
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(assistant.lastBatch).toBeNull();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
