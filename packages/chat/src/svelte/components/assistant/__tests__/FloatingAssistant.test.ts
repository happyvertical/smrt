// @vitest-environment jsdom
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
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
