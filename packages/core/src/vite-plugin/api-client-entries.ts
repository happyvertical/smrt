/**
 * Manifest -> generated API-client entry selection.
 *
 * Runtime client values, Vite ambient declarations, and physical prebuild
 * declarations must agree on which manifest object owns a collection's
 * canonical endpoint. Collection classes describe access methods, not row
 * payloads, so a populated model always wins the shared collection key.
 */

import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  findManifestObjectByName,
  isCollectionManifestClass,
} from './web-collections.js';

export interface ApiClientEntry {
  /** Original key in manifest.objects. */
  objectName: string;
  /** Object whose routes and custom methods this client entry exposes. */
  obj: SmartObjectDefinition;
  /** Canonical collection key or deterministic class-derived secondary key. */
  clientKey: string;
  /** Row-payload interface used by CRUD methods for this entry. */
  dataInterfaceName: string;
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

function resolveCollectionItemObject(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): SmartObjectDefinition | undefined {
  const seen = new Set<string>();
  let candidate: SmartObjectDefinition | undefined = obj;

  while (candidate) {
    if (candidate.extendsTypeArg) {
      const itemObject = findManifestObjectByName(
        manifest,
        candidate.extendsTypeArg,
        candidate,
      );
      if (itemObject) return itemObject;
    }

    if (candidate.className.endsWith('Collection')) {
      const conventionalItem = findManifestObjectByName(
        manifest,
        candidate.className.slice(0, -'Collection'.length),
        candidate,
      );
      if (conventionalItem) return conventionalItem;
    }

    const parentName = candidate.extendsQualified || candidate.extends;
    if (!parentName || seen.has(parentName)) return undefined;
    seen.add(parentName);
    candidate = findManifestObjectByName(manifest, parentName, candidate);
  }

  return undefined;
}

function resolveDataInterfaceName(
  obj: SmartObjectDefinition,
  manifest: SmartObjectManifest,
): string {
  if (!isCollectionManifestClass(manifest, obj)) {
    return `${obj.className}Data`;
  }

  const itemObject = resolveCollectionItemObject(obj, manifest);
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
    const leftHasItem = resolveCollectionItemObject(left.obj, manifest);
    const rightHasItem = resolveCollectionItemObject(right.obj, manifest);
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
  const candidates = Object.entries(manifest.objects).map(
    ([objectName, obj]): ManifestCandidate => ({ objectName, obj }),
  );
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
    };
  });
}
