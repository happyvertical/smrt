import { createCookbookEngine } from '@happyvertical/smrt-core/cookbook/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import {
  buildCommandTools,
  createHeadlessPlanner,
  libraryCookbooks,
  recipes,
} from '../src/lib/core/index.ts';
import { libraryState } from '../src/lib/library/state.svelte.ts';
import { engineCatalog } from '../src/lib/planner/commands/catalog.ts';
import {
  COMMAND_NAMES,
  type CommandName,
  type CommandResult,
  createPlannerController,
  type PlanSnapshot,
} from '../src/lib/planner/commands/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const FEATURE = '@happyvertical/smrt-ads:AdFormat';
const CUSTOMER = '@happyvertical/smrt-commerce:Customer';

function freshBrowser() {
  recipeState.clear();
  cookbookStore.reset();
  libraryState.active = null;
  return createPlannerController(cookbookStore);
}

type Step =
  | { name: string; input?: unknown; revision?: number }
  | ((snapshot: PlanSnapshot) => {
      name: string;
      input?: unknown;
      revision?: number;
    });

/** A small valid cookbook document to import. */
const IMPORTED = {
  $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
  version: 1,
  recipes: ['commerce.sales', 'nope.unknown'],
  features: [],
  policies: [],
};

const FIRST_SECTION = (s: PlanSnapshot) => s.sections[0];

/**
 * One script that runs every command (and several refusals) in an order that
 * makes each one meaningful. Steps that need an id read it from the snapshot.
 */
const SCRIPT: Step[] = [
  { name: 'focus', input: { tab: 'recipes' } },
  { name: 'validate' },
  { name: 'set_name', input: { name: 'Corner Bakery', description: 'Bread' } },
  { name: 'set_name', input: { name: '' } },
  { name: 'add_cookbook', input: { id: 'bakery' } },
  { name: 'remove_cookbook', input: { id: 'bakery' } },
  { name: 'add_recipes', input: { ids: ['commerce.sales'] } },
  { name: 'add_recipes', input: { ids: ['commerce.sales'] } },
  { name: 'remove_recipes', input: { ids: ['commerce.sales'] } },
  { name: 'add_features', input: { ids: [FEATURE] } },
  { name: 'add_features', input: { ids: ['@nope/none:Missing'] } },
  { name: 'remove_features', input: { ids: [FEATURE] } },
  { name: 'apply_cookbook', input: { id: 'bakery' } },
  {
    name: 'set_policy',
    input: { model: CUSTOMER, field: 'notes', label: 'Client note' },
  },
  { name: 'set_policy', input: { model: CUSTOMER, field: 'nope', label: 'X' } },
  {
    name: 'set_settings',
    input: { currency: 'CAD', taxRate: 13, paymentTerms: 'Net 30' },
  },
  { name: 'set_theme', input: { primary: '#d97706', colorScheme: 'dark' } },
  { name: 'reset_theme' },
  { name: 'set_theme', input: { preset: 'glass' } },
  (s) => ({
    name: 'rename_section',
    input: { id: FIRST_SECTION(s).id, label: 'The shop' },
  }),
  (s) => ({
    name: 'rename_item',
    input: { id: FIRST_SECTION(s).items[0].id, label: 'Front desk' },
  }),
  (s) => ({ name: 'hide', input: { id: FIRST_SECTION(s).items[0].id } }),
  (s) => ({ name: 'show', input: { id: FIRST_SECTION(s).items[0].id } }),
  (s) => ({ name: 'focus', input: { section: FIRST_SECTION(s).id } }),
  { name: 'rename_section', input: { id: 'section:nope', label: 'X' } },
  { name: 'export_cookbook', input: { name: 'Corner Bakery' } },
  (s) => ({ name: 'undo', input: { undoId: s.undo.at(-1) } }),
  { name: 'undo', input: { undoId: 'undo-999' } },
  { name: 'apply_cookbook', input: { id: 'bakery' } },
  { name: 'apply_cookbook', input: { id: 'bakery', replace: true } },
  { name: 'reset_theme' },
  { name: 'import_cookbook', input: { document: { version: 1 } } },
  { name: 'import_cookbook', input: { document: { version: 'x' } } },
  { name: 'import_cookbook', input: { document: IMPORTED } },
  { name: 'import_cookbook', input: { document: IMPORTED, replace: true } },
  { name: 'no_such_command', input: {} },
  { name: 'add_recipes', input: { ids: [] } },
  { name: 'set_settings', input: { taxRate: 101 } },
  { name: 'add_recipes', input: { ids: ['commerce.sales'] }, revision: 9999 },
  { name: 'remove_recipes', input: { ids: ['commerce.sales'] } },
];

describe('headless planner parity with the browser controller and the smrt engine', () => {
  beforeEach(() => {
    freshBrowser();
  });

  it('runs every command with the same results, snapshots and cookbooks', () => {
    const browser = freshBrowser();
    const headless = createHeadlessPlanner();
    // The engine itself: the planner adds `focus` and nothing else.
    const engine = createCookbookEngine({ catalog: engineCatalog() });
    const viewless = (snapshot: PlanSnapshot) => {
      const { focus: _focus, ...rest } = snapshot;
      return rest;
    };
    expect(headless.snapshot()).toEqual(browser.snapshot());
    expect(viewless(headless.snapshot())).toEqual(engine.snapshot());
    expect(headless.cookbook()).toEqual(cookbookStore.snapshot());

    const succeeded = new Set<string>();
    const codes = new Set<string>();
    const results: CommandResult[] = [];
    for (const step of SCRIPT) {
      const { name, input, revision } =
        typeof step === 'function' ? step(headless.snapshot()) : step;
      const command = { name, input };
      const options =
        revision === undefined ? undefined : { expectedRevision: revision };
      const a = browser.run(command, options);
      const b = headless.run(command, options);
      expect(b, `${name} ${JSON.stringify(input)}`).toEqual(a);
      expect(headless.snapshot(), `snapshot after ${name}`).toEqual(
        browser.snapshot(),
      );
      expect(headless.cookbook(), `cookbook after ${name}`).toEqual(
        cookbookStore.snapshot(),
      );
      if (name !== 'focus') {
        const c = engine.run(command, options);
        // Same results as the engine itself, once the planner's `focus` is set aside.
        const stripped = b.ok ? { ...b, snapshot: viewless(b.snapshot) } : b;
        if (name === 'import_cookbook' && b.ok && c.ok) {
          // The planner's check adds the requirements before the engine counts.
          expect({
            ...stripped,
            receipt: { ...b.receipt, summary: '' },
          }).toEqual({ ...c, receipt: { ...c.receipt, summary: '' } });
        } else if (name === 'import_cookbook' && !b.ok && !c.ok) {
          // The planner's own strict import check speaks first and in its own
          // words (and migrates old ids); the code and where it points agree.
          expect(b.error.code).toBe(c.error.code);
          expect(b.error.path).toBe(c.error.path);
        } else {
          expect(stripped, `engine: ${name} ${JSON.stringify(input)}`).toEqual(
            c,
          );
        }
        expect(
          viewless(headless.snapshot()),
          `engine snapshot after ${name}`,
        ).toEqual(engine.snapshot());
        expect(headless.cookbook(), `engine cookbook after ${name}`).toEqual(
          engine.cookbook(),
        );
      }
      if (a.ok) succeeded.add(name);
      else codes.add(a.error.code);
      results.push(a);
    }

    // Every command in the set was exercised successfully at least once.
    expect([...succeeded].sort()).toEqual(
      expect.arrayContaining([...COMMAND_NAMES] as CommandName[]),
    );
    // And the refusals too: validation, lookups, confirmation, revisions.
    expect([...codes].sort()).toEqual(
      expect.arrayContaining([
        'confirmation_required',
        'conflict',
        'invalid_input',
        'not_found',
        'unknown_command',
      ]),
    );
    // The run did change things (a parity of two empty plans proves nothing).
    expect(results.some((r) => r.ok && r.receipt.changed)).toBe(true);
  });

  it('parity of import/export: a plan round-trips between the two', () => {
    const browser = freshBrowser();
    browser.run({ name: 'apply_cookbook', input: { id: 'bakery' } });
    browser.run({ name: 'set_settings', input: { currency: 'EUR' } });
    const exported = browser.run({ name: 'export_cookbook', input: {} });
    if (!exported.ok) throw new Error('export failed');

    const headless = createHeadlessPlanner(cookbookStore.snapshot());
    expect(headless.snapshot().recipes).toEqual(browser.snapshot().recipes);
    expect(headless.cookbook()).toEqual(cookbookStore.snapshot());
    // The file name follows the library cookbook the session applied, which a
    // document does not carry; the document itself must match.
    const again = headless.run({ name: 'export_cookbook', input: {} });
    expect(again.ok && (again.data as { text: string }).text).toEqual(
      (exported.data as { text: string }).text,
    );
  });
});

describe('headless planner on its own', () => {
  it('holds independent plans that do not touch the browser stores', () => {
    freshBrowser();
    const a = createHeadlessPlanner();
    const b = createHeadlessPlanner();
    a.run({ name: 'add_cookbook', input: { id: 'bakery' } });
    expect(a.snapshot().recipes.length).toBeGreaterThan(0);
    expect(b.snapshot().recipes).toEqual([]);
    expect(recipeState.ids).toEqual([]);
    b.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } });
    expect(b.snapshot().recipes.map((r) => r.id)).toContain('commerce.sales');
    expect(a.snapshot().recipes.map((r) => r.id)).not.toEqual(
      b.snapshot().recipes.map((r) => r.id),
    );
    expect(recipeState.ids).toEqual([]);
    expect(libraryState.active).toBeNull();
  });

  it('undoes the latest change and says so when there is nothing', () => {
    const plan = createHeadlessPlanner();
    const nothing = plan.undo();
    expect(!nothing.ok && nothing.error.code).toBe('not_found');
    plan.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } });
    const before = plan.snapshot().recipes.length;
    expect(before).toBeGreaterThan(0);
    const undone = plan.undo();
    expect(undone.ok).toBe(true);
    expect(plan.snapshot().recipes).toEqual([]);
    expect(plan.snapshot().undo).toEqual([]);
  });

  it('notifies subscribers after commands', () => {
    const plan = createHeadlessPlanner();
    const seen: number[] = [];
    const stop = plan.subscribe((s) => seen.push(s.recipes.length));
    plan.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } });
    stop();
    plan.run({ name: 'remove_recipes', input: { ids: ['commerce.sales'] } });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBeGreaterThan(0);
    expect(seen).toHaveLength(2);
  });

  it('starts from a cookbook and refuses an invalid one', () => {
    const plan = createHeadlessPlanner({
      $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
      version: 1,
      recipes: ['commerce.sales'],
      features: [],
      policies: [],
    });
    expect(plan.snapshot().recipes.map((r) => r.id)).toContain(
      'commerce.sales',
    );
    expect(() => createHeadlessPlanner({ version: 2 } as never)).toThrowError();
  });

  it('restricts ids to a catalog', () => {
    const catalog = {
      recipes: recipes.slice(0, 2),
      cookbooks: libraryCookbooks.slice(0, 1),
    };
    const plan = createHeadlessPlanner(undefined, { catalog });
    const outside = recipes.at(-1)?.id as string;
    const refused = plan.run({
      name: 'add_recipes',
      input: { ids: [outside] },
    });
    expect(!refused.ok && refused.error.code).toBe('invalid_input');
    const inside = plan.run({
      name: 'add_recipes',
      input: { ids: [catalog.recipes[0].id] },
    });
    expect(inside.ok).toBe(true);
    expect(plan.tools).toEqual(
      buildCommandTools(
        catalog.recipes.map((r) => r.id),
        catalog.cookbooks.map((c) => c.id),
      ),
    );
  });

  it('never throws on garbage commands', () => {
    const plan = createHeadlessPlanner();
    for (const garbage of [null, 7, 'add_recipes', [], { name: 3 }]) {
      const result = plan.run(garbage);
      expect(!result.ok && result.error.code).toBe('unknown_command');
    }
  });
});
