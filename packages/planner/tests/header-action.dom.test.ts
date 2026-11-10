import { mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import type { BrowserAssistantTransport } from '../src/lib/assistant/transport.ts';
import PlannerHostAction from '../src/lib/planner/PlannerHostAction.svelte';

it('captures context, blocks repeated pending clicks, reports failures and permits retry', async () => {
  const target = document.createElement('div');
  document.body.append(target);
  let reject!: (cause: Error) => void;
  const run = vi.fn(
    (_context: import('../src/lib/planner/types.ts').PlannerExportContext) =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const app = mount(PlannerHostAction, {
    target,
    props: { action: { label: 'Build it', run } },
  });
  try {
    await tick();
    const button = target.querySelector('button')!;
    button.click();
    button.click();
    await tick();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      export: { fileName: expect.any(String), text: expect.any(String) },
      revision: expect.any(Number),
      conversation: [],
    });
    expect(button.disabled).toBe(true);
    reject(new Error('Try again'));
    await tick();
    await tick();
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(
      'Try again',
    );
    expect(button.disabled).toBe(false);
    button.click();
    expect(run).toHaveBeenCalledTimes(2);
    reject(new Error('Retry failed'));
    await tick();
  } finally {
    await unmount(app);
    target.remove();
  }
});

it('disables while the native thread is busy and captures that thread after it finishes', async () => {
  const target = document.createElement('div');
  let listener: (() => void) | undefined;
  let busy = true;
  const native = {
    get busy() {
      return busy;
    },
    conversation: () => [{ role: 'user', content: 'My actual app' }],
    subscribeConversation(callback: () => void) {
      listener = callback;
      callback();
      return () => {};
    },
  } as unknown as BrowserAssistantTransport;
  const run = vi.fn();
  const app = mount(PlannerHostAction, {
    target,
    props: { action: { label: 'Build it', run }, nativeAssistant: native },
  });
  try {
    await tick();
    const button = target.querySelector('button')!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(run).not.toHaveBeenCalled();
    busy = false;
    listener?.();
    await tick();
    button.click();
    await tick();
    expect(run.mock.calls[0]?.[0].conversation).toEqual(native.conversation());
  } finally {
    await unmount(app);
  }
});
