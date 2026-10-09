import type { Catalog, CatalogModel } from '../catalog/types.ts';

/**
 * Plumbing vs feature. The Features tab lists models a visitor can add to the
 * menu; most of the ~220 uncovered models are rows that only make sense inside
 * another model (a line item, a link table, a lookup list), so they are hidden
 * unless "Show all" is on. The rules are data-driven where the catalog allows:
 *
 * 1. Extends a junction/association base (`SmrtJunction`, `SmrtJunctionBase`,
 *    `SmrtPolymorphicAssociation`). The catalog keeps `extends` only for
 *    same-package STI parents, so this fires once the generator carries bases.
 * 2. Looks like a link table: two or more foreign keys and at most one other
 *    own field (`GroupMember`, `RolePermission`, `ProfileMetadata`).
 * 3. Child/extension record, by name suffix: `Metafield`, `Metadata`,
 *    `Association`, `LineItem`, `Allocation`, `Revision`, `Attachment`,
 *    `Snapshot`, `Completion`, `Override`, `Alias`. Each appears in the catalog
 *    only as a dependent of a parent model (`InvoiceLineItem`,
 *    `ContentContributionRevision`, `CampaignMetricSnapshot`).
 * 4. Tiny lookup list: a name ending `Status` or `Type` with at most three
 *    non-system fields (`AssetStatus`, `PlaceType`, `ProfileType`). Richer
 *    types such as `ContentContributionType` stay features.
 */
export const JUNCTION_BASES: readonly string[] = [
  'SmrtJunction',
  'SmrtJunctionBase',
  'SmrtPolymorphicAssociation',
];

export const CHILD_SUFFIXES: readonly string[] = [
  'Metafield',
  'Metadata',
  'Association',
  'LineItem',
  'Allocation',
  'Revision',
  'Attachment',
  'Snapshot',
  'Completion',
  'Override',
  'Alias',
];

export const LOOKUP_SUFFIXES: readonly string[] = ['Status', 'Type'];
export const LOOKUP_MAX_FIELDS = 3;
export const LINK_MIN_REFS = 2;
export const LINK_MAX_OTHER_FIELDS = 1;

type ModelShape = Pick<CatalogModel, 'name' | 'fields' | 'extends'>;

const REF_TYPES = new Set(['foreignKey', 'crossPackageRef']);

/** The reason a model is plumbing, or null when it is a feature. */
export function plumbingReason(model: ModelShape): string | null {
  const base = model.extends?.split(':').pop();
  if (base && JUNCTION_BASES.includes(base)) return 'junction';

  const own = model.fields.filter((f) => !f.system);
  const refs = own.filter((f) => REF_TYPES.has(f.type)).length;
  if (refs >= LINK_MIN_REFS && own.length - refs <= LINK_MAX_OTHER_FIELDS) {
    return 'link';
  }
  if (CHILD_SUFFIXES.some((s) => model.name.endsWith(s))) return 'child';
  if (
    own.length <= LOOKUP_MAX_FIELDS &&
    LOOKUP_SUFFIXES.some((s) => model.name.endsWith(s))
  ) {
    return 'lookup';
  }
  return null;
}

export function isPlumbing(model: ModelShape): boolean {
  return plumbingReason(model) !== null;
}

/** Plumbing reasons that make a model a dependent record of what it points at. */
const CHILD_REASONS = new Set(['junction', 'link', 'child']);

/** A field's `related` as a qualified name, given the package it is declared in. */
function qualify(related: string, ownerId: string): string {
  return related.includes(':')
    ? related
    : `${ownerId.slice(0, ownerId.lastIndexOf(':'))}:${related}`;
}

/**
 * The model and its STI ancestors, nearest first (`ProductionOrder` extends
 * `Contract`, whose `ContractLineItem` rows belong to every Contract subtype).
 */
function lineage(byId: Map<string, CatalogModel>, modelId: string): string[] {
  const ids: string[] = [];
  let current = byId.get(modelId);
  while (current && !ids.includes(current.id)) {
    ids.push(current.id);
    current = current.extends
      ? byId.get(qualify(current.extends, current.id))
      : undefined;
  }
  return ids;
}

/**
 * Child records of a model, found from the catalog: models with a foreign key
 * to the model (or to a model it extends) that are line items, allocations,
 * link tables and the like (`plumbingReason` of junction, link or child, never
 * a plain lookup list). They ride along with the model and have no menu entry.
 */
export function childModels(catalog: Catalog, modelId: string): CatalogModel[] {
  const all = catalog.packages.flatMap((p) => p.models);
  const byId = new Map(all.map((m) => [m.id, m]));
  const parents = new Set(lineage(byId, modelId));
  if (!parents.size) return [];
  return all.filter((candidate) => {
    if (parents.has(candidate.id)) return false;
    const reason = plumbingReason(candidate);
    if (!reason || !CHILD_REASONS.has(reason)) return false;
    return candidate.fields.some(
      (f) =>
        REF_TYPES.has(f.type) &&
        f.related &&
        parents.has(qualify(f.related, candidate.id)),
    );
  });
}

/** The slice of a recipe the child lookup reads. */
export interface RecipeScope {
  models: readonly string[];
  nav: readonly { model: string }[];
}

/** A child model and the foreign key that points it at its parent. */
export interface ChildLink {
  model: CatalogModel;
  /** The child's field holding the parent record's id. */
  fk: string;
}

function linkTo(
  candidate: CatalogModel,
  parents: Set<string>,
): ChildLink | undefined {
  const field = candidate.fields.find(
    (f) =>
      REF_TYPES.has(f.type) &&
      f.related &&
      parents.has(qualify(f.related, candidate.id)),
  );
  return field ? { model: candidate, fk: field.name } : undefined;
}

/**
 * The records that live inside a model's own record view. When the model is in
 * a recipe, a child is a model the recipe lists but gives no menu entry (so it
 * has no page of its own) whose foreign key targets the model or a class it
 * extends: `ContractLineItem` under every Contract subtype, `InvoiceLineItem`
 * and `PaymentAllocation` under Invoice, `JournalEntry` under Journal. A model
 * in no recipe (a Feature) falls back to {@link childModels}.
 */
export function childLinks(
  catalog: Catalog,
  recipes: readonly RecipeScope[],
  modelId: string,
): ChildLink[] {
  const all = catalog.packages.flatMap((p) => p.models);
  const byId = new Map(all.map((m) => [m.id, m]));
  const parents = new Set(lineage(byId, modelId));
  if (!parents.size) return [];
  const scoped = recipes.filter((r) => r.models.includes(modelId));
  if (!scoped.length) {
    return childModels(catalog, modelId).flatMap((m) => {
      const link = linkTo(m, parents);
      return link ? [link] : [];
    });
  }
  const found = new Map<string, ChildLink>();
  for (const recipe of scoped) {
    const navIds = new Set(recipe.nav.map((e) => e.model));
    for (const id of recipe.models) {
      const candidate = byId.get(id);
      if (!candidate || navIds.has(id) || parents.has(id) || found.has(id)) {
        continue;
      }
      const link = linkTo(candidate, parents);
      if (link) found.set(id, link);
    }
  }
  return [...found.values()];
}

/** Does any recipe give the model a menu entry of its own? */
export function hasNavPage(
  recipes: readonly RecipeScope[],
  modelId: string,
): boolean {
  return recipes.some((r) => r.nav.some((e) => e.model === modelId));
}

/**
 * Title of a child table: the child's name without the parent's prefix,
 * pluralised ("ContractLineItem" under Agreement/Contract is "Line items").
 */
export function childTitle(
  childName: string,
  parentNames: readonly string[],
): string {
  let name = childName;
  for (const parent of parentNames) {
    if (name.length > parent.length && name.startsWith(parent)) {
      name = name.slice(parent.length);
      break;
    }
  }
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const plural = /[^aeiou]y$/.test(spaced)
    ? `${spaced.slice(0, -1)}ies`
    : /(s|x|ch|sh)$/.test(spaced)
      ? `${spaced}es`
      : `${spaced}s`;
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

/** Names of the model and its STI ancestors, for {@link childTitle}. */
export function lineageNames(catalog: Catalog, modelId: string): string[] {
  const all = catalog.packages.flatMap((p) => p.models);
  const byId = new Map(all.map((m) => [m.id, m]));
  return lineage(byId, modelId).flatMap((id) => {
    const m = byId.get(id);
    return m ? [m.name] : [];
  });
}
