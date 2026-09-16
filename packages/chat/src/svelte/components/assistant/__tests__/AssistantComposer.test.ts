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

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input;
}

const png = (name = 'photo.png') =>
  new File(['data'], name, { type: 'image/png' });

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

  // Cycle-2 third final: a rejecting onupload previously had no catch
  // anywhere in handleFileChange, so the chip row never updated and no
  // error appeared — the rejection escaped as an unhandled promise
  // rejection from the DOM change event instead.
  it('shows an inline error and keeps existing chips when onupload rejects', async () => {
    const onsend = vi.fn();
    const onupload = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'att-1', name: 'existing.png' }])
      .mockRejectedValueOnce(new Error('no writeEndpoint configured'));

    const { container } = render(AssistantComposer, {
      props: { onsend, onupload },
    });

    // First upload succeeds and stages a chip.
    await userEvent.upload(fileInput(container), png('existing.png'));
    expect(await screen.findByText('existing.png')).toBeInTheDocument();

    // Second upload rejects: the existing chip must remain, and the
    // rejection must show as an inline error.
    await userEvent.upload(fileInput(container), png('second.png'));

    expect(
      await screen.findByText(
        /Could not attach file: no writeEndpoint configured/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('existing.png')).toBeInTheDocument();
    expect(screen.queryByText('second.png')).not.toBeInTheDocument();
  });
});
