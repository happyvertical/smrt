import { mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import { aiState } from '../src/lib/ai/instance.ts';
import Planner from '../src/lib/planner/Planner.svelte';
import PlannerLifecycle from '../src/lib/planner/PlannerLifecycle.svelte';
import { plannerTab } from '../src/lib/planner/tab.svelte.ts';
import type { PlannerHandle } from '../src/lib/planner/types.ts';

it('does not expose or export a hidden native thread without inference', async () => {
  const native = aiState.session.transport;
  native.reset();
  native.seed({
    id: 'hidden-old',
    messages: [{ role: 'user', content: 'Hidden old conversation' }],
  });
  const target = document.createElement('div');
  document.body.append(target);
  let handle: PlannerHandle | undefined;
  const header = vi.fn();
  const exported = vi.fn();
  const onreset = vi.fn();
  let app = mount(Planner, {
    target,
    props: {
      persistence: 'host',
      onreset,
      onready: (value: PlannerHandle) => {
        handle = value;
      },
      headerAction: { label: 'Host handoff', run: header },
      exportAction: { label: 'Export handoff', run: exported },
    },
  });
  try {
    for (let n = 0; n < 10; n++) await tick();
    expect(handle?.nativeAssistant).toBeUndefined();
    expect(handle?.openAssistant).toBeUndefined();
    const click = (label: string) =>
      [...target.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === label)
        ?.click();
    click('Host handoff');
    await tick();
    expect(header).toHaveBeenCalledOnce();
    expect(header.mock.calls[0][0].conversation).toEqual([]);
    plannerTab.active = 'export';
    for (let n = 0; n < 10; n++) await tick();
    click('Export handoff');
    await tick();
    expect(exported).toHaveBeenCalledOnce();
    expect(exported.mock.calls[0][0].conversation).toEqual([]);
    const reset = [
      ...target.querySelectorAll<HTMLElement>(
        '[data-export-section="replace"] button',
      ),
    ].find((button) => button.textContent?.trim() === 'Reset project');
    expect(reset).toBeDefined();
    reset?.click();
    for (let n = 0; n < 10; n++) await tick();
    const dialog = target.querySelector('dialog[open]');
    expect(dialog).not.toBeNull();
    dialog?.querySelectorAll('button')[1].click();
    for (let n = 0; n < 10; n++) await tick();
    expect(native.conversation().map((message) => message.content)).toEqual([
      'What would you like to build?',
    ]);
    expect(onreset).toHaveBeenCalledOnce();
    await unmount(app);
    app = mount(Planner, {
      target,
      props: {
        persistence: 'host',
        inference: {
          chat: { message: async () => '{"reply":"Fresh question"}' },
        },
        onready: (value: PlannerHandle) => {
          handle = value;
        },
      },
    });
    for (let n = 0; n < 10; n++) await tick();
    expect(
      handle?.nativeAssistant?.conversation().map((message) => message.content),
    ).toEqual(['What would you like to build?']);
  } finally {
    await unmount(app);
    target.remove();
    native.reset();
  }
});

it('exposes the real native dock transport while preserving the separate legacy assistant', async () => {
  const target = document.createElement('div');
  document.body.append(target);
  let handle: PlannerHandle | undefined;
  const app = mount(PlannerLifecycle, {
    target,
    props: {
      nativeAssistant: true,
      persistence: 'host',
      cookbookOffers: false,
      initialConversation: {
        id: 'dom-host',
        messages: [{ role: 'user', content: 'A workshop management app' }],
      },
      inference: { chat: { message: async () => '{"reply":"What next?"}' } },
      onready: (value: PlannerHandle) => {
        handle = value;
      },
    },
  });
  try {
    await tick();
    expect(handle?.nativeAssistant).toBe(aiState.session.transport);
    expect(await handle?.openAssistant?.()).toBe(false); // No shell in this lifecycle-only fixture.
    expect(handle?.assistant?.transport).not.toBe(handle?.nativeAssistant);
    expect(handle?.nativeAssistant?.conversation().at(-1)?.content).toBe(
      'A workshop management app',
    );
    expect(aiState.session.cookbookOffers).toBe(false);
  } finally {
    await unmount(app);
    target.remove();
  }
  expect(aiState.session.cookbookOffers).toBe(true);
});

it('opens the actual mounted native dock through the public handle and refuses after disposal', async () => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
  });
  const target = document.createElement('div');
  document.body.append(target);
  let handle: PlannerHandle | undefined;
  const app = mount(Planner, {
    target,
    props: {
      persistence: 'host',
      inference: { chat: { message: async () => '{"reply":"What next?"}' } },
      initialConversation: {
        id: 'actual-shell',
        messages: [{ role: 'user', content: 'A repair studio app' }],
      },
      onready: (value: PlannerHandle) => {
        handle = value;
      },
    },
  });
  try {
    for (let n = 0; n < 10; n++) await tick();
    expect(await handle?.openAssistant?.()).toBe(true);
    for (let n = 0; n < 10; n++) await tick();
    expect(target.textContent).toContain('A repair studio app');
  } finally {
    await unmount(app);
    target.remove();
  }
  expect(await handle?.openAssistant?.()).toBe(false);
  vi.unstubAllGlobals();
});
