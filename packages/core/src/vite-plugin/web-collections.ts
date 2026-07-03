/**
 * Manifest → web collection selection (single source of truth).
 *
 * The browser client data runtime (`@happyvertical/smrt-web`, #1761) consumes
 * one typed collection definition per API-exposed REST collection. Three
 * emission sites need the SAME selection and field rules, or the emitted
 * runtime values and their declared types drift apart:
 *
 *  - the `\0smrt:web` runtime virtual module (JSON literal — {@link generateWebModule})
 *  - the `@happyvertical/smrt-virt-web` ambient d.ts (vite-plugin)
 *  - the physical `@smrt/web` d.ts (prebuild, for `tsc`-only consumers)
 *
 * All three import {@link selectWebCollectionEntries} from here so the value
 * emission and the type emission can never disagree.
 */

import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { resolveApiActionSet } from './sveltekit-generator.js';

/**
 * Field types that are relationship pseudo-columns rather than persisted
 * public-DTO columns — they never appear on the wire as scalar values.
 */
const RELATIONSHIP_FIELD_TYPES: ReadonlySet<FieldDefinition['type']> = new Set([
  'oneToMany',
  'manyToMany',
]);

/**
 * Field types that describe a relationship to another model. A superset of
 * {@link RELATIONSHIP_FIELD_TYPES}: `foreignKey`/`crossPackageRef` are persisted
 * scalar id columns (they DO appear on the wire), while `oneToMany`/`manyToMany`
 * are pseudo-columns — but all four carry a `related` edge to a sibling model.
 */
const RELATIONSHIP_EDGE_TYPES: ReadonlySet<FieldDefinition['type']> = new Set([
  'foreignKey',
  'crossPackageRef',
  'oneToMany',
  'manyToMany',
]);

/** Informational per-column metadata carried by a collection definition. */
export interface WebFieldDefinition {
  type: FieldDefinition['type'];
  required?: boolean;
  default?: unknown;
}

/** The relationship kinds a web collection edge can describe. */
export type WebRelationshipKind =
  | 'foreignKey'
  | 'crossPackageRef'
  | 'oneToMany'
  | 'manyToMany';

/**
 * One manifest-derived relationship edge from a collection to a sibling REST
 * collection. Consumed by the browser client-data runtime to invalidate
 * dependent collection caches when this collection is mutated (#1761) — the
 * cache-invalidation graph is derived entirely from these edges, never
 * hand-wired. SMRT-owned data: no client-engine type appears here.
 */
export interface WebRelationship {
  /** The declaring field carrying the relationship (e.g. `groupId`, `items`). */
  field: string;
  /** The relationship kind, mirroring the manifest field type. */
  kind: WebRelationshipKind;
  /** REST collection name the edge resolves to (e.g. `ad_groups`). */
  relatedCollection: string;
}

/** One selected REST collection and the model that owns its definition. */
export interface WebCollectionEntry {
  /** REST collection name (pluralized), e.g. `products`. */
  collection: string;
  /** The manifest object that owns this collection's definition. */
  obj: SmartObjectDefinition;
  /** Sorted set of exposed CRUD + custom actions. */
  actions: string[];
}

/** Resolve a manifest object by qualified name or simple class name. */
function findByName(
  manifest: SmartObjectManifest,
  name: string,
): SmartObjectDefinition | undefined {
  return Object.values(manifest.objects).find(
    (candidate) =>
      candidate.qualifiedName === name || candidate.className === name,
  );
}

/**
 * True when `obj` is (transitively) a SmrtCollection subclass. Collection
 * classes describe access, not row shapes, so they never become web
 * collection definitions.
 *
 * NOTE: deliberately stronger than sveltekit-generator's private
 * `isCollectionClass`, which only inspects the direct base / a type argument.
 * A deeper subclass (`SpecialWidgetCollection extends WidgetCollection`)
 * carries no type argument of its own; without walking the extends chain it
 * would be mistaken for a model and claim its base model's REST collection.
 */
function isWebCollectionClass(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
  seen: Set<string> = new Set(),
): boolean {
  // Truthy check (not `!== undefined`) mirrors the scanner's own
  // manifest-generator: a scanner that emits `extendsTypeArg: null` for a
  // non-generic base must not be misread as a collection.
  if (obj.extends === 'SmrtCollection' || !!obj.extendsTypeArg) {
    return true;
  }
  const parentName = obj.extendsQualified || obj.extends;
  if (!parentName || seen.has(parentName)) return false;
  seen.add(parentName);
  const parent = findByName(manifest, parentName);
  return parent ? isWebCollectionClass(manifest, parent, seen) : false;
}

/**
 * True when some ancestor model maps to the SAME REST collection (a shared STI
 * table). The STI base model owns the shared table's single definition.
 */
function isStiChildModel(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): boolean {
  const seen = new Set<string>();
  let parentName = obj.extendsQualified || obj.extends;
  while (parentName && !seen.has(parentName)) {
    seen.add(parentName);
    const parent = findByName(manifest, parentName);
    if (!parent) return false;
    if (parent.collection === obj.collection) return true;
    parentName = parent.extendsQualified || parent.extends;
  }
  return false;
}

/**
 * Select the manifest entries that become web collection definitions: one per
 * REST collection, STI children folding into their base model, collection
 * classes excluded, and only models that expose `list` (a read surface is
 * required to materialize a collection). Uses the canonical
 * {@link resolveApiActionSet} so the exposed-action set matches exactly what
 * the REST/SvelteKit generators actually emit.
 */
export function selectWebCollectionEntries(
  manifest: SmartObjectManifest,
): WebCollectionEntry[] {
  const byCollection = new Map<
    string,
    WebCollectionEntry & { isStiChild: boolean }
  >();

  for (const obj of Object.values(manifest.objects)) {
    if (isWebCollectionClass(manifest, obj)) continue;

    const exposedActions = resolveApiActionSet(obj);
    if (!exposedActions.has('list')) continue;

    const isStiChild = isStiChildModel(manifest, obj);
    const existing = byCollection.get(obj.collection);
    // One definition per REST collection. The STI BASE model owns it: a child
    // only wins while no base has been recorded yet, so the result is
    // independent of declaration / scan order.
    if (existing && !(existing.isStiChild && !isStiChild)) continue;

    byCollection.set(obj.collection, {
      collection: obj.collection,
      obj,
      actions: [...exposedActions].sort(),
      isStiChild,
    });
  }

  return [...byCollection.values()].map(({ collection, obj, actions }) => ({
    collection,
    obj,
    actions,
  }));
}

/**
 * Build the informational per-field metadata for a web collection definition:
 * the persisted public-DTO columns only. Relationship pseudo-fields, STI meta
 * internals, transient (unpersisted) and sensitive (wire-stripped) fields are
 * excluded — they are not columns a client reads back over the REST surface.
 */
export function buildWebFieldDefinitions(
  obj: SmartObjectDefinition,
): Record<string, WebFieldDefinition> {
  const fields: Record<string, WebFieldDefinition> = {};
  for (const [fieldName, field] of Object.entries(obj.fields ?? {})) {
    if (RELATIONSHIP_FIELD_TYPES.has(field.type)) continue;
    if (field.type === 'meta') continue;
    if (field.transient) continue;
    if (field.sensitive) continue;
    fields[fieldName] = {
      type: field.type,
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    };
  }
  return fields;
}

/**
 * Build the manifest-derived relationship edges for a web collection
 * definition (#1761): one entry per relationship field (`foreignKey`,
 * `crossPackageRef`, `oneToMany`, `manyToMany`) whose `related` target resolves
 * to another API-exposed REST collection.
 *
 * These edges drive relationship-derived cache invalidation in the browser
 * client-data runtime: mutating this collection invalidates the caches of the
 * collections named here. The invalidation graph is thus derived entirely from
 * the manifest — no hand-wired cache keys.
 *
 * An edge is SKIPPED (not emitted) when:
 *  - `related` is missing, or
 *  - `related` cannot be resolved to a manifest object (e.g. a cross-package
 *    target not present in this package's manifest), or
 *  - the resolved target is not itself an API-exposed web collection (no read
 *    surface to invalidate — it never appears in {@link selectWebCollectionEntries}).
 *
 * Self-referential edges (a collection related to itself) are kept: the runtime
 * always invalidates the mutated collection anyway, so a self edge is harmless
 * and keeping it avoids a special case.
 */
export function buildWebRelationships(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): WebRelationship[] {
  // The set of REST collections that are actually materialized as web
  // collections. An edge to a model outside this set has no client cache to
  // invalidate, so it is dropped.
  const exposedCollections = new Set(
    selectWebCollectionEntries(manifest).map((entry) => entry.collection),
  );

  const relationships: WebRelationship[] = [];
  const seen = new Set<string>();
  for (const [fieldName, field] of Object.entries(obj.fields ?? {})) {
    if (!RELATIONSHIP_EDGE_TYPES.has(field.type)) continue;
    if (!field.related) continue;

    const target = findByName(manifest, field.related);
    if (!target) continue;
    if (!exposedCollections.has(target.collection)) continue;

    // De-dupe on (field, relatedCollection): a model never declares the same
    // field twice, but guard anyway so the emitted edge list is stable.
    const dedupeKey = `${fieldName} ${target.collection}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    relationships.push({
      field: fieldName,
      kind: field.type as WebRelationshipKind,
      relatedCollection: target.collection,
    });
  }
  return relationships;
}
