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
 * emission and the type emission can never disagree. The per-collection SHAPE
 * (name/className/endpoint/idField/actions/fields/relationships) is built by the
 * ONE {@link buildWebCollectionDefinition}, shared by the runtime emission AND
 * the #1764 {@link computeWebManifestHash} shape digest — so the emitted shape
 * and the hashed shape can never drift (a drift would let the hash under-cover a
 * change → stale client caches).
 */

import { createHash } from 'node:crypto';
import {
  buildToolDescriptors,
  type ToolDescriptor,
  type ToolFieldMeta,
} from '../generators/tool-schema.js';
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
 * Normalize a relationship field's `related` value to a resolvable class name.
 *
 * Thunk forward-ref decorators — `@foreignKey(() => Scene)`, used heavily in
 * video/voice for models that reference a class declared later — serialize as
 * the RAW arrow-function source string `"() => Scene"` in the manifest, which
 * neither `className` nor `qualifiedName` matches. Extract the target class
 * name from the thunk so the edge resolves. Plain (`"Scene"`) and qualified
 * (`"@happyvertical/smrt-assets:Asset"`) forms contain no `=>` and pass through
 * untouched — the qualified `:` separator is preserved.
 *
 * Kept local to the relationship-edge path on purpose: extends-chain resolution
 * never sees a thunk, so `findByName` and the scanner stay unchanged.
 */
function normalizeRelatedName(related: string): string {
  const thunk = related.match(/=>\s*([A-Za-z_$][\w$]*)/);
  return thunk ? thunk[1] : related.trim();
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
  if (obj.extends === 'SmrtCollection' || obj.extendsTypeArg) {
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
 * Select one entry per REST collection whose exposed action set satisfies
 * `qualifies` — STI children folding into their base model, collection classes
 * excluded. Uses the canonical {@link resolveApiActionSet} so the exposed-action
 * set matches exactly what the REST/SvelteKit generators actually emit. Shared
 * by {@link selectWebCollectionEntries} (list-qualified — materializable
 * collections) and {@link selectWebEtagSaltEntries} (get-OR-list — every model
 * with a read route the ETag salt must cover).
 */
function selectEntriesQualifiedBy(
  manifest: SmartObjectManifest,
  qualifies: (actions: ReadonlySet<string>) => boolean,
): WebCollectionEntry[] {
  const byCollection = new Map<
    string,
    WebCollectionEntry & { isStiChild: boolean }
  >();

  for (const obj of Object.values(manifest.objects)) {
    if (isWebCollectionClass(manifest, obj)) continue;

    const exposedActions = resolveApiActionSet(obj);
    if (!qualifies(exposedActions)) continue;

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
 * Select the manifest entries that become web collection definitions: one per
 * REST collection, STI children folding into their base model, collection
 * classes excluded, and only models that expose `list` (a read surface is
 * required to MATERIALIZE a client collection — that is what persists).
 */
export function selectWebCollectionEntries(
  manifest: SmartObjectManifest,
): WebCollectionEntry[] {
  return selectEntriesQualifiedBy(manifest, (actions) => actions.has('list'));
}

/**
 * Select the entries the ETag salt (#1764) must cover: every api-exposed model
 * with a GENERATED READ ROUTE — `list` OR `get`. Broader than
 * {@link selectWebCollectionEntries} on purpose: a get-only model
 * (`api: { include: ['get'] }`) has no materializable client collection (so it
 * never persists), but its generated GET route IS salted, so a shape-only change
 * to it must still change the salt — otherwise a client holding the old concrete
 * ETag would get a zero-query 304 after a shape-only deploy (the #1765 gap the
 * salt closes). Not exported: only {@link computeWebManifestHash} consumes it.
 */
function selectWebEtagSaltEntries(
  manifest: SmartObjectManifest,
): WebCollectionEntry[] {
  return selectEntriesQualifiedBy(
    manifest,
    (actions) => actions.has('list') || actions.has('get'),
  );
}

/**
 * Build the per-collection web-collection definition literal — the SINGLE
 * source of truth for the shape emitted by {@link generateWebModule} and hashed
 * by {@link computeWebManifestHash}. Building it in ONE place is a
 * cache-coherency requirement: if the emitted shape and the hashed shape were
 * built independently, adding a field to one and not the other would let the
 * hash silently UNDER-cover a shape change, so persisted caches would not drop
 * and stale rows would hydrate into new code.
 */
export function buildWebCollectionDefinition(
  entry: WebCollectionEntry,
  manifest: SmartObjectManifest,
): {
  name: string;
  className: string;
  endpoint: string;
  idField: string;
  actions: string[];
  fields: Record<string, WebFieldDefinition>;
  relationships: WebRelationship[];
} {
  return {
    name: entry.collection,
    className: entry.obj.className,
    endpoint: `/${entry.collection}`,
    idField: 'id',
    actions: entry.actions,
    fields: buildWebFieldDefinitions(entry.obj),
    relationships: buildWebRelationships(entry.obj, manifest),
  };
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

    // Normalize first: `@foreignKey(() => Scene)` thunks serialize as the raw
    // "() => Scene" source, which findByName cannot match on its own.
    const target = findByName(manifest, normalizeRelatedName(field.related));
    if (!target) continue;
    if (!exposedCollections.has(target.collection)) continue;

    // De-dupe on (field, relatedCollection): a model never declares the same
    // field twice, but guard anyway so the emitted edge list is stable.
    const dedupeKey = `${fieldName}:${target.collection}`;
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

/**
 * Build the WebMCP / MCP tool descriptors for a web collection (#1812): one
 * descriptor per exposed action, over the SAME public-DTO fields the definition
 * already exposes (`buildWebFieldDefinitions`). The tool ids match the Node MCP
 * surface (`<class>_<action>`), so a page's WebMCP tools and its MCP-server
 * tools share one vocabulary.
 *
 * Deliberately NOT part of {@link buildWebCollectionDefinition}: descriptors are
 * layered onto the emitted value by {@link generateWebModule} instead, so the
 * #1764 {@link computeWebManifestHash} shape digest keeps hashing ONLY the row
 * shape. That is safe because a descriptor is a pure function of
 * className/actions/fields — all already in the hash — so excluding it never
 * lets the digest under-cover a real shape change.
 */
export function buildWebToolDescriptors(
  entry: WebCollectionEntry,
): ToolDescriptor[] {
  const webFields = buildWebFieldDefinitions(entry.obj);
  const fields: ToolFieldMeta[] = Object.entries(webFields).map(
    ([name, def]) => ({
      name,
      type: def.type,
      ...(def.required !== undefined ? { required: def.required } : {}),
      ...(def.default !== undefined ? { default: def.default } : {}),
    }),
  );
  return buildToolDescriptors({
    className: entry.obj.className,
    fields,
    actions: entry.actions,
  });
}

/**
 * Recursively sort object keys so structurally-equal values serialize to the
 * SAME JSON regardless of insertion order. Arrays keep their order (order is
 * semantic for `actions`/`relationships`); objects are rebuilt with keys sorted.
 * Required for {@link computeWebManifestHash} to be replica-stable: two builds
 * that produce the same schema but visit the manifest in a different order (map
 * insertion, scan order) must still hash identically, which a plain
 * `JSON.stringify` of insertion-ordered objects would NOT guarantee.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * A deterministic, replica-stable digest of the web-collection SHAPE (#1764).
 *
 * The hash covers exactly the thing whose change means either old persisted
 * client rows may mis-hydrate OR a stale read ETag would still 304: the same
 * per-collection definition shape {@link generateWebModule} emits — name,
 * className, endpoint, idField, actions, fields, relationships — built via the
 * SHARED {@link buildWebCollectionDefinition} so the hash can never disagree
 * with what is actually shipped. The shape is CANONICALIZED (keys recursively
 * sorted; see {@link canonicalize}) before hashing, so the same schema always
 * yields the same digest across builds and replicas regardless of manifest
 * iteration order.
 *
 * SCOPE — get-OR-list (broader than materializable collections). Covered by
 * {@link selectWebEtagSaltEntries}, so it includes GET-ONLY models too: those do
 * not persist (no materializable collection), but their generated GET route IS
 * salted with this hash, so a shape-only change to a get-only model must change
 * it or a client holding the old concrete ETag gets a zero-query 304 after a
 * shape-only deploy (the #1765 gap the salt closes). The two consumers both use
 * this one value, so it stays identical between them:
 *  - `@happyvertical/smrt-web` persistence (#1764) folds it into the durable
 *    namespace, so a contract-changing deploy lands on a fresh namespace and old
 *    rows are never found (dropped, not mis-hydrated). Including get-only models
 *    here is harmless over-invalidation — only list-materializable collections
 *    ever hold a persisted snapshot.
 *  - the generated read ETag (#1765 salt, #1764) folds it in so a shape-only
 *    deploy (no table write) busts every read validator, get-only routes too.
 *
 * Truncated to the first 16 base64url chars: 96 bits is far more than enough to
 * make an accidental shape collision negligible, and a short constant keeps the
 * emitted module and every persistence key compact.
 */
export function computeWebManifestHash(manifest: SmartObjectManifest): string {
  const definitions: Record<string, unknown> = {};
  for (const entry of selectWebEtagSaltEntries(manifest)) {
    definitions[entry.collection] = buildWebCollectionDefinition(
      entry,
      manifest,
    );
  }
  const canonicalJson = JSON.stringify(canonicalize(definitions));
  return createHash('sha256')
    .update(canonicalJson)
    .digest('base64url')
    .slice(0, 16);
}
