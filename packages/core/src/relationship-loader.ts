import { RuntimeError } from './errors';
import { ObjectRegistry, type RelationshipMetadata } from './registry';

/** Resolve the identity used for I/O, never the public display-name alias. */
export async function resolveRelationshipTargetName(
  relationship: RelationshipMetadata,
): Promise<string> {
  const source = relationship.sourceQualifiedClass ?? relationship.sourceClass;
  const resolve = () =>
    ObjectRegistry.resolveRelationshipTarget(source, relationship.fieldName);
  let target = resolve();
  if (target === null) {
    throw RuntimeError.invalidState(
      `Relationship target is unresolved or ambiguous for ${source}.${relationship.fieldName}`,
      { sourceClass: source, fieldName: relationship.fieldName },
    );
  }
  // A qualified external target can be known before its package is loaded.
  // Truly missing legacy string targets retain manifest auto-discovery, but an
  // unresolved exact constructor must never fall back to its display name.
  await ObjectRegistry.ensureManifestLoaded(target ?? relationship.targetClass);
  target = resolve();
  if (!target) {
    throw RuntimeError.invalidState(
      `Relationship target is unresolved or ambiguous for ${source}.${relationship.fieldName}`,
      { sourceClass: source, fieldName: relationship.fieldName },
    );
  }
  return target;
}

/** One inverse selection contract for lazy, eager and joined readers. */
export function resolveOneToManyInverse(
  sourceQualifiedName: string,
  relationship: RelationshipMetadata,
  targetQualifiedName: string,
): RelationshipMetadata {
  const candidates = ObjectRegistry.getInverseRelationshipsForSelf(
    sourceQualifiedName,
  ).filter(
    (candidate) =>
      candidate.type === 'foreignKey' &&
      candidate.sourceQualifiedClass === targetQualifiedName,
  );
  const explicit = relationship.options?.foreignKey;
  const selected = explicit
    ? candidates.find((candidate) => candidate.fieldName === explicit)
    : (candidates.find(
        (candidate) => candidate.targetQualifiedClass === sourceQualifiedName,
      ) ?? candidates[0]);
  if (!selected) {
    throw RuntimeError.invalidState(
      explicit
        ? `oneToMany ${relationship.fieldName} specifies foreignKey '${explicit}', but ${relationship.targetClass} has no matching inverse foreignKey. Candidates: ${candidates.map((candidate) => candidate.fieldName).join(', ') || '(none)'}`
        : `Could not find inverse foreignKey on ${relationship.targetClass} for oneToMany relationship ${relationship.fieldName}`,
      { sourceClass: sourceQualifiedName, fieldName: relationship.fieldName },
    );
  }
  return selected;
}
