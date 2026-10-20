// @vitest-environment jsdom
/**
 * AssistantDock `conversations="single"`: the dock opens straight into one
 * conversation (no list, toggle, or choose/empty screens).
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import {
  type AssistantThreadSummary,
  createInMemoryAssistantTransport,
} from '../assistant-transport.js';
import AssistantDockI18nFixture from './AssistantDockI18nFixture.svelte';

function mount(
  transport = createInMemoryAssistantTransport(),
  props: Record<string, unknown> = {},
) {
  return {
    transport,
    ...render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
        conversations: 'single',
        ...props,
      },
    }),
  };
}

function expectNoConversationChrome() {
  expect(screen.queryByText('Conversations')).not.toBeInTheDocument();
  expect(screen.queryByText(/New conversation/i)).not.toBeInTheDocument();
  expect(screen.queryByText('Create conversation')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: 'Start a conversation' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: 'Choose a conversation' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText('Assistant conversations'),
  ).not.toBeInTheDocument();
}

describe('AssistantDock conversations="single"', () => {
  it('creates a conversation silently and enables the focused composer', async () => {
    const transport = createInMemoryAssistantTransport();
    const create = vi.spyOn(transport, 'createThread');
    const { container } = mount(transport);

    const composer = await screen.findByLabelText('Message');
    await vi.waitFor(() => expect(composer).toBeEnabled());
    await vi.waitFor(() => expect(composer).toHaveFocus());
    expect(create).toHaveBeenCalledTimes(1);
    expectNoConversationChrome();
    await expectNoA11yViolations(container);
  });

  it('reuses the most recent existing thread instead of creating one', async () => {
    const transport = createInMemoryAssistantTransport();
    const threads: AssistantThreadSummary[] = [
      {
        id: 'old',
        title: 'Old',
        isResolved: false,
        messageCount: 1,
        lastMessageAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'new',
        title: 'New',
        isResolved: false,
        messageCount: 1,
        lastMessageAt: '2026-06-01T00:00:00Z',
      },
      {
        id: 'older',
        title: 'Older',
        isResolved: false,
        messageCount: 1,
        lastMessageAt: '2025-01-01T00:00:00Z',
      },
    ];
    transport.listThreads = async () => threads;
    const create = vi.spyOn(transport, 'createThread');
    const load = vi.fn(async (_threadId: string) => []);
    transport.loadMessages = load;

    mount(transport);

    await vi.waitFor(() =>
      expect(screen.getByLabelText('Message')).toBeEnabled(),
    );
    expect(load).toHaveBeenCalledWith('new');
    expect(create).not.toHaveBeenCalled();
    expectNoConversationChrome();
  });

  it('shows a retryable inline error when the conversation cannot be created', async () => {
    const transport = createInMemoryAssistantTransport();
    let attempts = 0;
    const realCreate = transport.createThread.bind(transport);
    transport.createThread = async (title: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return realCreate(title);
    };

    mount(transport);

    expect(
      await screen.findByText(/Something went wrong: offline/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await vi.waitFor(() =>
      expect(screen.getByLabelText('Message')).toBeEnabled(),
    );
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('offers an icon-only clear action that starts a fresh conversation', async () => {
    const transport = createInMemoryAssistantTransport();
    const create = vi.spyOn(transport, 'createThread');
    mount(transport);

    const composer = await screen.findByLabelText('Message');
    await vi.waitFor(() => expect(composer).toBeEnabled());
    expect(
      screen.queryByRole('button', { name: 'Clear conversation' }),
    ).not.toBeInTheDocument();

    await userEvent.type(composer, 'hello{Enter}');
    const clear = await screen.findByRole('button', {
      name: 'Clear conversation',
    });
    expect(clear.textContent?.trim()).toBe('');

    await userEvent.click(clear);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Clear conversation' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
  });

  it('multiple mode (the default) is unchanged: it shows the list and the choose/start screens', async () => {
    const transport = createInMemoryAssistantTransport();
    const create = vi.spyOn(transport, 'createThread');
    render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
      },
    });

    expect(
      await screen.findByRole('heading', { name: 'Start a conversation' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});

it('shows fresh-thread suggestions and sends exactly the clicked intent', async () => {
  const transport = createInMemoryAssistantTransport();
  const send = vi.spyOn(transport, 'sendMessage');
  const user = userEvent.setup();
  mount(transport, {
    suggestions: [
      { label: 'Report on invoices', prompt: 'Count invoices by month' },
    ],
  });
  const choice = await screen.findByRole('button', {
    name: 'Report on invoices',
  });
  expect(
    screen.getByRole('group', { name: 'Conversation starters' }),
  ).toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  await user.click(choice);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0][0]).toMatchObject({
    content: 'Count invoices by month',
  });
  await vi.waitFor(() =>
    expect(
      screen.queryByRole('group', { name: 'Conversation starters' }),
    ).not.toBeInTheDocument(),
  );
});
it('localizes the conversation-starters accessible name through the host snapshot', async () => {
  const transport = createInMemoryAssistantTransport();
  render(AssistantDockI18nFixture, {
    props: {
      transport,
      registry: createDataSurfaceRegistry(),
    },
  });
  expect(
    await screen.findByRole('group', { name: 'Débuts de conversation' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('group', { name: 'Conversation starters' }),
  ).not.toBeInTheDocument();
});
it('keeps starters out of an existing user conversation', async () => {
  const transport = createInMemoryAssistantTransport();
  const thread = await transport.createThread!();
  await transport.sendMessage({
    threadId: thread.id,
    content: 'Existing business context',
    clientRequestId: 'seed',
  });
  mount(transport, {
    suggestions: [{ label: 'Start a report', prompt: 'Count rows' }],
  });
  await screen.findByText('Existing business context');
  expect(
    screen.queryByRole('group', { name: 'Conversation starters' }),
  ).not.toBeInTheDocument();
});
it('keeps explicit suggestion sending disabled with the composer', async () => {
  const transport = createInMemoryAssistantTransport();
  const send = vi.spyOn(transport, 'sendMessage');
  mount(transport, {
    composerDisabled: true,
    suggestions: [{ label: 'Start a report', prompt: 'Count rows' }],
  });
  expect(
    await screen.findByRole('button', { name: 'Start a report' }),
  ).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});
