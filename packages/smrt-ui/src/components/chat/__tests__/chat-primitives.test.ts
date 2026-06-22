/**
 * Golden tests for the L3 chat primitives (`./chat` subpath, #1422):
 * MessageBubble, ReactionPicker, TypingIndicator.
 */

import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import MessageBubble from '../MessageBubble.svelte';
import ReactionPicker from '../ReactionPicker.svelte';
import TypingIndicator from '../TypingIndicator.svelte';

const body = (text: string) =>
  createRawSnippet(() => ({ render: () => `<p>${text}</p>` }));

describe('MessageBubble', () => {
  it('labels the group by author + role and renders the body', () => {
    render(MessageBubble, {
      props: { role: 'agent', author: 'Ada', children: body('Hello there') },
    });
    const group = screen.getByRole('group', { name: 'Ada (agent)' });
    expect(group).toHaveTextContent('Hello there');
  });

  it('renders a machine-readable timestamp', () => {
    const { container } = render(MessageBubble, {
      props: {
        author: 'Ada',
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        children: body('hi'),
      },
    });
    expect(container.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-01-01T10:00:00.000Z',
    );
  });

  it('is axe-clean', async () => {
    const { container } = render(MessageBubble, {
      props: { role: 'user', author: 'You', children: body('hi') },
    });
    await expectNoA11yViolations(container);
  });
});

describe('ReactionPicker', () => {
  it('is a labelled group of named emoji buttons', () => {
    render(ReactionPicker);
    expect(
      screen.getByRole('group', { name: 'Add reaction' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Thumbs up' }),
    ).toBeInTheDocument();
  });

  it('reports the picked emoji', async () => {
    const onpick = vi.fn();
    render(ReactionPicker, { props: { onpick } });
    await userEvent.click(screen.getByRole('button', { name: 'Heart' }));
    expect(onpick).toHaveBeenCalledWith('❤️');
  });

  it('is axe-clean', async () => {
    const { container } = render(ReactionPicker);
    await expectNoA11yViolations(container);
  });
});

describe('TypingIndicator', () => {
  it('announces who is typing via a status region', () => {
    render(TypingIndicator, { props: { name: 'Assistant' } });
    expect(screen.getByRole('status')).toHaveTextContent('Assistant is typing');
  });

  it('is axe-clean', async () => {
    const { container } = render(TypingIndicator, {
      props: { name: 'Assistant' },
    });
    await expectNoA11yViolations(container);
  });
});
