// @vitest-environment jsdom
/**
 * Choices: the assistant offers a few options (from a page-registered
 * source, never from the model), the person clicks one, and only that click
 * applies it.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantClientToolCall } from '../../../../assistant-turn-events.js';
import AssistantDock from '../AssistantDock.svelte';
import {
  type AssistantChoiceSource,
  choiceToolName,
  createAssistantChoiceSourceRegistry,
  normalizeChoiceOptions,
  safeChoiceImageUrl,
} from '../assistant-choices.svelte.js';
import type {
  AssistantMessage,
  AssistantResumeTurnInput,
  AssistantSendMessageInput,
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

function suspendingTransport(calls: AssistantClientToolCall[]) {
  const sent: AssistantSendMessageInput[] = [];
  const resumed: AssistantResumeTurnInput[] = [];
  const transport: AssistantTransport & {
    sent: typeof sent;
    resumed: typeof resumed;
  } = {
    sent,
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
      sent.push(input);
      return {
        inProgress: false,
        userMessage: message('u1', 'user', input.content),
        clientToolCalls: {
          continuationId: `cont-${sent.length}`,
          calls: calls.map((call) => ({
            ...call,
            id: sent.length > 1 ? `${call.id}-${sent.length}` : call.id,
          })),
        },
      };
    },
    async resumeTurn(input) {
      resumed.push(input);
      const reply = message('a1', 'assistant', 'Pick one of these.');
      return { inProgress: false, assistantMessage: reply };
    },
  };
  return transport;
}

function cropSource(apply = vi.fn(async () => 'Cropped to a square.')) {
  const offer = vi.fn(async () => ({
    title: 'Pick a crop',
    options: [
      { id: 'wide', label: 'Wide', imageUrl: '/p/1?w=16', value: { w: 16 } },
      { id: 'square', label: 'Square', imageUrl: '/p/1?w=1' },
      { id: 'evil', label: 'Remote', imageUrl: 'https://evil.test/x.png' },
    ],
  }));
  const source: AssistantChoiceSource = {
    id: 'picture_crop',
    description: 'Offer crops of the selected picture.',
    inputSchema: {
      type: 'object',
      properties: { tighter: { type: 'boolean' } },
    },
    offer,
    apply,
  };
  return { source, offer, apply };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('choice helpers', () => {
  it('only allows same-origin image paths', () => {
    expect(safeChoiceImageUrl('/sites/a/p.jpg?size=card')).toBe(
      '/sites/a/p.jpg?size=card',
    );
    for (const bad of [
      '//evil.test/x',
      'https://x.test/a.jpg',
      '/\\evil',
      'javascript:alert(1)',
      '/a b',
      5,
    ]) {
      expect(safeChoiceImageUrl(bad)).toBeNull();
    }
  });

  it('keeps at most four unique, labelled options', () => {
    const options = normalizeChoiceOptions([
      { id: 'a', label: 'A' },
      { id: 'a', label: 'dupe' },
      { id: '', label: 'no id' },
      { id: 'b', label: '' },
      { id: 'c', label: 'C', imageUrl: 'https://x.test/c.jpg' },
      { id: 'd', label: 'D' },
      { id: 'e', label: 'E' },
      { id: 'f', label: 'F' },
    ]);
    expect(options.map((o) => o.id)).toEqual(['a', 'c', 'd', 'e']);
    expect(options[1].imageUrl).toBeUndefined();
  });

  it('rejects bad source ids and unregisters', () => {
    const registry = createAssistantChoiceSourceRegistry();
    expect(() =>
      registry.register({ ...cropSource().source, id: 'Bad Id' }),
    ).toThrow();
    const off = registry.register(cropSource().source);
    expect(registry.list()).toHaveLength(1);
    off();
    expect(registry.list()).toHaveLength(0);
  });
});

describe('dock choices', () => {
  it("offers each source as a read tool, and applies only on the person's pick", async () => {
    const registry = createAssistantChoiceSourceRegistry();
    const { source, offer, apply } = cropSource();
    registry.register(source);
    const transport = suspendingTransport([
      {
        id: 'c1',
        name: choiceToolName('picture_crop'),
        args: { tighter: true },
        effect: 'read',
      },
    ]);
    const controller = createAssistantDockController({
      transport,
      registry: createDataSurfaceRegistry(),
      choiceSources: registry,
    });
    await controller.loadThreads();
    await controller.openThread('t1');
    await controller.send('crop this tighter');

    const declared = transport.sent[0].clientTools ?? [];
    expect(declared.map((tool) => tool.name)).toContain(
      'assistant_offer_picture_crop',
    );
    expect(
      declared.find((tool) => tool.name === 'assistant_offer_picture_crop')
        ?.effect,
    ).toBe('read');
    expect(offer).toHaveBeenCalledWith({ tighter: true }, expect.anything());

    // The model learns the options by id and label only; nothing applied yet.
    const result = transport.resumed[0].results[0];
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.result ?? '{}')).toEqual({
      offered: true,
      waitingForUser: true,
      options: [
        { id: 'wide', label: 'Wide' },
        { id: 'square', label: 'Square' },
        { id: 'evil', label: 'Remote' },
      ],
    });
    expect(apply).not.toHaveBeenCalled();
    expect(controller.choices[0].status).toBe('waiting');
    expect(controller.choices[0].options[2].imageUrl).toBeUndefined();
    expect(controller.status.label).toBe('Pick one of the options');
    // A supervised run waits for the person's pick.
    expect(controller.run?.state).toBe('waiting');
    expect(controller.run?.waitingFor).toMatchObject({
      kind: 'choice',
      label: 'Pick a crop',
    });

    await controller.chooseOption('c1', 'square');
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'square' }),
    );
    expect(controller.choices[0]).toMatchObject({
      status: 'applied',
      chosenOptionId: 'square',
      outcome: 'Cropped to a square.',
    });
    expect(controller.run?.waitingFor?.kind).not.toBe('choice');
    // A second pick is ignored once applied.
    await controller.chooseOption('c1', 'wide');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('reports a source error to the model and shows nothing', async () => {
    const registry = createAssistantChoiceSourceRegistry();
    registry.register({
      id: 'picture_find',
      description: 'Find pictures.',
      offer: () => {
        throw new Error('No pictures match "arena".');
      },
      apply: () => undefined,
    });
    const transport = suspendingTransport([
      {
        id: 'c1',
        name: 'assistant_offer_picture_find',
        args: {},
        effect: 'read',
      },
    ]);
    const controller = createAssistantDockController({
      transport,
      registry: createDataSurfaceRegistry(),
      choiceSources: registry,
    });
    await controller.loadThreads();
    await controller.openThread('t1');
    await controller.send('find the arena');
    expect(transport.resumed[0].results[0]).toEqual({
      id: 'c1',
      ok: false,
      error: 'No pictures match "arena".',
    });
    expect(controller.choices).toHaveLength(0);
  });

  it('marks a failed apply so the person can pick again, and fails when the page is gone', async () => {
    const registry = createAssistantChoiceSourceRegistry();
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error('The picture is not in the story'))
      .mockResolvedValueOnce(undefined);
    const { source } = cropSource(apply);
    const off = registry.register(source);
    const transport = suspendingTransport([
      {
        id: 'c1',
        name: 'assistant_offer_picture_crop',
        args: {},
        effect: 'read',
      },
    ]);
    const controller = createAssistantDockController({
      transport,
      registry: createDataSurfaceRegistry(),
      choiceSources: registry,
    });
    await controller.loadThreads();
    await controller.openThread('t1');
    await controller.send('crop');
    await controller.chooseOption('c1', 'wide');
    expect(controller.choices[0]).toMatchObject({
      status: 'failed',
      error: 'The picture is not in the story',
    });
    await controller.chooseOption('c1', 'square');
    expect(controller.choices[0].status).toBe('applied');

    // A newer request replaces an offer still waiting, not an applied one.
    await controller.send('crop again');
    expect(controller.choices.map((s) => s.status)).toEqual([
      'applied',
      'waiting',
    ]);
    await controller.send('and again');
    expect(controller.choices.map((s) => s.status)).toEqual([
      'applied',
      'dismissed',
      'waiting',
    ]);
    // The page went away: a pick fails plainly instead of applying.
    off();
    await controller.chooseOption('c1-3', 'wide');
    expect(controller.choices[2]).toMatchObject({
      status: 'failed',
      error: 'This is no longer on the page.',
    });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('renders picture cards and applies the clicked one', async () => {
    const registry = createAssistantChoiceSourceRegistry();
    const { source, apply } = cropSource();
    registry.register(source);
    const transport = suspendingTransport([
      {
        id: 'c1',
        name: 'assistant_offer_picture_crop',
        args: {},
        effect: 'read',
      },
    ]);
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
    await controller?.send('crop this');
    const group = await screen.findByRole('group', { name: 'Pick a crop' });
    const images = group.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('src')).toBe('/p/1?w=16');
    expect(screen.getByText('Pick one to use it.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Square/ }));
    await until(() => apply.mock.calls.length > 0);
    expect(await screen.findByText('Cropped to a square.')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: /Square/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('dismisses with None of these', async () => {
    const registry = createAssistantChoiceSourceRegistry();
    const { source, apply } = cropSource();
    registry.register(source);
    const transport = suspendingTransport([
      {
        id: 'c1',
        name: 'assistant_offer_picture_crop',
        args: {},
        effect: 'read',
      },
    ]);
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
    await controller?.send('crop this');
    await userEvent.click(
      await screen.findByRole('button', { name: 'None of these' }),
    );
    expect(screen.queryByRole('group', { name: 'Pick a crop' })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});
