import { describe, expect, it, vi } from 'vitest';
import { createAnalyticsTransitions } from './index.js';

describe('standard persisted UI analytics', () => {
  it('ignores initial/history, failed unchanged actions and rerenders; emits only successful observed transitions', () => {
    const emit = vi.fn();
    const observe = createAnalyticsTransitions(emit);
    const outcomes = { answered: 'project_question_answered' as const };
    observe(
      [
        { id: 'historical', status: 'answered' },
        { id: 'private-id', status: 'open' },
      ],
      'open',
      outcomes,
    );
    observe([{ id: 'private-id', status: 'open' }], 'open', outcomes);
    expect(emit).not.toHaveBeenCalled();
    observe([{ id: 'private-id', status: 'answered' }], 'open', outcomes);
    observe([{ id: 'private-id', status: 'answered' }], 'open', outcomes);
    expect(emit.mock.calls).toEqual([['project_question_answered']]);
  });
  it.each([
    { replacement: [] },
    { replacement: [{ id: 'other', status: 'open' }] },
  ])('forgets rows absent from a later observed snapshot $replacement', ({
    replacement,
  }) => {
    const emit = vi.fn();
    const observe = createAnalyticsTransitions(emit);
    const outcomes = { answered: 'project_question_answered' as const };
    observe([{ id: 'x', status: 'open' }], 'open', outcomes);
    observe(replacement, 'open', outcomes);
    observe([{ id: 'x', status: 'answered' }], 'open', outcomes);
    expect(emit).not.toHaveBeenCalled();
    observe([{ id: 'x', status: 'open' }], 'open', outcomes);
    observe([{ id: 'x', status: 'answered' }], 'open', outcomes);
    expect(emit.mock.calls).toEqual([['project_question_answered']]);
  });
  it('contains a configured sink failure', () => {
    const observe = createAnalyticsTransitions(() => {
      throw new Error('offline');
    });
    observe([{ id: 'x', status: 'pending' }], 'pending', {
      approved: 'project_preview_approved',
    });
    expect(() =>
      observe([{ id: 'x', status: 'approved' }], 'pending', {
        approved: 'project_preview_approved',
      }),
    ).not.toThrow();
  });
});
