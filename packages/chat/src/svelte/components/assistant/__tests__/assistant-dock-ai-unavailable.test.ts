// @vitest-environment jsdom
/**
 * AssistantDock renders "AI is off, open settings" (#4757) when a send is
 * refused with `ai_unavailable`, instead of the generic error banner, and
 * clears it once a send goes through.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import { AssistantHttpError } from '../assistant-http-client.js';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';

describe('AssistantDock AI unavailable', () => {
  it('shows the off notice with the host settings link, then clears it', async () => {
    const transport = createInMemoryAssistantTransport();
    const send = transport.sendMessage.bind(transport);
    let refuse = true;
    transport.sendMessage = async (...args) => {
      if (refuse) {
        throw new AssistantHttpError(
          'AI is turned off.',
          503,
          'ai_unavailable',
          {
            available: false,
            mode: 'off',
            reason: 'off',
          },
        );
      }
      return send(...args);
    };
    render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
        aiSettingsHref: '/settings/ai',
      },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: /New conversation/i }),
    );
    await userEvent.type(screen.getByLabelText('Message'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('AI is off.')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open AI settings' }),
    ).toHaveAttribute('href', '/settings/ai');
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();

    refuse = false;
    await userEvent.clear(screen.getByLabelText('Message'));
    await userEvent.type(screen.getByLabelText('Message'), 'again');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await expect.poll(() => screen.queryByText('AI is off.')).toBeNull();
  });
});
