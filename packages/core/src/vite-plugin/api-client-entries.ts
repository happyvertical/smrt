/**
 * Manifest -> generated API-client entry selection.
 *
 * Runtime client values, Vite ambient declarations, and physical prebuild
 * declarations must agree on which manifest object owns a collection's
 * canonical endpoint. Collection classes describe access methods, not row
 * payloads, so a populated model always wins the shared collection key.
 */

import {
  CRUD_OPERATIONS,
  createManifestClassNamePredicate,
  resolveApiMethodExposure,
} from '../generators/custom-action.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { resolveApiActionRouteConfig } from './sveltekit-generator.js';
import {
  findManifestObjectByName,
  isCollectionManifestClass,
  resolveCollectionItemObject,
} from './web-collections.js';

export type ApiClientCrudMethod =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'search';

export interface ApiClientEntry {
  /** Original key in manifest.objects. */
  objectName: string;
  /** Object whose routes and custom methods this client entry exposes. */
  obj: SmartObjectDefinition;
  /** Canonical collection key or deterministic class-derived secondary key. */
  clientKey: string;
  /** Row-payload interface used by CRUD methods for this entry. */
  dataInterfaceName: string;
  /** Standard client operations whose server routes are actually emitted. */
  crudMethods: ApiClientCrudMethod[];
  /** Custom methods whose routes are actually emitted by the server. */
  customMethods: Array<{
    name: string;
    scope: 'item' | 'collection';
    pathParamNames: string[];
    parameters: Array<{
      name: string;
      type: string;
      optional?: boolean;
      default?: unknown;
    }>;
  }>;
}

export function renderApiClientCrudType(
  dataInterfaceName: string,
  crudMethods: ApiClientCrudMethod[],
  overriddenMethods: string[] = [],
): string | undefined {
  const overridden = new Set(overriddenMethods);
  const methods = crudMethods.filter((method) => !overridden.has(method));
  if (methods.length === 0) return undefined;
  if (
    methods.length === 6 &&
    methods.every(
      (method, index) => method === [...CRUD_OPERATIONS, 'search'][index],
    )
  ) {
    return `CrudOperations<${dataInterfaceName}>`;
  }
  return `Pick<CrudOperations<${dataInterfaceName}>, ${methods
    .map((method) => JSON.stringify(method))
    .join(' | ')}>`;
}

export function renderApiClientCustomMethodParameters(
  method: ApiClientEntry['customMethods'][number],
  mapType: (type: string) => string,
): string {
  const pathParamNames = new Set(method.pathParamNames);
  const params = method.parameters;
  const hasSingleOptionsParameter =
    params.length === 1 && params[0]?.name === 'options';
  const requiredPathProperties = method.pathParamNames
    .map((name) => `${name}: string`)
    .join('; ');
  let optionsType: string;

  if (hasSingleOptionsParameter) {
    const directOptionsType = mapType(params[0].type);
    optionsType = requiredPathProperties
      ? `${directOptionsType} & { ${requiredPathProperties} }`
      : directOptionsType;
  } else {
    const parameterNames = new Set(params.map((param) => param.name));
    const properties = params.map(
      (param) =>
        `${param.name}${pathParamNames.has(param.name) || !param.optional ? '' : '?'}: ${mapType(param.type)}`,
    );
    for (const pathParamName of method.pathParamNames) {
      if (!parameterNames.has(pathParamName)) {
        properties.push(`${pathParamName}: string`);
      }
    }
    optionsType =
      properties.length > 0
        ? `{ ${properties.join('; ')} }`
        : 'Record<string, never>';
  }

  const hasRequiredOptions = hasSingleOptionsParameter
    ? !params[0]?.optional
    : params.some(
        (param) => !pathParamNames.has(param.name) && !param.optional,
      );
  const optionsParameter = `${method.pathParamNames.length > 0 || hasRequiredOptions ? 'options' : 'options?'}: ${optionsType}`;
  return method.scope === 'collection'
    ? optionsParameter
    : `id: string, ${optionsParameter}`;
}

interface ManifestCandidate {
  objectName: string;
  obj: SmartObjectDefinition;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function candidateIdentity(candidate: ManifestCandidate): string {
  return [
    candidate.obj.qualifiedName ?? '',
    candidate.obj.className,
    candidate.objectName,
  ].join('\0');
}

function compareCandidateIdentity(
  left: ManifestCandidate,
  right: ManifestCandidate,
): number {
  return compareText(candidateIdentity(left), candidateIdentity(right));
}

function lowerFirst(value: string): string {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function isAncestorOf(
  manifest: SmartObjectManifest,
  ancestor: SmartObjectDefinition,
  descendant: SmartObjectDefinition,
): boolean {
  const seen = new Set<string>();
  let child = descendant;
  let parentName = child.extendsQualified || child.extends;

  while (parentName && !seen.has(parentName)) {
    seen.add(parentName);
    const parent = findManifestObjectByName(manifest, parentName, child);
    if (!parent) return false;
    if (parent === ancestor) return true;
    child = parent;
    parentName = parent.extendsQualified || parent.extends;
  }

  return false;
}

const CRUD_OPERATION_SET = new Set<string>(CRUD_OPERATIONS);

function resolveGeneratedClientCustomMethods(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): ApiClientEntry['customMethods'] {
  const apiConfig = obj.decoratorConfig?.api;
  if (apiConfig === false) return [];

  const isCollection = isCollectionManifestClass(manifest, obj);
  const isModelClassName = createManifestClassNamePredicate(manifest);

  return Object.entries(obj.methods ?? {}).flatMap(([name, method]) => {
    // The client's whole contract is "methods whose routes the server actually
    // emits", so it reads the SAME resolver the emitters do rather than its own
    // include/exclude copy. Before #2686 that copy was equivalent; once the
    // wire-ability gate and `@method()` joined the decision, a local copy would
    // hand callers a typed `client.assets.createNewVersion(...)` pointing at a
    // route that is no longer written.
    if (
      !resolveApiMethodExposure({
        actionName: name,
        method,
        apiConfig,
        isCollectionClass: isCollection,
        ...(isModelClassName ? { isModelClassName } : {}),
      }).exposed
    ) {
      return [];
    }

    const routeConfig = resolveApiActionRouteConfig(
      name,
      method,
      apiConfig,
      {},
      isCollection ? 'collection' : method.isStatic ? 'collection' : 'item',
    );

    return [
      {
        name,
        scope: routeConfig.scope,
        pathParamNames: routeConfig.pathParamNames,
        parameters: method.parameters ?? [],
      },
    ];
  });
}

function resolveCrudObject(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): SmartObjectDefinition | undefined {
  if (!isCollectionManifestClass(manifest, obj)) return obj;

  const itemObject = resolveCollectionItemObject(manifest, obj);
  if (itemObject) return itemObject;

  // A non-conventional collection can still share an endpoint with a model.
  return Object.values(manifest.objects)
    .filter(
      (candidate) =>
        candidate.collection === obj.collection &&
        !isCollectionManifestClass(manifest, candidate),
    )
    .sort((left, right) =>
      compareText(
        left.qualifiedName ?? left.className,
        right.qualifiedName ?? right.className,
      ),
    )[0];
}

function resolveGeneratedClientCrudMethods(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): ApiClientCrudMethod[] {
  const crudObject = resolveCrudObject(obj, manifest);
  const apiConfig = crudObject?.decoratorConfig?.api;
  if (!crudObject || apiConfig === false) return [];

  if (apiConfig === true || apiConfig === undefined) {
    return [...CRUD_OPERATIONS, 'search'];
  }
  if (typeof apiConfig !== 'object' || apiConfig === null) {
    return [...CRUD_OPERATIONS, 'search'];
  }

  const included = Array.isArray(apiConfig.include)
    ? apiConfig.include
    : undefined;
  const excluded = Array.isArray(apiConfig.exclude) ? apiConfig.exclude : [];
  const standardMethods = (
    included
      ? CRUD_OPERATIONS.filter((action) => included.includes(action))
      : [...CRUD_OPERATIONS]
  ).filter((action) => !excluded.includes(action));

  // Preserve the historical search convenience only for an unbounded API
  // config. Explicit include lists are fail-closed; a real custom search
  // method is carried separately by resolveGeneratedClientCustomMethods().
  const includeSearch = !included && !excluded.includes('search');
  return includeSearch ? [...standardMethods, 'search'] : standardMethods;
}

/**
 * Resolve the CRUD surface that the generated route files actually expose for
 * one shared collection endpoint.
 *
 * Route generation processes manifest objects in insertion order. Collection
 * and item handlers live in separate files, and the last model that emits each
 * file replaces the earlier file. Mirror that behavior here so every client
 * alias for a shared endpoint has the same, real action set.
 */
function resolveGeneratedEndpointCrudMethods(
  collection: string,
  manifest: SmartObjectManifest,
): ApiClientCrudMethod[] {
  let collectionMethods: ApiClientCrudMethod[] = [];
  let itemMethods: ApiClientCrudMethod[] = [];

  for (const obj of Object.values(manifest.objects)) {
    if (
      obj.collection !== collection ||
      isCollectionManifestClass(manifest, obj)
    ) {
      continue;
    }

    const methods = resolveGeneratedClientCrudMethods(obj, manifest);
    const emittedCollectionMethods = methods.filter((method) =>
      ['list', 'create', 'search'].includes(method),
    );
    const emittedItemMethods = methods.filter((method) =>
      ['get', 'update', 'delete'].includes(method),
    );

    // generateRoutesForObject only writes a route file when that file has at
    // least one standard handler. A custom-only object leaves an earlier CRUD
    // file intact rather than replacing it with an empty file.
    if (
      emittedCollectionMethods.some(
        (method) => method === 'list' || method === 'create',
      )
    ) {
      collectionMethods = emittedCollectionMethods;
    }
    if (emittedItemMethods.length > 0) {
      itemMethods = emittedItemMethods;
    }
  }

  const emitted = new Set([...collectionMethods, ...itemMethods]);
  const orderedMethods: ApiClientCrudMethod[] = [...CRUD_OPERATIONS, 'search'];
  return orderedMethods.filter((method) => emitted.has(method));
}

function exposesApiClientSurface(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): boolean {
  if (obj.decoratorConfig?.api === false) return false;
  if (resolveGeneratedClientCrudMethods(obj, manifest).length > 0) return true;

  // A disabled item has no CRUD routes. Keep its companion collection only
  // when the collection itself contributes a custom route that the SvelteKit
  // generator will actually emit.
  return resolveGeneratedClientCustomMethods(obj, manifest).length > 0;
}

function resolveDataInterfaceName(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): string {
  if (!isCollectionManifestClass(manifest, obj)) {
    return `${obj.className}Data`;
  }

  const itemObject = resolveCollectionItemObject(manifest, obj);
  return `${itemObject?.className || obj.className}Data`;
}

function sharedCollectionModelDepth(
  manifest: SmartObjectManifest,
  obj: SmartObjectDefinition,
): number {
  const seen = new Set<string>();
  let depth = 0;
  let child = obj;
  let parentName = child.extendsQualified || child.extends;

  while (parentName && !seen.has(parentName)) {
    seen.add(parentName);
    const parent = findManifestObjectByName(manifest, parentName, child);
    if (!parent || parent.collection !== obj.collection) break;
    depth += 1;
    child = parent;
    parentName = parent.extendsQualified || parent.extends;
  }

  return depth;
}

/**
 * Select the owner of one canonical collection endpoint with a transitive rank.
 *
 * Models beat collection classes because CRUD payloads are rows. Among models,
 * shallower same-collection ancestry wins, then a root with more descendants
 * wins (the STI base over an unrelated endpoint collision), then qualified
 * identity resolves any remaining ambiguity. Numeric/lexical tuple ranks stay
 * transitive, unlike pairwise ancestry overrides inside Array.sort().
 */
function selectCanonicalOwner(
  manifest: SmartObjectManifest,
  group: ManifestCandidate[],
): ManifestCandidate | undefined {
  const models = group.filter(
    (candidate) => !isCollectionManifestClass(manifest, candidate.obj),
  );

  if (models.length > 0) {
    return [...models]
      .map((candidate) => ({
        candidate,
        depth: sharedCollectionModelDepth(manifest, candidate.obj),
        descendantCount: models.filter(
          (other) =>
            other !== candidate &&
            isAncestorOf(manifest, candidate.obj, other.obj),
        ).length,
      }))
      .sort(
        (left, right) =>
          left.depth - right.depth ||
          right.descendantCount - left.descendantCount ||
          compareCandidateIdentity(left.candidate, right.candidate),
      )[0]?.candidate;
  }

  return [...group].sort((left, right) => {
    const leftHasItem = resolveCollectionItemObject(manifest, left.obj);
    const rightHasItem = resolveCollectionItemObject(manifest, right.obj);
    if (Boolean(leftHasItem) !== Boolean(rightHasItem)) {
      return leftHasItem ? -1 : 1;
    }
    return compareCandidateIdentity(left, right);
  })[0];
}

/**
 * Select every generated client entry with deterministic endpoint keys and row
 * payload types. Exactly one entry owns each canonical collection key; other
 * API objects remain available under stable class-derived secondary keys.
 */
export function selectApiClientEntries(
  manifest: SmartObjectManifest,
): ApiClientEntry[] {
  const candidates = Object.entries(manifest.objects)
    .filter(([, obj]) => exposesApiClientSurface(obj, manifest))
    .map(([objectName, obj]): ManifestCandidate => ({ objectName, obj }));
  const candidatesByCollection = new Map<string, ManifestCandidate[]>();

  for (const candidate of candidates) {
    const group = candidatesByCollection.get(candidate.obj.collection) ?? [];
    group.push(candidate);
    candidatesByCollection.set(candidate.obj.collection, group);
  }

  const canonicalOwners = new Map<string, ManifestCandidate>();
  for (const [collection, group] of candidatesByCollection) {
    const canonicalOwner = selectCanonicalOwner(manifest, group);
    if (canonicalOwner) canonicalOwners.set(collection, canonicalOwner);
  }

  // Canonical owners are emitted first within each collection. Sorting all
  // remaining candidates by identity makes numeric suffixes stable too.
  const orderedCandidates = [...candidates].sort((left, right) => {
    const collectionOrder = compareText(
      left.obj.collection,
      right.obj.collection,
    );
    if (collectionOrder !== 0) return collectionOrder;

    const leftIsCanonical = canonicalOwners.get(left.obj.collection) === left;
    const rightIsCanonical =
      canonicalOwners.get(right.obj.collection) === right;
    if (leftIsCanonical !== rightIsCanonical) {
      return leftIsCanonical ? -1 : 1;
    }

    return compareCandidateIdentity(left, right);
  });

  // A secondary key must never shadow any canonical endpoint, including a
  // later collection whose canonical owner has not been emitted yet.
  const reservedCanonicalKeys = new Set(canonicalOwners.keys());
  const usedKeys = new Set<string>();

  return orderedCandidates.map(({ objectName, obj }) => {
    const isCanonicalOwner =
      canonicalOwners.get(obj.collection)?.objectName === objectName;
    let clientKey = isCanonicalOwner
      ? obj.collection
      : lowerFirst(obj.className);
    const baseClientKey = clientKey;
    let suffix = 2;

    while (
      usedKeys.has(clientKey) ||
      (!isCanonicalOwner && reservedCanonicalKeys.has(clientKey))
    ) {
      clientKey = `${baseClientKey}${suffix}`;
      suffix += 1;
    }

    usedKeys.add(clientKey);
    return {
      objectName,
      obj,
      clientKey,
      dataInterfaceName: resolveDataInterfaceName(obj, manifest),
      crudMethods: resolveGeneratedEndpointCrudMethods(
        obj.collection,
        manifest,
      ),
      customMethods: resolveGeneratedClientCustomMethods(obj, manifest),
    };
  });
}
