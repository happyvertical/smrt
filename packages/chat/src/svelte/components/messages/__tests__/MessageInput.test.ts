// @vitest-environment jsdom
/**
 * Component coverage for MessageInput via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import MessageInput from '../MessageInput.svelte';

describe('MessageInput', () => {
  it('sends the trimmed content on Enter', async () => {
    const onsend = vi.fn();
    render(MessageInput, { props: { onsend } });
    await userEvent.type(
      screen.getByLabelText('Message input'),
      'Hello{Enter}',
    );
    expect(onsend).toHaveBeenCalledWith('Hello');
  });

  it('does not send empty content', async () => {
    const onsend = vi.fn();
    render(MessageInput, { props: { onsend } });
    await userEvent.type(screen.getByLabelText('Message input'), '{Enter}');
    expect(onsend).not.toHaveBeenCalled();
  });

  it('shows a reply banner and cancels it', async () => {
    const oncancelreply = vi.fn();
    render(MessageInput, {
      props: {
        onsend: vi.fn(),
        replyTo: { id: 'm1', senderName: 'Ada', content: 'earlier message' },
        oncancelreply,
      },
    });
    expect(screen.getByText('Ada')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(oncancelreply).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean', async () => {
    const { container } = render(MessageInput, { props: { onsend: vi.fn() } });
    await expectNoA11yViolations(container);
  });
});
