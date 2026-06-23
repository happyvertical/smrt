// @vitest-environment jsdom
/**
 * Component coverage for MessageItem via the shared S11 harness (#1416).
 *
 * Regression for the T2 #1391 a11y blocker: the per-message actions
 * (reply/edit/delete/react) used to be revealed ONLY by mouseenter/mouseleave,
 * so keyboard- and touch-only users could never reach them. There must now be a
 * keyboard-reachable "more actions" button that toggles the action bar, and
 * focusing into the row must reveal the actions.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessageData } from '../../../types.js';
import MessageItem from '../MessageItem.svelte';

function makeMessage(
  overrides: Partial<ChatMessageData> = {},
): ChatMessageData {
  return {
    id: 'm1',
    roomId: 'room-1',
    threadId: null,
    senderProfileId: 'p1',
    senderName: 'Ada',
    senderAvatarUrl: undefined,
    agentSessionId: null,
    content: 'Hello there',
    messageType: 'text',
    role: 'user',
    isEdited: false,
    isDeleted: false,
    replyTo: null,
    reactions: [],
    attachments: [],
    toolCallData: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('MessageItem', () => {
  it('renders a keyboard-reachable "more actions" button when actions are available', () => {
    render(MessageItem, {
      props: {
        message: makeMessage(),
        isOwn: false,
        onreply: vi.fn(),
        onreact: vi.fn(),
      },
    });
    const moreBtn = screen.getByRole('button', { name: 'Message actions' });
    expect(moreBtn).toBeInTheDocument();
    // A real <button> is inherently in the tab order (no tabindex="-1").
    expect(moreBtn.getAttribute('tabindex')).not.toBe('-1');
  });

  it('reveals the action bar via the more-actions button without any mouse hover', async () => {
    const onreply = vi.fn();
    render(MessageItem, {
      props: {
        message: makeMessage(),
        isOwn: false,
        onreply,
        onreact: vi.fn(),
      },
    });

    // Actions are hidden until requested — no hover, no focus yet.
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();

    await userEvent.click(
      screen.getByRole('button', { name: 'Message actions' }),
    );

    // The action bar is now reachable; clicking Reply invokes the callback.
    const replyBtn = await screen.findByRole('button', { name: 'Reply' });
    await userEvent.click(replyBtn);
    expect(onreply).toHaveBeenCalledWith('m1');
  });

  it("exposes edit/delete actions for the user's own message", async () => {
    const onedit = vi.fn();
    const ondelete = vi.fn();
    render(MessageItem, {
      props: {
        message: makeMessage(),
        isOwn: true,
        onedit,
        ondelete,
      },
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Message actions' }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(onedit).toHaveBeenCalledWith('m1');

    // The bar stays open while focus remains inside the row, so Delete is
    // reachable in the same interaction.
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(ondelete).toHaveBeenCalledWith('m1');
  });

  it('does not render the more-actions affordance when no action callbacks are provided', () => {
    render(MessageItem, {
      props: {
        message: makeMessage(),
        isOwn: false,
      },
    });
    expect(
      screen.queryByRole('button', { name: 'Message actions' }),
    ).toBeNull();
  });

  it('is axe-clean with the action affordance present', async () => {
    const { container } = render(MessageItem, {
      props: {
        message: makeMessage(),
        isOwn: false,
        onreply: vi.fn(),
        onreact: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
