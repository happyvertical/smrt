import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { aiState } from '../src/lib/ai/instance.ts';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import Planner from '../src/lib/planner/Planner.svelte';
import type { PlannerHandle } from '../src/lib/planner/types.ts';

let app: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
let handle: PlannerHandle | undefined;
async function settle() {
  for (let n = 0; n < 12; n++) await tick();
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 20,
    top: 20,
    right: 80,
    bottom: 60,
    width: 60,
    height: 40,
  } as DOMRect);
  cookbookStore.reset();
  location.hash = '';
  handle = undefined;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cookbookStore.reset();
  location.hash = '';
});
async function render(entryMode: 'planning' | 'browse' = 'planning') {
  app = mount(Planner, {
    target,
    props: {
      entryMode,
      persistence: 'host',
      onready: (value: PlannerHandle) => {
        handle = value;
      },
    },
  });
  await settle();
}
it('keeps trusted planning empty state neutral without a cookbook flash; explicit browse still works', async () => {
  const seen: string[] = [];
  const observer = new MutationObserver(() =>
    seen.push(target.textContent ?? ''),
  );
  observer.observe(target, { subtree: true, childList: true });
  await render();
  await settle();
  observer.disconnect();
  expect(target.querySelector('[aria-label="App planning"]')).not.toBeNull();
  expect(target.textContent).toContain('Your app starts here');
  expect(
    target.querySelector('[data-smrt-component="CookbooksPanel"]'),
  ).toBeNull();
  expect(seen.some((text) => text.includes('Apply cookbook'))).toBe(false);
  await unmount(app!);
  app = undefined;
  target.innerHTML = '';
  location.hash = '#/configure/cookbooks/';
  await render();
  expect(target.querySelector('[aria-label="App planning"]')).toBeNull();
  expect(
    target.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toContain('Cookbooks');
});
it('preserves standalone default browse behavior rather than hiding the chooser everywhere', async () => {
  await render('browse');
  expect(target.querySelector('[aria-label="App planning"]')).toBeNull();
  expect(target.textContent).toContain('Cookbooks');
});
it('highlights the actual layout Edit without focus/motion and dismisses via Escape once', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  await render();
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  try {
    const result = await handle?.guide?.highlight({ kind: 'arrival' });
    expect(result?.ok).toBe(true);
    expect(result?.targetId).toBe('item:layout-edit');
    expect(result?.description).toContain('rearrange the menu and page layout');
    expect(
      target.querySelector('[data-smrt-target="item:layout-edit"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-smrt-component="ControlSpotlight"]'),
    ).not.toBeNull();
    expect(target.querySelector('[data-smrt-highlighted="true"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(
      document.querySelector('[data-smrt-component="ControlSpotlight"]'),
    ).toBeNull();
    expect((await handle?.guide?.highlight({ kind: 'arrival' }))?.ok).toBe(
      false,
    );
  } finally {
    input.remove();
  }
});
it('highlights only a real newly added visible menu target from execution, and cleans up on disposal', async () => {
  await render();
  const controller = handle!.controller;
  const before = controller.snapshot();
  const result = controller.batch({
    id: 'guide-add',
    expectedRevision: before.revision,
    commands: [{ name: 'add_recipes', input: { ids: ['commerce.sales'] } }],
  });
  await settle();
  const guide = await handle?.guide?.highlight({
    kind: 'addition',
    before,
    result,
  });
  expect(guide?.ok).toBe(true);
  expect(guide?.description).toContain('main menu');
  const node = target.querySelector(`[data-smrt-target="${guide?.targetId}"]`);
  expect(node).not.toBeNull();
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).not.toBeNull();
  handle?.guide?.dismiss();
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
  const previousGuide = handle?.guide;
  await unmount(app!);
  app = undefined;
  expect(
    (await previousGuide?.highlight({ kind: 'addition', before, result }))?.ok,
  ).toBe(false);
});
it('rejects a no-op or refused addition rather than inventing a highlighted feature', async () => {
  await render();
  const before = handle!.controller.snapshot();
  const result = handle!.controller.batch({
    id: 'refused',
    expectedRevision: before.revision,
    commands: [{ name: 'add_recipes', input: { ids: ['invented.recipe'] } }],
  });
  expect(
    (await handle?.guide?.highlight({ kind: 'addition', before, result }))?.ok,
  ).toBe(false);
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
});

it('bounds highlight lifetime and clears immediately when native workspace reset retires its epoch', async () => {
  await render();
  vi.useFakeTimers();
  expect((await handle?.guide?.highlight({ kind: 'arrival' }))?.ok).toBe(true);
  vi.advanceTimersByTime(6000);
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
  const before = handle!.controller.snapshot();
  const result = handle!.controller.batch({
    id: 'reset-guide-add',
    expectedRevision: before.revision,
    commands: [{ name: 'add_recipes', input: { ids: ['commerce.sales'] } }],
  });
  await settle();
  expect(
    (await handle?.guide?.highlight({ kind: 'addition', before, result }))?.ok,
  ).toBe(true);
  // No-inference hosts keep guidance, but must not receive the hidden thread.
  expect(handle?.nativeAssistant).toBeUndefined();
  aiState.session.transport.reset();
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
});
it('resolves each real header control and replaces a single passive spotlight', async () => {
  app = mount(Planner, {
    target,
    props: {
      persistence: 'host',
      headerAction: { label: 'Build it', run: async () => {} },
      onready: (value: PlannerHandle) => {
        handle = value;
      },
    },
  });
  await settle();
  for (const [control, id] of [
    ['build', 'item:planner-host-action'],
    ['export', 'item:planner-export'],
    ['chef', 'item:planner-customize'],
    ['edit', 'item:layout-edit'],
  ] as const) {
    const result = await handle!.guide!.highlight({ kind: 'control', control });
    expect(result.ok).toBe(true);
    expect(result.targetId).toBe(id);
    expect(
      document.querySelectorAll('[data-smrt-component="ControlSpotlight"]'),
    ).toHaveLength(1);
  }
  handle!.guide!.dismiss();
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
});
it('declines a missing Build control without opening or generating anything', async () => {
  await render();
  expect(
    await handle!.guide!.highlight({ kind: 'control', control: 'build' }),
  ).toMatchObject({ ok: false });
});
it('resolves the labelled header buttons, including Specs and Styles', async () => {
  app = mount(Planner, {
    target,
    props: {
      persistence: 'host',
      headerNav: 'labelled',
      onready: (value: PlannerHandle) => {
        handle = value;
      },
    },
  });
  await settle();
  for (const [control, id] of [
    ['specs', 'item:planner-specs'],
    ['chef', 'item:planner-customize'],
    ['styles', 'item:planner-styles'],
    ['export', 'item:planner-export'],
  ] as const) {
    const result = await handle!.guide!.highlight({ kind: 'control', control });
    expect(result).toMatchObject({ ok: true, targetId: id });
  }
});
it('declines Specs and Styles when the default icon header has no such buttons', async () => {
  await render();
  for (const control of ['specs', 'styles'] as const)
    expect(
      await handle!.guide!.highlight({ kind: 'control', control }),
    ).toMatchObject({ ok: false });
});
it('holds a narrated spotlight for the requested time within bounds', async () => {
  const { guideHold } = await import('../src/lib/planner/guide.ts');
  expect(guideHold(undefined)).toBe(6000);
  expect(guideHold(9000)).toBe(9000);
  expect(guideHold(50)).toBe(1000);
  expect(guideHold(120000)).toBe(30000);
  vi.useFakeTimers();
  await render();
  await handle!.guide!.highlight({
    kind: 'control',
    control: 'edit',
    holdMs: 9000,
  });
  vi.advanceTimersByTime(7000);
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).not.toBeNull();
  vi.advanceTimersByTime(2500);
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
});
