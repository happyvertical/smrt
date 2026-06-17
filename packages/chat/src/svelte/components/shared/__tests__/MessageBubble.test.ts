// @vitest-environment jsdom
/**
 * Component coverage for MessageBubble via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import MessageBubble from '../MessageBubble.svelte';

describe('MessageBubble', () => {
  it('renders the message content', () => {
    render(MessageBubble, {
      props: { content: 'Hello there', isOwn: false },
    });
    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });

  it('is axe-clean for an own message', async () => {
    const { container } = render(MessageBubble, {
      props: { content: 'Hi', isOwn: true },
    });
    await expectNoA11yViolations(container);
  });
});
