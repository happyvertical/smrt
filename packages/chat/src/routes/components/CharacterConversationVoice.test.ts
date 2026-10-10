// @vitest-environment jsdom
import type {
  DictationSpeechResult,
  DictationSpeechSource,
} from '@happyvertical/smrt-ui/forms';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CharacterConversationVoice from './CharacterConversationVoice.svelte';

const mocks = vi.hoisted(() => ({
  createSttDictationSource: vi.fn(),
}));

vi.mock('@happyvertical/smrt-svelte/browser-ai', () => ({
  createSttDictationSource: mocks.createSttDictationSource,
}));

function speechSource() {
  const results = new Set<(result: DictationSpeechResult) => void>();
  const ends = new Set<() => void>();
  const source: DictationSpeechSource = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      for (const callback of ends) callback();
    }),
    onResult(callback) {
      results.add(callback);
      return () => results.delete(callback);
    },
    onError() {
      return () => {};
    },
    onEnd(callback) {
      ends.add(callback);
      return () => ends.delete(callback);
    },
  };
  return {
    source,
    emit(text: string, isFinal: boolean) {
      for (const callback of results) callback({ text, isFinal });
    },
  };
}

describe('CharacterConversationVoice', () => {
  afterEach(() => vi.clearAllMocks());

  it('does not create a recognizer until the explicit microphone click, then reuses one source', async () => {
    const speech = speechSource();
    mocks.createSttDictationSource.mockReturnValue(async () => speech.source);
    render(CharacterConversationVoice, { props: { onfinal: vi.fn() } });

    expect(mocks.createSttDictationSource).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Speak to your assistant' }),
    );
    await vi.waitFor(() =>
      expect(speech.source.start).toHaveBeenCalledTimes(1),
    );
    expect(mocks.createSttDictationSource).toHaveBeenCalledTimes(1);

    await userEvent.click(
      screen.getByRole('button', { name: 'Stop listening' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Speak to your assistant' }),
    );
    await vi.waitFor(() =>
      expect(speech.source.start).toHaveBeenCalledTimes(2),
    );
    expect(mocks.createSttDictationSource).toHaveBeenCalledTimes(1);
  });

  it('shows interim and final HeardCaptions separately and sends only final speech', async () => {
    const speech = speechSource();
    const onfinal = vi.fn();
    mocks.createSttDictationSource.mockReturnValue(async () => speech.source);
    render(CharacterConversationVoice, { props: { onfinal } });

    await userEvent.click(
      screen.getByRole('button', { name: 'Speak to your assistant' }),
    );
    await vi.waitFor(() => expect(speech.source.start).toHaveBeenCalled());
    speech.emit('half a sentence', false);
    await vi.waitFor(() =>
      expect(screen.getByText('half a sentence')).toHaveAttribute(
        'aria-hidden',
        'true',
      ),
    );
    expect(onfinal).not.toHaveBeenCalled();

    speech.emit('final sentence', true);
    expect(await screen.findByText('final sentence')).toBeInTheDocument();
    expect(onfinal).toHaveBeenCalledWith('final sentence');
  });

  it('keeps a typed fallback that sends through the same final callback', async () => {
    const onfinal = vi.fn();
    render(CharacterConversationVoice, { props: { onfinal } });
    const field = screen.getByLabelText('Type your message');
    await userEvent.type(field, ' Typed turn ');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onfinal).toHaveBeenCalledWith('Typed turn');
  });

  it('submits a typed turn with Enter and suppresses a second click while sending', async () => {
    let release!: () => void;
    const onfinal = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    render(CharacterConversationVoice, { props: { onfinal } });
    const field = screen.getByLabelText('Type your message');
    await userEvent.type(field, 'first turn');
    await userEvent.keyboard('{Enter}');
    expect(onfinal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onfinal).toHaveBeenCalledTimes(1);
    release();
  });

  it('suppresses late finals while sending and leaves Stop reachable', async () => {
    const speech = speechSource();
    let release!: () => void;
    const onfinal = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mocks.createSttDictationSource.mockReturnValue(async () => speech.source);
    render(CharacterConversationVoice, { props: { onfinal } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Speak to your assistant' }),
    );
    await vi.waitFor(() => expect(speech.source.start).toHaveBeenCalled());
    speech.emit('first', true);
    speech.emit('late', true);
    expect(onfinal).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop listening' }),
    );
    expect(speech.source.stop).toHaveBeenCalled();
    release();
  });

  it('suppresses recognition finals during confirmation and after unmount', async () => {
    const speech = speechSource();
    const onfinal = vi.fn();
    mocks.createSttDictationSource.mockReturnValue(async () => speech.source);
    const view = render(CharacterConversationVoice, { props: { onfinal } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Speak to your assistant' }),
    );
    await vi.waitFor(() => expect(speech.source.start).toHaveBeenCalled());
    await view.rerender({ onfinal, disabled: true });
    speech.emit('late confirmation', true);
    expect(onfinal).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Stop listening' }),
    ).toBeEnabled();
    view.unmount();
    speech.emit('hidden', true);
    expect(onfinal).not.toHaveBeenCalled();
    expect(speech.source.stop).toHaveBeenCalled();
  });

  it('keeps the typed fallback visible when speech recognition is unsupported', async () => {
    mocks.createSttDictationSource.mockReturnValue(async () => {
      throw new Error('Speech recognition is unsupported');
    });
    render(CharacterConversationVoice, { props: { onfinal: vi.fn() } });

    await userEvent.click(
      screen.getByRole('button', { name: 'Speak to your assistant' }),
    );
    expect(
      await screen.findByText(
        'Speech input is unavailable. Type your message below.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Type your message')).toBeEnabled();
  });
});
