// @vitest-environment jsdom
/**
 * Component coverage for MentionAutocomplete via the shared S11 harness (#1416).
 *
 * Regression for T2 #1391: `case 'Escape': break;` was a no-op, so the
 * suggestion popup could not be dismissed from the keyboard. Escape must now
 * invoke the `oncancel` callback so a parent can close the popup.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import MentionAutocomplete from '../MentionAutocomplete.svelte';

const SUGGESTIONS = [
  { id: 'p1', name: 'Ada Lovelace' },
  { id: 'p2', name: 'Alan Turing' },
];

describe('MentionAutocomplete', () => {
  it('invokes oncancel when Escape is pressed while visible', async () => {
    const oncancel = vi.fn();
    render(MentionAutocomplete, {
      props: {
        query: 'a',
        suggestions: SUGGESTIONS,
        onselect: vi.fn(),
        isVisible: true,
        oncancel,
      },
    });

    await userEvent.keyboard('{Escape}');
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it('does not throw on Escape when no oncancel is provided', async () => {
    render(MentionAutocomplete, {
      props: {
        query: 'a',
        suggestions: SUGGESTIONS,
        onselect: vi.fn(),
        isVisible: true,
      },
    });
    await expect(userEvent.keyboard('{Escape}')).resolves.not.toThrow();
  });

  it('selects the active suggestion on Enter', async () => {
    const onselect = vi.fn();
    render(MentionAutocomplete, {
      props: {
        query: 'a',
        suggestions: SUGGESTIONS,
        onselect,
        isVisible: true,
      },
    });
    await userEvent.keyboard('{Enter}');
    expect(onselect).toHaveBeenCalledWith('p1');
  });

  it('is axe-clean', async () => {
    const { container } = render(MentionAutocomplete, {
      props: {
        query: 'a',
        suggestions: SUGGESTIONS,
        onselect: vi.fn(),
        isVisible: true,
      },
    });
    await expectNoA11yViolations(container);
  });
});
