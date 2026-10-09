// @vitest-environment jsdom
/**
 * Hands-free "send when I stop talking" in AssistantComposer: the message is
 * sent after a quiet grace period once the last sentence is written down.
 * The microphone and the speech source are mocked; real audio cannot run here.
 */

import type { DictationSpeechSource } from '@happyvertical/smrt-ui/forms';
import {
  expectNoA11yViolations,
  fireEvent,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantComposer from '../AssistantComposer.svelte';

const GRACE = 120;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(
  heard: Array<string | Promise<string>>,
  props: Record<string, unknown> = {},
) {
  let micOptions:
    | {
        onUtterance(u: unknown): void;
        onSpeaking?(speaking: boolean): void;
      }
    | undefined;
  const capture = {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    cancel: vi.fn(),
  };
  const source: DictationSpeechSource = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onResult: () => () => {},
    onError: () => () => {},
    onEnd: () => () => {},
    transcribePcm: vi.fn(async () => (await heard.shift()) ?? ''),
  };
  const onsend = vi.fn().mockResolvedValue(undefined);
  const view = render(AssistantComposer, {
    props: {
      onsend,
      dictation: () => source,
      dictationMode: 'hands-free',
      handsFreeCapture: vi.fn((o: typeof micOptions) => {
        micOptions = o;
        return capture;
      }),
      sendOnPause: true,
      sendOnPauseMs: GRACE,
      ...props,
    },
  });
  const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
  return {
    ...view,
    onsend,
    capture,
    field,
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
    speaking(on: boolean) {
      micOptions?.onSpeaking?.(on);
    },
  };
}

describe('AssistantComposer send on pause', () => {
  it('sends after the grace period, shows "Sending…" first, and keeps listening', async () => {
    const t = setup(['add milk']);
    await t.listen();
    t.say();
    await vi.waitFor(() => expect(t.field.value).toBe('add milk'));
    expect(await screen.findByRole('status')).toHaveTextContent('Sending…');
    expect(t.onsend).not.toHaveBeenCalled();
    await expectNoA11yViolations(t.container);
    await vi.waitFor(() =>
      expect(t.onsend).toHaveBeenCalledWith('add milk', []),
    );
    expect(t.capture.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.field.value).toBe(''));
  });

  it('a new utterance during the grace period cancels the send and keeps appending', async () => {
    const t = setup(['add milk', 'and eggs']);
    await t.listen();
    t.say();
    await vi.waitFor(() => expect(t.field.value).toBe('add milk'));
    await wait(GRACE / 3);
    t.speaking(true);
    await wait(GRACE * 2);
    expect(t.onsend).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).not.toHaveTextContent('Sending…');
    t.speaking(false);
    t.say();
    await vi.waitFor(() =>
      expect(t.onsend).toHaveBeenCalledWith('add milk and eggs', []),
    );
    expect(t.onsend).toHaveBeenCalledTimes(1);
  });

  it('waits for queued transcriptions before sending, in spoken order', async () => {
    let release: (text: string) => void = () => {};
    const slow = new Promise<string>((r) => {
      release = r;
    });
    const t = setup([slow, 'and eggs']);
    await t.listen();
    t.say();
    t.say();
    await wait(GRACE * 2);
    expect(t.onsend).not.toHaveBeenCalled();
    release('add milk');
    await vi.waitFor(() =>
      expect(t.onsend).toHaveBeenCalledWith('add milk and eggs', []),
    );
    expect(t.onsend).toHaveBeenCalledTimes(1);
  });

  it('never sends an empty or noise-only message', async () => {
    const t = setup(['', '[BLANK_AUDIO]', '   ']);
    await t.listen();
    t.say();
    t.say();
    t.say();
    await wait(GRACE * 3);
    expect(t.onsend).not.toHaveBeenCalled();
    expect(t.field.value).toBe('');
  });

  it('while a send is in flight the next one waits, and only the newer text goes', async () => {
    let finish: () => void = () => {};
    const first = new Promise<void>((r) => {
      finish = r;
    });
    const t = setup(['one', 'two']);
    t.onsend.mockReturnValueOnce(first);
    await t.listen();
    t.say();
    await vi.waitFor(() => expect(t.onsend).toHaveBeenCalledWith('one', []));
    t.say();
    // The sent text left the box at once; the new sentence is alone in it.
    await vi.waitFor(() => expect(t.field.value).toBe('two'));
    await wait(GRACE * 2);
    expect(t.onsend).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(t.onsend).toHaveBeenCalledTimes(2));
    expect(t.onsend).toHaveBeenLastCalledWith('two', []);
  });

  it('Escape cancels the pending send and stops listening; the text stays', async () => {
    const t = setup(['add milk']);
    await t.listen();
    t.say();
    await vi.waitFor(() => expect(t.field.value).toBe('add milk'));
    await fireEvent.keyDown(t.field, { key: 'Escape' });
    await wait(GRACE * 2);
    expect(t.onsend).not.toHaveBeenCalled();
    expect(t.field.value).toBe('add milk');
    expect(t.capture.stop).toHaveBeenCalled();
  });

  it('tapping the microphone cancels the pending send', async () => {
    const t = setup(['add milk']);
    await t.listen();
    t.say();
    await vi.waitFor(() => expect(t.field.value).toBe('add milk'));
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop listening' }),
    );
    await wait(GRACE * 2);
    expect(t.onsend).not.toHaveBeenCalled();
    expect(t.field.value).toBe('add milk');
  });

  it('typing takes over: no automatic send', async () => {
    const t = setup(['add milk']);
    await t.listen();
    t.say();
    await vi.waitFor(() => expect(t.field.value).toBe('add milk'));
    await fireEvent.keyDown(t.field, { key: 'x' });
    await wait(GRACE * 2);
    expect(t.onsend).not.toHaveBeenCalled();
  });

  it('is off by default', async () => {
    const t = setup(['add milk'], { sendOnPause: false });
    await t.listen();
    t.say();
    await vi.waitFor(() => expect(t.field.value).toBe('add milk'));
    await wait(GRACE * 2);
    expect(t.onsend).not.toHaveBeenCalled();
  });
});
