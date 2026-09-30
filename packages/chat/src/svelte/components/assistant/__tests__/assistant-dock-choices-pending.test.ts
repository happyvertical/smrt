// @vitest-environment jsdom
/**
 * Choices whose options take a while (generated pictures): the offer shows
 * "Making…" placeholders, options are added as they finish, the person can
 * pick any that arrived, and a failure is said plainly.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantClientToolCall } from '../../../../assistant-turn-events.js';
import AssistantDock from '../AssistantDock.svelte';
import {
  type AssistantChoicePendingUpdate,
  type AssistantChoiceSource,
  choiceToolName,
  createAssistantChoiceSourceRegistry,
} from '../assistant-choices.svelte.js';
import type {
  AssistantMessage,
  AssistantTransport,
} from '../assistant-transport.js';
import { createAssistantDockController } from '../create-assistant-dock-controller.svelte.js';

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

/** Every send asks for one choice tool call; resuming answers in text. */
function transportCalling(call: AssistantClientToolCall) {
  const resumed: Array<{ results: Array<{ ok: boolean; result?: string }> }> =
    [];
  let sends = 0;
  const transport: AssistantTransport & { resumed: typeof resumed } = {
    resumed,
    async listThreads() {
      return [{ id: 't1', title: 'T', isResolved: false, messageCount: 0 }];
    },
    async createThread() {
      return { id: 't1', title: 'T', isResolved: false, messageCount: 0 };
    },
    async loadMessages() {
      return [];
    },
    async uploadAttachment() {
      throw new Error('no');
    },
    async sendMessage(input) {
      sends += 1;
      return {
        inProgress: false,
        userMessage: message(`u${sends}`, 'user', input.content),
        clientToolCalls: {
          continuationId: `cont-${sends}`,
          calls: [{ ...call, id: sends > 1 ? `${call.id}-${sends}` : call.id }],
        },
      };
    },
    async resumeTurn(input) {
      resumed.push(input as never);
      return {
        inProgress: false,
        assistantMessage: message('a1', 'assistant', 'Making them now.'),
      };
    },
  };
  return transport;
}

/** A source whose versions arrive when the test says so. */
function slowSource() {
  let update: AssistantChoicePendingUpdate | undefined;
  let signal: AbortSignal | undefined;
  let finish: (err?: Error) => void = () => {};
  const apply = vi.fn(async () => 'Used the snowy one.');
  const source: AssistantChoiceSource = {
    id: 'picture_edit',
    description: 'Make new versions of the picture.',
    offer: () => ({
      title: 'Snowy versions',
      options: [],
      pending: {
        message: 'Making versions… this takes a minute or two.',
        expected: 3,
        fill: (u, s) =>
          new Promise<void>((resolve, reject) => {
            update = u;
            signal = s;
            finish = (err) => (err ? reject(err) : resolve());
          }),
      },
    }),
    apply,
  };
  return {
    source,
    apply,
    add: (id: string) =>
      update?.add([{ id, label: `Version ${id}`, imageUrl: `/v/${id}.jpg` }]),
    finish: (err?: Error) => finish(err),
    signal: () => signal,
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function offered(slow: ReturnType<typeof slowSource>) {
  const registry = createAssistantChoiceSourceRegistry();
  registry.register(slow.source);
  const transport = transportCalling({
    id: 'e1',
    name: choiceToolName('picture_edit'),
    args: {},
    effect: 'read',
  });
  const controller = createAssistantDockController({
    transport,
    registry: createDataSurfaceRegistry(),
    choiceSources: registry,
  });
  await controller.loadThreads();
  await controller.openThread('t1');
  await controller.send('make it snowing');
  await until(() => Boolean(slow.signal()));
  return { controller, transport };
}

describe('pending choices', () => {
  it('tells the model versions are coming, fills them in, and applies the pick', async () => {
    const slow = slowSource();
    const { controller, transport } = await offered(slow);

    expect(JSON.parse(transport.resumed[0].results[0].result ?? '{}')).toEqual({
      offered: true,
      waitingForUser: true,
      stillMaking: true,
      progress: 'Making versions… this takes a minute or two.',
      options: [],
    });
    expect(controller.choices[0]).toMatchObject({
      status: 'waiting',
      pending: { expected: 3 },
    });
    expect(controller.status.label).toBe(
      'Making versions… this takes a minute or two.',
    );

    slow.add('a');
    expect(controller.choices[0].options.map((o) => o.id)).toEqual(['a']);
    expect(controller.choices[0].pending?.expected).toBe(2);
    expect(controller.status.label).toBe('Pick one of the options');

    // The person picks the first version while the others are still coming.
    await controller.chooseOption('e1', 'a');
    expect(slow.apply).toHaveBeenCalledTimes(1);
    expect(controller.choices[0]).toMatchObject({ status: 'applied' });
    expect(controller.choices[0].pending).toBeUndefined();
    expect(slow.signal()?.aborted).toBe(true);
    // Late versions are ignored.
    slow.add('b');
    expect(controller.choices[0].options).toHaveLength(1);
  });

  it('keeps the offer when the person sends another message; None of these stops it', async () => {
    const slow = slowSource();
    const { controller } = await offered(slow);
    const firstSignal = slow.signal();
    await controller.send('thanks');
    expect(controller.choices[0]).toMatchObject({
      id: 'e1',
      status: 'waiting',
    });
    expect(firstSignal?.aborted).toBe(false);
    controller.dismissChoices('e1');
    expect(controller.choices[0].status).toBe('dismissed');
    expect(firstSignal?.aborted).toBe(true);
  });

  it('ends ready with what arrived, and notes a partial failure', async () => {
    const slow = slowSource();
    const { controller } = await offered(slow);
    slow.add('a');
    slow.add('b');
    slow.finish(new Error('One version could not be made.'));
    await until(() => !controller.choices[0].pending);
    expect(controller.choices[0]).toMatchObject({
      status: 'waiting',
      note: 'One version could not be made.',
    });
    expect(controller.choices[0].options).toHaveLength(2);
  });

  it('is unavailable, and holds nothing, when no version could be made', async () => {
    const slow = slowSource();
    const { controller } = await offered(slow);
    slow.finish(new Error('The picture service is busy. Try again later.'));
    await until(() => controller.choices[0].status !== 'waiting');
    expect(controller.choices[0]).toMatchObject({
      status: 'unavailable',
      error: 'The picture service is busy. Try again later.',
    });
    expect(controller.status.label).not.toBe('Pick one of the options');
  });

  it('shows placeholders, then the versions as cards', async () => {
    const slow = slowSource();
    const registry = createAssistantChoiceSourceRegistry();
    registry.register(slow.source);
    const transport = transportCalling({
      id: 'e1',
      name: 'assistant_offer_picture_edit',
      args: {},
      effect: 'read',
    });
    let controller:
      | ReturnType<typeof createAssistantDockController>
      | undefined;
    render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        choiceSources: registry,
        oncontroller: (c: ReturnType<typeof createAssistantDockController>) => {
          controller = c;
        },
      },
    });
    await until(() => Boolean(controller));
    await controller?.openThread('t1');
    await controller?.send('make it snowing');
    const group = await screen.findByRole('group', { name: 'Snowy versions' });
    expect(group.getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByText('Making…')).toHaveLength(3);
    expect(
      screen.getAllByText('Making versions… this takes a minute or two.')
        .length,
    ).toBeGreaterThan(0);

    slow.add('a');
    await screen.findByRole('button', { name: /Version a/ });
    expect(screen.getAllByText('Making…')).toHaveLength(2);
    slow.finish();
    await until(() => screen.queryAllByText('Making…').length === 0);
    expect(group.getAttribute('aria-busy')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Version a/ }));
    expect(await screen.findByText('Used the snowy one.')).toBeTruthy();
  });
});
