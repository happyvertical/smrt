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

describe('DictationButton — one click, one toggle', () => {
  it('a single click starts once and does not stop again', async () => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const source: DictationSpeechSource = {
      start,
      stop,
      onResult: () => () => {},
      onError: () => () => {},
      onEnd: () => () => {},
    };
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
    });
    render(DictationButton, { props: { dictation } });
    // userEvent.click sends pointerdown, pointerup and click.
    await userEvent.click(
      screen.getByRole('button', { name: 'Speak instead of typing' }),
    );
    await vi.waitFor(() => expect(dictation.state).toBe('listening'));
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('DictationStatus', () => {
  function erroringSource(code: string): DictationSpeechSource {
    const errors = new Set<(e: Error) => void>();
    return {
      start: async () => {
        queueMicrotask(() => {
          for (const cb of errors)
            cb(Object.assign(new Error(code), { speechError: code }));
        });
      },
      stop: async () => {},
      onResult: () => () => {},
      onError: (cb) => (errors.add(cb), () => errors.delete(cb)),
      onEnd: () => () => {},
    };
  }

  it.each([
    [
      'network',
      "Speech recognition isn't available in this browser. Brave blocks it",
    ],
    [
      'service-not-allowed',
      "Speech recognition isn't available in this browser",
    ],
    ['not-allowed', 'The microphone is blocked'],
    ['no-speech', "Didn't hear anything. Tap the mic and try again."],
    ['audio-capture', "Couldn't use the microphone"],
    ['aborted', 'Listening stopped straight away'],
  ])('shows a plain message for %s instead of "Listening"', async (code, text) => {
    const source = erroringSource(code);
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
      log: () => {},
    });
    const { container } = render(DictationStatus, { props: { dictation } });
    await dictation.start();
    await vi.waitFor(() => expect(dictation.state).toBe('error'));
    flushSync();
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('alert')).toHaveAttribute(
      'data-dictation-error',
      code,
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('Listening');
    expect(container.querySelector('[data-dictation-error]')).not.toBeNull();
  });

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
      "Speech recognition isn't available in this browser",
    );
  });
});
