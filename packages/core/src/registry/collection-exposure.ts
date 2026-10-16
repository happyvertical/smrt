/**
 * Generated-surface (api/mcp/cli) exposure that a collection class takes from
 * its model.
 *
 * A collection class is registered as a resource of its own, so every
 * transport generates operations for it: `<name>collection_create` MCP tools,
 * `<name>collection:create` CLI commands, and routes for its public methods.
 * Those operations reach the same rows as the model's, so a collection must
 * never publish more than its model does. A surface the collection does not
 * configure itself therefore inherits the model's:
 *
 * - `false` stays `false`.
 * - An `include` list keeps its CRUD verbs, plus any name that only the
 *   collection declares (the model publishing a collection-hosted action,
 *   with its `api.routes` entry). A name the model declares is the model's
 *   own method; a collection method that happens to share it is a different
 *   operation, so the collection's custom methods stay closed until the
 *   collection lists them itself.
 * - An `exclude` list is copied as is.
 * - A model with no list (or `true`) leaves the collection's surface unset,
 *   which is the historical open default.
 * - A `sensitive: true` model's collection gets read-only MCP (`list`/`get`
 *   where the model has them) unless the collection configures `mcp` itself.
 *
 * A collection that configures a surface keeps its own value; that is how a
 * collection opts in to its own custom methods (for example
 * `@smrt({ api: { include: ['resolveBatch'] } })`). Its CRUD writes are then
 * checked against the model by {@link findCollectionWriteEscalations}.
 *
 * Pure functions over config objects: the manifest generator applies them at
 * build time and `ObjectRegistry.getConfig()` applies them again at runtime, so
 * a manifest built before this rule existed is held to it too.
 */
import type { SmartObjectConfig } from './types';

/** The generated transports whose exposure a collection inherits. */
export type ExposureSurface = 'api' | 'mcp' | 'cli';

/** Every generated transport, in a stable order. */
export const EXPOSURE_SURFACES: readonly ExposureSurface[] = [
  'api',
  'mcp',
  'cli',
];

const CRUD_VERBS = ['list', 'get', 'create', 'update', 'delete'] as const;

/** A generated CRUD operation. */
export type CrudVerb = (typeof CRUD_VERBS)[number];

/** The CRUD operations that change rows. */
export const CRUD_WRITE_VERBS: readonly CrudVerb[] = [
  'create',
  'update',
  'delete',
];

const CRUD_READ_VERBS: readonly CrudVerb[] = ['list', 'get'];

/**
 * Transports on which a collection class gets generated CRUD operations of its
 * own. REST serves collection CRUD through the model's routes and gives a
 * collection class only its custom-method routes, so `api` is not one.
 */
export const COLLECTION_CRUD_SURFACES: readonly ExposureSurface[] = [
  'mcp',
  'cli',
];

/**
 * Method names of a collection class and of its model. When given, an entry in
 * the model's `include` list that names a method only the collection declares
 * carries over to the collection (see {@link inheritedCollectionSurface}).
 */
export interface CollectionMethodNames {
  collection?: ReadonlySet<string>;
  item?: ReadonlySet<string>;
}

function isCrudVerb(name: unknown): name is CrudVerb {
  return (CRUD_VERBS as readonly unknown[]).includes(name);
}

/**
 * The CRUD verbs a surface config opens, with the same reading the MCP and CLI
 * generators use: `false` opens none, an absent value or `true` opens all, an
 * object opens `include` (or everything when it has no `include`) minus
 * `exclude`.
 */
export function exposedCrudVerbs(value: unknown): CrudVerb[] {
  if (value === false) return [];
  if (!value || typeof value !== 'object') return [...CRUD_VERBS];
  const { include, exclude } = value as {
    include?: unknown;
    exclude?: unknown;
  };
  const included = Array.isArray(include) ? include : undefined;
  const excluded = Array.isArray(exclude) ? exclude : [];
  return CRUD_VERBS.filter(
    (verb) =>
      (!included || included.includes(verb)) && !excluded.includes(verb),
  );
}

/**
 * The value a collection inherits for one surface from its model, or
 * `undefined` when the model leaves that surface open (the collection keeps
 * its historical default).
 */
export function inheritedCollectionSurface(
  surface: ExposureSurface,
  itemConfig: SmartObjectConfig,
  methods: CollectionMethodNames = {},
): SmartObjectConfig[ExposureSurface] | undefined {
  const itemValue = itemConfig[surface];
  if (itemValue === false) return false;

  if (surface === 'mcp' && itemConfig.sensitive === true) {
    return {
      include: exposedCrudVerbs(itemValue).filter((verb) =>
        CRUD_READ_VERBS.includes(verb),
      ),
    };
  }

  if (!itemValue || typeof itemValue !== 'object') return undefined;

  const source = itemValue as {
    include?: unknown;
    exclude?: unknown;
    skipApiCheck?: unknown;
  };
  const inherited: {
    include?: string[];
    exclude?: string[];
    skipApiCheck?: boolean | string[];
    routes?: Record<string, unknown>;
    principalContext?: unknown;
  } = {};
  const hosted: string[] = [];
  if (Array.isArray(source.include)) {
    inherited.include = source.include.filter((entry) => {
      if (isCrudVerb(entry)) return true;
      // A name only the collection declares can mean nothing else: the
      // model is publishing a collection-hosted action (the legacy
      // `api.routes` `scope: 'collection'` form). A name the model also
      // declares is the model's own method and stays off the collection.
      if (
        typeof entry === 'string' &&
        methods.collection?.has(entry) &&
        !methods.item?.has(entry)
      ) {
        hosted.push(entry);
        return true;
      }
      return false;
    });
  }
  if (surface === 'api' && hosted.length > 0) {
    const api = itemValue as {
      routes?: Record<string, unknown>;
      principalContext?: unknown;
    };
    const routes = Object.fromEntries(
      Object.entries(api.routes ?? {}).filter(([name]) =>
        hosted.includes(name),
      ),
    );
    if (Object.keys(routes).length > 0) inherited.routes = routes;
    if (api.principalContext !== undefined) {
      inherited.principalContext = api.principalContext;
    }
  }
  if (Array.isArray(source.exclude)) {
    inherited.exclude = source.exclude.filter(
      (entry): entry is string => typeof entry === 'string',
    );
  }
  if (inherited.include === undefined && inherited.exclude === undefined) {
    // Route or context options alone do not narrow the model's surface.
    return undefined;
  }
  if (surface === 'cli') {
    // The model's acknowledgement that a command has no API route carries
    // over for the CRUD verbs the collection inherits.
    if (source.skipApiCheck === true) {
      inherited.skipApiCheck = true;
    } else if (Array.isArray(source.skipApiCheck)) {
      const verbs = source.skipApiCheck.filter(
        (entry): entry is CrudVerb =>
          isCrudVerb(entry) && (inherited.include?.includes(entry) ?? true),
      );
      if (verbs.length > 0) inherited.skipApiCheck = verbs;
    }
  }
  return inherited as SmartObjectConfig[ExposureSurface];
}

/**
 * The surfaces a collection inherits from its model: every surface the
 * collection leaves unset and the model narrows (see the module comment).
 * Returns an empty object when nothing changes.
 */
export function inheritCollectionExposure(
  collectionConfig: SmartObjectConfig,
  itemConfig: SmartObjectConfig,
  methods: CollectionMethodNames = {},
): Partial<Pick<SmartObjectConfig, ExposureSurface>> {
  const inherited: Partial<Pick<SmartObjectConfig, ExposureSurface>> = {};
  for (const surface of EXPOSURE_SURFACES) {
    if (collectionConfig[surface] !== undefined) continue;
    const value = inheritedCollectionSurface(surface, itemConfig, methods);
    if (value !== undefined) {
      (inherited as Record<ExposureSurface, unknown>)[surface] = value;
    }
  }
  return inherited;
}

/** A CRUD write a collection opens on a transport where its model does not. */
export interface CollectionWriteEscalation {
  surface: ExposureSurface;
  verbs: CrudVerb[];
}

/**
 * CRUD writes the collection's effective config opens that the model's does
 * not, per transport on which collections get CRUD operations. Pass the
 * collection config AFTER inheritance; an undecorated collection then never
 * escalates, so a finding always points at the collection's own `@smrt()`.
 */
export function findCollectionWriteEscalations(
  collectionConfig: SmartObjectConfig,
  itemConfig: SmartObjectConfig,
): CollectionWriteEscalation[] {
  const escalations: CollectionWriteEscalation[] = [];
  for (const surface of COLLECTION_CRUD_SURFACES) {
    const modelWrites = new Set(
      itemConfig.abstract === true ? [] : exposedCrudVerbs(itemConfig[surface]),
    );
    const verbs = exposedCrudVerbs(collectionConfig[surface]).filter(
      (verb) => CRUD_WRITE_VERBS.includes(verb) && !modelWrites.has(verb),
    );
    if (verbs.length > 0) escalations.push({ surface, verbs });
  }
  return escalations;
}

/**
 * Build-time error text for collections that open writes their model closes.
 */
export function formatCollectionWriteEscalations(
  findings: Array<{
    collection: string;
    model: string;
    escalations: CollectionWriteEscalation[];
  }>,
): string {
  const lines = findings.flatMap(({ collection, model, escalations }) =>
    escalations.map(
      ({ surface, verbs }) =>
        `  - ${collection} opens ${surface} ${verbs.join('/')}, which ${model} does not.`,
    ),
  );
  return [
    '[smrt] A collection class publishes generated writes its model closes:',
    ...lines,
    '',
    'A collection reaches the same rows as its model, so it may not open a CRUD',
    'write the model keeps closed. Either:',
    "  - remove the verb from the collection's own @smrt() surface (or drop that",
    "    surface key so the collection inherits the model's), or",
    '  - open the verb on the model itself, if it is meant to be public.',
    "Custom collection methods are not affected: list them in the collection's",
    'own include to expose them.',
  ].join('\n');
}
