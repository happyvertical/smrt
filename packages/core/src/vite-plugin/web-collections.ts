/**
 * Manifest → web collection selection (single source of truth).
 *
 * The browser client data runtime (`@happyvertical/smrt-web`, #1761) consumes
 * one typed collection definition per API-exposed REST collection. Four
 * co-managed emission surfaces need the SAME selection and field rules, or the
 * emitted runtime values and their declared types drift apart:
 *
 *  - the `\0smrt:web` runtime virtual module (JSON literal — {@link generateWebModule})
 *  - the `@happyvertical/smrt-virt-web` ambient d.ts (vite-plugin)
 *  - the physical `@smrt/web` d.ts (prebuild, for `tsc`-only consumers)
 *  - the dependency-free type mirror in `@happyvertical/smrt-web`
 *
 * The three generated sites import {@link selectWebCollectionEntries} from
 * here so the value emission and the type emission can never disagree. The hand-written mirror
 * is deliberately smrt-dependency-free, so its copy cannot import these types;
 * keep it textually in sync when the shape here changes. The per-collection SHAPE
 * (name/objectRef/className/endpoint/idField/actions/fields/relationships) is built by the
 * ONE {@link buildWebCollectionDefinition}, shared by the runtime emission AND
 * the #1764 {@link computeWebManifestHash} shape digest — so the emitted shape
 * and the hashed shape can never drift (a drift would let the hash under-cover a
 * change → stale client caches).
 */

import { createHash } from 'node:crypto';
import {
  customActionParameterInputName,
  resolveCustomActionMetadata,
} from '../generators/custom-action.js';
import {
  buildToolDescriptors,
  isCrudAction,
  type ToolDescriptor,
  type ToolFieldMeta,
  type ToolIdType,
  type ToolRouteDescriptor,
} from '../generators/tool-schema.js';
import type {
  FieldDefinition,
  FieldUIHints,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  resolveApiActionRouteConfig,
  resolveApiActionSet,
} from './sveltekit-generator.js';

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

/**
 * The field types that actually reach an emitted web collection definition:
 * everything {@link buildWebFieldDefinitions} does not skip. Relationship
 * pseudo-columns (`oneToMany`/`manyToMany`) and STI `meta` internals never
 * appear on the wire, so they are excluded from the union — keeping the
 * declared type honest about what a client can observe. Co-managed with the
 * `SmrtWebFieldType` unions in the ambient `@happyvertical/smrt-virt-web`
 * d.ts, the physical `@smrt/web` d.ts, and the hand-written
 * `@happyvertical/smrt-web` mirror.
 */
export type WebFieldType = Exclude<
  FieldDefinition['type'],
  'meta' | 'oneToMany' | 'manyToMany'
>;

/** Informational per-column metadata carried by a collection definition. */
export interface WebFieldDefinition {
  type: WebFieldType;
  required?: boolean;
  /** Whether the public field contract explicitly permits `null`. */
  nullable?: boolean;
  default?: unknown;
  /**
   * The developer-authored `@field({ description })` (#2046) — the same text
   * that feeds OpenAPI and MCP schemas, now available to browser UIs as the
   * seed for end-user field help. Sensitive/transient fields are excluded
   * from emission entirely, so their descriptions never ship to the client.
   */
  description?: string;
  /** Static `@field({ ui })` hints (#2046) — the field-policy rail seed. */
  ui?: FieldUIHints;
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

/**
 * One canonical WebMCP tool candidate. `obj` owns the REST collection and row
 * contract; `actionHost` declares the action. They differ for custom methods
 * declared on a `SmrtCollection` subclass.
 */
export interface WebMcpToolEntry {
  collection: string;
  obj: SmartObjectDefinition;
  actionHost: SmartObjectDefinition;
  action: string;
}

/**
 * Transport-complete, data-only definition for one generated browser tool.
 * Unlike {@link WebCollectionEntry}, this shape does not imply that a list
 * route or cache-backed browser collection exists.
 */
export interface WebMcpToolDefinition extends ToolDescriptor {
  /** Stable definition identity is `(collection, action)`. */
  collection: string;
  /** Canonical qualified identity of the row model owning the collection. */
  objectRef: string;
  /** Row-model class used by the shared MCP tool vocabulary. */
  className: string;
  /** Path below the generated API base path. */
  endpoint: string;
  idField: string;
  idType: ToolIdType;
  /** Always present so a fetch-only registrar needs no action heuristics. */
  route: ToolRouteDescriptor;
  /** Cache-invalidation edges for materialized sibling collections. */
  relationships: WebRelationship[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function manifestObjectPackage(
  manifestKey: string | undefined,
  obj: SmartObjectDefinition,
): string | undefined {
  if (obj.packageName) return obj.packageName;
  const qualifiedName = obj.qualifiedName || manifestKey;
  const separator = qualifiedName?.lastIndexOf(':') ?? -1;
  return separator > 0 ? qualifiedName?.slice(0, separator) : undefined;
}

interface ManifestObjectIndex {
  byExactName: Map<string, SmartObjectDefinition>;
  byPackageAndClass: Map<string, SmartObjectDefinition>;
  bySimpleName: Map<string, SmartObjectDefinition>;
  packageByObject: WeakMap<SmartObjectDefinition, string>;
  objectRefByObject: WeakMap<SmartObjectDefinition, string>;
}

const manifestObjectIndexes = new WeakMap<
  SmartObjectManifest['objects'],
  ManifestObjectIndex
>();

function packageAndClassKey(packageName: string, className: string): string {
  return `${packageName}\0${className}`;
}

function getManifestObjectIndex(
  manifest: SmartObjectManifest,
): ManifestObjectIndex {
  const cached = manifestObjectIndexes.get(manifest.objects);
  if (cached) return cached;

  const entries = Object.entries(manifest.objects).sort(
    ([leftKey, left], [rightKey, right]) =>
      compareText(
        left.qualifiedName || leftKey,
        right.qualifiedName || rightKey,
      ) || compareText(leftKey, rightKey),
  );
  const index: ManifestObjectIndex = {
    byExactName: new Map(),
    byPackageAndClass: new Map(),
    bySimpleName: new Map(),
    packageByObject: new WeakMap(),
    objectRefByObject: new WeakMap(),
  };

  for (const [manifestKey, candidate] of entries) {
    if (!index.byExactName.has(manifestKey)) {
      index.byExactName.set(manifestKey, candidate);
    }
    if (
      candidate.qualifiedName &&
      !index.byExactName.has(candidate.qualifiedName)
    ) {
      index.byExactName.set(candidate.qualifiedName, candidate);
    }
    if (!index.bySimpleName.has(candidate.className)) {
      index.bySimpleName.set(candidate.className, candidate);
    }

    const packageName = manifestObjectPackage(manifestKey, candidate);
    if (packageName) {
      if (!index.packageByObject.has(candidate)) {
        index.packageByObject.set(candidate, packageName);
      }
      const packageKey = packageAndClassKey(packageName, candidate.className);
      if (!index.byPackageAndClass.has(packageKey)) {
        index.byPackageAndClass.set(packageKey, candidate);
      }
    }

    // New manifests carry `qualifiedName` on each object. Legacy aggregated
    // manifests can omit it from the object body while retaining a qualified
    // manifest key, so retain that equally canonical identity for browser
    // definitions rather than falling back to an ambiguous simple class name.
    const objectRef = candidate.qualifiedName?.includes(':')
      ? candidate.qualifiedName
      : manifestKey.includes(':')
        ? manifestKey
        : packageName
          ? `${packageName}:${candidate.className}`
          : undefined;
    if (objectRef && !index.objectRefByObject.has(candidate)) {
      index.objectRefByObject.set(candidate, objectRef);
    }
  }

  manifestObjectIndexes.set(manifest.objects, index);
  return index;
}

function indexedManifestObjectPackage(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): string | undefined {
  const index = getManifestObjectIndex(manifest);
  return (
    index.packageByObject.get(obj) || manifestObjectPackage(undefined, obj)
  );
}

/**
 * Return the canonical qualified model identity carried by a web collection.
 * Field-policy APIs require this `@package/name:ClassName` reference; a simple
 * class name is ambiguous in aggregated manifests and must never reach a
 * browser definition.
 */
function webCollectionObjectRef(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): string {
  const objectRef = getManifestObjectIndex(manifest).objectRefByObject.get(obj);
  if (objectRef) return objectRef;

  throw new Error(
    `[smrt] Cannot emit web collection definition for ${obj.className}: ` +
      'a qualifiedName, qualified manifest key, or packageName is required',
  );
}

/**
 * Resolve a manifest object deterministically across aggregated packages.
 *
 * Qualified references win exactly. Simple references prefer the referencing
 * object's package, then fall back to a stable qualified/key identity. This is
 * important because aggregated manifests can contain duplicate class names and
 * their object insertion order reflects package discovery order.
 */
export function findManifestObjectByName(
  manifest: SmartObjectManifest,
  name: string,
  owner?: SmartObjectDefinition,
): SmartObjectDefinition | undefined {
  const index = getManifestObjectIndex(manifest);
  const exact = name.includes(':') ? index.byExactName.get(name) : undefined;
  if (exact) return exact;

  const ownerPackage = owner
    ? indexedManifestObjectPackage(manifest, owner)
    : undefined;
  const packageLocal = ownerPackage
    ? index.byPackageAndClass.get(packageAndClassKey(ownerPackage, name))
    : undefined;

  return packageLocal || index.bySimpleName.get(name);
}

/**
 * Normalize a relationship field's `related` value to a resolvable class name.
 *
 * Thunk forward-ref decorators — `@foreignKey(() => Scene)`, used heavily in
 * video/voice for models that reference a class declared later — used to
 * serialize as the RAW arrow-function source string `"() => Scene"` in the
 * manifest, which neither `className` nor `qualifiedName` matches. The scanner
 * now unwraps the thunk itself (#2379), so this only has to cover manifests
 * generated before that fix. Extract the target class name from the thunk so
 * the edge resolves. Plain (`"Scene"`) and qualified
 * (`"@happyvertical/smrt-assets:Asset"`) forms contain no `=>` and pass through
 * untouched — the qualified `:` separator is preserved.
 *
 * Kept local to the relationship-edge path on purpose: extends-chain resolution
 * never sees a thunk, so `findManifestObjectByName` and the scanner stay
 * unchanged.
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
export function isCollectionManifestClass(
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
  const parent = findManifestObjectByName(manifest, parentName, obj);
  return parent ? isCollectionManifestClass(manifest, parent, seen) : false;
}

/**
 * Resolve the row model carried by a collection class.
 *
 * An explicit generic on any ancestor is authoritative. Conventional
 * `FooCollection` → `Foo` lookup is only a fallback after the full ancestry
 * has been checked, so an unrelated `SpecialFoo` cannot override an inherited
 * `FooCollection<Foo>` contract.
 */
function collectionAncestry(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): SmartObjectDefinition[] {
  const ancestry: SmartObjectDefinition[] = [];
  const seen = new Set<string>();
  let candidate: SmartObjectDefinition | undefined = obj;

  while (candidate) {
    ancestry.push(candidate);
    const parentName = candidate.extendsQualified || candidate.extends;
    if (!parentName || seen.has(parentName)) break;
    seen.add(parentName);
    candidate = findManifestObjectByName(manifest, parentName, candidate);
  }
  return ancestry;
}

/**
 * Resolve the authoritative collection item type name even when a partial
 * manifest omits the item definition itself.
 */
interface CollectionItemReference {
  name: string;
  owner: SmartObjectDefinition;
  object?: SmartObjectDefinition;
}

function resolveCollectionItemCandidate(
  manifest: SmartObjectManifest,
  name: string,
  owner: SmartObjectDefinition,
): CollectionItemReference {
  const object = findManifestObjectByName(manifest, name, owner);
  const ownerPackage = indexedManifestObjectPackage(manifest, owner);

  if (!name.includes(':') && ownerPackage) {
    const objectPackage = object
      ? indexedManifestObjectPackage(manifest, object)
      : undefined;
    if (objectPackage !== ownerPackage) {
      return {
        name: `${ownerPackage}:${name}`,
        owner,
      };
    }
  }

  return { name, owner, object };
}

function resolveCollectionItemReference(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): CollectionItemReference | undefined {
  const ancestry = collectionAncestry(manifest, obj);
  for (const collectionClass of ancestry) {
    if (collectionClass.extendsTypeArg) {
      return resolveCollectionItemCandidate(
        manifest,
        collectionClass.extendsTypeArg,
        collectionClass,
      );
    }
  }

  let fallback: CollectionItemReference | undefined;
  for (const collectionClass of ancestry) {
    if (!collectionClass.className.endsWith('Collection')) continue;
    const conventionalName = collectionClass.className.slice(
      0,
      -'Collection'.length,
    );
    const candidate = resolveCollectionItemCandidate(
      manifest,
      conventionalName,
      collectionClass,
    );
    if (candidate.object) return candidate;
    fallback ??= candidate;
  }

  return fallback;
}

export function resolveCollectionItemTypeName(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): string | undefined {
  return resolveCollectionItemReference(manifest, obj)?.name;
}

export function resolveCollectionItemObject(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): SmartObjectDefinition | undefined {
  return resolveCollectionItemReference(manifest, obj)?.object;
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
  let child = obj;
  let parentName = child.extendsQualified || child.extends;
  while (parentName && !seen.has(parentName)) {
    seen.add(parentName);
    const parent = findManifestObjectByName(manifest, parentName, child);
    if (!parent) return false;
    if (parent.collection === obj.collection) return true;
    child = parent;
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
    if (isCollectionManifestClass(manifest, obj)) continue;

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

/** Walk to the highest STI ancestor that owns the same REST collection. */
function resolveStiCollectionOwner(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): SmartObjectDefinition {
  const seen = new Set<string>();
  let owner = obj;
  let parentName = owner.extendsQualified || owner.extends;
  while (parentName && !seen.has(parentName)) {
    seen.add(parentName);
    const parent = findManifestObjectByName(manifest, parentName, owner);
    if (!parent || parent.collection !== obj.collection) break;
    owner = parent;
    parentName = owner.extendsQualified || owner.extends;
  }
  return owner;
}

/**
 * Select every generated WebMCP action independently of collection
 * materialization. Object actions establish the owning row model first;
 * collection-class actions then supplement missing `(collection, action)`
 * identities. Therefore an object action wins an exact collision, while all
 * ordering is independent of manifest insertion order.
 */
export function selectWebMcpToolEntries(
  manifest: SmartObjectManifest,
): WebMcpToolEntry[] {
  const sortedObjects = Object.values(manifest.objects).sort((left, right) =>
    compareText(
      webCollectionObjectRef(manifest, left),
      webCollectionObjectRef(manifest, right),
    ),
  );
  const objectOwners = new Map<string, WebCollectionEntry>();

  for (const candidate of sortedObjects) {
    if (isCollectionManifestClass(manifest, candidate)) continue;
    const existing = objectOwners.get(candidate.collection);
    const candidateIsChild = isStiChildModel(manifest, candidate);
    const existingIsChild = existing
      ? isStiChildModel(manifest, existing.obj)
      : false;
    if (existing && !(existingIsChild && !candidateIsChild)) continue;

    objectOwners.set(candidate.collection, {
      collection: candidate.collection,
      obj: candidate,
      actions: [],
    });
  }

  const entries = new Map<string, WebMcpToolEntry>();
  const ownerObjects = [...objectOwners.values()]
    .sort(
      (left, right) =>
        compareText(left.collection, right.collection) ||
        compareText(
          webCollectionObjectRef(manifest, left.obj),
          webCollectionObjectRef(manifest, right.obj),
        ),
    )
    .map((entry) => entry.obj);
  const ownerSet = new Set(ownerObjects);
  // Owners go first so the STI base wins an exact object-action collision.
  // Remaining models still contribute unique custom actions on the shared
  // collection instead of disappearing behind the owning row definition.
  const objectActionHosts = [
    ...ownerObjects,
    ...sortedObjects.filter(
      (candidate) =>
        !isCollectionManifestClass(manifest, candidate) &&
        !ownerSet.has(candidate),
    ),
  ];

  for (const actionHost of objectActionHosts) {
    const owner = objectOwners.get(actionHost.collection);
    if (!owner) continue;
    for (const action of [...resolveApiActionSet(actionHost, manifest)].sort(
      compareText,
    )) {
      const identity = `${owner.collection}\0${action}`;
      if (entries.has(identity)) continue;
      entries.set(identity, {
        collection: owner.collection,
        obj: owner.obj,
        // CRUD is a shared collection identity owned by the STI base even if
        // a child is the manifest entry that exposed it. Custom actions retain
        // their declaring host so route overrides and parameters stay exact.
        actionHost: isCrudAction(action) ? owner.obj : actionHost,
        action,
      });
    }
  }

  for (const collectionClass of sortedObjects) {
    if (!isCollectionManifestClass(manifest, collectionClass)) continue;
    const itemObject = resolveCollectionItemObject(manifest, collectionClass);
    if (!itemObject) continue;
    const owner =
      objectOwners.get(collectionClass.collection)?.obj ??
      resolveStiCollectionOwner(manifest, itemObject);

    for (const action of [
      ...resolveApiActionSet(collectionClass, manifest),
    ].sort(compareText)) {
      const identity = `${collectionClass.collection}\0${action}`;
      if (entries.has(identity)) continue;
      entries.set(identity, {
        collection: collectionClass.collection,
        obj: owner,
        actionHost: collectionClass,
        action,
      });
    }
  }

  return [...entries.values()].sort(
    (left, right) =>
      compareText(left.collection, right.collection) ||
      compareText(left.action, right.action) ||
      compareText(
        webCollectionObjectRef(manifest, left.actionHost),
        webCollectionObjectRef(manifest, right.actionHost),
      ),
  );
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
  objectRef: string;
  className: string;
  endpoint: string;
  idField: string;
  actions: string[];
  fields: Record<string, WebFieldDefinition>;
  relationships: WebRelationship[];
} {
  return {
    name: entry.collection,
    objectRef: webCollectionObjectRef(manifest, entry.obj),
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
    const ui = sanitizeFieldUIHints(field._meta?.ui);
    // Scanner manifests expose `description` top-level; runtime-registry
    // manifests (computeRuntimeWebManifestHash → registeredFieldsToManifest)
    // keep it under `_meta` only. Read both so the build-time and runtime
    // shape digests agree — otherwise every described field would latch a
    // false `updateAvailable.contract` signal on APIGenerator SSE connects.
    const description = readFieldDescription(field);
    fields[fieldName] = {
      // Safe: the three skips above are exactly the types WebFieldType excludes.
      type: field.type as WebFieldType,
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field._meta?.nullable === true ? { nullable: true } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(ui ? { ui } : {}),
    };
  }
  return fields;
}

/** Top-level `description` with `_meta.description` fallback (see call site). */
function readFieldDescription(field: FieldDefinition): string | undefined {
  if (typeof field.description === 'string' && field.description !== '') {
    return field.description;
  }
  const metaDescription = field._meta?.description;
  if (typeof metaDescription === 'string' && metaDescription !== '') {
    return metaDescription;
  }
  return undefined;
}

/**
 * Narrow a manifest `_meta.ui` bag to the known {@link FieldUIHints} keys with
 * per-key type guards. `_meta` is an open bag, so authored junk (wrong-typed
 * values, arbitrary extra keys) must not reach the emitted client module — the
 * emitted value also feeds the #1764 shape digest, so unknown unstable keys
 * would churn the hash. Returns undefined when nothing valid remains, so
 * hint-less fields emit no `ui` key at all (existing shapes stay byte-stable).
 */
function sanitizeFieldUIHints(value: unknown): FieldUIHints | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const ui: FieldUIHints = {
    ...(typeof raw.basic === 'boolean' ? { basic: raw.basic } : {}),
    ...(typeof raw.group === 'string' && raw.group !== ''
      ? { group: raw.group }
      : {}),
    ...(typeof raw.order === 'number' && Number.isFinite(raw.order)
      ? { order: raw.order }
      : {}),
    ...(typeof raw.locked === 'boolean' ? { locked: raw.locked } : {}),
  };
  return Object.keys(ui).length > 0 ? ui : undefined;
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
    // "() => Scene" source, which findManifestObjectByName cannot match on its
    // own.
    const target = findManifestObjectByName(
      manifest,
      normalizeRelatedName(field.related),
      obj,
    );
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
 * shape. That remains safe because descriptor-only inputs (including `idType`)
 * do not alter persisted public rows or read responses, which are the cache
 * contracts this digest protects.
 */
export function buildWebToolDescriptors(
  entry: WebCollectionEntry,
  options: { kebabRoutes?: boolean } = {},
): ToolDescriptor[] {
  return buildWebToolDescriptorsForHost({
    owner: entry.obj,
    actionHost: entry.obj,
    actions: entry.actions,
    options,
  });
}

function buildWebToolDescriptorsForHost(input: {
  owner: SmartObjectDefinition;
  actionHost: SmartObjectDefinition;
  actions: string[];
  options: { kebabRoutes?: boolean };
  collectionHost?: boolean;
}): ToolDescriptor[] {
  const { owner, actionHost, actions, options, collectionHost = false } = input;
  const webFields = buildWebFieldDefinitions(owner);
  const fields: ToolFieldMeta[] = Object.entries(webFields).map(
    ([name, def]) => ({
      name,
      type: def.type,
      ...(def.required !== undefined ? { required: def.required } : {}),
      ...(def.nullable === true ? { nullable: true } : {}),
      ...(def.default !== undefined ? { default: def.default } : {}),
      // #2046: the authored field description flows into the generated JSON
      // Schema (`fieldTypeToJsonSchema` prefers it over the type-derived
      // fallback), so browser-side WebMCP tools document their arguments.
      ...(def.description !== undefined
        ? { description: def.description }
        : {}),
    }),
  );
  const descriptors = buildToolDescriptors({
    className: owner.className,
    fields,
    actions,
    customActions: Object.fromEntries(
      actions.map((action) => [
        action,
        resolveCustomActionMetadata({
          actionName: action,
          method: actionHost.methods?.[action],
          apiConfig: actionHost.decoratorConfig?.api,
          ...(collectionHost ? { defaultScope: 'collection' as const } : {}),
        }),
      ]),
    ),
    idType: owner.decoratorConfig.idType,
  });

  return descriptors.map((descriptor) => {
    if (isCrudAction(descriptor.action)) return descriptor;
    const method = actionHost.methods?.[descriptor.action];
    const route = resolveApiActionRouteConfig(
      descriptor.action,
      method ?? {},
      actionHost.decoratorConfig?.api,
      { kebabRoutes: options.kebabRoutes },
      collectionHost ? 'collection' : method?.isStatic ? 'collection' : 'item',
    );
    const metadata = resolveCustomActionMetadata({
      actionName: descriptor.action,
      method,
      apiConfig: actionHost.decoratorConfig?.api,
      ...(collectionHost ? { defaultScope: 'collection' as const } : {}),
    });
    const parameterAliases = Object.fromEntries(
      (method?.parameters ?? [])
        .map((parameter) => [
          customActionParameterInputName(metadata, parameter.name),
          parameter.name,
        ])
        .filter(([inputName, parameterName]) => inputName !== parameterName),
    );
    return {
      ...descriptor,
      route: {
        method: route.method,
        scope: route.scope,
        path: route.pathSegments,
        ...(metadata.parameters === undefined ||
        (metadata.parameters.length === 1 &&
          metadata.parameters[0]?.name === 'options')
          ? { optionsBag: true }
          : {}),
        ...(Object.keys(parameterAliases).length > 0
          ? { parameterAliases }
          : {}),
      },
    };
  });
}

function crudToolRoute(action: string): ToolRouteDescriptor {
  switch (action) {
    case 'list':
      return { method: 'GET', scope: 'collection', path: [] };
    case 'get':
      return { method: 'GET', scope: 'item', path: [] };
    case 'create':
      return { method: 'POST', scope: 'collection', path: [] };
    case 'update':
      return { method: 'PUT', scope: 'item', path: [] };
    case 'delete':
      return { method: 'DELETE', scope: 'item', path: [] };
    default:
      throw new Error(`[smrt] Unknown generated CRUD action: ${action}`);
  }
}

/** Build the canonical, transport-complete definition for one selected tool. */
export function buildWebMcpToolDefinition(
  entry: WebMcpToolEntry,
  manifest: SmartObjectManifest,
  options: { kebabRoutes?: boolean } = {},
): WebMcpToolDefinition {
  const descriptor = buildWebToolDescriptorsForHost({
    owner: entry.obj,
    actionHost: entry.actionHost,
    actions: [entry.action],
    options,
    collectionHost: isCollectionManifestClass(manifest, entry.actionHost),
  })[0];
  if (!descriptor) {
    throw new Error(
      `[smrt] Failed to build WebMCP descriptor for ${entry.collection}.${entry.action}`,
    );
  }

  return {
    collection: entry.collection,
    objectRef: webCollectionObjectRef(manifest, entry.obj),
    className: entry.obj.className,
    endpoint: `/${entry.collection}`,
    idField: 'id',
    idType: entry.obj.decoratorConfig.idType ?? 'uuid',
    relationships: buildWebRelationships(entry.obj, manifest),
    ...descriptor,
    route: descriptor.route ?? crudToolRoute(entry.action),
  };
}

/** Emit every API-backed WebMCP tool, including non-list models. */
export function buildWebMcpToolDefinitions(
  manifest: SmartObjectManifest,
  options: { kebabRoutes?: boolean } = {},
): WebMcpToolDefinition[] {
  return selectWebMcpToolEntries(manifest).map((entry) =>
    buildWebMcpToolDefinition(entry, manifest, options),
  );
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
