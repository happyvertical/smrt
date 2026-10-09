// @vitest-environment jsdom
/**
 * Speaking into the assistant composer (smrt-ui `Dictation` over a mocked
 * speech source; real speech recognition cannot run headless): a named
 * microphone button, press-and-hold on the message box, heard words at the
 * cursor, and Send / Escape stopping it. No source means no microphone.
 */

import type {
  DictationSpeechResult,
  DictationSpeechSource,
} from '@happyvertical/smrt-ui/forms';
import {
  fireEvent,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AssistantChoiceCards from '../AssistantChoiceCards.svelte';
import AssistantComposer from '../AssistantComposer.svelte';

function mockSpeech() {
  const results = new Set<(r: DictationSpeechResult) => void>();
  const ends = new Set<() => void>();
  const source: DictationSpeechSource = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      for (const cb of ends) cb();
    }),
    onResult: (cb) => {
      results.add(cb);
      return () => results.delete(cb);
    },
    onError: () => () => {},
    onEnd: (cb) => {
      ends.add(cb);
      return () => ends.delete(cb);
    },
  };
  return {
    source,
    say(text: string) {
      for (const cb of results) cb({ text, isFinal: true });
    },
  };
}

function pointerEvent(type: string, init: Record<string, unknown> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    isPrimary: true,
    pointerId: 3,
    pointerType: 'touch',
    button: 0,
    clientX: 20,
    clientY: 20,
    ...init,
  });
  return event;
}

describe('AssistantComposer dictation', () => {
  afterEach(() => vi.useRealTimers());

  it('has no microphone without a speech source', () => {
    render(AssistantComposer, {
      props: { onsend: vi.fn(), onupload: vi.fn() },
    });
    expect(
      screen.queryByRole('button', { name: 'Speak instead of typing' }),
    ).toBeNull();
  });

  it('the microphone listens and puts heard words at the cursor; Send stops it', async () => {
    const speech = mockSpeech();
    const onsend = vi.fn().mockResolvedValue(undefined);
    render(AssistantComposer, {
      props: { onsend, onupload: vi.fn(), dictation: () => speech.source },
    });
    const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
    await userEvent.type(field, 'Find a picture of');
    await userEvent.click(
      screen.getByRole('button', { name: 'Speak instead of typing' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Stop listening' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Listening');

    speech.say('the arena');
    expect(field).toHaveValue('Find a picture of the arena');

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onsend).toHaveBeenCalledWith('Find a picture of the arena', []);
    expect(speech.source.stop).toHaveBeenCalled();
  });

  it('pressing and holding the message box starts listening; Escape stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const speech = mockSpeech();
    render(AssistantComposer, {
      props: {
        onsend: vi.fn(),
        onupload: vi.fn(),
        dictation: () => speech.source,
      },
    });
    const field = screen.getByLabelText('Message');
    field.dispatchEvent(pointerEvent('pointerdown'));
    vi.advanceTimersByTime(520);
    window.dispatchEvent(pointerEvent('pointerup'));
    await vi.waitFor(() => expect(speech.source.start).toHaveBeenCalled());
    expect(
      await screen.findByRole('button', { name: 'Stop listening' }),
    ).toBeInTheDocument();

    await fireEvent.keyDown(field, { key: 'Escape' });
    await vi.waitFor(() => expect(speech.source.stop).toHaveBeenCalled());
  });

  it('a short tap on the message box does not listen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const speech = mockSpeech();
    render(AssistantComposer, {
      props: {
        onsend: vi.fn(),
        onupload: vi.fn(),
        dictation: () => speech.source,
      },
    });
    const field = screen.getByLabelText('Message');
    field.dispatchEvent(pointerEvent('pointerdown'));
    vi.advanceTimersByTime(150);
    window.dispatchEvent(pointerEvent('pointerup'));
    vi.advanceTimersByTime(800);
    expect(speech.source.start).not.toHaveBeenCalled();
  });
});

describe('AssistantChoiceCards', () => {
  it('renders offered options and reports the pick and "None of these"', async () => {
    const onchoose = vi.fn();
    const ondismiss = vi.fn();
    render(AssistantChoiceCards, {
      props: {
        choices: [
          {
            id: 's1',
            sourceId: 'crop',
            title: 'Pick a shape',
            status: 'waiting',
            options: [
              { id: 'wide', label: 'Wide' },
              { id: 'square', label: 'Square' },
            ],
          },
        ] as never,
        onchoose,
        ondismiss,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Square' }));
    expect(onchoose).toHaveBeenCalledWith('s1', 'square');
    await userEvent.click(
      screen.getByRole('button', { name: 'None of these' }),
    );
    expect(ondismiss).toHaveBeenCalledWith('s1');
  });
});

describe('AssistantComposer recording fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubRecorder() {
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported = (type: string) =>
        type === 'audio/webm;codecs=opus';
      state = 'inactive';
      mimeType: string;
      constructor(_stream: unknown, options?: { mimeType?: string }) {
        super();
        this.mimeType = options?.mimeType ?? '';
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.dispatchEvent(
          Object.assign(new Event('dataavailable'), {
            data: new Blob(['opus'], { type: this.mimeType }),
          }),
        );
        this.dispatchEvent(new Event('stop'));
      }
    }
    const track = { stop: vi.fn() };
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
    });
    return track;
  }

  it('records with only `transcribe` (Firefox), writes it down, and puts the text in the box', async () => {
    const track = stubRecorder();
    let finish!: (text: string) => void;
    const transcribe = vi.fn(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    render(AssistantComposer, {
      props: { onsend: vi.fn(), onupload: vi.fn(), transcribe },
    });
    const mic = screen.getByRole('button', { name: 'Speak instead of typing' });
    await userEvent.click(mic);
    await screen.findByText(/Listening/);

    await userEvent.click(
      screen.getByRole('button', { name: 'Stop listening' }),
    );
    await screen.findByText('Writing it down…');
    expect(track.stop).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), {
      mimeType: 'audio/webm;codecs=opus',
      language: expect.any(String),
      durationMs: expect.any(Number),
      signal: expect.any(AbortSignal),
    });
    finish('Show me the arena');
    const box = screen.getByRole('textbox', { name: /message/i });
    await vi.waitFor(() =>
      expect((box as HTMLTextAreaElement).value).toBe('Show me the arena'),
    );
  });
});

describe('AssistantComposer hands-free dictation', () => {
  /** A microphone that cuts speech into utterances; the test speaks. */
  function mockHandsFree() {
    let options:
      | {
          onUtterance(u: {
            pcm: Float32Array;
            sampleRate: number;
            durationMs: number;
            reason: 'silence' | 'max' | 'flush';
          }): void;
        }
      | undefined;
    const capture = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    return {
      capture,
      factory: vi.fn((o: NonNullable<typeof options>) => {
        options = o;
        return capture;
      }),
      say() {
        options?.onUtterance({
          pcm: new Float32Array([0.1]),
          sampleRate: 16_000,
          durationMs: 800,
          reason: 'silence',
        });
      },
    };
  }

  it('keeps listening between sentences and puts each one at the cursor; the microphone button ends it', async () => {
    const speech = mockSpeech();
    const heard: string[] = ['add milk', 'and eggs'];
    const source: DictationSpeechSource = {
      ...speech.source,
      transcribePcm: vi.fn(async () => heard.shift() ?? ''),
    };
    const mic = mockHandsFree();
    render(AssistantComposer, {
      props: {
        onsend: vi.fn(),
        onupload: vi.fn(),
        dictation: () => source,
        dictationMode: 'hands-free',
        handsFreeCapture: mic.factory,
      },
    });
    const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
    await userEvent.click(
      screen.getByRole('button', { name: 'Speak instead of typing' }),
    );
    const stop = await screen.findByRole('button', { name: 'Stop listening' });
    expect(stop).toHaveAttribute('data-dictation-mode', 'hands-free');
    expect(speech.source.start).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Listening');
    expect(screen.getByRole('status')).not.toHaveTextContent(/Just talk/);
    expect(stop).toHaveAttribute('title', expect.stringMatching(/Just talk/));

    mic.say();
    await vi.waitFor(() => expect(field.value).toBe('add milk'));
    mic.say();
    await vi.waitFor(() => expect(field.value).toBe('add milk and eggs'));
    // Still on after two sentences.
    expect(
      screen.getByRole('button', { name: 'Stop listening' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(stop);
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Speak instead of typing' }),
      ).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(mic.capture.stop).toHaveBeenCalledTimes(1);
  });
});
