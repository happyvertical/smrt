/**
 * Hands-free dictation: the microphone stays on, each utterance the detector
 * cuts out is written down in the order spoken, and one tap ends it. The
 * microphone (voice activity detection) and the speech source are fakes.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import DictationButton from '../DictationButton.svelte';
import DictationStatus from '../DictationStatus.svelte';
import { Dictation, type DictationSpeechSource } from '../dictation.svelte.js';
import type {
  HandsFreeCapture,
  HandsFreeCaptureOptions,
  HandsFreeUtterance,
} from '../hands-free-capture.js';

/** A hands-free microphone the test drives by hand. */
function fakeMicrophone(
  options: { startError?: Error; finalUtterance?: boolean } = {},
) {
  let captured: HandsFreeCaptureOptions | undefined;
  const capture = {
    start: vi.fn(async () => {
      if (options.startError) throw options.startError;
    }),
    stop: vi.fn(() => {
      if (options.finalUtterance) {
        captured?.onUtterance(utterance('flush'));
      }
    }),
    cancel: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
  } satisfies HandsFreeCapture;
  const factory = vi.fn((o: HandsFreeCaptureOptions) => {
    captured = o;
    return capture;
  });
  return {
    factory,
    capture,
    get options() {
      return captured as HandsFreeCaptureOptions;
    },
    say: (reason: HandsFreeUtterance['reason'] = 'silence') =>
      captured?.onUtterance(utterance(reason)),
  };
}

function utterance(reason: HandsFreeUtterance['reason']): HandsFreeUtterance {
  return {
    pcm: new Float32Array([0.1, 0.2]),
    sampleRate: 16_000,
    durationMs: 1000,
    reason,
  };
}

/** A source whose `transcribePcm` answers when the test says so. */
function fakeSource() {
  const pending: Array<{
    resolve(text: string): void;
    reject(error: Error): void;
  }> = [];
  const transcribePcm = vi.fn(
    (_pcm: Float32Array, _options?: { language?: string }) =>
      new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const source: DictationSpeechSource = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onResult: () => () => {},
    onError: () => () => {},
    onEnd: () => () => {},
    transcribePcm,
  };
  return { source, transcribePcm, pending };
}

function setup(
  options: {
    mic?: ReturnType<typeof fakeMicrophone>;
    src?: ReturnType<typeof fakeSource>;
    mode?: 'push' | 'hands-free';
  } = {},
) {
  const mic = options.mic ?? fakeMicrophone();
  const src = options.src ?? fakeSource();
  const texts: string[] = [];
  const dictation = new Dictation({
    source: () => src.source,
    onText: (text) => texts.push(text),
    mode: options.mode ?? 'hands-free',
    handsFreeCapture: mic.factory,
    vad: { silenceMs: 600 },
    beep: false,
    requestMicrophone: false,
    log: () => {},
    language: 'en-CA',
  });
  return { dictation, mic, src, texts };
}

describe('Dictation hands-free', () => {
  it('opens the microphone once and stays listening without calling start() on the source', async () => {
    const { dictation, mic, src } = setup();
    await dictation.start();
    expect(dictation.state).toBe('listening');
    expect(dictation.handsFree).toBe(true);
    expect(mic.factory).toHaveBeenCalledTimes(1);
    expect(mic.options.vad).toEqual({ silenceMs: 600 });
    expect(mic.capture.start).toHaveBeenCalledTimes(1);
    expect(src.source.start).not.toHaveBeenCalled();
    dictation.dispose();
  });

  it('fails with model-missing and never opens the microphone when the source is not prepared', async () => {
    const src = fakeSource();
    const error = Object.assign(
      new Error("The speech model isn't downloaded yet"),
      {
        dictationKind: 'model-missing',
      },
    );
    src.source.prepare = vi.fn(async () => {
      throw error;
    });
    const { dictation, mic } = setup({ src });
    await dictation.start();
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe('model-missing');
    expect(mic.factory).not.toHaveBeenCalled();
    expect(mic.capture.start).not.toHaveBeenCalled();
    dictation.dispose();
  });

  it('follows speaking and the voice level', async () => {
    const { dictation, mic } = setup();
    await dictation.start();
    mic.options.onSpeaking?.(true);
    mic.options.onLevel?.(0.52);
    expect(dictation.speaking).toBe(true);
    expect(dictation.level).toBe(0.5);
    mic.options.onSpeaking?.(false);
    mic.options.onLevel?.(7);
    expect(dictation.speaking).toBe(false);
    expect(dictation.level).toBe(1);
    dictation.dispose();
  });

  it('suspend() pauses listening, drops what arrives, and resume() restores it', async () => {
    const { dictation, mic, src } = setup();
    await dictation.start();
    mic.options.onSpeaking?.(true);
    mic.options.onLevel?.(0.5);
    dictation.suspend();
    expect(dictation.suspended).toBe(true);
    expect(dictation.speaking).toBe(false);
    expect(dictation.level).toBe(0);
    expect(mic.capture.suspend).toHaveBeenCalledTimes(1);
    // Backstop: nothing that arrives while suspended is written down.
    mic.say();
    mic.options.onSpeaking?.(true);
    expect(dictation.queued).toBe(0);
    expect(dictation.speaking).toBe(false);
    expect(src.transcribePcm).not.toHaveBeenCalled();
    expect(dictation.state).toBe('listening');
    dictation.resume();
    expect(dictation.suspended).toBe(false);
    expect(mic.capture.resume).toHaveBeenCalledTimes(1);
    mic.say();
    expect(dictation.queued).toBe(1);
    dictation.dispose();
  });

  it('a suspend() requested before hands-free starts applies as it opens', async () => {
    const { dictation, mic } = setup();
    dictation.suspend();
    expect(dictation.suspended).toBe(false);
    await dictation.start();
    expect(dictation.suspended).toBe(true);
    expect(mic.capture.suspend).toHaveBeenCalledTimes(1);
    dictation.resume();
    expect(dictation.suspended).toBe(false);
    dictation.dispose();
  });

  it('stopping clears the suspended state; ending hands-free is still one tap', async () => {
    const { dictation } = setup();
    await dictation.start();
    dictation.suspend();
    await dictation.stop();
    expect(dictation.suspended).toBe(false);
    expect(dictation.state).toBe('idle');
    dictation.dispose();
  });

  it('shows a paused state on the button and in the live region while suspended', async () => {
    const { dictation } = setup();
    const view = render(DictationButton, { props: { dictation } });
    render(DictationStatus, { props: { dictation } });
    await dictation.start();
    const button = screen.getByRole('button', { name: 'Stop listening' });
    expect(button).not.toHaveAttribute('data-dictation-paused');
    dictation.suspend();
    await vi.waitFor(() =>
      expect(button).toHaveAttribute('data-dictation-paused', 'true'),
    );
    expect(button).toHaveAttribute(
      'title',
      'Paused while the assistant speaks',
    );
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(
      'Paused while the assistant speaks',
    );
    await expectNoA11yViolations(view.container);
    dictation.resume();
    await vi.waitFor(() =>
      expect(button).not.toHaveAttribute('data-dictation-paused'),
    );
    dictation.dispose();
  });

  it('writes utterances down in the order spoken, even when a later one finishes first', async () => {
    const { dictation, mic, src, texts } = setup();
    await dictation.start();
    mic.say();
    mic.say();
    expect(dictation.queued).toBe(2);
    // The second is not started until the first is written down.
    await vi.waitFor(() => expect(src.transcribePcm).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(src.transcribePcm).toHaveBeenCalledTimes(1);
    expect(src.transcribePcm.mock.calls[0]?.[1]).toEqual({ language: 'en-CA' });
    src.pending[0]?.resolve(' first sentence. ');
    await vi.waitFor(() => expect(src.transcribePcm).toHaveBeenCalledTimes(2));
    expect(texts).toEqual(['first sentence.']);
    expect(dictation.queued).toBe(1);
    src.pending[1]?.resolve('second sentence.');
    await vi.waitFor(() => expect(dictation.queued).toBe(0));
    expect(texts).toEqual(['first sentence.', 'second sentence.']);
    // Still listening: one phrase does not end hands-free.
    expect(dictation.state).toBe('listening');
    dictation.dispose();
  });

  it('ignores empty text and bracketed noise labels', async () => {
    const { dictation, mic, src, texts } = setup();
    await dictation.start();
    for (const reply of ['', '[BLANK_AUDIO]', ' (silence) ', 'real words']) {
      mic.say();
      await vi.waitFor(() => expect(src.pending.length).toBeGreaterThan(0));
      src.pending.shift()?.resolve(reply);
      await vi.waitFor(() => expect(dictation.queued).toBe(0));
    }
    expect(texts).toEqual(['real words']);
    dictation.dispose();
  });

  it('stop() hands over the last phrase, releases the microphone, writes everything down, then goes idle', async () => {
    const { dictation, mic, src, texts } = setup({
      mic: fakeMicrophone({ finalUtterance: true }),
    });
    await dictation.start();
    mic.say();
    await dictation.stop();
    expect(mic.capture.stop).toHaveBeenCalledTimes(1);
    // The utterance in progress arrived with the stop: two are waiting.
    expect(dictation.queued).toBe(2);
    expect(dictation.state).toBe('transcribing');
    expect(dictation.speaking).toBe(false);
    await vi.waitFor(() => expect(src.pending.length).toBe(1));
    src.pending[0]?.resolve('one');
    await vi.waitFor(() => expect(src.pending.length).toBe(2));
    src.pending[1]?.resolve('two');
    await vi.waitFor(() => expect(dictation.state).toBe('idle'));
    expect(texts).toEqual(['one', 'two']);
    expect(dictation.handsFree).toBe(false);
    expect(dictation.queued).toBe(0);
  });

  it('whenSettled() resolves after the last phrase has been written down', async () => {
    const { dictation, mic, src, texts } = setup({
      mic: fakeMicrophone({ finalUtterance: true }),
    });
    await dictation.start();
    mic.say();
    await dictation.stop();
    const settled = dictation.whenSettled();
    await vi.waitFor(() => expect(src.pending.length).toBe(1));
    src.pending[0]?.resolve('one');
    await vi.waitFor(() => expect(src.pending.length).toBe(2));
    src.pending[1]?.resolve('two');
    await settled;
    expect(texts).toEqual(['one', 'two']);
  });

  it('stop() with nothing waiting goes straight to idle', async () => {
    const { dictation, mic } = setup();
    await dictation.start();
    await dictation.stop();
    expect(mic.capture.stop).toHaveBeenCalledTimes(1);
    expect(dictation.state).toBe('idle');
  });

  it('toggle() ends it, and a second start begins a fresh session', async () => {
    const { dictation, mic } = setup();
    await dictation.toggle();
    expect(dictation.state).toBe('listening');
    await dictation.toggle();
    expect(dictation.state).toBe('idle');
    await dictation.toggle();
    expect(mic.factory).toHaveBeenCalledTimes(2);
    dictation.dispose();
  });

  it('a failed transcription ends the session with a plain error and frees the microphone', async () => {
    const { dictation, mic, src } = setup();
    await dictation.start();
    mic.say();
    mic.say();
    await vi.waitFor(() => expect(src.pending.length).toBe(1));
    src.pending[0]?.reject(new Error('model crashed'));
    await vi.waitFor(() => expect(dictation.state).toBe('error'));
    expect(dictation.errorKind).toBe('not-transcribed');
    expect(mic.capture.cancel).toHaveBeenCalled();
    expect(dictation.queued).toBe(0);
    // The utterance behind the failed one is dropped, not written down.
    expect(src.transcribePcm).toHaveBeenCalledTimes(1);
  });

  it('a blocked microphone is reported as denied', async () => {
    const denied = Object.assign(new Error('blocked'), {
      name: 'NotAllowedError',
    });
    const { dictation } = setup({
      mic: fakeMicrophone({ startError: denied }),
    });
    await dictation.start();
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe('denied');
    expect(dictation.handsFree).toBe(false);
  });

  it('stopping before the microphone has opened cancels it afterwards', async () => {
    let open!: () => void;
    const mic = fakeMicrophone();
    mic.capture.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    );
    const { dictation } = setup({ mic });
    const starting = dictation.start();
    await vi.waitFor(() => expect(mic.capture.start).toHaveBeenCalled());
    await dictation.stop();
    open();
    await starting;
    expect(dictation.state).toBe('idle');
    expect(mic.capture.cancel).toHaveBeenCalled();
  });

  it('dispose() releases the microphone and drops queued speech', async () => {
    const { dictation, mic, src, texts } = setup();
    await dictation.start();
    mic.say();
    await vi.waitFor(() => expect(src.pending.length).toBe(1));
    dictation.dispose();
    expect(mic.capture.cancel).toHaveBeenCalled();
    src.pending[0]?.resolve('too late');
    await Promise.resolve();
    expect(texts).toEqual([]);
  });

  it('is plain press-to-talk where hands-free is not possible', async () => {
    // Mode push, no microphone factory, or a source that cannot take PCM.
    const push = setup({ mode: 'push' });
    await push.dictation.start();
    expect(push.dictation.handsFree).toBe(false);
    expect(push.src.source.start).toHaveBeenCalled();
    expect(push.mic.factory).not.toHaveBeenCalled();
    push.dictation.dispose();

    const noFactory = new Dictation({
      source: () => fakeSource().source,
      onText: () => {},
      mode: 'hands-free',
      beep: false,
      requestMicrophone: false,
    });
    expect(noFactory.wantsHandsFree).toBe(false);
    await noFactory.start();
    expect(noFactory.handsFree).toBe(false);
    noFactory.dispose();

    const plain = fakeSource();
    delete plain.source.transcribePcm;
    const mic = fakeMicrophone();
    const withoutPcm = new Dictation({
      source: () => plain.source,
      onText: () => {},
      mode: 'hands-free',
      handsFreeCapture: mic.factory,
      beep: false,
      requestMicrophone: false,
    });
    await withoutPcm.start();
    expect(withoutPcm.handsFree).toBe(false);
    expect(mic.factory).not.toHaveBeenCalled();
    expect(plain.source.start).toHaveBeenCalled();
    withoutPcm.dispose();
  });
});

describe('hands-free in the button and the status line', () => {
  it('shows listening, speaking and writing states with words, and a tap ends it', async () => {
    const { dictation, mic, src } = setup();
    const { container } = render(DictationButton, { props: { dictation } });
    render(DictationStatus, { props: { dictation } });

    const start = screen.getByRole('button', {
      name: 'Speak instead of typing',
    });
    // The hint says it is hands-free before anyone starts.
    expect(start).toHaveAttribute('title', expect.stringMatching(/hands-free/));

    await userEvent.click(start);
    await vi.waitFor(() => expect(dictation.state).toBe('listening'));
    flushSync();
    const stop = screen.getByRole('button', { name: 'Stop listening' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');
    expect(stop).toHaveAttribute('data-dictation-mode', 'hands-free');
    expect(stop.className).toContain('smrt-dictation-button--hands-free');
    // The help text is the tooltip and the description, not a line of text;
    // the live region only says the state, and is visually hidden.
    expect(stop).toHaveAttribute(
      'title',
      expect.stringMatching(/Just talk; I write it down when you pause/),
    );
    const helpId = stop.getAttribute('aria-describedby');
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId as string)).toHaveTextContent(
      /Just talk; I write it down when you pause/,
    );
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('Listening');
    expect(live).not.toHaveTextContent(/Just talk/);
    expect(live.className).toContain('smrt-dictation-status--empty');
    expect(stop).not.toHaveAttribute('data-dictation-speaking');

    // Someone speaks: the halo follows the level, and the live region says so.
    mic.options.onSpeaking?.(true);
    mic.options.onLevel?.(0.6);
    flushSync();
    expect(stop).toHaveAttribute('data-dictation-speaking', 'true');
    expect(stop.getAttribute('style')).toContain('--smrt-dictation-level: 0.6');
    expect(stop.className).toContain('smrt-dictation-button--speaking');
    expect(screen.getByRole('status')).toHaveTextContent('Hearing you…');
    await expectNoA11yViolations(container);

    // A sentence ends and is being written down.
    mic.options.onSpeaking?.(false);
    mic.say();
    flushSync();
    expect(screen.getByRole('status')).toHaveTextContent('Writing it down…');
    expect(container.querySelector('.smrt-dictation-writing')).not.toBeNull();
    await vi.waitFor(() => expect(src.pending.length).toBe(1));
    src.pending[0]?.resolve('hello');
    await vi.waitFor(() => expect(dictation.queued).toBe(0));
    flushSync();
    expect(container.querySelector('.smrt-dictation-writing')).toBeNull();

    await userEvent.click(stop);
    await vi.waitFor(() => expect(dictation.state).toBe('idle'));
    expect(mic.capture.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the halo and spinner still for people who ask for reduced motion', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/forms/DictationButton.svelte'),
      'utf8',
    );
    const reduced = source.slice(source.indexOf('prefers-reduced-motion'));
    expect(reduced).toContain('.smrt-dictation-writing');
    expect(reduced).toContain('.smrt-dictation-button--speaking');
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).toMatch(/transition:\s*none/);
  });
});

describe('DictationStatus sending hint', () => {
  it('shows a short visible "Sending…" and is axe-clean', async () => {
    const { dictation } = setup();
    const { container } = render(DictationStatus, {
      props: { dictation, sending: true },
    });
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('Sending…');
    expect(live.className).not.toContain('smrt-dictation-status--empty');
    await expectNoA11yViolations(container);
  });
});
