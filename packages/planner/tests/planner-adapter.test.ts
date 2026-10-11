import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeUndos } from '../src/lib/assistant/theme-undo.svelte.ts';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { createHeadlessPlanner } from '../src/lib/core/index.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { libraryState } from '../src/lib/library/state.svelte.ts';
import {
  createPlannerAdapter,
  createPlannerController,
  createSliceController,
  engineCatalog,
  portFromStore,
} from '../src/lib/planner/commands/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

function fresh(onReplaced?: () => void) {
  recipeState.clear();
  cookbookStore.reset();
  libraryState.active = null;
  return createPlannerController(cookbookStore, { onReplaced });
}

const SALES = { name: 'add_recipes', input: { ids: ['commerce.sales'] } };

describe('the browser controller is an adapter over the engine', () => {
  beforeEach(() => {
    fresh();
  });

  it('writes what the engine changed into the stores', () => {
    const controller = fresh();
    const added = controller.run(SALES);
    expect(added.ok).toBe(true);
    expect(recipeState.ids).toContain('commerce.sales');
    controller.run({ name: 'set_name', input: { name: 'Corner Shop' } });
    expect(cookbookStore.name).toBe('Corner Shop');
    expect(cookbookStore.snapshot().name).toBe('Corner Shop');
    expect(controller.snapshot().app.name).toBe('Corner Shop');
    controller.run({ name: 'set_theme', input: { preset: 'glass' } });
    expect(cookbookStore.theme?.preset).toBe('glass');
  });

  it('adopts a manual edit as one revision and closes the undo history', () => {
    const controller = fresh();
    const before = controller.snapshot().revision;
    const added = controller.run(SALES);
    if (!added.ok) throw new Error('add failed');
    const undoId = added.receipt.undoId as string;
    expect(controller.snapshot().revision).toBe(before + 1);

    recipeState.add('commerce.purchases');
    const after = controller.snapshot();
    expect(after.revision).toBe(before + 2);
    expect(after.recipes.map((r) => r.id)).toContain('commerce.purchases');
    expect(after.undo).toEqual([]);

    // An undo id from before the edit names nothing now; the edit is kept.
    const stale = controller.run({ name: 'undo', input: { undoId } });
    expect(!stale.ok && stale.error.code).toBe('not_found');
    expect(recipeState.ids).toContain('commerce.purchases');
    // And a model that read the plan before the edit is refused.
    const late = controller.run(
      { name: 'add_recipes', input: { ids: ['commerce.estimates'] } },
      { expectedRevision: before + 1 },
    );
    expect(!late.ok && late.error.code).toBe('conflict');
  });

  it('does not count a page customisation as a plan change', () => {
    const controller = fresh();
    controller.run(SALES);
    const revision = controller.snapshot().revision;
    cookbookStore.setOverview('section:sales', {
      version: 1,
      removed: ['count'],
    });
    expect(controller.snapshot().revision).toBe(revision);
    // The next command keeps the page edit.
    controller.run({
      name: 'add_recipes',
      input: { ids: ['commerce.estimates'] },
    });
    expect(cookbookStore.overviews['section:sales']).toBeDefined();
  });

  it('applies a library cookbook as the Cookbooks tab does', () => {
    let replaced = 0;
    const controller = fresh(() => {
      replaced += 1;
    });
    const result = controller.run({
      name: 'apply_cookbook',
      input: { id: 'bakery' },
    });
    expect(result.ok).toBe(true);
    expect(libraryState.active).toBe('bakery');
    expect(replaced).toBe(1);
    expect(controller.snapshot().app).toMatchObject({
      name: 'Bakery',
      cookbook: 'bakery',
    });
  });

  it("keeps the visitor's look when the cookbook sets none, in one undoable step", () => {
    recipeState.clear();
    cookbookStore.reset();
    libraryState.active = null;
    const bakery = getLibraryCookbook('bakery');
    if (!bakery) throw new Error('no bakery');
    const base = engineCatalog();
    const controller = createPlannerAdapter({
      catalog: {
        ...base,
        cookbooks: [
          {
            id: 'plain',
            name: 'Plain',
            document: { ...bakery.document, theme: undefined } as never,
          },
        ],
      },
      port: portFromStore(cookbookStore),
    });
    controller.run({ name: 'set_theme', input: { preset: 'glass' } });
    const revision = controller.snapshot().revision;
    const applied = controller.run({
      name: 'apply_cookbook',
      input: { id: 'plain', replace: true },
    });
    if (!applied.ok) throw new Error(applied.error.message);
    expect(controller.snapshot().theme.preset).toBe('glass');
    expect(cookbookStore.theme?.preset).toBe('glass');
    expect(recipeState.ids.length).toBeGreaterThan(0);
    expect(applied.receipt.revisionBefore).toBe(revision);
    expect(applied.receipt.name).toBe('apply_cookbook');
    const undone = controller.run({
      name: 'undo',
      input: { undoId: applied.receipt.undoId as string },
    });
    expect(undone.ok).toBe(true);
    expect(recipeState.ids).toEqual([]);
    expect(cookbookStore.theme?.preset).toBe('glass');
  });

  it('repeats a command id without applying it twice', () => {
    const controller = fresh();
    const first = controller.run({ ...SALES, id: 'retry-1' });
    const revision = controller.snapshot().revision;
    const again = controller.run({ ...SALES, id: 'retry-1' });
    expect(first.ok && again.ok && again.replayed).toBe(true);
    expect(controller.snapshot().revision).toBe(revision);
    const reused = controller.run({
      name: 'remove_recipes',
      input: { ids: ['commerce.sales'] },
      id: 'retry-1',
    });
    expect(!reused.ok && reused.error.code).toBe('id_reuse');
  });

  it('runs a batch all or nothing against the stores', () => {
    const controller = fresh();
    const failed = controller.batch({
      commands: [
        SALES,
        { name: 'rename_section', input: { id: 'section:nope', label: 'X' } },
      ],
    });
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error.code).toBe('batch_failed');
    expect(recipeState.ids).toEqual([]);
    const done = controller.batch({
      commands: [SALES, { name: 'set_settings', input: { currency: 'CAD' } }],
    });
    expect(done.ok && done.receipt.count).toBe(2);
    expect(recipeState.ids).toContain('commerce.sales');
    expect(cookbookStore.settings().currency).toBe('CAD');
  });

  it('puts only the theme back when the assistant Undo is pressed after other edits', () => {
    const controller = fresh();
    const store = {
      read: () => cookbookStore.snapshot().theme,
      write: (next: Parameters<typeof cookbookStore.setTheme>[0]) =>
        cookbookStore.setTheme(next),
    };
    const undos = new ThemeUndos(store, controller);
    const set = controller.run({
      name: 'set_theme',
      input: { preset: 'glass' },
    });
    if (!set.ok) throw new Error('theme failed');
    const ref = undos.record(undefined, set.receipt.undoId);
    controller.run(SALES);
    undos.undo(ref.undoId);
    expect(cookbookStore.theme).toBeUndefined();
    // The recipe added after the theme is still there: Undo was not the whole document.
    expect(recipeState.ids).toContain('commerce.sales');
  });

  it('focus follows the planner tab and never touches the plan', () => {
    const controller = fresh();
    const revision = controller.snapshot().revision;
    const result = controller.run({ name: 'focus', input: { tab: 'layout' } });
    expect(result.ok && result.receipt.changed).toBe(true);
    expect(controller.snapshot().focus.tab).toBe('layout');
    expect(controller.snapshot().revision).toBe(revision);
  });
});

describe('what the review of the adapter found', () => {
  it('exports and reports the live page customisations, not the engine copy', () => {
    const controller = fresh();
    controller.run(SALES);
    cookbookStore.setOverview('section:sales', {
      version: 1,
      removed: ['count'],
    });
    const exported = controller.run({ name: 'export_cookbook', input: {} });
    if (!exported.ok) throw new Error('export failed');
    const data = exported.data as {
      text: string;
      cookbook: { overviews?: unknown };
    };
    expect(data.cookbook.overviews).toEqual(cookbookStore.snapshot().overviews);
    expect(JSON.parse(data.text).overviews).toBeDefined();
    expect(controller.cookbook().overviews).toBeDefined();
  });

  it('asks before an apply wipes only page customisations', () => {
    const controller = fresh();
    cookbookStore.setOverview('section:sales', {
      version: 1,
      removed: ['count'],
    });
    const refused = controller.run({
      name: 'apply_cookbook',
      input: { id: 'bakery' },
    });
    expect(!refused.ok && refused.error.code).toBe('confirmation_required');
    expect(cookbookStore.overviews['section:sales']).toBeDefined();
    // Validation still comes first, as in the engine.
    const bad = controller.run({
      name: 'apply_cookbook',
      input: { id: 'no-such-cookbook' },
    });
    expect(!bad.ok && bad.error.code).toBe('invalid_input');
  });

  it('a replayed command never hands back an undo id from another epoch', () => {
    const controller = fresh();
    const first = controller.run({
      name: 'set_name',
      input: { name: 'A' },
      id: 'x',
    });
    expect(first.ok && first.receipt.undoId).toBeTruthy();
    recipeState.add('commerce.vendors');
    const second = controller.run({ name: 'set_name', input: { name: 'B' } });
    if (!second.ok) throw new Error('set_name failed');
    const replay = controller.run({
      name: 'set_name',
      input: { name: 'A' },
      id: 'x',
    });
    expect(replay.ok && replay.replayed).toBe(true);
    expect(replay.ok && replay.receipt.undoId).toBeUndefined();
    // B's undo is still B's.
    const undone = controller.run({
      name: 'undo',
      input: { undoId: second.receipt.undoId as string },
    });
    expect(undone.ok).toBe(true);
    expect(cookbookStore.name).toBe('A');
  });

  it('never throws on a document the engine rejects, and says so', () => {
    const controller = fresh();
    controller.run(SALES);
    cookbookStore.theme = { custom: { primary: '#12' } };
    expect(() => controller.snapshot()).not.toThrow();
    expect(() => controller.undo()).not.toThrow();
    expect(() => controller.subscribe(() => {})()).not.toThrow();
    const refused = controller.run({
      name: 'add_recipes',
      input: { ids: ['commerce.estimates'] },
    });
    expect(!refused.ok && refused.error.code).toBe('failed');
    expect(!refused.ok && refused.error.message).toMatch(
      /not one the planner can read/,
    );
    const batch = controller.batch({ commands: [SALES] });
    expect(!batch.ok && batch.error.code).toBe('failed');
    // Fixing the document brings it back.
    cookbookStore.theme = undefined;
    expect(
      controller.run({
        name: 'add_recipes',
        input: { ids: ['commerce.estimates'] },
      }).ok,
    ).toBe(true);
  });

  it('starts empty, without throwing, over an invalid app document', () => {
    recipeState.clear();
    cookbookStore.reset();
    cookbookStore.theme = { custom: { primary: '#12' } };
    const controller = createPlannerController(cookbookStore);
    expect(controller.snapshot().recipes).toEqual([]);
    cookbookStore.reset();
  });

  it('a batch that applies a library cookbook selects it and resets sample data', () => {
    let replaced = 0;
    const controller = fresh(() => {
      replaced += 1;
    });
    const done = controller.batch({
      commands: [
        { name: 'apply_cookbook', input: { id: 'bakery', replace: true } },
        { name: 'set_name', input: { name: 'Corner Bakery' } },
      ],
    });
    expect(done.ok).toBe(true);
    expect(libraryState.active).toBe('bakery');
    expect(replaced).toBe(1);
    expect(recipeState.ids.length).toBeGreaterThan(0);
    expect(cookbookStore.name).toBe('Corner Bakery');
  });

  it('undoing an apply restores the plan and leaves page customisations alone', () => {
    const controller = fresh();
    const applied = controller.run({
      name: 'apply_cookbook',
      input: { id: 'bakery' },
    });
    if (!applied.ok) throw new Error('apply failed');
    cookbookStore.setOverview('section:sales', {
      version: 1,
      removed: ['count'],
    });
    const undone = controller.run({
      name: 'undo',
      input: { undoId: applied.receipt.undoId as string },
    });
    expect(undone.ok).toBe(true);
    expect(recipeState.ids).toEqual([]);
    expect(cookbookStore.overviews['section:sales']).toBeDefined();
  });

  it('checks focus like every other command', () => {
    const controller = fresh();
    for (const command of [
      { name: 'focus', input: {}, bogus: 1 },
      { name: 'focus', input: {}, id: 3 },
      { name: 'focus', input: {}, id: '' },
      { name: 'focus', input: {}, expectedRevision: 1.5 },
    ]) {
      const result = controller.run(command);
      expect(!result.ok && result.error.code, JSON.stringify(command)).toBe(
        'invalid_input',
      );
    }
  });

  it('names the undo id the caller sent, and forgets used ones', () => {
    const controller = fresh();
    const added = controller.run(SALES);
    if (!added.ok) throw new Error('add failed');
    const id = added.receipt.undoId as string;
    expect(controller.run({ name: 'undo', input: { undoId: id } }).ok).toBe(
      true,
    );
    const again = controller.run({ name: 'undo', input: { undoId: id } });
    expect(!again.ok && again.error.code).toBe('not_found');
    expect(!again.ok && again.error.message).toContain(`"${id}"`);
  });
});

describe('a controller over slices', () => {
  it('drives plain stores through the same commands', () => {
    const ids: string[] = [];
    const written: unknown[] = [];
    const controller = createSliceController({
      store: {
        get ids() {
          return ids;
        },
        add: (...more) => {
          for (const id of more) if (!ids.includes(id)) ids.push(id);
        },
        remove: (...gone) => {
          for (const id of gone) {
            const at = ids.indexOf(id);
            if (at >= 0) ids.splice(at, 1);
          }
        },
      },
      theme: { read: () => undefined, write: (t) => written.push(t) },
    });
    controller.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } });
    expect(ids).toContain('commerce.sales');
    controller.run({ name: 'set_theme', input: { preset: 'glass' } });
    expect(written.at(-1)).toMatchObject({ preset: 'glass' });
  });
});

describe('the headless planner', () => {
  it('has the same atomic batch and retry ids as the engine', () => {
    const plan = createHeadlessPlanner();
    const first = plan.batch({ id: 'b1', commands: [SALES] });
    const again = plan.batch({ id: 'b1', commands: [SALES] });
    expect(first.ok && first.receipt.changed).toBe(true);
    expect(again.ok && again.replayed).toBe(true);
    const bad = plan.batch({ commands: [SALES, { name: 'nope', input: {} }] });
    expect(!bad.ok && bad.error.code).toBe('batch_failed');
  });
});
