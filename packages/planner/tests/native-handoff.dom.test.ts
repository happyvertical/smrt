import { mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import { aiState } from '../src/lib/ai/instance.ts';
import Planner from '../src/lib/planner/Planner.svelte';
import PlannerLifecycle from '../src/lib/planner/PlannerLifecycle.svelte';
import type { PlannerHandle } from '../src/lib/planner/types.ts';

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
