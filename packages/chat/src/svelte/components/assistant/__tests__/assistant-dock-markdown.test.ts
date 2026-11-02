// @vitest-environment jsdom
/**
 * #4505: opt-in Markdown for assistant answers in the dock, and the host's
 * `renderMessage` snippet hook. The default stays verbatim text.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import type {
  AssistantMessage,
  AssistantSendMessageResult,
  AssistantTransport,
} from '../assistant-transport.js';
import type { AssistantDockController } from '../create-assistant-dock-controller.svelte.js';

function message(
  id: string,
  role: AssistantMessage['role'],
  content: string,
): AssistantMessage {
  return {
    id,
    threadId: 't1',
    role,
    content,
    createdAt: new Date(0).toISOString(),
  };
}

const ANSWER = 'Use **bold** and `code` <img src=x onerror="alert(1)">';

/**
 * A one-thread transport holding `messages`; a send streams `streamed` and
 * then waits for `release()` before answering.
 */
function transport(messages: AssistantMessage[], streamed = '') {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const value: AssistantTransport = {
    async listThreads() {
      return [{ id: 't1', title: 'T', isResolved: false, messageCount: 0 }];
    },
    async createThread() {
      return { id: 't1', title: 'T', isResolved: false, messageCount: 0 };
    },
    async loadMessages() {
      return messages;
    },
    async uploadAttachment() {
      throw new Error('no');
    },
    async sendMessage(input) {
      input.onEvent?.({ type: 'token', text: streamed });
      await held;
      const reply = message('a2', 'assistant', streamed);
      return {
        inProgress: false,
        userMessage: message('u2', 'user', input.content),
        assistantMessage: reply,
      } satisfies AssistantSendMessageResult;
    },
  };
  return { transport: value, release: () => release() };
}

function dock(
  messages: AssistantMessage[],
  props: Record<string, unknown> = {},
  streamed = '',
) {
  const { transport: t, release } = transport(messages, streamed);
  let controller: AssistantDockController | undefined;
  const view = render(AssistantDock, {
    props: {
      transport: t,
      registry: createDataSurfaceRegistry(),
      contextMode: 'server',
      conversations: 'single',
      oncontroller: (value: AssistantDockController) => {
        controller = value;
      },
      ...props,
    },
  });
  return { view, release, controller: () => controller };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('AssistantDock message format (#4505)', () => {
  it('keeps assistant text verbatim by default', async () => {
    const { view } = dock([message('a1', 'assistant', ANSWER)]);
    expect(await screen.findByText(ANSWER)).toBeTruthy();
    expect(view.container.querySelector('strong')).toBeNull();
    expect(view.container.querySelector('.assistant-dock-markdown')).toBeNull();
  });

  it('renders assistant Markdown escaped, and leaves user text plain', async () => {
    const { view } = dock(
      [
        message('u1', 'user', 'Is **this** bold?'),
        message('a1', 'assistant', ANSWER),
      ],
      { messageFormat: 'markdown' },
    );
    await until(
      () => view.container.querySelector('.assistant-dock-markdown') !== null,
    );
    const answer = view.container.querySelector(
      '.assistant-dock-markdown',
    ) as HTMLElement;
    expect(answer.querySelector('strong')?.textContent).toBe('bold');
    expect(answer.querySelector('code')?.textContent).toBe('code');
    // The raw tag is text, never an element.
    expect(answer.querySelector('img')).toBeNull();
    expect(answer.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(screen.getByText('Is **this** bold?')).toBeTruthy();
    expect(
      view.container.querySelectorAll('.assistant-dock-markdown'),
    ).toHaveLength(1);
  });

  it('renders the streaming reply as Markdown too', async () => {
    const { view, release, controller } = dock(
      [],
      { messageFormat: 'markdown' },
      'Partial **answer**',
    );
    await until(() => controller() !== undefined);
    await until(() => controller()?.activeThreadId === 't1');
    const sent = controller()?.send('hi');
    await until(
      () =>
        view.container.querySelector('.assistant-dock-streaming strong') !==
        null,
    );
    expect(
      view.container.querySelector('.assistant-dock-streaming strong')
        ?.textContent,
    ).toBe('answer');
    release();
    await sent;
  });

  it('lets a renderMessage snippet render assistant text, streaming included', async () => {
    const seen: Array<{ id: string; streaming: boolean }> = [];
    const renderMessage = createRawSnippet(
      (args: () => { message: AssistantMessage; streaming: boolean }) => ({
        render: () => {
          const { message: entry, streaming } = args();
          seen.push({ id: entry.id, streaming });
          return `<span data-testid="host-render">${streaming ? 'live' : 'stored'}</span>`;
        },
      }),
    );
    const { view, release, controller } = dock(
      [message('u1', 'user', 'question'), message('a1', 'assistant', ANSWER)],
      { renderMessage, messageFormat: 'markdown' },
      'partial',
    );
    expect(await screen.findByText('stored')).toBeTruthy();
    // The hook wins over messageFormat; user messages keep the default.
    expect(view.container.querySelector('.assistant-dock-markdown')).toBeNull();
    expect(screen.getByText('question')).toBeTruthy();
    await until(() => controller()?.activeThreadId === 't1');
    const sent = controller()?.send('hi');
    expect(await screen.findByText('live')).toBeTruthy();
    expect(seen).toContainEqual({ id: 'a1', streaming: false });
    expect(seen).toContainEqual({
      id: 'assistant-dock-streaming',
      streaming: true,
    });
    release();
    await sent;
  });
});
