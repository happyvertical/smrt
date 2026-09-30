/**
 * DictationButton + DictationStatus: a named 44px mic toggle with
 * aria-pressed, and plain-words status for listening and each error.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import DictationButton from '../DictationButton.svelte';
import DictationStatus from '../DictationStatus.svelte';
import { Dictation, type DictationSpeechSource } from '../dictation.svelte.js';

function quietSource(): DictationSpeechSource {
  const ends = new Set<() => void>();
  return {
    start: async () => {},
    stop: async () => {
      for (const cb of ends) cb();
    },
    onResult: () => () => {},
    onError: () => () => {},
    onEnd: (cb) => (ends.add(cb), () => ends.delete(cb)),
  };
}

describe('DictationButton', () => {
  it('toggles listening with a name that follows the state', async () => {
    const dictation = new Dictation({
      source: quietSource,
      onText: () => {},
      beep: false,
    });
    const { container } = render(DictationButton, { props: { dictation } });
    const button = screen.getByRole('button', {
      name: 'Speak instead of typing',
    });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await expectNoA11yViolations(container);

    await userEvent.click(button);
    await vi.waitFor(() => expect(dictation.state).toBe('listening'));
    flushSync();
    const stop = screen.getByRole('button', { name: 'Stop listening' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(stop);
    await vi.waitFor(() => expect(dictation.state).toBe('idle'));
  });
});

describe('DictationStatus', () => {
  it('says it is listening, then explains a blocked microphone', async () => {
    const dictation = new Dictation({
      source: quietSource,
      onText: () => {},
      beep: false,
    });
    render(DictationStatus, { props: { dictation } });
    await dictation.start();
    flushSync();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Listening. Tap the microphone when you are done.',
    );

    const blocked = new Dictation({ source: null, onText: () => {} });
    render(DictationStatus, { props: { dictation: blocked } });
    await blocked.start();
    flushSync();
    expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent(
      "This browser can't turn speech into text",
    );
  });
});
