// @vitest-environment jsdom
/**
 * AssistantDock thread layout in a narrow dock: sides, status placement, and
 * the composer clearing the moment a send starts.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';

describe('AssistantDock layout', () => {
  it('shows status just above the composer and clears the sent text at once', async () => {
    const transport = createInMemoryAssistantTransport();
    const base = transport.sendMessage.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    transport.sendMessage = async (input) => {
      input.onEvent?.({
        type: 'status',
        status: { state: 'working', label: 'Thinking…' },
      });
      await gate;
      return base(input);
    };
    const { container } = render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
        conversations: 'single',
      },
    });
    const box = await screen.findByLabelText('Message');
    await vi.waitFor(() => expect(box).toBeEnabled());
    await userEvent.type(box, 'hello there');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const status = await vi.waitFor(() => {
      const el = container.querySelector('.assistant-dock-status');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const composer = container.querySelector(
      '.assistant-dock-composer',
    ) as HTMLElement;
    expect(status.nextElementSibling).toBe(composer);
    expect(box).toHaveValue('');
    await expectNoA11yViolations(container);
    release();
    await vi.waitFor(() =>
      expect(container.querySelector('li[data-role="user"]')).not.toBeNull(),
    );
  });
});
