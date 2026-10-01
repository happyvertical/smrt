// @vitest-environment jsdom
/**
 * Previewable choices: a click previews a card in place (nothing applied),
 * another click swaps the preview, "Original" shows the page as it was, and
 * only the commit button applies. Cancel, Escape, dismissing and disposing
 * restore the original.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantClientToolCall } from '../../../../assistant-turn-events.js';
import AssistantDock from '../AssistantDock.svelte';
import {
  type AssistantChoiceOption,
  type AssistantChoiceSource,
  createAssistantChoiceSourceRegistry,
} from '../assistant-choices.svelte.js';
import type {
  AssistantMessage,
  AssistantResumeTurnInput,
  AssistantSendMessageInput,
  AssistantTransport,
} from '../assistant-transport.js';
import type { createAssistantDockController } from '../create-assistant-dock-controller.svelte.js';

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

async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const ORIGINAL = { id: 'original', label: 'Original', imageUrl: '/p/1?orig' };

function previewSource() {
  const shown: Array<string | null> = [];
  const apply = vi.fn(async () => 'Changed it.');
  const source: AssistantChoiceSource = {
    id: 'picture_adjust',
    description: 'Quick changes.',
    offer: async () => ({
      title: 'Pick a version',
      options: [
        { id: 'a', label: 'Brighter', imageUrl: '/p/1?a' },
        { id: 'b', label: 'Much brighter', imageUrl: '/p/1?b' },
      ],
      original: ORIGINAL,
      commitLabel: 'Use this picture',
      cancelLabel: 'Keep the original',
    }),
    apply,
    preview: (option: AssistantChoiceOption | null) => {
      shown.push(
        option?.id === 'original' || !option ? null : (option.imageUrl ?? null),
      );
    },
  };
  return { source, shown, apply };
}

async function mount(source: AssistantChoiceSource) {
  const registry = createAssistantChoiceSourceRegistry();
  registry.register(source);
  const transport = suspendingTransport([
    {
      id: 'c1',
      name: 'assistant_offer_picture_adjust',
      args: {},
      effect: 'read',
    },
  ]);
  let controller: ReturnType<typeof createAssistantDockController> | undefined;
  const view = render(AssistantDock, {
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
  await controller?.send('brighter');
  await screen.findByRole('group', { name: 'Pick a version' });
  return { controller: controller as NonNullable<typeof controller>, view };
}

describe('previewable choices', () => {
  it('previews a click, swaps the preview, shows the original, and applies nothing', async () => {
    const { source, shown, apply } = previewSource();
    const { controller } = await mount(source);
    // The Original card comes first.
    const cards = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-pressed'));
    expect(cards.map((b) => b.textContent?.trim())).toEqual([
      'Original',
      'Brighter',
      'Much brighter',
    ]);

    await userEvent.click(screen.getByRole('button', { name: /^Brighter/ }));
    await until(() => shown.length === 1);
    expect(shown).toEqual(['/p/1?a']);
    expect(
      screen
        .getByRole('button', { name: /^Brighter/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    await userEvent.click(
      screen.getByRole('button', { name: /^Much brighter/ }),
    );
    await until(() => shown.length === 2);
    expect(shown).toEqual(['/p/1?a', '/p/1?b']);
    expect(
      screen
        .getByRole('button', { name: /^Brighter/ })
        .getAttribute('aria-pressed'),
    ).toBe('false');

    await userEvent.click(screen.getByRole('button', { name: /^Original/ }));
    await until(() => shown.length === 3);
    expect(shown).toEqual(['/p/1?a', '/p/1?b', null]);
    expect(apply).not.toHaveBeenCalled();
    expect(controller.choices[0].status).toBe('waiting');
  });

  it('keeps the commit button off until a version is previewed, then applies only the previewed one and resolves', async () => {
    const { source, apply } = previewSource();
    const { controller } = await mount(source);
    const use = screen.getByRole('button', {
      name: 'Use this picture',
    }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    await userEvent.click(
      screen.getByRole('button', { name: /^Much brighter/ }),
    );
    await until(() => !use.disabled);
    expect(use.disabled).toBe(false);
    await userEvent.click(use);
    await until(() => apply.mock.calls.length > 0);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(await screen.findByText('Changed it.')).toBeTruthy();
    expect(controller.choices[0]).toMatchObject({
      status: 'applied',
      chosenOptionId: 'b',
    });
    // The cards collapse once resolved.
    expect(screen.queryByRole('button', { name: /^Brighter/ })).toBeNull();
  });

  it('cancel restores the original and closes without applying', async () => {
    const { source, shown, apply } = previewSource();
    await mount(source);
    await userEvent.click(screen.getByRole('button', { name: /^Brighter/ }));
    await until(() => shown.length === 1);
    await userEvent.click(
      screen.getByRole('button', { name: 'Keep the original' }),
    );
    await until(() => shown.length === 2);
    expect(shown).toEqual(['/p/1?a', null]);
    expect(screen.queryByRole('group', { name: 'Pick a version' })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('Escape cancels an open preview', async () => {
    const { source, shown, apply } = previewSource();
    await mount(source);
    const card = screen.getByRole('button', { name: /^Brighter/ });
    await userEvent.click(card);
    await until(() => shown.length === 1);
    card.focus();
    await userEvent.keyboard('{Escape}');
    await until(() => shown.length === 2);
    expect(shown).toEqual(['/p/1?a', null]);
    expect(screen.queryByRole('group', { name: 'Pick a version' })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('puts the page back when the conversation is disposed with an uncommitted preview', async () => {
    const { source, shown, apply } = previewSource();
    const { controller } = await mount(source);
    await userEvent.click(screen.getByRole('button', { name: /^Brighter/ }));
    await until(() => shown.length === 1);
    controller.dispose();
    await until(() => shown.length === 2);
    expect(shown).toEqual(['/p/1?a', null]);
    expect(apply).not.toHaveBeenCalled();
  });

  it('a source without preview still applies on click', async () => {
    const apply = vi.fn(async () => 'Done.');
    const { source } = previewSource();
    await mount({ ...source, preview: undefined, apply });
    await userEvent.click(screen.getByRole('button', { name: /^Brighter/ }));
    await until(() => apply.mock.calls.length > 0);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Use this picture' }),
    ).toBeNull();
  });
});
