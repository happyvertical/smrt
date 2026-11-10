// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { PollProjection } from '../types.js';
import PollCard from './PollCard.svelte';
import ReactionBar from './ReactionBar.svelte';

const poll: PollProjection = {
  id: 'poll',
  question: 'Next topic?',
  options: [
    { id: 'parks', label: 'Parks' },
    { id: 'roads', label: 'Roads' },
  ],
  closed: false,
  selectedOptionId: null,
  results: { parks: 2, roads: 1 },
  totalVotes: 3,
};
describe('authorized participation projections', () => {
  it('renders aggregate reaction counts and emits desired state', async () => {
    const onChange = vi.fn();
    render(ReactionBar, {
      props: {
        reactions: [{ kind: 'like', count: 3, selected: true }],
        onChange,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'like 3' }));
    expect(onChange).toHaveBeenCalledWith('like', false);
  });
  it('disables busy reactions and announces callback failures', async () => {
    let reject!: (reason: Error) => void;
    const onChange = vi.fn(
      () =>
        new Promise<void>((_yes, no) => {
          reject = no;
        }),
    );
    render(ReactionBar, {
      props: {
        reactions: [{ kind: 'like', count: 0, selected: false }],
        onChange,
      },
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);
    await userEvent.click(button);
    expect(onChange).toHaveBeenCalledTimes(1);
    reject(new Error('offline'));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
  it('renders poll results and submits one option', async () => {
    const onVote = vi.fn();
    render(PollCard, { props: { poll, onVote } });
    expect(screen.getByText('3 total votes')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Parks' }));
    expect(onVote).toHaveBeenCalledWith('parks');
  });
  it.each([
    'closed',
    'selected',
    'disabled',
  ])('prevents %s poll mutation and hides withheld counts', async (state) => {
    const onVote = vi.fn();
    render(PollCard, {
      props: {
        poll: {
          ...poll,
          closed: state === 'closed',
          selectedOptionId: state === 'selected' ? 'parks' : null,
          results: null,
          totalVotes: null,
        },
        disabled: state === 'disabled',
        onVote,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Parks' }));
    expect(onVote).not.toHaveBeenCalled();
    expect(screen.queryByText('3 total votes')).toBeNull();
  });
  it('announces poll callback failure', async () => {
    render(PollCard, {
      props: { poll, onVote: vi.fn().mockRejectedValue(new Error('offline')) },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Parks' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
