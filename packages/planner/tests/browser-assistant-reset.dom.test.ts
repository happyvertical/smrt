import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { aiState } from '../src/lib/ai/instance.ts';
import BrowserAssistant from '../src/lib/components/BrowserAssistant.svelte';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { createPlannerDataSource } from '../src/lib/data/planner-source.ts';
import StaticPage from './static-reset.fixture.svelte';

let app: ReturnType<typeof mount> | undefined;
let page: ReturnType<typeof mount> | undefined;
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
  if (page) await unmount(page);
  app = undefined;
  page = undefined;
  target?.remove();
  aiState.session.hostTurn = undefined;
  aiState.session.transport.reset();
});
it('the static page resets its actual visible native conversation and cannot persist it again', async () => {
  const native = aiState.session.transport;
  native.reset();
  aiState.dismissFirstRun();
  aiState.useChat(
    { message: async () => '{"reply":"Fresh answer","add":[],"remove":[]}' },
    'Test',
  );
  native.seed({
    id: 'old-static',
    messages: [{ role: 'user', content: 'Obsolete static conversation' }],
  });
  target = document.createElement('div');
  document.body.append(target);
  const context = new Map([[DATA_SOURCE_KEY, createPlannerDataSource()]]);
  page = mount(StaticPage, { target, context });
  await settle();
  expect(target.textContent).toContain('Obsolete static conversation');
  const settings = [
    ...target.querySelectorAll<HTMLElement>('[role="tab"]'),
  ].find((node) => node.textContent?.trim() === 'Settings');
  expect(settings).toBeDefined();
  settings?.click();
  await settle();
  const reset = [...target.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === 'Reset project',
  );
  expect(reset).toBeDefined();
  reset?.click();
  await settle();
  const dialog = target.querySelector('dialog[open]');
  expect(dialog).not.toBeNull();
  dialog?.querySelectorAll('button')[1].click();
  await settle();
  expect(target.textContent).not.toContain('Obsolete static conversation');
  expect(native.conversation().map((message) => message.content)).toEqual([
    'What would you like to build?',
  ]);
  await native.sendMessage({
    threadId: 'planner',
    clientRequestId: 'fresh-static',
    content: 'Fresh static request',
  });
  expect(
    native
      .conversation()
      .some((message) => message.content.includes('Obsolete static')),
  ).toBe(false);
  expect(sessionStorage.getItem('smrt-planner:conversation:v1')).not.toContain(
    'Obsolete static',
  );
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
