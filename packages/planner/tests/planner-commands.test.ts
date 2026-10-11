import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeUndos } from '../src/lib/assistant/theme-undo.svelte.ts';
import {
  type ChatModel,
  createBrowserAssistantTransport,
} from '../src/lib/assistant/transport.ts';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { libraryState } from '../src/lib/library/state.svelte.ts';
import {
  COMMAND_NAMES,
  type CommandName,
  checkSchema,
  commandSchemas,
  commandTools,
  createPlannerController,
  type JsonSchema,
  PLANNER_COMMANDS_VERSION,
  type PlanSnapshot,
} from '../src/lib/planner/commands/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const FEATURE = '@happyvertical/smrt-ads:AdFormat';

function fresh() {
  recipeState.clear();
  cookbookStore.reset();
  libraryState.active = null;
  return createPlannerController(cookbookStore);
}

type Controller = ReturnType<typeof fresh>;

function ok(controller: Controller, name: CommandName, input: object = {}) {
  const result = controller.run({ name, input });
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  return result;
}

function errorOf(controller: Controller, name: unknown, input: unknown = {}) {
  const result = controller.run({ name, input });
  if (result.ok) throw new Error(`${String(name)} unexpectedly succeeded`);
  return result.error;
}

beforeEach(() => {
  fresh();
});

/** One valid and several invalid inputs per command; the schema and the runtime must agree. */
const EXAMPLES: Record<CommandName, { valid: object[]; invalid: unknown[] }> = {
  add_recipes: {
    valid: [{ ids: ['commerce.sales'] }],
    invalid: [
      {},
      { ids: [] },
      { ids: ['nope'] },
      { ids: 'commerce.sales' },
      { ids: ['commerce.sales'], x: 1 },
    ],
  },
  remove_recipes: {
    valid: [{ ids: ['commerce.sales'] }],
    invalid: [{}, { ids: [] }, { ids: [3] }],
  },
  add_features: {
    valid: [{ ids: [FEATURE] }],
    invalid: [{}, { ids: [] }, { ids: [''] }],
  },
  remove_features: {
    valid: [{ ids: [FEATURE] }],
    invalid: [{}, { ids: [1] }],
  },
  add_cookbook: {
    valid: [{ id: 'bakery' }],
    invalid: [{}, { id: 'nope' }, { id: 4 }],
  },
  remove_cookbook: {
    valid: [{ id: 'bakery' }],
    invalid: [{}, { id: 'nope' }],
  },
  apply_cookbook: {
    valid: [{ id: 'bakery' }, { id: 'bakery', replace: true }],
    invalid: [{}, { id: 'bakery', replace: 'yes' }],
  },
  import_cookbook: {
    valid: [{ document: { version: 1, recipes: [], policies: [] } }],
    invalid: [{}, { document: 'text' }, { document: [] }],
  },
  set_settings: {
    valid: [{}, { currency: 'CAD', taxRate: 13, paymentTerms: 'Net 30' }],
    invalid: [
      { currency: 'cad' },
      { currency: 'XXX' },
      { taxRate: 101 },
      { taxRate: -1 },
      { taxRate: '13' },
      { paymentTerms: '' },
      { paymentTerms: 'x'.repeat(41) },
      { other: 1 },
    ],
  },
  set_policy: {
    valid: [
      {
        model: '@happyvertical/smrt-commerce:Customer',
        field: 'notes',
        label: 'Client',
      },
    ],
    invalid: [
      {},
      { model: '@happyvertical/smrt-commerce:Customer' },
      { model: 'm', field: 'f', visibility: 'secret' },
      { model: 'm', field: 'f', label: 3 },
    ],
  },
  set_theme: {
    valid: [
      {},
      { primary: '#d97706' },
      { preset: 'glass', colorScheme: 'dark' },
    ],
    invalid: [
      { preset: 'neon-nope' },
      { primary: 'orange' },
      { primary: '#fff' },
      { colorScheme: 'sepia' },
      { css: 'body{}' },
    ],
  },
  reset_theme: { valid: [{}], invalid: [{ preset: 'glass' }] },
  rename_section: {
    valid: [{ id: 'section:sales', label: 'Shop' }],
    invalid: [
      { id: 'section:sales' },
      { id: 'section:sales', label: '' },
      { label: 'x' },
    ],
  },
  rename_item: {
    valid: [
      { id: 'item:a', label: 'X' },
      { id: 'item:a', label: null },
    ],
    invalid: [{ id: 'item:a' }, { id: 'item:a', label: 4 }],
  },
  hide: { valid: [{ id: 'section:sales' }], invalid: [{}, { id: '' }] },
  show: { valid: [{ id: 'section:sales' }], invalid: [{}, { id: 7 }] },
  focus: {
    valid: [{}, { tab: 'layout' }, { section: 'section:sales' }],
    invalid: [{ tab: 'nowhere' }, { section: '' }],
  },
  set_name: {
    valid: [
      { name: 'Corner Bakery' },
      { description: 'Bread' },
      { name: null },
    ],
    invalid: [{ name: 3 }, { name: '' }, { x: 1 }],
  },
  validate: {
    valid: [{}],
    invalid: [{ x: 1 }],
  },
  export_cookbook: {
    valid: [{}, { name: 'Shop' }],
    invalid: [{ name: '' }, { name: 3 }],
  },
  undo: {
    valid: [{ undoId: 'undo-1' }, { undoId: 'undo-1', force: true }],
    invalid: [{}, { undoId: '' }, { undoId: 'u', force: 1 }],
  },
};

const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'items',
  'description',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
]);

function keywordsIn(schema: JsonSchema, path: string, out: string[]) {
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) out.push(`${path}.${key}`);
    if (key === 'properties') {
      for (const [name, child] of Object.entries(
        value as Record<string, JsonSchema>,
      )) {
        keywordsIn(child, `${path}.${name}`, out);
      }
    }
    if (key === 'items') keywordsIn(value as JsonSchema, `${path}[]`, out);
  }
}

describe('command schemas', () => {
  it('has a tool definition for every command, and only those', () => {
    expect([...COMMAND_NAMES].sort()).toEqual(Object.keys(EXAMPLES).sort());
    expect(Object.keys(commandSchemas).sort()).toEqual(
      [...COMMAND_NAMES].sort(),
    );
  });

  it('is plain, portable JSON Schema usable as a tool inputSchema', () => {
    const stray: string[] = [];
    for (const tool of commandTools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.name).toMatch(/^[a-z][a-z_]*$/);
      const schema = tool.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
      keywordsIn(schema, tool.name, stray);
    }
    expect(stray).toEqual([]);
  });

  for (const name of Object.keys(EXAMPLES) as CommandName[]) {
    it(`${name}: the schema and the runtime accept and refuse the same inputs`, () => {
      const controller = fresh();
      const { valid, invalid } = EXAMPLES[name];
      for (const input of valid) {
        expect(
          checkSchema(commandSchemas[name], input),
          JSON.stringify(input),
        ).toBeNull();
        const result = controller.run({ name, input });
        // May fail for a reason of state (nothing to undo), never for its shape.
        if (!result.ok) expect(result.error.code).not.toBe('invalid_input');
      }
      for (const input of invalid) {
        expect(
          checkSchema(commandSchemas[name], input),
          JSON.stringify(input),
        ).not.toBeNull();
        const result = controller.run({ name, input });
        expect(result.ok, JSON.stringify(input)).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('invalid_input');
      }
    });
  }

  it('enumerates recipe and cookbook ids so a model cannot invent one', () => {
    const recipeIds = (
      commandSchemas.add_recipes.properties as {
        ids: { items: { enum: string[] } };
      }
    ).ids.items.enum;
    expect(recipeIds).toContain('commerce.sales');
    const cookbooks = (
      commandSchemas.add_cookbook.properties as { id: { enum: string[] } }
    ).id.enum;
    expect(cookbooks).toContain('bakery');
  });
});

describe('runtime', () => {
  it('refuses what is not a command', () => {
    const controller = fresh();
    for (const bad of [null, 'add_recipes', [], {}, { name: 'drop_tables' }]) {
      const result = controller.run(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unknown_command');
    }
    expect(errorOf(controller, '__proto__').code).toBe('unknown_command');
    expect(recipeState.ids).toEqual([]);
  });

  it('recipes: adds with requirements, keeps what is needed, reports it', () => {
    const controller = fresh();
    const added = ok(controller, 'add_recipes', { ids: ['commerce.sales'] });
    expect(added.receipt.changed).toBe(true);
    expect(added.receipt.summary).toMatch(/^Added /);
    expect(added.snapshot.recipes.map((r) => r.id)).toContain('commerce.sales');
    const again = ok(controller, 'add_recipes', { ids: ['commerce.sales'] });
    expect(again.receipt.changed).toBe(false);
    expect(again.receipt.summary).toBe('');
    expect(again.receipt.undoId).toBeUndefined();
    const removed = ok(controller, 'remove_recipes', {
      ids: ['commerce.sales'],
    });
    expect(removed.snapshot.recipes.map((r) => r.id)).not.toContain(
      'commerce.sales',
    );
  });

  it('features: add, unknown model, remove', () => {
    const controller = fresh();
    const added = ok(controller, 'add_features', { ids: [FEATURE] });
    expect(added.snapshot.features).toEqual([FEATURE]);
    expect(added.receipt.changes?.added).toEqual([FEATURE]);
    expect(
      errorOf(controller, 'add_features', { ids: ['@x/y:Nothing'] }).code,
    ).toBe('not_found');
    expect(
      ok(controller, 'remove_features', { ids: [FEATURE] }).snapshot.features,
    ).toEqual([]);
  });

  it('cookbooks: add and remove are additive, apply and import confirm a replace', () => {
    const controller = fresh();
    const added = ok(controller, 'add_cookbook', { id: 'bakery' });
    expect(added.snapshot.recipes.length).toBeGreaterThan(5);
    const removed = ok(controller, 'remove_cookbook', { id: 'bakery' });
    expect(removed.snapshot.recipes).toEqual([]);

    // Empty: no confirmation needed.
    const applied = ok(controller, 'apply_cookbook', { id: 'bakery' });
    expect(applied.snapshot.app).toEqual({
      name: 'Bakery',
      description: null,
      cookbook: 'bakery',
    });
    // The engine undoes a whole-document change too (the old per-slice undo had none).
    expect(applied.receipt.undoId).toBeDefined();
    // Not empty: refused until confirmed, and nothing changes.
    const before = controller.snapshot();
    const refused = errorOf(controller, 'apply_cookbook', { id: 'mechanic' });
    expect(refused.code).toBe('confirmation_required');
    expect(controller.snapshot()).toEqual(before);
    const confirmed = ok(controller, 'apply_cookbook', {
      id: 'mechanic',
      replace: true,
    });
    expect(confirmed.snapshot.app.cookbook).toBe('mechanic');

    const bad = errorOf(controller, 'import_cookbook', {
      document: { version: 9, recipes: [], policies: [] },
      replace: true,
    });
    expect(bad.code).toBe('invalid_input');
    expect(controller.snapshot().app.cookbook).toBe('mechanic');
    const exported = ok(controller, 'export_cookbook');
    const data = exported.data as { fileName: string; text: string };
    expect(data.fileName).toBe('mechanic.cookbook.json');
    const imported = ok(controller, 'import_cookbook', {
      document: JSON.parse(data.text),
      replace: true,
    });
    expect(imported.snapshot.recipes.length).toBe(
      controller.snapshot().recipes.length,
    );
  });

  it('settings: tax in percent, bad values are errors, undo restores', () => {
    const controller = fresh();
    ok(controller, 'add_cookbook', { id: 'bakery' });
    const set = ok(controller, 'set_settings', {
      currency: 'CAD',
      taxRate: 13,
      paymentTerms: 'Net 15',
    });
    expect(set.receipt.summary).toBe('Currency CAD, tax 13%, terms Net 15.');
    expect(set.snapshot.settings).toEqual({
      currency: 'CAD',
      taxRate: 13,
      paymentTerms: 'Net 15',
    });
    expect(errorOf(controller, 'set_settings', { currency: 'ZZZ' }).code).toBe(
      'invalid_input',
    );
    expect(controller.snapshot().settings.currency).toBe('CAD');
    ok(controller, 'undo', { undoId: set.receipt.undoId });
    expect(controller.snapshot().settings.currency).toBe('USD');
  });

  it('policy: sets a field label, needs the model on, clears it again', () => {
    const controller = fresh();
    const model = '@happyvertical/smrt-commerce:Customer';
    expect(
      errorOf(controller, 'set_policy', {
        model,
        field: 'notes',
        label: 'Client',
      }).code,
    ).toBe('not_found');
    ok(controller, 'add_recipes', { ids: ['commerce.customers'] });
    expect(
      errorOf(controller, 'set_policy', { model, field: 'nope', label: 'X' })
        .code,
    ).toBe('not_found');
    const set = ok(controller, 'set_policy', {
      model,
      field: 'notes',
      label: 'Client',
    });
    expect(set.snapshot.policies).toBe(1);
    expect(recipeState.rows.find((r) => r.fieldName === 'notes')?.label).toBe(
      'Client',
    );
    const cleared = ok(controller, 'set_policy', {
      model,
      field: 'notes',
      label: null,
    });
    expect(cleared.snapshot.policies).toBe(0);
    expect(
      ok(controller, 'set_policy', { model, field: 'notes', label: null })
        .receipt.changed,
    ).toBe(false);
  });

  it('theme: sets, resets, undoes through the same path', () => {
    const controller = fresh();
    const set = ok(controller, 'set_theme', {
      primary: '#d97706',
      colorScheme: 'dark',
    });
    expect(set.receipt.summary).toBe('Theme: brand colour #d97706, dark.');
    expect(set.snapshot.theme).toMatchObject({
      primary: '#d97706',
      colorScheme: 'dark',
    });
    expect(cookbookStore.theme?.custom?.primary).toBe('#d97706');
    ok(controller, 'undo', { undoId: set.receipt.undoId });
    expect(cookbookStore.theme).toBeUndefined();
    const again = errorOf(controller, 'undo', { undoId: set.receipt.undoId });
    expect(again.code).toBe('not_found');
    ok(controller, 'set_theme', { preset: 'glass' });
    expect(ok(controller, 'reset_theme').snapshot.theme.preset).toBeNull();
    expect(ok(controller, 'reset_theme').receipt.changed).toBe(false);
  });

  it('undo refuses after later edits unless forced', () => {
    const controller = fresh();
    const first = ok(controller, 'set_theme', { preset: 'glass' });
    ok(controller, 'set_theme', { colorScheme: 'dark' });
    const refused = errorOf(controller, 'undo', {
      undoId: first.receipt.undoId,
    });
    expect(refused.code).toBe('conflict');
    expect(cookbookStore.theme?.colorScheme).toBe('dark');
    ok(controller, 'undo', { undoId: first.receipt.undoId, force: true });
    expect(cookbookStore.theme).toBeUndefined();
  });

  it('undoes recipe changes', () => {
    const controller = fresh();
    const added = ok(controller, 'add_recipes', { ids: ['commerce.sales'] });
    expect(recipeState.ids.length).toBeGreaterThan(0);
    ok(controller, 'undo', { undoId: added.receipt.undoId });
    expect(recipeState.ids).toEqual([]);
    expect(controller.snapshot().undo).toEqual([]);
  });

  it('menu: rename, hide, show, with undo; unknown ids are not_found', () => {
    const controller = fresh();
    ok(controller, 'add_cookbook', { id: 'bakery' });
    const [section] = controller.snapshot().sections;
    const item = section.items[0];
    const renamed = ok(controller, 'rename_section', {
      id: section.id,
      label: 'Shop',
    });
    expect(renamed.snapshot.sections[0].label).toBe('Shop');
    const itemRenamed = ok(controller, 'rename_item', {
      id: item.id,
      label: 'Goods',
    });
    expect(itemRenamed.snapshot.sections[0].items[0].label).toBe('Goods');
    const hidden = ok(controller, 'hide', { id: item.id });
    expect(hidden.snapshot.sections[0].items[0].hidden).toBe(true);
    expect(ok(controller, 'hide', { id: item.id }).receipt.changed).toBe(false);
    const shown = ok(controller, 'show', { id: item.id });
    expect(shown.snapshot.sections[0].items[0].hidden).toBe(false);
    ok(controller, 'undo', { undoId: renamed.receipt.undoId, force: true });
    expect(controller.snapshot().sections[0].label).toBe(section.label);
    expect(errorOf(controller, 'hide', { id: 'section:nope' }).code).toBe(
      'not_found',
    );
    expect(
      errorOf(controller, 'rename_section', { id: 'item:nope', label: 'x' })
        .code,
    ).toBe('not_found');
  });

  it('focus moves the view without changing the plan', () => {
    const controller = fresh();
    ok(controller, 'add_cookbook', { id: 'bakery' });
    const before = controller.snapshot();
    const focused = ok(controller, 'focus', { tab: 'layout' });
    expect(focused.snapshot.focus.tab).toBe('layout');
    expect(focused.snapshot.revision).toBe(before.revision);
    expect(focused.receipt.changed).toBe(true);
    expect(errorOf(controller, 'focus', { section: 'section:nope' }).code).toBe(
      'not_found',
    );
    const section = before.sections[0].id;
    expect(ok(controller, 'focus', { section }).snapshot.focus.section).toBe(
      section,
    );
  });

  it('revision changes with the plan, and a stale caller is refused', () => {
    const controller = fresh();
    const r0 = controller.snapshot().revision;
    expect(controller.snapshot().revision).toBe(r0);
    const added = ok(controller, 'add_recipes', { ids: ['commerce.sales'] });
    const r1 = added.snapshot.revision;
    expect(r1).toBeGreaterThan(r0);
    const stale = controller.run(
      { name: 'remove_recipes', input: { ids: ['commerce.sales'] } },
      { expectedRevision: r0 },
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('conflict');
    expect(recipeState.ids.length).toBeGreaterThan(0);
    const fine = controller.run(
      { name: 'remove_recipes', input: { ids: ['commerce.sales'] } },
      { expectedRevision: r1 },
    );
    expect(fine.ok).toBe(true);
    // A manual edit moves it too.
    const r2 = controller.snapshot().revision;
    recipeState.add('commerce.vendors');
    expect(controller.snapshot().revision).toBeGreaterThan(r2);
  });

  it('subscribe: current snapshot now, then every change; stops when unsubscribed', () => {
    const controller = fresh();
    const seen: PlanSnapshot[] = [];
    const stop = controller.subscribe((snapshot) => seen.push(snapshot));
    expect(seen).toHaveLength(1);
    ok(controller, 'add_recipes', { ids: ['commerce.sales'] });
    expect(seen).toHaveLength(2);
    expect(seen[1].recipes.length).toBeGreaterThan(0);
    // Not for a command that changed nothing.
    ok(controller, 'add_recipes', { ids: ['commerce.sales'] });
    expect(seen).toHaveLength(2);
    stop();
    ok(controller, 'remove_recipes', { ids: ['commerce.sales'] });
    expect(seen).toHaveLength(2);
  });
});

describe('snapshot', () => {
  it('is versioned and read-only data (plain JSON)', () => {
    const controller = fresh();
    ok(controller, 'add_cookbook', { id: 'bakery' });
    const snapshot = controller.snapshot();
    expect(snapshot.version).toBe(PLANNER_COMMANDS_VERSION);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('is small enough for a model prompt, even for the fullest cookbook', () => {
    const controller = fresh();
    const empty = JSON.stringify(controller.snapshot()).length;
    expect(empty).toBeLessThan(600);
    for (const id of ['bakery', 'mechanic', 'welder', 'yoga-studio']) {
      ok(controller, 'apply_cookbook', { id, replace: true });
      const size = JSON.stringify(controller.snapshot()).length;
      expect(size, id).toBeLessThan(3500);
    }
    // Every recipe on at once: still a prompt-sized document, not the catalog.
    ok(controller, 'add_recipes', {
      ids: (
        commandSchemas.add_recipes.properties as {
          ids: { items: { enum: string[] } };
        }
      ).ids.items.enum,
    });
    expect(JSON.stringify(controller.snapshot()).length).toBeLessThan(6500);
  });
});

describe('the assistant is a client of the controller', () => {
  it('its changes show in the snapshot and its theme Undo is the undo command', async () => {
    const controller = fresh();
    const theme = {
      read: () => cookbookStore.snapshot().theme,
      write: (next: Parameters<typeof cookbookStore.setTheme>[0]) =>
        cookbookStore.setTheme(next),
    };
    const undos = new ThemeUndos(theme, controller);
    const model: ChatModel = {
      message: async () =>
        JSON.stringify({
          reply: 'Done.',
          add: ['commerce.sales'],
          remove: [],
          settings: { currency: 'CAD' },
          theme: { primary: '#d97706' },
        }),
    };
    const transport = createBrowserAssistantTransport({
      model: () => model,
      store: recipeState,
      recipes,
      settings: {
        read: () => cookbookStore.settings(),
        write: (settings) => cookbookStore.setSettings(settings),
      },
      theme,
      themeUndos: undos,
      controller,
    });
    const seen: number[] = [];
    controller.subscribe((snapshot) => seen.push(snapshot.revision));
    const result = await transport.sendMessage({
      threadId: 'planner',
      content: 'a shop in Canada, warmer please',
      clientRequestId: 'c1',
    });
    const snapshot = controller.snapshot();
    expect(snapshot.recipes.map((r) => r.id)).toContain('commerce.sales');
    expect(snapshot.settings.currency).toBe('CAD');
    expect(snapshot.theme.primary).toBe('#d97706');
    expect(result.assistantMessage?.content).toMatch(/Added .*Sales/);
    expect(seen.length).toBeGreaterThan(1);
    // The Undo button runs the controller's undo, and the history shows it.
    expect(snapshot.undo).toHaveLength(3);
    const ref = result.assistantMessage?.toolCallData as { undoId: string };
    undos.undo(ref.undoId);
    expect(cookbookStore.theme).toBeUndefined();
    expect(controller.snapshot().undo).toHaveLength(2);
    // A manual edit since does not stop the person's Undo.
    expect(undos.undos[ref.undoId].status).toBe('undone');
  });
});
