import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { aiState } from '../src/lib/ai/instance.ts';
import BrowserAssistant from '../src/lib/components/BrowserAssistant.svelte';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { createPlannerDataSource } from '../src/lib/data/planner-source.ts';

let app: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}
afterEach(async () => {
  if (app) await unmount(app);
  target?.remove();
  aiState.session.hostTurn = undefined;
  aiState.session.transport.reset();
});
it('retires the visible native dock immediately on reset without reload or remounting ordinary turns', async () => {
  const native = aiState.session.transport;
  native.reset();
  aiState.useChat(
    { message: async () => '{"reply":"fresh reply","add":[],"remove":[]}' },
    'Test',
  );
  native.seed({
    id: 'old',
    messages: [
      { role: 'user', content: 'Old contact Casey old@example.test' },
      { role: 'assistant', content: 'Old contact acknowledgement' },
    ],
  });
  target = document.createElement('div');
  document.body.append(target);
  app = mount(BrowserAssistant, {
    target,
    context: new Map([[DATA_SOURCE_KEY, createPlannerDataSource()]]),
    props: { registry: createDataSurfaceRegistry() },
  });
  await settle();
  expect(target.textContent).toContain('Old contact Casey');
  const oldComposer = target.querySelector('textarea');
  expect(oldComposer).not.toBeNull();
  native.reset();
  await settle();
  expect(target.textContent).not.toContain('Old contact Casey');
  expect(target.textContent).not.toContain('Old contact acknowledgement');
  expect(native.conversation().map((message) => message.content)).toEqual([
    'What would you like to build?',
  ]);
  const freshComposer = target.querySelector('textarea');
  expect(freshComposer).not.toBe(oldComposer);
  await native.sendMessage({
    threadId: 'planner',
    content: 'Fresh laboratory idea',
    clientRequestId: 'new',
  });
  await settle();
  expect(target.querySelector('textarea')).toBe(freshComposer);
  expect(native.conversation().map((message) => message.content)).toContain(
    'Fresh laboratory idea',
  );
  expect(
    native
      .conversation()
      .some((message) => message.content.includes('old@example.test')),
  ).toBe(false);
  let complete!: (value: string) => void;
  aiState.useChat(
    {
      message: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
    'Test',
  );
  const answering = native.sendMessage({
    threadId: 'planner',
    content: 'Old pending request',
    clientRequestId: 'pending',
  });
  await settle();
  expect(complete).toBeTypeOf('function');
  native.reset();
  await settle();
  complete('{"reply":"Old late response","add":[],"remove":[]}');
  await answering;
  await settle();
  expect(target.textContent).not.toContain('Old pending request');
  expect(target.textContent).not.toContain('Old late response');
  expect(native.conversation().map((message) => message.content)).toEqual([
    'What would you like to build?',
  ]);
});
