// @vitest-environment jsdom
/**
 * Half-duplex voice: while `speaking` (the reply is read aloud) the composer
 * suspends hands-free listening so the assistant is not transcribed, and
 * resumes when it is `false` again. The microphone and speech source are fakes.
 */

import type { DictationSpeechSource } from '@happyvertical/smrt-ui/forms';
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantComposer from '../AssistantComposer.svelte';

function setup(props: Record<string, unknown> = {}) {
  let micOptions: { onUtterance(u: unknown): void } | undefined;
  const capture = {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    cancel: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
  };
  const source: DictationSpeechSource = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onResult: () => () => {},
    onError: () => () => {},
    onEnd: () => () => {},
    transcribePcm: vi.fn(async () => 'heard'),
  };
  const view = render(AssistantComposer, {
    props: {
      onsend: vi.fn().mockResolvedValue(undefined),
      dictation: () => source,
      dictationMode: 'hands-free',
      handsFreeCapture: vi.fn((o: typeof micOptions) => {
        micOptions = o;
        return capture;
      }),
      ...props,
    },
  });
  return {
    ...view,
    capture,
    source,
    async listen() {
      await userEvent.click(
        screen.getByRole('button', { name: 'Speak instead of typing' }),
      );
      await screen.findByRole('button', { name: 'Stop listening' });
    },
    say() {
      micOptions?.onUtterance({
        pcm: new Float32Array([0.1]),
        sampleRate: 16_000,
        durationMs: 800,
        reason: 'silence',
      });
    },
  };
}

describe('AssistantComposer speaking', () => {
  it('suspends hands-free listening while speaking and resumes after', async () => {
    const t = setup();
    await t.listen();
    expect(t.capture.suspend).not.toHaveBeenCalled();
    await t.rerender({ speaking: true });
    await vi.waitFor(() => expect(t.capture.suspend).toHaveBeenCalledTimes(1));
    const mic = screen.getByRole('button', { name: 'Stop listening' });
    expect(mic).toHaveAttribute('data-dictation-paused', 'true');
    expect(mic).toHaveAttribute('title', 'Paused while the assistant speaks');
    // Anything the microphone still hands over is not written into the box.
    t.say();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.source.transcribePcm).not.toHaveBeenCalled();
    await expectNoA11yViolations(t.container);
    await t.rerender({ speaking: false });
    await vi.waitFor(() => expect(t.capture.resume).toHaveBeenCalledTimes(1));
    expect(mic).not.toHaveAttribute('data-dictation-paused');
  });

  it('listening that starts while she is already speaking starts paused', async () => {
    const t = setup({ speaking: true });
    await t.listen();
    expect(t.capture.suspend).toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Stop listening' }),
    ).toHaveAttribute('data-dictation-paused', 'true');
  });

  it('tapping the microphone while paused still ends hands-free', async () => {
    const t = setup({ speaking: true });
    await t.listen();
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop listening' }),
    );
    expect(t.capture.stop).toHaveBeenCalled();
    await screen.findByRole('button', { name: 'Speak instead of typing' });
  });
});
