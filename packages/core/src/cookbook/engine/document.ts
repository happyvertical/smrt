import type {
  Cookbook,
  CookbookPolicyRow,
  CookbookTheme,
} from '@happyvertical/smrt-types';
import {
  COOKBOOK_SCHEMA_URL,
  COOKBOOK_VERSION,
  validateCookbook,
} from '../validate.js';
import {
  COMMERCE_SETTING_TARGETS,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_PRESET,
  DEFAULT_THEME_PRESETS,
} from './defaults.js';
import { buildNav, findModel } from './nav.js';
import type {
  Diagnostic,
  EngineCatalog,
  EngineRecipe,
  RecipeChanges,
  SettingTargets,
} from './types.js';

/*
 * Pure document rules: every function takes a cookbook and returns a new one.
 * The engine holds a document and calls these; nothing here keeps state.
 */

export const clone = <T>(value: T): T =>
  value === undefined ? value : structuredClone(value);

export const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const emptyCookbook = (): Cookbook => ({
  $schema: COOKBOOK_SCHEMA_URL,
  version: COOKBOOK_VERSION,
  recipes: [],
  features: [],
  policies: [],
});

/** Does the document hold nothing yet (so replacing it needs no say-so)? */
export function isEmptyCookbook(doc: Cookbook): boolean {
  return (
    !doc.recipes.length &&
    !doc.features.length &&
    !doc.policies.length &&
    !Object.keys(doc.exposure ?? {}).length &&
    !doc.layout &&
    !doc.theme &&
    !Object.keys(doc.overviews ?? {}).length
  );
}

const sortedUnique = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * The document in its stable shape: sorted ids, sorted policies, empty optional
 * sections absent, key order fixed. Unknown top-level keys are kept (additive
 * fields in v1). Two engines given the same commands export identical text.
 */
export function canonical(doc: Cookbook): Cookbook {
  const known = new Set([
    '$schema',
    'version',
    'name',
    'description',
    'recipes',
    'features',
    'policies',
    'exposure',
    'layout',
    'theme',
    'overviews',
  ]);
  const out: Cookbook = {
    $schema: COOKBOOK_SCHEMA_URL,
    version: COOKBOOK_VERSION,
    ...(doc.name ? { name: doc.name } : {}),
    ...(doc.description ? { description: doc.description } : {}),
    recipes: sortedUnique(doc.recipes),
    features: sortedUnique(doc.features),
    policies: [...doc.policies]
      .sort(
        (a, b) =>
          a.objectRef.localeCompare(b.objectRef) ||
          a.fieldName.localeCompare(b.fieldName),
      )
      .map((row) => ({ ...row })),
  };
  const exposure = Object.fromEntries(
    Object.keys(doc.exposure ?? {})
      .sort()
      .filter((ref) => doc.exposure?.[ref]?.length)
      .map((ref) => [ref, [...(doc.exposure?.[ref] ?? [])].sort()]),
  );
  if (Object.keys(exposure).length) {
    out.exposure = exposure as NonNullable<Cookbook['exposure']>;
  }
  if (doc.layout) out.layout = clone(doc.layout);
  const theme = compactTheme(doc.theme);
  if (theme) out.theme = theme;
  const overviews = Object.entries(doc.overviews ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (overviews.length) {
    out.overviews = Object.fromEntries(
      overviews.map(([id, value]) => [id, clone(value)]),
    );
  }
  for (const [key, value] of Object.entries(doc)) {
    if (!known.has(key))
      (out as unknown as Record<string, unknown>)[key] = clone(value);
  }
  return out;
}

// ---- recipes ---------------------------------------------------------------

const recipeMap = (catalog: EngineCatalog) =>
  new Map(catalog.recipes.map((r) => [r.id, r]));

/** `ids` plus everything they transitively require, as a sorted set. */
export function withRequirements(
  ids: Iterable<string>,
  recipes: ReadonlyMap<string, EngineRecipe>,
): string[] {
  const result = new Set<string>();
  const visit = (id: string) => {
    const recipe = recipes.get(id);
    if (!recipe || result.has(id)) return;
    result.add(id);
    for (const required of recipe.requires) visit(required);
  };
  for (const id of ids) visit(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...result]) {
      for (const alternatives of recipes.get(id)?.requiresAny ?? []) {
        if (alternatives.some((alt) => result.has(alt))) continue;
        const first = alternatives.find((alt) => recipes.has(alt));
        if (first) {
          visit(first);
          changed = true;
        }
      }
    }
  }
  return sortedUnique(result);
}

/** Models the added recipes and features cover. */
export function coveredModels(
  catalog: EngineCatalog,
  doc: Cookbook,
): Set<string> {
  const byId = recipeMap(catalog);
  return new Set([
    ...doc.recipes.flatMap((id) => byId.get(id)?.models ?? []),
    ...doc.features,
  ]);
}

export function settingTargets(catalog: EngineCatalog): SettingTargets {
  return catalog.settingTargets ?? COMMERCE_SETTING_TARGETS;
}

function isSettingRow(catalog: EngineCatalog, row: CookbookPolicyRow): boolean {
  return Object.values(settingTargets(catalog)).some((targets) =>
    targets.some((t) => t.model === row.objectRef && t.field === row.fieldName),
  );
}

/** Drop options for models nothing covers any more (settings rows stay). */
export function prune(catalog: EngineCatalog, doc: Cookbook): Cookbook {
  const covered = coveredModels(catalog, doc);
  const next: Cookbook = {
    ...doc,
    policies: doc.policies.filter(
      (r) => covered.has(r.objectRef) || isSettingRow(catalog, r),
    ),
  };
  if (doc.exposure) {
    const exposure = Object.fromEntries(
      Object.entries(doc.exposure).filter(([ref]) => covered.has(ref)),
    );
    if (Object.keys(exposure).length) next.exposure = exposure;
    else delete next.exposure;
  }
  return next;
}

const knownRecipeIds = (catalog: EngineCatalog, doc: Cookbook) => {
  const byId = recipeMap(catalog);
  return doc.recipes.filter((id) => byId.has(id));
};

const unknownRecipeIds = (catalog: EngineCatalog, doc: Cookbook) => {
  const byId = recipeMap(catalog);
  return doc.recipes.filter((id) => !byId.has(id));
};

function diff(
  before: string[],
  after: string[],
): Pick<RecipeChanges, 'added' | 'removed'> {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((id) => !b.has(id)),
    removed: before.filter((id) => !a.has(id)),
  };
}

export function withRecipesAdded(
  catalog: EngineCatalog,
  doc: Cookbook,
  ids: readonly string[],
): { doc: Cookbook; changes: RecipeChanges } {
  const byId = recipeMap(catalog);
  const before = knownRecipeIds(catalog, doc);
  const known = withRequirements([...before, ...ids], byId);
  const next = {
    ...doc,
    recipes: sortedUnique([...known, ...unknownRecipeIds(catalog, doc)]),
  };
  return { doc: next, changes: { ...diff(before, known), kept: [] } };
}

export function withRecipesRemoved(
  catalog: EngineCatalog,
  doc: Cookbook,
  ids: readonly string[],
): { doc: Cookbook; changes: RecipeChanges } {
  const byId = recipeMap(catalog);
  const before = knownRecipeIds(catalog, doc);
  const removing = new Set(ids);
  const known = withRequirements(
    before.filter((id) => !removing.has(id)),
    byId,
  );
  const next = prune(catalog, {
    ...doc,
    recipes: sortedUnique([...known, ...unknownRecipeIds(catalog, doc)]),
  });
  const { added, removed } = diff(before, known);
  return {
    doc: next,
    changes: {
      added,
      removed,
      kept: ids.filter((id) => known.includes(id) && before.includes(id)),
    },
  };
}

export function withFeaturesChanged(
  catalog: EngineCatalog,
  doc: Cookbook,
  ids: readonly string[],
  on: boolean,
): { doc: Cookbook; changes: RecipeChanges } {
  const set = new Set(doc.features);
  for (const id of ids) {
    if (on) set.add(id);
    else set.delete(id);
  }
  const features = [...set].sort();
  let next: Cookbook = { ...doc, features };
  if (!on) next = prune(catalog, next);
  return {
    doc: next,
    changes: { ...diff(doc.features, features), kept: [] },
  };
}

export const mergeChanges = (
  a: RecipeChanges,
  b: RecipeChanges,
): RecipeChanges => ({
  added: [...a.added, ...b.added],
  removed: [...a.removed, ...b.removed],
  kept: [...a.kept, ...b.kept],
});

// ---- settings --------------------------------------------------------------

export interface AppSettings {
  currency: string;
  /** A fraction: 0.0825 is 8.25%. */
  taxRate: number;
  paymentTerms: string;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  currency: 'USD',
  taxRate: 0,
  paymentTerms: '',
};

const SETTING_KEYS = ['currency', 'taxRate', 'paymentTerms'] as const;

function rowValue(row: CookbookPolicyRow | undefined): unknown {
  if (row?.defaultValue === undefined || row.defaultValue === null)
    return undefined;
  try {
    return JSON.parse(row.defaultValue);
  } catch {
    return undefined;
  }
}

const findRow = (
  policies: readonly CookbookPolicyRow[],
  model: string,
  field: string,
) =>
  policies.find(
    (r) =>
      r.scopeType === 'app' && r.objectRef === model && r.fieldName === field,
  );

/** The app's settings: the first stored row of each, else the defaults. */
export function readSettings(
  catalog: EngineCatalog,
  doc: Cookbook,
): AppSettings {
  const targets = settingTargets(catalog);
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  const first = (key: keyof AppSettings, type: 'number' | 'string') => {
    for (const { model, field } of targets[key]) {
      const value = rowValue(findRow(doc.policies, model, field));
      if (typeof value === type) return value;
    }
    return undefined;
  };
  const currency = first('currency', 'string');
  const taxRate = first('taxRate', 'number');
  const paymentTerms = first('paymentTerms', 'string');
  if (typeof currency === 'string') out.currency = currency;
  if (typeof taxRate === 'number') out.taxRate = taxRate;
  if (typeof paymentTerms === 'string') out.paymentTerms = paymentTerms;
  return out;
}

const isUnset = (v: unknown) => v === undefined || v === null || v === '';

function seedDefault(
  catalog: EngineCatalog,
  doc: Cookbook,
  modelId: string,
  field: string,
): unknown {
  const byId = recipeMap(catalog);
  for (const id of doc.recipes) {
    const hint = byId.get(id)?.options?.[modelId]?.fields?.[field];
    if (hint && 'default' in hint) return hint.default;
  }
  return findModel(catalog, modelId)?.fields?.find((f) => f.name === field)
    ?.default;
}

/**
 * The document with the settings written as app-scope policy rows. A row is
 * written for every model a setting covers (covered or not, so a recipe added
 * later picks it up) and only where the value differs from what the model
 * starts as; otherwise the row's default is removed. Other row keys are kept.
 */
export function writeSettings(
  catalog: EngineCatalog,
  doc: Cookbook,
  settings: AppSettings,
): Cookbook {
  const targets = settingTargets(catalog);
  let policies = doc.policies.map((row) => ({ ...row }));
  for (const key of SETTING_KEYS) {
    const raw = settings[key];
    const value =
      key === 'paymentTerms'
        ? String(raw).trim()
        : key === 'currency'
          ? String(raw).trim().toUpperCase()
          : raw;
    for (const { model, field } of targets[key]) {
      const seed = seedDefault(catalog, doc, model, field);
      const wanted =
        !isUnset(value) &&
        !(!isUnset(seed) && seed === value) &&
        !(isUnset(seed) && key === 'taxRate' && value === 0);
      const existing = findRow(policies, model, field);
      if (wanted) {
        const encoded = JSON.stringify(value);
        if (existing) existing.defaultValue = encoded;
        else
          policies.push({
            objectRef: model,
            fieldName: field,
            scopeType: 'app',
            defaultValue: encoded,
          });
      } else if (existing) {
        delete existing.defaultValue;
        if (Object.keys(existing).length <= 3) {
          policies = policies.filter((r) => r !== existing);
        }
      }
    }
  }
  return { ...doc, policies };
}

// ---- theme -----------------------------------------------------------------

export function compactTheme(
  theme: CookbookTheme | undefined,
): CookbookTheme | undefined {
  if (!theme) return undefined;
  const out: CookbookTheme = {};
  if (theme.preset) out.preset = theme.preset;
  if (theme.colorScheme) out.colorScheme = theme.colorScheme;
  if (theme.custom) out.custom = { ...theme.custom };
  return Object.keys(out).length ? out : undefined;
}

export function describeTheme(theme: CookbookTheme | undefined): string {
  const scheme = theme?.colorScheme ?? DEFAULT_COLOR_SCHEME;
  const base = theme?.custom
    ? `brand colour ${theme.custom.primary}`
    : (theme?.preset ?? DEFAULT_PRESET);
  return scheme === 'system' ? base : `${base}, ${scheme}`;
}

/** A preset replaces a brand colour; a brand colour sits on the preset; the scheme is kept. */
export function withThemePatch(
  doc: Cookbook,
  patch: {
    preset?: string;
    primary?: string;
    colorScheme?: CookbookTheme['colorScheme'];
  },
): Cookbook {
  const next: CookbookTheme = { ...(doc.theme ?? {}) };
  if (patch.preset) {
    next.preset = patch.preset;
    delete next.custom;
  }
  if (patch.primary) {
    next.custom = {
      primary: patch.primary.toLowerCase(),
      ...(doc.theme?.custom?.fontFamily
        ? { fontFamily: doc.theme.custom.fontFamily }
        : {}),
    };
  }
  if (patch.colorScheme) next.colorScheme = patch.colorScheme;
  const theme = compactTheme(next);
  const out = { ...doc };
  if (theme) out.theme = theme;
  else delete out.theme;
  return out;
}

// ---- validation ------------------------------------------------------------

/**
 * Check a document against the catalog. Structural errors come from
 * `validateCookbook`; the rest need the catalog: unknown ids, unmet `requires`,
 * policy targets nothing covers, layout ids the menu does not have, theme
 * values. Errors mean the app would not build as written; warnings mean
 * something is carried but unused.
 */
export function diagnose(
  catalog: EngineCatalog,
  input: Cookbook,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (
    severity: Diagnostic['severity'],
    code: string,
    path: string,
    message: string,
  ) => out.push({ severity, code, path, message });

  const structural = validateCookbook(input);
  if (!structural.ok) {
    for (const message of structural.errors) {
      add('error', 'invalid_document', '', message);
    }
    return out;
  }
  for (const message of structural.warnings)
    add('warning', 'migrated', '', message);
  const doc = structural.cookbook;
  const byId = recipeMap(catalog);

  for (const [i, id] of doc.recipes.entries()) {
    if (!byId.has(id))
      add(
        'error',
        'unknown_recipe',
        `recipes[${i}]`,
        `Unknown recipe "${id}".`,
      );
  }
  const closure = new Set(withRequirements(doc.recipes, byId));
  for (const id of closure) {
    if (!doc.recipes.includes(id)) {
      add(
        'error',
        'missing_requirement',
        'recipes',
        `A recipe needs "${id}", which is not listed.`,
      );
    }
  }
  for (const [i, id] of doc.features.entries()) {
    const model = findModel(catalog, id);
    if (!model)
      add('error', 'unknown_model', `features[${i}]`, `Unknown model "${id}".`);
    else if (model.exposed === false) {
      add(
        'error',
        'model_not_exposed',
        `features[${i}]`,
        `${id} cannot be added as a feature.`,
      );
    }
  }
  const covered = coveredModels(catalog, doc);
  for (const [i, row] of doc.policies.entries()) {
    const at = `policies[${i}]`;
    const model = findModel(catalog, row.objectRef);
    if (!model) {
      add(
        'error',
        'unknown_model',
        `${at}.objectRef`,
        `Unknown model "${row.objectRef}".`,
      );
      continue;
    }
    if (
      model.fields &&
      !model.fields.some((f) => f.name === row.fieldName && !f.system)
    ) {
      add(
        'error',
        'unknown_field',
        `${at}.fieldName`,
        `${model.name} has no field "${row.fieldName}".`,
      );
    }
    if (!covered.has(row.objectRef) && !isSettingRow(catalog, row)) {
      add(
        'warning',
        'policy_not_covered',
        at,
        `${model.name} is not in the app, so this row has no effect.`,
      );
    }
  }
  for (const ref of Object.keys(doc.exposure ?? {})) {
    if (!findModel(catalog, ref)) {
      add(
        'error',
        'unknown_model',
        `exposure.${ref}`,
        `Unknown model "${ref}".`,
      );
    }
  }
  const presets = catalog.themePresets ?? DEFAULT_THEME_PRESETS;
  if (doc.theme?.preset && !presets.includes(doc.theme.preset)) {
    add(
      'error',
      'unknown_preset',
      'theme.preset',
      `Unknown theme preset "${doc.theme.preset}".`,
    );
  }
  if (doc.layout) {
    const nav = buildNav(catalog, { ...doc, layout: undefined });
    const ids = new Set([
      ...nav.flatMap((s) => [s.id, ...s.items.map((i) => i.id)]),
      ...(doc.layout.customSections ?? []).map((c) => c.id),
    ]);
    const refs: [string, string][] = [
      ...(doc.layout.hidden ?? []).map((id, i): [string, string] => [
        `layout.hidden[${i}]`,
        id,
      ]),
      ...Object.keys(doc.layout.sections ?? {}).map((id): [string, string] => [
        `layout.sections.${id}`,
        id,
      ]),
      ...Object.keys(doc.layout.items ?? {}).map((id): [string, string] => [
        `layout.items.${id}`,
        id,
      ]),
      ...(doc.layout.sectionOrder ?? []).map((id, i): [string, string] => [
        `layout.sectionOrder[${i}]`,
        id,
      ]),
    ];
    for (const [path, id] of refs) {
      if (!ids.has(id)) {
        add(
          'warning',
          'unknown_layout_id',
          path,
          `The menu has no section or entry "${id}".`,
        );
      }
    }
  }
  return out;
}
