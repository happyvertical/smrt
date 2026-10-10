import type { Cookbook, CookbookPolicyRow } from '@happyvertical/smrt-types';
import { validateCookbook } from '../validate.js';
import {
  type AppSettings,
  canonical,
  clone,
  coveredModels,
  describeTheme,
  diagnose,
  isEmptyCookbook,
  mergeChanges,
  prune,
  readSettings,
  withFeaturesChanged,
  withRecipesAdded,
  withRecipesRemoved,
  withRequirements,
  withThemePatch,
  writeSettings,
} from './document.js';
import {
  buildNav,
  findModel,
  humanize,
  modelLabel,
  withHidden,
  withItemRenamed,
  withSectionRenamed,
} from './nav.js';
import type {
  CommandError,
  CommandErrorCode,
  CommandInputs,
  CommandName,
  EngineCatalog,
  ExportData,
  RecipeChanges,
  ValidateData,
} from './types.js';

/** What the engine holds besides its counters: the document and where it came from. */
export interface PlanState {
  doc: Cookbook;
  /** The library cookbook the plan was last set up from. */
  applied: string | null;
}

export type Outcome =
  | {
      ok: true;
      state: PlanState;
      summary: string;
      changes?: RecipeChanges;
      data?: unknown;
      warnings?: string[];
    }
  | { ok: false; error: CommandError };

export const fail = (
  code: CommandErrorCode,
  message: string,
  extra: { path?: string; details?: Record<string, unknown> } = {},
): Outcome => ({ ok: false, error: { code, message, ...extra } });

const done = (
  state: PlanState,
  summary = '',
  extra: Partial<Extract<Outcome, { ok: true }>> = {},
): Outcome => ({ ok: true, state, summary, ...extra });

const REPLACE_NEEDED =
  'This replaces the recipes, options, menu and look. Send replace: true to confirm.';

const list = (values: readonly string[]) => values.join(', ');

/** The file name an export gets: a slug of the app name. */
export function exportFileName(name?: string): string {
  const slug = (name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'my-app'}.cookbook.json`;
}

export const serializeCookbook = (doc: Cookbook): string =>
  `${JSON.stringify(doc, null, 2)}\n`;

/**
 * A document from outside (a library entry, an import, a restored state) as
 * the engine holds it: requirements included, options pruned to what is
 * covered. Recipe and feature ids the catalog lacks stay, reported as
 * `unavailable`, so a round trip loses nothing.
 */
export function adopt(catalog: EngineCatalog, doc: Cookbook): Cookbook {
  const byId = new Map(catalog.recipes.map((r) => [r.id, r]));
  const known = doc.recipes.filter((id) => byId.has(id));
  const unknown = doc.recipes.filter((id) => !byId.has(id));
  return canonical(
    prune(catalog, {
      ...clone(doc),
      recipes: [...withRequirements(known, byId), ...unknown],
    }),
  );
}

export function libraryName(
  catalog: EngineCatalog,
  id: string | null,
): string | undefined {
  return id ? catalog.cookbooks?.find((c) => c.id === id)?.name : undefined;
}

const describeChange = (catalog: EngineCatalog, changes: RecipeChanges) => {
  const label = (id: string) =>
    catalog.recipes.find((r) => r.id === id)?.label ?? id;
  return [
    changes.added.length ? `Added ${list(changes.added.map(label))}.` : '',
    changes.removed.length
      ? `Removed ${list(changes.removed.map(label))}.`
      : '',
    changes.kept.length
      ? `Kept ${list(changes.kept.map(label))} (needed).`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
};

const describeFeatures = (catalog: EngineCatalog, changes: RecipeChanges) =>
  [
    changes.added.length
      ? `Added ${list(changes.added.map((id) => modelLabel(catalog, id)))}.`
      : '',
    changes.removed.length
      ? `Removed ${list(changes.removed.map((id) => modelLabel(catalog, id)))}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

const percent = (fraction: number) => `${Number((fraction * 100).toFixed(4))}%`;

type Handler<N extends CommandName> = (
  catalog: EngineCatalog,
  state: PlanState,
  input: CommandInputs[N],
) => Outcome;

const withDoc = (state: PlanState, doc: Cookbook): PlanState => ({
  ...state,
  doc: canonical(doc),
});

function navOf(catalog: EngineCatalog, doc: Cookbook) {
  const sections = buildNav(catalog, doc);
  return {
    sections,
    section: (id: string) => sections.find((s) => s.id === id),
    item: (id: string) =>
      sections.flatMap((s) => s.items).find((i) => i.id === id),
  };
}

const setLayout = (doc: Cookbook, layout: Cookbook['layout']): Cookbook => {
  const next = { ...doc };
  if (layout) next.layout = layout;
  else delete next.layout;
  return next;
};

const handlers: { [N in CommandName]?: Handler<N> } = {
  add_recipes(catalog, state, { ids }) {
    const missing = ids.filter(
      (id) => !catalog.recipes.some((r) => r.id === id),
    );
    if (missing.length) {
      return fail('not_found', `No such recipe: ${list(missing)}.`, {
        path: 'input.ids',
      });
    }
    const { doc, changes } = withRecipesAdded(catalog, state.doc, ids);
    return done(withDoc(state, doc), describeChange(catalog, changes), {
      changes,
    });
  },
  remove_recipes(catalog, state, { ids }) {
    const { doc, changes } = withRecipesRemoved(catalog, state.doc, ids);
    return done(withDoc(state, doc), describeChange(catalog, changes), {
      changes,
    });
  },
  add_features(catalog, state, { ids }) {
    const missing = ids.filter((id) => !findModel(catalog, id)?.exposed);
    if (missing.length) {
      return fail('not_found', `No such model to add: ${list(missing)}.`, {
        path: 'input.ids',
      });
    }
    const { doc, changes } = withFeaturesChanged(catalog, state.doc, ids, true);
    return done(withDoc(state, doc), describeFeatures(catalog, changes), {
      changes,
    });
  },
  remove_features(catalog, state, { ids }) {
    const { doc, changes } = withFeaturesChanged(
      catalog,
      state.doc,
      ids,
      false,
    );
    return done(withDoc(state, doc), describeFeatures(catalog, changes), {
      changes,
    });
  },
  add_cookbook(catalog, state, { id }) {
    const book = catalog.cookbooks?.find((c) => c.id === id);
    if (!book)
      return fail('not_found', `No cookbook "${id}".`, { path: 'input.id' });
    const recipes = withRecipesAdded(catalog, state.doc, book.document.recipes);
    const features = withFeaturesChanged(
      catalog,
      recipes.doc,
      book.document.features.filter((f) => findModel(catalog, f)?.exposed),
      true,
    );
    const changes = mergeChanges(recipes.changes, features.changes);
    return done(
      withDoc(state, features.doc),
      changes.added.length ? `Added the ${book.name} cookbook.` : '',
      { changes },
    );
  },
  remove_cookbook(catalog, state, { id }) {
    const book = catalog.cookbooks?.find((c) => c.id === id);
    if (!book)
      return fail('not_found', `No cookbook "${id}".`, { path: 'input.id' });
    const recipes = withRecipesRemoved(
      catalog,
      state.doc,
      book.document.recipes,
    );
    const features = withFeaturesChanged(
      catalog,
      recipes.doc,
      book.document.features,
      false,
    );
    const changes = mergeChanges(recipes.changes, features.changes);
    return done(
      withDoc(state, features.doc),
      [
        describeChange(catalog, recipes.changes),
        describeFeatures(catalog, features.changes),
      ]
        .filter(Boolean)
        .join(' '),
      { changes },
    );
  },
  apply_cookbook(catalog, state, { id, replace }) {
    const book = catalog.cookbooks?.find((c) => c.id === id);
    if (!book)
      return fail('not_found', `No cookbook "${id}".`, { path: 'input.id' });
    if (!replace && !isEmptyCookbook(state.doc)) {
      return fail('confirmation_required', REPLACE_NEEDED);
    }
    return done(
      { doc: adopt(catalog, book.document), applied: id },
      `${book.name} set up.`,
    );
  },
  import_cookbook(catalog, state, { document, replace }) {
    const checked = validateCookbook(document);
    if (!checked.ok) {
      return fail('invalid_input', checked.errors[0] ?? 'Not a cookbook.', {
        path: 'input.document',
        details: { errors: checked.errors },
      });
    }
    if (!replace && !isEmptyCookbook(state.doc)) {
      return fail('confirmation_required', REPLACE_NEEDED);
    }
    const n = checked.cookbook.recipes.length;
    return done(
      { doc: adopt(catalog, checked.cookbook), applied: null },
      `Imported ${n} ${n === 1 ? 'recipe' : 'recipes'}.`,
      checked.warnings.length ? { warnings: checked.warnings } : {},
    );
  },
  set_settings(catalog, state, input) {
    const before = readSettings(catalog, state.doc);
    const next: AppSettings = { ...before };
    const parts: string[] = [];
    if (input.currency !== undefined) {
      const code = input.currency.trim().toUpperCase();
      if (catalog.currencies && !catalog.currencies.includes(code)) {
        return fail('invalid_input', `${code} is not a known currency.`, {
          path: 'input.currency',
        });
      }
      if (!/^[A-Z]{3}$/.test(code)) {
        return fail('invalid_input', 'currency must be a three-letter code.', {
          path: 'input.currency',
        });
      }
      if (code !== before.currency) {
        next.currency = code;
        parts.push(`currency ${code}`);
      }
    }
    if (input.taxRate !== undefined) {
      const fraction = Number((input.taxRate / 100).toFixed(6));
      if (fraction !== before.taxRate) {
        next.taxRate = fraction;
        parts.push(`tax ${percent(fraction)}`);
      }
    }
    if (input.paymentTerms !== undefined) {
      const terms = [...input.paymentTerms]
        .map((ch) =>
          ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch,
        )
        .join('')
        .trim();
      if (!terms) {
        return fail('invalid_input', 'paymentTerms must not be empty.', {
          path: 'input.paymentTerms',
        });
      }
      if (terms !== before.paymentTerms) {
        next.paymentTerms = terms;
        parts.push(`terms ${terms}`);
      }
    }
    if (!parts.length) return done(state);
    const text = parts.join(', ');
    return done(
      withDoc(state, writeSettings(catalog, state.doc, next)),
      `${text[0].toUpperCase()}${text.slice(1)}.`,
    );
  },
  set_policy(catalog, state, input) {
    const model = findModel(catalog, input.model);
    if (!model)
      return fail('not_found', `No such model: ${input.model}.`, {
        path: 'input.model',
      });
    if (model.fields) {
      const field = model.fields.find((f) => f.name === input.field);
      if (!field || field.system) {
        return fail('not_found', `${model.name} has no field ${input.field}.`, {
          path: 'input.field',
        });
      }
    }
    if (!coveredModels(catalog, state.doc).has(model.id)) {
      return fail(
        'not_found',
        `${humanize(model.name)} is not in the app yet; add its recipe or feature first.`,
        { path: 'input.model' },
      );
    }
    const locked = state.doc.recipes.some(
      (id) =>
        catalog.recipes.find((r) => r.id === id)?.options?.[model.id]?.fields?.[
          input.field
        ]?.locked,
    );
    if (locked)
      return fail('failed', `${input.field} is locked by its recipe.`, {
        path: 'input.field',
      });
    const rows = state.doc.policies.map((row) => ({ ...row }));
    const existing = rows.find(
      (r) => r.objectRef === model.id && r.fieldName === input.field,
    );
    const row: CookbookPolicyRow = existing ?? {
      objectRef: model.id,
      fieldName: input.field,
      scopeType: 'app',
    };
    const before = JSON.stringify(row);
    for (const key of ['visibility', 'label', 'help'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (value === null) delete row[key];
      else (row as unknown as Record<string, unknown>)[key] = value;
    }
    if (input.defaultValue !== undefined) {
      if (input.defaultValue === null) delete row.defaultValue;
      else {
        const encoded = JSON.stringify(input.defaultValue);
        if (encoded === undefined) {
          return fail('invalid_input', 'defaultValue is not a JSON value.', {
            path: 'input.defaultValue',
          });
        }
        row.defaultValue = encoded;
      }
    }
    // A row with only its identity says nothing: it is removed, not stored.
    const empty = Object.keys(row).length <= 3;
    if (JSON.stringify(row) === before || (empty && !existing))
      return done(state);
    const rest = rows.filter((r) => r !== existing);
    return done(
      withDoc(state, { ...state.doc, policies: empty ? rest : [...rest, row] }),
      `Updated ${humanize(model.name)} ${input.field}.`,
    );
  },
  set_theme(_catalog, state, input) {
    const doc = withThemePatch(state.doc, input);
    if (
      JSON.stringify(canonical(doc).theme ?? null) ===
      JSON.stringify(state.doc.theme ?? null)
    ) {
      return done(state);
    }
    return done(
      withDoc(state, doc),
      `Theme: ${describeTheme(canonical(doc).theme)}.`,
    );
  },
  reset_theme(_catalog, state) {
    if (!state.doc.theme) return done(state);
    const doc = { ...state.doc };
    delete doc.theme;
    return done(withDoc(state, doc), 'Theme: default.');
  },
  set_name(_catalog, state, input) {
    const doc = { ...state.doc };
    for (const key of ['name', 'description'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      const clean = value?.trim();
      if (clean) doc[key] = clean;
      else delete doc[key];
    }
    if (JSON.stringify(canonical(doc)) === JSON.stringify(state.doc))
      return done(state);
    return done(
      withDoc(state, doc),
      input.name
        ? `Named the app ${input.name.trim()}.`
        : 'Updated the app details.',
    );
  },
  rename_section(catalog, state, { id, label }) {
    const section = navOf(catalog, state.doc).section(id);
    if (!section)
      return fail('not_found', `No menu section "${id}".`, {
        path: 'input.id',
      });
    const layout = withSectionRenamed(state.doc.layout, section, label);
    return JSON.stringify(layout ?? null) ===
      JSON.stringify(state.doc.layout ?? null)
      ? done(state)
      : done(
          withDoc(state, setLayout(state.doc, layout)),
          `Renamed the section to ${label.trim()}.`,
        );
  },
  rename_item(catalog, state, { id, label }) {
    const item = navOf(catalog, state.doc).item(id);
    if (!item)
      return fail('not_found', `No menu entry "${id}".`, { path: 'input.id' });
    const layout = withItemRenamed(state.doc.layout, item, label);
    return JSON.stringify(layout ?? null) ===
      JSON.stringify(state.doc.layout ?? null)
      ? done(state)
      : done(
          withDoc(state, setLayout(state.doc, layout)),
          label
            ? `Renamed the entry to ${label.trim()}.`
            : 'Entry name restored.',
        );
  },
  hide(catalog, state, { id }) {
    const nav = navOf(catalog, state.doc);
    const target = nav.section(id) ?? nav.item(id);
    if (!target)
      return fail('not_found', `No menu section or entry "${id}".`, {
        path: 'input.id',
      });
    if (state.doc.layout?.hidden?.includes(id)) return done(state);
    return done(
      withDoc(
        state,
        setLayout(state.doc, withHidden(state.doc.layout, id, true)),
      ),
      'Hidden.',
    );
  },
  show(catalog, state, { id }) {
    const nav = navOf(catalog, state.doc);
    if (!nav.section(id) && !nav.item(id)) {
      return fail('not_found', `No menu section or entry "${id}".`, {
        path: 'input.id',
      });
    }
    if (!state.doc.layout?.hidden?.includes(id)) return done(state);
    return done(
      withDoc(
        state,
        setLayout(state.doc, withHidden(state.doc.layout, id, false)),
      ),
      'Shown.',
    );
  },
  validate(catalog, state) {
    const diagnostics = diagnose(catalog, state.doc);
    const data: ValidateData = {
      ok: !diagnostics.some((d) => d.severity === 'error'),
      diagnostics,
    };
    return done(state, '', { data });
  },
  export_cookbook(catalog, state, { name }) {
    const fileName = exportFileName(
      name ?? state.doc.name ?? libraryName(catalog, state.applied),
    );
    const data: ExportData = {
      fileName,
      text: serializeCookbook(state.doc),
      cookbook: clone(state.doc),
    };
    return done(state, '', { data });
  },
};

/** Run one validated command over a state. Pure: returns the next state, never mutates. */
export function execute<N extends CommandName>(
  catalog: EngineCatalog,
  state: PlanState,
  name: N,
  input: CommandInputs[N],
): Outcome {
  const handler = handlers[name] as Handler<N> | undefined;
  if (!handler) return fail('unknown_command', `No command "${name}".`);
  return handler(catalog, state, input);
}
