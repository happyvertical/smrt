/**
 * Corner radius, density and contrast (smrt#3912): cookbook `theme` fields of
 * the same names as `set_theme`'s inputs and smrt-svelte's `AppShell` props.
 * They round-trip through the store, the plan snapshot, the export and the
 * import, and the assistant may set them.
 */
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseChange } from '../src/lib/assistant/change.ts';
import ThemeSection from '../src/lib/components/ThemeSection.svelte';
import { serializeCookbook } from '../src/lib/cookbook/file.ts';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { parseCookbook } from '../src/lib/cookbook/validate.ts';
import { libraryState } from '../src/lib/library/state.svelte.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import {
  compactTheme,
  parseTheme,
  themeEquals,
} from '../src/lib/theme/theme.ts';

const SHAPE = {
  borderRadius: 'xl',
  density: 'touch',
  contrast: 'more',
} as const;

function fresh() {
  recipeState.clear();
  cookbookStore.reset();
  libraryState.active = null;
  return createPlannerController(cookbookStore);
}

beforeEach(() => {
  fresh();
});

describe('theme radius, density and contrast', () => {
  it('validates each against the cookbook schema enums', () => {
    expect(parseTheme({ preset: 'glass', ...SHAPE })).toEqual({
      ok: true,
      theme: { preset: 'glass', ...SHAPE },
    });
    for (const bad of [
      { borderRadius: 'huge' },
      { density: 'compact' },
      { contrast: 'high' },
      { borderRadius: 4 },
    ]) {
      expect(parseTheme(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(compactTheme({ borderRadius: undefined, density: 'touch' })).toEqual(
      { density: 'touch' },
    );
    expect(themeEquals({ contrast: 'more' }, undefined)).toBe(false);
    expect(themeEquals({ preset: 'glass' }, {})).toBe(true);
  });

  it('round-trip: store -> snapshot -> export -> import', () => {
    const controller = fresh();
    cookbookStore.setTheme({ preset: 'studio', ...SHAPE });
    // The manual edit is adopted on the next call and reported.
    expect(controller.snapshot().theme).toMatchObject(SHAPE);
    const exported = controller.run({ name: 'export_cookbook', input: {} });
    if (!exported.ok) throw new Error(exported.error.message);
    const text = (exported.data as { text: string }).text;
    expect(JSON.parse(text).theme).toEqual({ preset: 'studio', ...SHAPE });

    const other = fresh();
    expect(other.snapshot().theme).toMatchObject({
      borderRadius: null,
      density: null,
      contrast: null,
    });
    const imported = other.run({
      name: 'import_cookbook',
      input: { document: JSON.parse(text), replace: true },
    });
    if (!imported.ok) throw new Error(imported.error.message);
    expect(cookbookStore.theme).toEqual({ preset: 'studio', ...SHAPE });
    expect(imported.snapshot.theme).toMatchObject(SHAPE);

    // The planner's own strict import and file format agree.
    const parsed = parseCookbook(
      JSON.parse(serializeCookbook(cookbookStore.snapshot())),
    );
    expect(parsed.ok && parsed.cookbook.theme).toEqual({
      preset: 'studio',
      ...SHAPE,
    });
  });

  it('set_theme writes them to the cookbook and refuses unknown values', () => {
    const controller = fresh();
    const set = controller.run({ name: 'set_theme', input: SHAPE });
    if (!set.ok) throw new Error(set.error.message);
    expect(cookbookStore.theme).toMatchObject(SHAPE);
    const bad = controller.run({
      name: 'set_theme',
      input: { density: 'compact' },
    });
    expect(bad.ok).toBe(false);
    expect(cookbookStore.theme).toMatchObject(SHAPE);
  });

  it('the assistant may set them; unknown values are dropped', () => {
    const change = parseChange(
      JSON.stringify({
        reply: 'ok',
        add: [],
        remove: [],
        theme: { ...SHAPE, extra: 1 },
      }),
      recipes,
    );
    expect(change.theme).toEqual(SHAPE);
    const bad = parseChange(
      JSON.stringify({
        reply: 'ok',
        add: [],
        remove: [],
        theme: { borderRadius: 'huge', density: 'compact', contrast: 'high' },
      }),
      recipes,
    );
    expect(bad.theme).toEqual({});
  });

  it('the Theme tab shows the three controls with the cookbook values', () => {
    cookbookStore.setTheme(SHAPE);
    const { body } = render(ThemeSection, { props: { provider: false } });
    for (const label of ['Corner radius', 'Density', 'Contrast']) {
      expect(body, label).toContain(label);
    }
    expect(body).toMatch(/<option value="xl"[^>]*selected/);
    expect(body).toMatch(/<option value="touch"[^>]*selected/);
    expect(body).toMatch(/<option value="more"[^>]*selected/);
    for (const label of ['Comfortable', 'Touch', 'Auto', 'Standard', 'More']) {
      expect(body, label).toContain(`>${label}</option>`);
    }
  });
});
