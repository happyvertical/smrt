// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CharacterConversation from './CharacterConversation.svelte';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  mount: vi.fn(),
  destroy: vi.fn(),
  play: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  events: {} as { onStart?: () => void; onEnd?: () => void },
  reply: (_text: string) => {},
  proposal: (_proposal: { kind: string; value: string }) => {},
}));
vi.mock('@happyvertical/animation', () => ({ mountPhotoCutout: mocks.mount }));
vi.mock('../../dev-character-persistence-client.js', () => ({
  createDevCharacterPersistenceClient: () => ({ load: mocks.load }),
}));
vi.mock('@happyvertical/speech/browser', () => ({
  createSpeechPlayback: (events: typeof mocks.events) => {
    mocks.events = events;
    return {
      play: mocks.play,
      stop: mocks.stop,
      prepare: vi.fn(),
      destroy: vi.fn(),
    };
  },
}));
vi.mock('../../dev-assistant-transport.js', () => ({
  createDevAssistantTransport: (
    _fetch: unknown,
    reply: typeof mocks.reply,
    proposal: typeof mocks.proposal,
  ) => {
    mocks.reply = reply;
    mocks.proposal = proposal;
    return {
      listThreads: async () => [],
      loadMessages: async () => [],
      sendMessage: mocks.sendMessage,
    };
  },
}));
const saved = (name: string) => ({
  rig: { name },
  pngDataUrl: 'data:image/png;base64,YQ==',
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('conversation lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    mocks.load.mockResolvedValue(null);
    mocks.mount.mockImplementation(() => ({
      destroy: mocks.destroy,
      setMouthOpen: vi.fn(),
      setExpression: vi.fn(),
    }));
    mocks.play.mockResolvedValue(undefined);
  });
  it('previews and applies a 200-character draft through canonical confirmation', async () => {
    const stageDraft = vi.fn();
    render(CharacterConversation, {
      props: { workbenchAction: { stageDraft } },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Talk to your assistant' }),
    );
    const value = 'x'.repeat(200);
    mocks.proposal({ kind: 'stageDraft', value });
    const confirm = await screen.findByRole('button', {
      name: 'Confirm',
      exact: true,
    });
    expect(stageDraft).not.toHaveBeenCalled();
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(stageDraft).toHaveBeenCalledWith(value));
  });
  it('keeps an in-flight turn locked across tab and listening-mode remounts', async () => {
    const pending = deferred<unknown>();
    mocks.sendMessage.mockReturnValue(pending.promise);
    const view = render(CharacterConversation);
    await userEvent.click(
      screen.getByRole('button', { name: 'Listening mode', exact: true }),
    );
    await userEvent.type(
      screen.getByLabelText('Type your message'),
      'First pending turn',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Send message', exact: true }),
    );
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    await view.rerender({ active: false });
    await view.rerender({ active: true });
    await userEvent.click(
      screen.getByRole('button', { name: 'Listening mode', exact: true }),
    );
    expect(screen.getByLabelText('Type your message')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Speak to your assistant' }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Send message', exact: true }),
    );
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const userMessage = {
      id: 'first',
      threadId: 'dev-character-conversation',
      role: 'user',
      content: 'First pending turn',
      createdAt: new Date().toISOString(),
    };
    const assistantMessage = {
      ...userMessage,
      id: 'reply',
      role: 'assistant',
      content: 'First reply',
    };
    pending.resolve({
      inProgress: false,
      userMessage,
      assistantMessage,
      messages: [userMessage, assistantMessage],
    });
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Type your message')).toBeEnabled(),
    );
  });

  it('refreshes an initially missing and then replaced saved rig on activation', async () => {
    const view = render(CharacterConversation);
    await screen.findByText(/Save a character in Character setup/);
    await view.rerender({ active: false });
    mocks.load.mockResolvedValue(saved('first'));
    await view.rerender({ active: true });
    await vi.waitFor(() =>
      expect(mocks.mount).toHaveBeenCalledWith(
        { name: 'first' },
        expect.anything(),
      ),
    );
    await view.rerender({ active: false });
    mocks.load.mockResolvedValue(saved('replacement'));
    await view.rerender({ active: true });
    await vi.waitFor(() =>
      expect(mocks.mount).toHaveBeenLastCalledWith(
        { name: 'replacement' },
        expect.anything(),
      ),
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it('leaves listening mode when hidden and requires explicit restart', async () => {
    const view = render(CharacterConversation);
    await userEvent.click(
      screen.getByRole('button', { name: 'Listening mode' }),
    );
    expect(screen.getByLabelText('Type your message')).toBeInTheDocument();
    await view.rerender({ active: false });
    expect(
      screen.queryByLabelText('Type your message'),
    ).not.toBeInTheDocument();
    await view.rerender({ active: true });
    expect(
      screen.queryByLabelText('Type your message'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Listening mode' }),
    ).toBeInTheDocument();
  });
  it('ignores an obsolete saved-character load after tab changes', async () => {
    const old = deferred<ReturnType<typeof saved>>();
    mocks.load
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(saved('current'));
    const view = render(CharacterConversation);
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    await view.rerender({ active: false });
    await view.rerender({ active: true });
    await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledTimes(1));
    old.resolve(saved('obsolete'));
    await new Promise((done) => setTimeout(done, 0));
    expect(mocks.mount).toHaveBeenCalledTimes(1);
  });
  it('publishes captions only on actual playback and clears failure', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response('audio'));
    vi.stubGlobal('fetch', request);
    const playing = deferred<void>();
    mocks.play.mockReturnValue(playing.promise);
    render(CharacterConversation);
    await userEvent.click(
      screen.getByRole('button', { name: 'Enable spoken replies' }),
    );
    mocks.reply('failed speech');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('failed speech')).not.toBeInTheDocument();
    mocks.reply('actual speech');
    await vi.waitFor(() => expect(mocks.play).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('actual speech')).not.toBeInTheDocument();
    mocks.events.onStart?.();
    expect(await screen.findByText('actual speech')).toBeInTheDocument();
    mocks.events.onEnd?.();
    playing.resolve();
  });
  it('does not play a delayed obsolete body or a body completed after hide/disposal', async () => {
    const old = deferred<ArrayBuffer>();
    const hidden = deferred<ArrayBuffer>();
    const disposed = deferred<ArrayBuffer>();
    const response = (body: Promise<ArrayBuffer>) => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => body,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(old.promise))
        .mockResolvedValueOnce(new Response('new audio'))
        .mockResolvedValueOnce(response(hidden.promise))
        .mockResolvedValueOnce(response(disposed.promise)),
    );
    const view = render(CharacterConversation);
    await userEvent.click(
      screen.getByRole('button', { name: 'Enable spoken replies' }),
    );
    mocks.reply('old');
    await new Promise((done) => setTimeout(done, 0));
    mocks.reply('new');
    await vi.waitFor(() => expect(mocks.play).toHaveBeenCalledTimes(1));
    old.resolve(new ArrayBuffer(1));
    mocks.reply('hidden');
    await new Promise((done) => setTimeout(done, 0));
    await view.rerender({ active: false });
    hidden.resolve(new ArrayBuffer(2));
    await view.rerender({ active: true });
    mocks.reply('disposed');
    await new Promise((done) => setTimeout(done, 0));
    view.unmount();
    disposed.resolve(new ArrayBuffer(3));
    await new Promise((done) => setTimeout(done, 0));
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });
});
