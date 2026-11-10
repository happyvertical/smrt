import { exposedModels, getModelByQualifiedName } from '../catalog/index.ts';
import type { Catalog, CatalogPackage } from '../catalog/types.ts';
import { humanize } from '../data/format.ts';
import { childModels, isPlumbing } from './plumbing.ts';
import { entryDescription, navItemId } from './sections.ts';
import type { Recipe, RecipeNavSection } from './types.ts';

/**
 * Features: exposed catalog models no recipe covers, which a visitor can add
 * one at a time (the Planner's Features tab). They sit in the cookbook's
 * `features` and in one suggested nav section, after the recipes' sections.
 */
export const FEATURE_SECTION: RecipeNavSection = {
  id: 'more',
  label: 'More',
  icon: 'layers',
  description: 'Extra records you added one at a time.',
};

/** Icon of a feature entry: they are loose records, so one generic glyph. */
export const FEATURE_ENTRY_ICON = 'fileText';

export interface FeatureEntry {
  /** `@scope/pkg:Class` qualified name, as stored in the cookbook. */
  id: string;
  name: string;
  /** Humanized model name, e.g. `Purchase Order`. */
  label: string;
  /** Catalog package id, for `/m/<package>/<model>/` and `/packages/<id>/`. */
  packageId: string;
  /** The model's description, else a field count (see `featureSummary`). */
  description: string;
  /** `description` is the model's own, not the field-count fallback. */
  described: boolean;
  /** Link tables, child records and tiny lookups; hidden unless "Show all". */
  plumbing: boolean;
  fieldNames: string[];
  /** Humanized names of the child models that come along (line items). */
  includes: string[];
}

/** One line for a row: the model's description, else how many fields it has. */
function describeModel(model: CatalogPackage['models'][number]): string {
  const description = model.description?.trim();
  if (description) return description.split(/(?<=[.!?])\s/)[0] ?? description;
  const count = model.fields.filter((f) => !f.system).length;
  return `${count} ${count === 1 ? 'field' : 'fields'}`;
}

/** Every exposed model that no recipe lists in `models`, by package then name. */
export function featureEntries(
  catalog: Catalog,
  recipes: readonly Recipe[],
): FeatureEntry[] {
  const covered = new Set(recipes.flatMap((recipe) => recipe.models));
  return catalog.packages.flatMap((pkg) =>
    exposedModels(pkg)
      .filter((model) => !covered.has(model.id))
      .map((model) => ({
        id: model.id,
        name: model.name,
        label: humanize(model.name),
        packageId: pkg.id,
        description: describeModel(model),
        described: Boolean(model.description?.trim()),
        plumbing: isPlumbing(model),
        fieldNames: model.fields.map((f) => f.name),
        includes: childModels(catalog, model.id).map((c) => humanize(c.name)),
      })),
  );
}

/** The row's second line: the description, else "Package · N fields". */
export function featureSummary(entry: FeatureEntry): string {
  return entry.described
    ? entry.description
    : `${humanize(entry.packageId)} · ${entry.description}`;
}

/** Entries to list: features only, or everything when `showAll`. */
export function visibleFeatures(
  entries: readonly FeatureEntry[],
  showAll: boolean,
): FeatureEntry[] {
  return showAll ? [...entries] : entries.filter((e) => !e.plumbing);
}

/** Packages that have at least one of the entries, in catalog order. */
export function featurePackages(entries: readonly FeatureEntry[]): string[] {
  return [...new Set(entries.map((e) => e.packageId))];
}

/**
 * Entries matching every search term (model name, description, package, field
 * names; case-insensitive) and, when given, one package.
 */
export function filterFeatures(
  entries: readonly FeatureEntry[],
  query: string,
  packageId?: string | null,
): FeatureEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (packageId && entry.packageId !== packageId) return false;
    if (!terms.length) return true;
    const haystack = [
      entry.name,
      entry.label,
      entry.description,
      entry.packageId,
      ...entry.fieldNames,
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface FeatureNavItem {
  /** Stable layout id: `item:<package>:<Model>`. */
  id: string;
  packageId: string;
  modelName: string;
  label: string;
  /** Shell icon name. */
  icon: string;
  description: string;
}

/** Nav items for the added feature models; unknown or internal ones are dropped. */
export function featureNavItems(features: readonly string[]): FeatureNavItem[] {
  return features.flatMap((qualified) => {
    const found = getModelByQualifiedName(qualified);
    if (!found?.model.exposed) return [];
    return [
      {
        id: navItemId(found.pkg.id, found.model.name),
        packageId: found.pkg.id,
        modelName: found.model.name,
        label: humanize(found.model.name),
        icon: FEATURE_ENTRY_ICON,
        description: entryDescription(undefined, found.model),
      },
    ];
  });
}
