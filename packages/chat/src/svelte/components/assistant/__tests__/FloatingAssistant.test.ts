// @vitest-environment jsdom
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import { createFloatingFixture } from '../../../../routes/previews/floating-assistant/fixture.js';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';
import type { AssistantDockController } from '../create-assistant-dock-controller.svelte.js';
import FloatingAssistant from '../FloatingAssistant.svelte';

function props() {
  return {
    transport: createInMemoryAssistantTransport(),
    registry: createDataSurfaceRegistry(),
  };
}

describe('FloatingAssistant', () => {
  it('keeps one mounted dock and its draft through collapse and reopen', async () => {
    const oncontroller = vi.fn<(controller: AssistantDockController) => void>();
    render(FloatingAssistant, { props: { ...props(), oncontroller } });

    await vi.waitFor(() => expect(oncontroller).toHaveBeenCalledTimes(1));
    const controller = oncontroller.mock.calls[0]?.[0];
    if (!controller) throw new Error('Expected AssistantDock controller');
    controller.setDraft('Keep this question');

    const launcher = screen.getByRole('button', { name: 'Open assistant' });
    await userEvent.click(launcher);
    expect(screen.getByLabelText('Message')).toHaveValue('Keep this question');

    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse assistant' }),
    );
    expect(launcher).toHaveFocus();
    expect(oncontroller).toHaveBeenCalledTimes(1);

    await userEvent.click(launcher);
    expect(screen.getByLabelText('Message')).toHaveValue('Keep this question');
    expect(oncontroller.mock.calls[0]?.[0]).toBe(controller);
  });

  it('collapses with Escape and keeps the hidden panel inert', async () => {
    const { container } = render(FloatingAssistant, { props: props() });
    const launcher = screen.getByRole('button', { name: 'Open assistant' });
    await userEvent.click(launcher);

    await userEvent.keyboard('{Escape}');
    const panel = container.querySelector<HTMLElement>(
      '.floating-assistant-panel',
    );
    await vi.waitFor(() => {
      expect(panel).toHaveAttribute('aria-hidden', 'true');
      expect((panel as HTMLElement & { inert?: boolean })?.inert).toBe(true);
    });
    expect(launcher).toHaveFocus();
  });

  it('offers a controls-only presentation without conversational history or input', async () => {
    render(FloatingAssistant, {
      props: { ...props(), presentation: 'controls', expanded: true },
    });

    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Conversations' }),
    ).not.toBeInTheDocument();
  });
});

async function mountedFixture() {
  const fixture = createFloatingFixture();
  const oncontroller = vi.fn<(controller: AssistantDockController) => void>();
  const view = render(FloatingAssistant, {
    props: {
      ...fixture,
      oncontroller,
      presentation: 'controls',
      expanded: true,
    },
  });
  await vi.waitFor(() => expect(oncontroller).toHaveBeenCalledTimes(1));
  const controller = oncontroller.mock.calls[0][0];
  await controller.openThread('preview-thread');
  return { ...fixture, ...view, controller, oncontroller };
}

describe('FloatingAssistant decision authority', () => {
  it('keeps a real preview visible against Escape, collapse and host closure, then confirms once with its original key', async () => {
    const fixture = await mountedFixture();
    await fixture.controller.previewAction(fixture.proposal());
    const key =
      fixture.controller.actions.get('preview-action')?.idempotencyKey;
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse assistant' }),
    );
    await fixture.rerender({ expanded: false });
    expect(
      fixture.container.querySelector('.floating-assistant-panel'),
    ).toHaveAttribute('aria-hidden', 'false');
    expect(fixture.evidence.keys).toEqual([]);
    expect(
      fixture.controller.actions.get('preview-action')?.idempotencyKey,
    ).toBe(key);
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(fixture.evidence.keys).toEqual([key]));
    expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
  });

  it('rejects a real preview without applying it', async () => {
    const fixture = await mountedFixture();
    await fixture.controller.previewAction(fixture.proposal());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reject' }),
    );
    expect(fixture.evidence.keys).toEqual([]);
    expect(fixture.controller.actions.size).toBe(0);
  });

  it.each([
    'Allow',
    "Don't allow",
  ])('reveals a collapsed tool request and requires the actual %s decision', async (decision) => {
    const fixture = await mountedFixture();
    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse assistant' }),
    );
    const sending = fixture.controller.send('tool');
    const decide = await screen.findByRole('button', { name: decision });
    expect(
      fixture.container.querySelector('.floating-assistant-panel'),
    ).toHaveAttribute('aria-hidden', 'false');
    await userEvent.keyboard('{Escape}');
    expect(fixture.evidence.executions).toBe(0);
    await userEvent.click(decide);
    await sending;
    expect(fixture.evidence.executions).toBe(decision === 'Allow' ? 1 : 0);
    expect(fixture.evidence.decisions).toEqual([decision === 'Allow']);
    expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])('reveals an incoming choice from a collapsed controller (host hidden: %s)', async (hidden) => {
    const fixture = await mountedFixture();
    await fixture.rerender({ expanded: false, visible: !hidden });
    await fixture.controller.send('choices');
    expect(fixture.controller.run?.waitingFor?.kind).toBe('choice');
    expect(fixture.evidence.choices).toEqual([]);
    if (hidden) {
      expect(
        screen.queryByRole('button', { name: /Compact layout/ }),
      ).not.toBeInTheDocument();
      await fixture.rerender({ visible: true, expanded: false });
    }
    const choice = await screen.findByRole('button', {
      name: /Compact layout/,
    });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse assistant' }),
    );
    await fixture.rerender({ expanded: false });
    expect(
      fixture.container.querySelector('.floating-assistant-panel'),
    ).toHaveAttribute('aria-hidden', 'false');
    expect(
      fixture.container.querySelector('.floating-assistant-panel'),
    ).not.toHaveAttribute('inert');
    expect(fixture.evidence.choices).toEqual([]);
    await userEvent.click(choice);
    expect(fixture.evidence.choices).toEqual(['compact']);
    expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
  });

  it('preserves visible choices, waiting status, Stop and errors in controls mode', async () => {
    const fixture = await mountedFixture();
    await fixture.controller.send('choices');
    expect(fixture.controller.run?.state).toBe('waiting');
    expect(fixture.controller.run?.waitingFor?.kind).toBe('choice');
    expect(
      fixture.container.querySelector('.assistant-dock-run'),
    ).toHaveTextContent('Pick a layout');
    await userEvent.click(
      await screen.findByRole('button', { name: /Compact layout/ }),
    );
    expect(fixture.evidence.choices).toEqual(['compact']);
    const working = fixture.controller.send('work');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await working;
    expect(fixture.controller.run?.stoppedReason).toBe('user');
    fixture.controller.setError('Preview failure remains visible');
    expect(
      await screen.findByText(/Preview failure remains visible/),
    ).toBeVisible();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  });

  it('reuses its controller and discards a late preview across registry and transport swaps', async () => {
    const fixture = await mountedFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preview = fixture.actionClient.preview;
    await fixture.rerender({
      actionClient: {
        ...fixture.actionClient,
        preview: async (request) => {
          await gate;
          return preview(request);
        },
      },
    });
    const pending = fixture.controller.previewAction(fixture.proposal());
    const replacement = createFloatingFixture();
    await fixture.rerender({
      registry: replacement.registry,
      transport: replacement.transport,
    });
    release();
    await pending;
    expect(fixture.controller.actions.size).toBe(0);
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();
    expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
  });
});

describe('FloatingAssistant pending state lifecycle', () => {
  it('keeps the in-flight action and key across collapse, then applies only once', async () => {
    const fixture = await mountedFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = fixture.actionClient.apply;
    await fixture.rerender({
      actionClient: {
        ...fixture.actionClient,
        apply: async (request, key) => {
          await gate;
          return apply(request, key);
        },
      },
    });
    await fixture.controller.previewAction(fixture.proposal());
    const key =
      fixture.controller.actions.get('preview-action')?.idempotencyKey;
    await userEvent.click(
      await screen.findByRole('button', { name: 'Confirm' }),
    );
    await vi.waitFor(() =>
      expect(fixture.controller.actions.get('preview-action')?.status).toBe(
        'applying',
      ),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse assistant' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Open assistant' }),
    );
    expect(
      fixture.controller.actions.get('preview-action')?.idempotencyKey,
    ).toBe(key);
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();
    release();
    await vi.waitFor(() => expect(fixture.evidence.keys).toEqual([key]));
    expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
  });

  it('drops a late old-context message when transport changes without recreating the controller', async () => {
    const fixture = await mountedFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await fixture.rerender({
      transport: {
        ...fixture.transport,
        sendMessage: async () => {
          await gate;
          return {
            inProgress: false,
            assistantMessage: {
              id: 'old-reply',
              threadId: 'preview-thread',
              role: 'assistant' as const,
              content: 'Old private context',
              createdAt: new Date().toISOString(),
            },
          };
        },
      },
    });
    await fixture.controller.openThread('preview-thread');
    const sending = fixture.controller.send('old context');
    const replacement = createFloatingFixture();
    await fixture.rerender({
      transport: replacement.transport,
      registry: replacement.registry,
    });
    release();
    await sending;
    expect(
      fixture.controller.messages.some((message) => message.id === 'old-reply'),
    ).toBe(false);
    expect(fixture.controller.activeThreadId).toBeNull();
    expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
  });
});

describe('FloatingAssistant host visibility', () => {
  it('hides the whole mounted assistant and pauses polling independently of expansion', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fixture = await mountedFixture();
    try {
      fixture.controller.setDraft('Keep the hidden draft');
      const initialLoads = fixture.evidence.loads;
      await vi.advanceTimersByTimeAsync(15001);
      expect(fixture.evidence.loads).toBeGreaterThan(initialLoads);
      await fixture.rerender({ visible: false });
      expect(
        screen.queryByRole('button', { name: 'Open assistant' }),
      ).not.toBeInTheDocument();
      expect(
        fixture.container.querySelector('.floating-assistant'),
      ).toHaveAttribute('hidden');
      const hiddenLoads = fixture.evidence.loads;
      await vi.advanceTimersByTimeAsync(30001);
      expect(fixture.evidence.loads).toBe(hiddenLoads);
      await fixture.rerender({ visible: true });
      expect(
        screen.getByRole('button', { name: 'Open assistant' }),
      ).toBeVisible();
      await vi.advanceTimersByTimeAsync(15001);
      expect(fixture.evidence.loads).toBeGreaterThan(hiddenLoads);
      expect(fixture.controller.activeThreadId).toBe('preview-thread');
      expect(fixture.controller.draft).toBe('Keep the hidden draft');
      expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
    } finally {
      fixture.unmount();
      vi.useRealTimers();
    }
  });

  it('retains hidden pending authority and reveals it when the host becomes visible', async () => {
    const fixture = await mountedFixture();
    await fixture.controller.previewAction(fixture.proposal());
    const key =
      fixture.controller.actions.get('preview-action')?.idempotencyKey;
    await fixture.rerender({ visible: false, expanded: false });
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open assistant' }),
    ).not.toBeInTheDocument();
    expect(fixture.evidence.keys).toEqual([]);
    expect(
      fixture.controller.actions.get('preview-action')?.idempotencyKey,
    ).toBe(key);
    await fixture.rerender({ visible: true, expanded: false });
    await userEvent.keyboard('{Escape}');
    expect(
      await screen.findByRole('button', { name: 'Confirm' }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await vi.waitFor(() => expect(fixture.evidence.keys).toEqual([key]));
    expect(fixture.oncontroller).toHaveBeenCalledTimes(1);
  });
});
