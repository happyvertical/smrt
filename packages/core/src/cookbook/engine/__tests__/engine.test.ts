import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateCookbook } from '../../validate.js';
import {
  buildBatchTool,
  buildCommandTools,
  type CommandResult,
  checkSchema,
  createCookbookEngine,
  diagnose,
  type EngineCatalog,
  type PlanSnapshot,
} from '../index.js';

const C = '@happyvertical/smrt-commerce:';
const FIXTURES = join(import.meta.dirname, '../__fixtures__');
const catalog = JSON.parse(
  readFileSync(join(FIXTURES, 'catalog.json'), 'utf8'),
) as EngineCatalog;

const engine = (cookbook?: unknown) =>
  createCookbookEngine({ catalog, cookbook });
const ok = (r: CommandResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
};
const code = (r: { ok: boolean; error?: { code: string } }) =>
  r.ok ? 'ok' : r.error?.code;

/**
 * One script that runs every command (and several refusals) in an order that
 * makes each one meaningful: the planner's parity scenario on a catalog given
 * as data. Steps that need an id read it from the snapshot.
 */
type Step =
  | { name: string; input?: unknown; revision?: number; id?: string }
  | ((s: PlanSnapshot) => { name: string; input?: unknown; revision?: number });

const IMPORTED = {
  $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
  version: 1,
  recipes: ['commerce.sales', 'nope.unknown'],
  features: [],
  policies: [],
};

const SCRIPT: Step[] = [
  { name: 'add_cookbook', input: { id: 'bakery' } },
  { name: 'remove_cookbook', input: { id: 'bakery' } },
  { name: 'add_recipes', input: { ids: ['commerce.sales'] } },
  { name: 'add_recipes', input: { ids: ['commerce.sales'] } },
  { name: 'remove_recipes', input: { ids: ['commerce.customers'] } },
  { name: 'remove_recipes', input: { ids: ['commerce.sales'] } },
  {
    name: 'add_features',
    input: { ids: ['@happyvertical/smrt-ads:AdFormat'] },
  },
  { name: 'add_features', input: { ids: ['@nope/none:Missing'] } },
  { name: 'add_features', input: { ids: [`${C}Internal`] } },
  {
    name: 'remove_features',
    input: { ids: ['@happyvertical/smrt-ads:AdFormat'] },
  },
  { name: 'apply_cookbook', input: { id: 'bakery', replace: true } },
  {
    name: 'set_policy',
    input: { model: `${C}Customer`, field: 'notes', label: 'Client note' },
  },
  {
    name: 'set_policy',
    input: { model: `${C}Customer`, field: 'nope', label: 'X' },
  },
  {
    name: 'set_policy',
    input: { model: `${C}Order`, field: 'number', label: 'X' },
  },
  {
    name: 'set_policy',
    input: { model: `${C}Vendor`, field: 'name', label: 'X' },
  },
  {
    name: 'set_settings',
    input: { currency: 'CAD', taxRate: 13, paymentTerms: 'Net 30' },
  },
  { name: 'set_theme', input: { primary: '#d97706', colorScheme: 'dark' } },
  { name: 'reset_theme' },
  { name: 'set_theme', input: { preset: 'glass' } },
  { name: 'set_name', input: { name: 'Corner Bakery', description: 'Bread.' } },
  (s) => ({
    name: 'rename_section',
    input: { id: s.sections[0].id, label: 'The shop' },
  }),
  (s) => ({
    name: 'rename_item',
    input: { id: s.sections[0].items[0].id, label: 'Front desk' },
  }),
  (s) => ({ name: 'hide', input: { id: s.sections[0].items[0].id } }),
  (s) => ({ name: 'show', input: { id: s.sections[0].items[0].id } }),
  { name: 'rename_section', input: { id: 'section:nope', label: 'X' } },
  { name: 'validate' },
  { name: 'export_cookbook', input: { name: 'Corner Bakery' } },
  (s) => ({ name: 'undo', input: { undoId: s.undo.at(-1) } }),
  { name: 'undo', input: { undoId: 'undo-999' } },
  { name: 'apply_cookbook', input: { id: 'bakery' } },
  { name: 'apply_cookbook', input: { id: 'bakery', replace: true } },
  { name: 'import_cookbook', input: { document: { version: 1 } } },
  { name: 'import_cookbook', input: { document: { version: 'x' } } },
  { name: 'import_cookbook', input: { document: IMPORTED } },
  { name: 'import_cookbook', input: { document: IMPORTED, replace: true } },
  { name: 'no_such_command', input: {} },
  { name: 'add_recipes', input: { ids: [] } },
  { name: 'set_settings', input: { taxRate: 101 } },
  { name: 'add_recipes', input: { ids: ['commerce.sales'] }, revision: 9999 },
  { name: 'add_recipes', input: { ids: ['commerce.vendors'] }, id: 'retry-me' },
  { name: 'add_recipes', input: { ids: ['commerce.vendors'] }, id: 'retry-me' },
  { name: 'remove_recipes', input: { ids: ['commerce.sales'] } },
];

function play(e: ReturnType<typeof engine>) {
  const results: CommandResult[] = [];
  for (const step of SCRIPT) {
    const s = typeof step === 'function' ? step(e.snapshot()) : step;
    const { revision, id, ...rest } = s as {
      revision?: number;
      id?: string;
      name: string;
      input?: unknown;
    };
    results.push(
      e.run({
        ...rest,
        ...(id ? { id } : {}),
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      }),
    );
  }
  return results;
}

describe('commands', () => {
  it('runs every command with receipts, and the refusals', () => {
    const e = engine();
    const results = play(e);
    const succeeded = new Set(
      results.flatMap((r) => (r.ok ? [r.receipt.name] : [])),
    );
    const names = buildCommandTools(catalog).map((t) => t.name);
    expect([...succeeded].sort()).toEqual([...names].sort());
    const codes = new Set(results.flatMap((r) => (r.ok ? [] : [r.error.code])));
    expect([...codes].sort()).toEqual(
      expect.arrayContaining([
        'confirmation_required',
        'conflict',
        'invalid_input',
        'not_found',
        'unknown_command',
        'failed',
      ]),
    );
    expect(results.some((r) => r.ok && r.receipt.changed)).toBe(true);
  });

  it('adds recipes with their requirements and keeps what others need', () => {
    const e = engine();
    const added = ok(
      e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }),
    );
    expect(added.receipt.changes?.added).toEqual([
      'commerce.customers',
      'commerce.sales',
    ]);
    expect(added.receipt.summary).toBe('Added Customers, Sales.');
    const kept = ok(
      e.run({ name: 'remove_recipes', input: { ids: ['commerce.customers'] } }),
    );
    expect(kept.receipt.changed).toBe(false);
    expect(kept.receipt.changes?.kept).toEqual(['commerce.customers']);
    // requiresAny adds the first known alternative
    const any = ok(
      engine().run({
        name: 'add_recipes',
        input: { ids: ['commerce.purchases'] },
      }),
    );
    expect(any.snapshot.recipes.map((r) => r.id)).toEqual([
      'commerce.purchases',
      'commerce.vendors',
    ]);
  });

  it('writes settings as policy rows and reads them back', () => {
    const e = engine();
    const r = ok(
      e.run({
        name: 'set_settings',
        input: { currency: 'CAD', taxRate: 8.25, paymentTerms: 'Net 30' },
      }),
    );
    expect(r.snapshot.settings).toEqual({
      currency: 'CAD',
      taxRate: 8.25,
      paymentTerms: 'Net 30',
    });
    expect(r.receipt.summary).toBe('Currency CAD, tax 8.25%, terms Net 30.');
    const rows = e.cookbook().policies;
    expect(
      rows.find((p) => p.objectRef === `${C}InvoiceLineItem`)?.defaultValue,
    ).toBe('0.0825');
    // clearing back to the default leaves no rows
    ok(e.run({ name: 'set_settings', input: { currency: 'USD', taxRate: 0 } }));
    expect(e.cookbook().policies.some((p) => p.fieldName === 'taxRate')).toBe(
      false,
    );
  });

  it('theme: a preset replaces a brand colour, the scheme stays', () => {
    const e = engine();
    ok(
      e.run({
        name: 'set_theme',
        input: { primary: '#D97706', colorScheme: 'dark' },
      }),
    );
    expect(e.snapshot().theme).toMatchObject({
      primary: '#d97706',
      colorScheme: 'dark',
    });
    ok(e.run({ name: 'set_theme', input: { preset: 'glass' } }));
    expect(e.snapshot().theme).toMatchObject({
      preset: 'glass',
      primary: null,
      colorScheme: 'dark',
    });
    expect(e.snapshot().theme.text).toBe('glass, dark');
  });

  it('keeps custom CSS source through import, theme edits, state and export', () => {
    const css = 'form { max-width: 60ch; }\n';
    const e = engine();
    ok(
      e.run({
        name: 'import_cookbook',
        input: { document: { ...IMPORTED, theme: { customCss: css } } },
      }),
    );
    expect(e.cookbook().theme?.customCss).toBe(css);
    ok(e.run({ name: 'set_theme', input: { preset: 'glass' } }));
    expect(e.cookbook().theme).toEqual({ preset: 'glass', customCss: css });
    const exported = ok(e.run({ name: 'export_cookbook', input: {} })).data as {
      text: string;
    };
    expect(JSON.parse(exported.text).theme.customCss).toBe(css);
    const restored = createCookbookEngine({ catalog, state: e.state() });
    expect(restored.cookbook().theme?.customCss).toBe(css);
    ok(restored.run({ name: 'reset_theme', input: {} }));
    expect(restored.cookbook().theme).toBeUndefined();
  });

  it('edits a font without replacing the preset and preserves it through export', () => {
    const e = engine();
    ok(
      e.run({
        name: 'set_theme',
        input: { preset: 'glass', fontFamily: 'Georgia' },
      }),
    );
    expect(e.cookbook().theme).toEqual({
      preset: 'glass',
      fontFamily: 'Georgia',
    });
    ok(e.run({ name: 'set_theme', input: { colorScheme: 'dark' } }));
    expect(e.cookbook().theme?.fontFamily).toBe('Georgia');
    const exported = ok(e.run({ name: 'export_cookbook', input: {} })).data as {
      text: string;
    };
    expect(JSON.parse(exported.text).theme.fontFamily).toBe('Georgia');
    const restored = createCookbookEngine({ catalog, state: e.state() });
    expect(restored.cookbook().theme?.fontFamily).toBe('Georgia');
    ok(restored.run({ name: 'set_theme', input: { fontFamily: null } }));
    expect(restored.cookbook().theme?.fontFamily).toBeUndefined();
  });

  it('clearing the font also clears a legacy brand font, keeping the colour', () => {
    const e = engine();
    ok(
      e.run({
        name: 'import_cookbook',
        input: {
          document: {
            ...IMPORTED,
            theme: { custom: { primary: '#c2410c', fontFamily: 'Georgia' } },
          },
        },
      }),
    );
    ok(e.run({ name: 'set_theme', input: { fontFamily: 'Inter' } }));
    ok(e.run({ name: 'set_theme', input: { fontFamily: null } }));
    expect(e.cookbook().theme).toEqual({ custom: { primary: '#c2410c' } });
  });

  it('layout: rename, hide and show touch only the layout and stay sparse', () => {
    const e = engine();
    ok(e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }));
    const [people] = e.snapshot().sections;
    expect(people).toMatchObject({ id: 'section:people', label: 'People' });
    ok(
      e.run({
        name: 'rename_section',
        input: { id: 'section:people', label: 'Contacts' },
      }),
    );
    ok(e.run({ name: 'hide', input: { id: people.items[0].id } }));
    expect(e.cookbook().layout).toEqual({
      version: 1,
      hidden: [people.items[0].id],
      sections: { 'section:people': { label: 'Contacts' } },
    });
    const noop = ok(e.run({ name: 'hide', input: { id: people.items[0].id } }));
    expect(noop.receipt.changed).toBe(false);
    ok(e.run({ name: 'show', input: { id: people.items[0].id } }));
    ok(
      e.run({
        name: 'rename_section',
        input: { id: 'section:people', label: 'People' },
      }),
    );
    expect(e.cookbook().layout).toBeUndefined();
  });

  it('refuses to replace a non-empty app without replace, and import never half-applies', () => {
    const e = engine();
    ok(e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }));
    const before = e.state();
    const refused = e.run({ name: 'apply_cookbook', input: { id: 'studio' } });
    expect(code(refused)).toBe('confirmation_required');
    const bad = e.run({
      name: 'import_cookbook',
      input: { document: { version: 1, recipes: 3 }, replace: true },
    });
    expect(code(bad)).toBe('invalid_input');
    expect(
      !bad.ok && ((bad.error.details?.errors ?? []) as string[]).length,
    ).toBeGreaterThan(0);
    expect(e.state()).toEqual({ ...before, journal: [] });
  });

  it('keeps ids this catalog lacks (unavailable) and round-trips them on export', () => {
    const e = engine();
    const r = ok(
      e.run({ name: 'import_cookbook', input: { document: IMPORTED } }),
    );
    expect(r.snapshot.unavailable).toEqual(['nope.unknown']);
    expect(e.cookbook().recipes).toContain('nope.unknown');
    const out = ok(e.run({ name: 'export_cookbook', input: {} })).data as {
      fileName: string;
      text: string;
    };
    expect(out.fileName).toBe('my-app.cookbook.json');
    expect(JSON.parse(out.text).recipes).toContain('nope.unknown');
  });

  it('migrates the legacy blueprint $schema and says so', () => {
    const r = ok(
      engine().run({
        name: 'import_cookbook',
        input: {
          document: {
            ...IMPORTED,
            $schema: 'https://s-m-r-t.dev/schemas/blueprint/v1.json',
          },
        },
      }),
    );
    expect(r.receipt.warnings).toEqual([
      '$schema uses the legacy blueprint URL; migrated',
    ]);
  });

  it('imports every library fixture and exports a valid document', () => {
    const dir = join(import.meta.dirname, '../../__fixtures__');
    for (const file of readdirSync(dir).filter((f) =>
      f.endsWith('.cookbook.json'),
    )) {
      const e = engine();
      const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      ok(e.run({ name: 'import_cookbook', input: { document: doc } }));
      const exported = ok(e.run({ name: 'export_cookbook', input: {} }))
        .data as { text: string };
      expect(validateCookbook(JSON.parse(exported.text)).ok, file).toBe(true);
      // exporting twice is stable: the document is in canonical form
      const again = createCookbookEngine({
        catalog,
        cookbook: JSON.parse(exported.text),
      });
      expect(
        (
          ok(again.run({ name: 'export_cookbook', input: {} })).data as {
            text: string;
          }
        ).text,
      ).toBe(exported.text);
    }
  });

  it('validate reports typed diagnostics', () => {
    const e = engine();
    ok(e.run({ name: 'import_cookbook', input: { document: IMPORTED } }));
    const result = ok(e.run({ name: 'validate', input: {} })).data as {
      ok: boolean;
      diagnostics: { code: string; severity: string; path: string }[];
    };
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'unknown_recipe',
        path: 'recipes[2]',
      }),
    ]);
    const staleLayout = ok(
      engine({
        version: 1,
        recipes: [],
        policies: [],
        layout: { version: 1, hidden: ['item:ghost'] },
      }).run({ name: 'validate', input: {} }),
    ).data as {
      ok: boolean;
      diagnostics: { code: string; severity: string; path: string }[];
    };
    expect(staleLayout).toMatchObject({
      ok: true,
      diagnostics: [
        {
          code: 'unknown_layout_id',
          severity: 'warning',
          path: 'layout.hidden[0]',
        },
      ],
    });
    const bad = diagnose(
      { ...catalog, placementItems: ['dock:assistant'] },
      {
        ...engine().cookbook(),
        recipes: ['commerce.sales'],
        features: ['@x/y:Z'],
        theme: { preset: 'neon' },
        layout: {
          version: 1,
          hidden: ['item:ghost'],
          placements: {
            'dock:assistant': 'header.end',
            'host:missing': 'header.start',
          },
        },
        policies: [
          { objectRef: `${C}Vendor`, fieldName: 'name', scopeType: 'app' },
        ],
      },
    );
    expect(bad.map((d) => d.code).sort()).toEqual([
      'missing_requirement',
      'policy_not_covered',
      'unknown_layout_id',
      'unknown_layout_id',
      'unknown_model',
      'unknown_preset',
    ]);
    expect(
      bad.find((diagnostic) => diagnostic.path === 'layout.hidden[0]'),
    ).toMatchObject({ severity: 'warning', code: 'unknown_layout_id' });
    expect(
      bad.find(
        (diagnostic) => diagnostic.path === 'layout.placements.host:missing',
      ),
    ).toMatchObject({ severity: 'error', code: 'unknown_layout_id' });
    expect(diagnose(catalog, { version: 2 } as never)[0]).toMatchObject({
      severity: 'error',
      code: 'invalid_document',
    });
  });
});

describe('retries and idempotency', () => {
  it('a retried id returns the original receipt and applies nothing twice', () => {
    const e = engine();
    const command = {
      id: 'cmd-1',
      name: 'add_recipes',
      input: { ids: ['commerce.sales'] },
    };
    const first = ok(e.run(command));
    const revision = e.snapshot().revision;
    const second = ok(e.run(command));
    expect(second.replayed).toBe(true);
    expect({ ...second, replayed: undefined }).toEqual({
      ...first,
      replayed: undefined,
    });
    expect(e.snapshot().revision).toBe(revision);
    expect(e.snapshot().undo).toEqual([first.receipt.undoId]);
  });

  it('a retry after later edits still returns the first receipt, not the current state', () => {
    const e = engine();
    const first = ok(
      e.run({
        id: 'a',
        name: 'add_recipes',
        input: { ids: ['commerce.sales'] },
      }),
    );
    ok(e.run({ name: 'set_settings', input: { currency: 'EUR' } }));
    const again = ok(
      e.run({
        id: 'a',
        name: 'add_recipes',
        input: { ids: ['commerce.sales'] },
      }),
    );
    expect(again.snapshot).toEqual(first.snapshot);
    expect(e.snapshot().settings.currency).toBe('EUR');
  });

  it('reusing an id for a different command is refused and does not poison the id', () => {
    const e = engine();
    ok(
      e.run({
        id: 'x',
        name: 'add_recipes',
        input: { ids: ['commerce.sales'] },
      }),
    );
    const clash = e.run({
      id: 'x',
      name: 'add_recipes',
      input: { ids: ['inventory.stock'] },
    });
    expect(code(clash)).toBe('id_reuse');
    expect(e.snapshot().recipes.map((r) => r.id)).not.toContain(
      'inventory.stock',
    );
    expect(
      ok(
        e.run({
          id: 'x',
          name: 'add_recipes',
          input: { ids: ['commerce.sales'] },
        }),
      ).replayed,
    ).toBe(true);
  });

  it('a failed command with an id replays its error', () => {
    const e = engine();
    const first = e.run({
      id: 'f',
      name: 'add_recipes',
      input: { ids: ['nope'] },
    });
    expect(code(first)).toBe('invalid_input');
    const again = e.run({
      id: 'f',
      name: 'add_recipes',
      input: { ids: ['nope'] },
    });
    expect(again).toEqual({ ...first, replayed: true });
  });

  it('survives a restart: state() resumes with the journal', () => {
    const e = engine();
    const first = ok(
      e.run({ id: 'p', name: 'apply_cookbook', input: { id: 'bakery' } }),
    );
    const saved = JSON.parse(JSON.stringify(e.state()));
    const resumed = createCookbookEngine({ catalog, state: saved });
    expect(resumed.snapshot().revision).toBe(first.receipt.revisionAfter);
    expect(resumed.cookbook()).toEqual(e.cookbook());
    const retry = ok(
      resumed.run({ id: 'p', name: 'apply_cookbook', input: { id: 'bakery' } }),
    );
    expect(retry.replayed).toBe(true);
    expect(retry.receipt).toEqual(first.receipt);
    expect(resumed.snapshot().app.cookbook).toBe('bakery');
  });

  it('forgets the oldest ids past maxJournal', () => {
    const e = createCookbookEngine({ catalog, maxJournal: 2 });
    for (const id of ['1', '2', '3'])
      e.run({ id, name: 'validate', input: {} });
    expect(e.state().journal.map((j) => j.id)).toEqual(['2', '3']);
  });

  it('a command that changes nothing is a no-op: same revision, no undo', () => {
    const e = engine();
    ok(e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }));
    const revision = e.snapshot().revision;
    const again = ok(
      e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }),
    );
    expect(again.receipt).toMatchObject({
      changed: false,
      summary: '',
      revisionBefore: revision,
      revisionAfter: revision,
    });
    expect(again.receipt.undoId).toBeUndefined();
    for (const noop of [
      { name: 'reset_theme' },
      { name: 'show', input: { id: 'section:people' } },
      { name: 'set_settings', input: { currency: 'USD' } },
    ]) {
      expect(ok(e.run(noop)).receipt.changed).toBe(false);
    }
    const reapplied = ok(
      e.run({ name: 'apply_cookbook', input: { id: 'bakery', replace: true } }),
    );
    const twice = ok(
      e.run({ name: 'apply_cookbook', input: { id: 'bakery', replace: true } }),
    );
    expect(reapplied.receipt.changed).toBe(true);
    expect(twice.receipt.changed).toBe(false);
  });
});

describe('revisions and conflicts', () => {
  it('a model action on a stale revision cannot overwrite a newer manual edit', () => {
    const e = engine();
    const seenByModel = e.snapshot().revision;
    // a person edits by hand after the model looked
    ok(e.run({ name: 'set_settings', input: { currency: 'CAD' } }));
    const stale = e.run({
      name: 'set_settings',
      input: { currency: 'EUR' },
      expectedRevision: seenByModel,
    });
    expect(code(stale)).toBe('conflict');
    expect(!stale.ok && stale.error.details).toEqual({
      expectedRevision: seenByModel,
      currentRevision: e.snapshot().revision,
    });
    expect(e.snapshot().settings.currency).toBe('CAD');
    // the option form works too
    expect(
      code(e.run({ name: 'validate' }, { expectedRevision: seenByModel })),
    ).toBe('conflict');
    expect(
      ok(
        e.run({
          name: 'set_settings',
          input: { currency: 'EUR' },
          expectedRevision: e.snapshot().revision,
        }),
      ).snapshot.settings.currency,
    ).toBe('EUR');
  });

  it('revisions count changes only', () => {
    const e = engine();
    expect(e.snapshot().revision).toBe(0);
    ok(e.run({ name: 'validate' }));
    ok(e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }));
    ok(e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }));
    e.run({ name: 'add_recipes', input: { ids: ['nope'] } });
    expect(e.snapshot().revision).toBe(1);
  });

  it('undo restores the document, and refuses after later edits unless forced', () => {
    const e = engine();
    const a = ok(
      e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }),
    );
    const b = ok(e.run({ name: 'set_settings', input: { currency: 'CAD' } }));
    const conflict = e.run({
      name: 'undo',
      input: { undoId: a.receipt.undoId },
    });
    expect(code(conflict)).toBe('conflict');
    expect(e.snapshot().recipes).toHaveLength(2);
    ok(e.run({ name: 'undo', input: { undoId: b.receipt.undoId } }));
    expect(e.snapshot().settings.currency).toBe('USD');
    ok(e.run({ name: 'undo', input: { undoId: a.receipt.undoId } }));
    expect(e.snapshot().recipes).toEqual([]);
    expect(
      code(e.run({ name: 'undo', input: { undoId: a.receipt.undoId } })),
    ).toBe('not_found');
    const c = ok(
      e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }),
    );
    ok(e.run({ name: 'set_settings', input: { currency: 'CAD' } }));
    ok(
      e.run({ name: 'undo', input: { undoId: c.receipt.undoId, force: true } }),
    );
    expect(e.snapshot().recipes).toEqual([]);
  });

  it('keeps at most maxUndo undo entries', () => {
    const e = createCookbookEngine({ catalog, maxUndo: 2 });
    for (const c of ['CAD', 'EUR', 'GBP'])
      ok(e.run({ name: 'set_settings', input: { currency: c } }));
    expect(e.snapshot().undo).toHaveLength(2);
  });

  it('subscribers hear the snapshot now and after each change only', () => {
    const e = engine();
    const seen: number[] = [];
    const stop = e.subscribe((s) => seen.push(s.revision));
    ok(e.run({ name: 'validate' }));
    ok(e.run({ name: 'add_recipes', input: { ids: ['commerce.sales'] } }));
    stop();
    ok(e.run({ name: 'set_settings', input: { currency: 'CAD' } }));
    expect(seen).toEqual([0, 1]);
  });
});

describe('atomic batches', () => {
  const sales = { name: 'add_recipes', input: { ids: ['commerce.sales'] } };

  it('applies every command and reports one receipt, one undo', () => {
    const e = engine();
    const r = e.batch({
      id: 'b1',
      commands: [
        sales,
        { name: 'set_settings', input: { currency: 'CAD' } },
        { name: 'validate' },
      ],
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.results.map((x) => x.receipt.name)).toEqual([
      'add_recipes',
      'set_settings',
      'validate',
    ]);
    expect(r.receipt).toMatchObject({
      count: 3,
      changed: true,
      revisionBefore: 0,
      revisionAfter: 2,
    });
    expect(r.snapshot.settings.currency).toBe('CAD');
    expect(r.snapshot.undo).toEqual([r.receipt.undoId]);
    ok(e.run({ name: 'undo', input: { undoId: r.receipt.undoId } }));
    expect(e.snapshot().recipes).toEqual([]);
    expect(e.snapshot().settings.currency).toBe('USD');
  });

  it('a failing batch leaves the prior state intact and names the command', () => {
    const e = engine();
    ok(e.run({ name: 'apply_cookbook', input: { id: 'bakery' } }));
    const before = JSON.stringify(e.state());
    const failed = e.batch({
      commands: [
        { name: 'set_settings', input: { currency: 'CAD' } },
        { name: 'set_theme', input: { preset: 'glass' } },
        { name: 'rename_section', input: { id: 'section:nope', label: 'X' } },
        sales,
      ],
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toMatchObject({
      code: 'batch_failed',
      path: 'commands[2]',
      details: { index: 2, cause: { code: 'not_found' } },
    });
    expect(JSON.stringify(e.state())).toBe(before);
    expect(failed.snapshot).toEqual(e.snapshot());
    expect(e.snapshot().settings.currency).toBe('USD');
    // recoverable: the same commands without the bad one apply cleanly
    const retry = e.batch({
      commands: [{ name: 'set_settings', input: { currency: 'CAD' } }, sales],
    });
    expect(retry.ok).toBe(true);
  });

  it('rejects malformed batches and commands inside them without touching state', () => {
    const e = engine();
    const before = e.snapshot();
    for (const bad of [
      null,
      { commands: [] },
      { commands: 'x' },
      { commands: [sales, { name: 'nope' }] },
      { commands: [sales, { name: 'set_settings', input: { taxRate: 500 } }] },
      { commands: [sales, { name: 'undo', input: { undoId: 'undo-1' } }] },
      { commands: [{ ...sales, id: 'inner' }] },
    ]) {
      const r = e.batch(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(e.snapshot()).toEqual(before);
    }
  });

  it('honours expectedRevision for the whole batch', () => {
    const e = engine();
    ok(e.run(sales));
    const r = e.batch({
      commands: [{ name: 'set_settings', input: { currency: 'CAD' } }],
      expectedRevision: 0,
    });
    expect(!r.ok && r.error.code).toBe('conflict');
    expect(e.snapshot().settings.currency).toBe('USD');
  });

  it('a retried batch id replays the original and applies nothing twice; success or failure', () => {
    const e = engine();
    const batch = {
      id: 'b',
      commands: [sales, { name: 'set_settings', input: { currency: 'CAD' } }],
    };
    const first = e.batch(batch);
    const revision = e.snapshot().revision;
    const second = e.batch(batch);
    expect(second).toEqual({ ...first, replayed: true });
    expect(e.snapshot().revision).toBe(revision);
    // Key order does not make a retry a different payload.
    const reordered = e.batch({
      commands: [
        { input: sales.input, name: sales.name },
        { input: { currency: 'CAD' }, name: 'set_settings' },
      ],
      id: 'b',
    });
    expect(reordered).toEqual({ ...first, replayed: true });
    const clash = e.batch({ id: 'b', commands: [sales] });
    expect(!clash.ok && clash.error.code).toBe('id_reuse');
    const bad = {
      id: 'bad',
      commands: [{ name: 'add_recipes', input: { ids: ['x'] } }],
    };
    const f1 = e.batch(bad);
    expect(e.batch(bad)).toEqual({ ...f1, replayed: true });
  });

  it('a batch that changes nothing is a no-op', () => {
    const e = engine();
    ok(e.run(sales));
    const r = e.batch({
      commands: [sales, { name: 'reset_theme', input: {} }],
    });
    expect(r.ok && r.receipt).toMatchObject({
      changed: false,
      revisionBefore: 1,
      revisionAfter: 1,
    });
    expect(r.ok && r.receipt.undoId).toBeUndefined();
  });
});

describe('two independent hosts', () => {
  it('given the same cookbook and command sequence, produce equal results, snapshots and exports', () => {
    const a = engine();
    const b = engine();
    const ra = play(a);
    const rb = play(b);
    expect(rb).toEqual(ra);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.state()).toEqual(a.state());
    expect(ok(b.run({ name: 'export_cookbook', input: {} })).data).toEqual(
      ok(a.run({ name: 'export_cookbook', input: {} })).data,
    );
  });

  it('batches and a resumed engine agree with a straight run', () => {
    const commands = [
      { name: 'apply_cookbook', input: { id: 'bakery' } },
      { name: 'set_settings', input: { currency: 'CAD', taxRate: 5 } },
      { name: 'set_theme', input: { preset: 'studio' } },
    ];
    const a = engine();
    for (const c of commands) ok(a.run(c));
    const b = engine();
    expect(b.batch({ commands }).ok).toBe(true);
    const c = createCookbookEngine({
      catalog,
      state: JSON.parse(JSON.stringify(a.state())),
    });
    expect(b.cookbook()).toEqual(a.cookbook());
    expect(b.snapshot().revision).toBe(a.snapshot().revision);
    expect(c.snapshot()).toEqual({ ...a.snapshot(), undo: [] });
    expect(c.cookbook()).toEqual(a.cookbook());
  });

  it('start from the same cookbook and agree', () => {
    const doc = { ...IMPORTED, recipes: ['commerce.invoicing'] };
    const a = engine(doc);
    const b = engine(JSON.parse(JSON.stringify(doc)));
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(() => engine({ version: 2 })).toThrowError(/Invalid cookbook/);
  });
});

describe('never throws', () => {
  it('garbage in, typed error out', () => {
    const e = engine();
    for (const garbage of [
      null,
      undefined,
      7,
      'add_recipes',
      [],
      { name: 3 },
      { name: 'hide', input: 'x' },
      { name: '__proto__' },
      { name: 'validate', extra: 1 },
    ]) {
      const r = e.run(garbage);
      expect(r.ok).toBe(false);
    }
    expect(code(e.run({ id: '', name: 'validate' }))).toBe('invalid_input');
    expect(code(e.run({ name: 'validate', expectedRevision: -1 }))).toBe(
      'invalid_input',
    );
  });
});

describe('JSON Schemas', () => {
  const ajv = new Ajv2020({ strict: false });
  const tools = buildCommandTools(catalog);

  it('every command has a schema that compiles', () => {
    expect(tools.length).toBe(20);
    for (const tool of tools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
      expect(tool.description.length).toBeGreaterThan(10);
    }
    expect(() =>
      ajv.compile(buildBatchTool(catalog).inputSchema),
    ).not.toThrow();
  });

  it('the runtime check and Ajv agree on valid and invalid inputs', () => {
    const cases: [string, unknown][] = [
      ['add_recipes', { ids: ['commerce.sales'] }],
      ['add_recipes', { ids: ['nope'] }],
      ['add_recipes', { ids: [] }],
      ['add_recipes', {}],
      ['add_recipes', { ids: ['commerce.sales'], extra: 1 }],
      ['set_settings', { taxRate: 13 }],
      ['set_settings', { taxRate: 101 }],
      ['set_settings', { currency: 'cad' }],
      ['set_theme', { primary: '#abcdef' }],
      ['set_theme', { primary: 'red' }],
      ['set_theme', { preset: 'neon' }],
      ['set_policy', { model: 'a', field: 'b', visibility: null }],
      ['set_policy', { model: 'a', field: 'b', visibility: 'x' }],
      ['rename_item', { id: 'a', label: null }],
      ['rename_item', { id: 'a', label: '' }],
      ['apply_cookbook', { id: 'bakery', replace: true }],
      ['apply_cookbook', { id: 'nope' }],
      ['validate', {}],
      ['validate', { x: 1 }],
    ];
    for (const [name, input] of cases) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as never;
      const mine = checkSchema(schema, input) === null;
      const theirs = ajv.compile(schema)(input) === true;
      expect(mine, `${name} ${JSON.stringify(input)}`).toBe(theirs);
    }
  });

  it('ids become enums from the catalog data', () => {
    const add = tools.find((t) => t.name === 'add_recipes')?.inputSchema as {
      properties: { ids: { items: { enum: string[] } } };
    };
    expect(add.properties.ids.items.enum).toEqual(
      catalog.recipes.map((r) => r.id),
    );
    const apply = tools.find((t) => t.name === 'apply_cookbook')
      ?.inputSchema as { properties: { id: { enum: string[] } } };
    expect(apply.properties.id.enum).toEqual(['bakery', 'studio']);
    expect(createCookbookEngine({ catalog }).tools).toEqual(tools);
  });

  it('a catalog with no recipes or library still works (free-form ids)', () => {
    const bare = createCookbookEngine({ catalog: { recipes: [], models: [] } });
    expect(
      code(bare.run({ name: 'add_recipes', input: { ids: ['x.y'] } })),
    ).toBe('not_found');
    expect(code(bare.run({ name: 'apply_cookbook', input: { id: 'x' } }))).toBe(
      'not_found',
    );
  });
});

describe('snapshots', () => {
  it('are compact and plain JSON', () => {
    const e = engine();
    ok(e.run({ name: 'apply_cookbook', input: { id: 'bakery' } }));
    const text = JSON.stringify(e.snapshot());
    expect(text.length).toBeLessThan(2500);
    expect(JSON.parse(text)).toEqual(e.snapshot());
    expect(e.snapshot()).toMatchObject({
      version: 1,
      app: { name: 'Bakery', cookbook: 'bakery' },
    });
  });
});

describe('portability', () => {
  it('imports nothing but relative modules and types', () => {
    const sources = readdirSync(join(import.meta.dirname, '..')).filter((f) =>
      f.endsWith('.ts'),
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
      for (const [, spec] of text.matchAll(/from '([^']+)'/g)) {
        const typeOnly = new RegExp(`import type[^;]*from '${spec}'`, 's').test(
          text,
        );
        expect(
          spec.startsWith('.') || typeOnly,
          `${file} imports ${spec}`,
        ).toBe(true);
      }
      expect(text, file).not.toMatch(
        /\b(process\.|window\.|localStorage|sessionStorage|node:)/,
      );
    }
  });
});

describe('schema portability', () => {
  const emitted: Array<[string, unknown]> = [
    ...buildCommandTools(catalog).map((t): [string, unknown] => [
      t.name,
      t.inputSchema,
    ]),
    ['batch', buildBatchTool(catalog)],
  ];
  const nullableAnyOf: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      for (const [i, v] of node.entries()) walk(v, `${path}[${i}]`);
    } else if (node && typeof node === 'object') {
      const any = (node as { anyOf?: Array<{ type?: unknown }> }).anyOf;
      if (
        Array.isArray(any) &&
        any.length === 2 &&
        any.some((b) => b.type === 'null') &&
        any.some((b) => typeof b.type === 'string' && b.type !== 'null')
      ) {
        nullableAnyOf.push(path);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    }
  };

  it('never spells nullability as anyOf', () => {
    expect(emitted.length).toBeGreaterThan(10);
    for (const [name, schema] of emitted) walk(schema, name);
    expect(nullableAnyOf).toEqual([]);
  });

  it('uses portable type arrays for set_name and set_theme.fontFamily', () => {
    const tool = (n: string) =>
      buildCommandTools(catalog).find((t) => t.name === n)?.inputSchema as {
        properties: Record<string, Record<string, unknown>>;
      };
    expect(tool('set_name').properties.name).toMatchObject({
      type: ['string', 'null'],
    });
    const font = tool('set_theme').properties.fontFamily;
    expect(font).toMatchObject({ type: ['string', 'null'], minLength: 1 });
    expect(font).not.toHaveProperty('anyOf');
  });
});

describe('the ./cookbook/engine package export', () => {
  it('names a file the build emits (one dist/<export>.js per entry)', () => {
    const pkg = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../../../../package.json'),
        'utf8',
      ),
    ) as { exports: Record<string, { import: string } | string> };
    const entry = pkg.exports['./cookbook/engine'] as { import: string };
    const source = entry.import
      .replace(/^\.\/dist\//, '')
      .replace(/\.js$/, '.ts');
    expect(readdirSync(join(import.meta.dirname, '../..'))).toContain(
      source.replace(/^cookbook\//, ''),
    );
  });
});
