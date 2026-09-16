// @vitest-environment jsdom
/**
 * Component-level coverage for AssistantComposer (#2904 review finding 4).
 *
 * Before this fix, `handleSend` cleared `content`/`stagedAttachments`
 * synchronously before `onsend`'s promise settled, so a transport failure
 * discarded the user's typed message with no visible error.
 */
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantComposer from '../AssistantComposer.svelte';

describe('AssistantComposer', () => {
  it('keeps the draft and shows an inline error when onsend rejects', async () => {
    const onsend = vi.fn().mockRejectedValue(new Error('network down'));
    const onupload = vi.fn();

    render(AssistantComposer, { props: { onsend, onupload } });

    const textarea = screen.getByLabelText('Message');
    await userEvent.type(textarea, 'hello there');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onsend).toHaveBeenCalledWith('hello there', []);
    // The draft text must still be in the textarea — not cleared.
    expect(textarea).toHaveValue('hello there');
    expect(
      await screen.findByText(/Could not send: network down/i),
    ).toBeInTheDocument();
  });

  it('clears the draft only after onsend resolves successfully', async () => {
    const onsend = vi.fn().mockResolvedValue(undefined);
    const onupload = vi.fn();

    render(AssistantComposer, { props: { onsend, onupload } });

    const textarea = screen.getByLabelText('Message');
    await userEvent.type(textarea, 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onsend).toHaveBeenCalledWith('hi', []);
    expect(textarea).toHaveValue('');
    expect(screen.queryByText(/Could not send/i)).not.toBeInTheDocument();
  });
});
