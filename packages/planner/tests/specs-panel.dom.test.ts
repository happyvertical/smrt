import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SpecsPanel from '../src/lib/components/SpecsPanel.svelte';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { NAV_GROUP_TABS } from '../src/lib/planner/header-nav.ts';
import PlannerControls from '../src/lib/planner/PlannerControls.svelte';
import { plannerTab } from '../src/lib/planner/tab.svelte.ts';

async function settle() {
  await tick();
  flushSync();
  await tick();
}

describe('the Specs tab', () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | undefined;
  const context = new Map<unknown, unknown>([[DATA_SOURCE_KEY, {}]]);
  beforeEach(() => {
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(async () => {
    if (app) await unmount(app);
    app = undefined;
    target.remove();
    plannerTab.active = 'cookbooks';
    vi.restoreAllMocks();
  });

  it('is a labelled textarea that writes through setSpecs with a character count', async () => {
    const setSpecs = vi.spyOn(cookbookStore, 'setSpecs');
    app = mount(SpecsPanel, { target });
    await settle();
    const area = target.querySelector('textarea');
    expect(area).not.toBeNull();
    expect(target.querySelector('h2')?.textContent).toBe('Specs');
    expect(area?.getAttribute('aria-labelledby')).toBe('planner-specs-heading');
    expect(area?.getAttribute('placeholder')).toContain('Examples');
    expect(target.textContent).toContain('/ 20,000');
    if (!area) return;
    area.value = 'Only admins export';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setSpecs).toHaveBeenCalledWith('Only admins export');
  });

  it('keeps a typed trailing space or new line while saving the trimmed text', async () => {
    cookbookStore.setSpecs('');
    app = mount(SpecsPanel, { target });
    await settle();
    const area = target.querySelector('textarea');
    if (!area) throw new Error('missing textarea');
    for (const text of ['- Waivers ', '- Waivers\n']) {
      area.value = text;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
      expect(area.value).toBe(text);
      expect(cookbookStore.specs).toBe('- Waivers');
    }
    cookbookStore.setSpecs('- Waivers\n- Gift cards');
    await settle();
    expect(area.value).toBe('- Waivers\n- Gift cards');
    cookbookStore.setSpecs('');
  });

  const tabLabels = () =>
    [...target.querySelectorAll('[role="tab"]')].map((t) =>
      t.textContent?.trim(),
    );

  it.each([
    ['specs', ['Specs']],
    ['recipes', ['Cookbooks', 'Recipes', 'Features']],
    ['settings', ['Theme', 'Settings']],
    ['export', ['Export']],
  ] as const)('labelled: the strip for %s shows its group', async (active, expected) => {
    plannerTab.active = active;
    app = mount(PlannerControls, {
      target,
      context,
      props: { persistence: 'host', headerNav: 'labelled' },
    });
    await settle();
    expect(tabLabels()).toEqual(expected);
    expect(NAV_GROUP_TABS).toBeDefined();
  });

  it("icons mode keeps today's default strip", async () => {
    app = mount(PlannerControls, {
      target,
      context,
      props: { persistence: 'host' },
    });
    await settle();
    expect(tabLabels()).toEqual([
      'Cookbooks',
      'Recipes',
      'Theme',
      'Settings',
      'Export',
    ]);
  });
});
