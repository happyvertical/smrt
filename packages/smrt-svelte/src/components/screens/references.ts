/** Shared reference resolution: identities come from edges, names from owning-model metadata. */
import { targetOf } from './relations.js';
import type {
  ScreenCollectionDefinition,
  ScreenField,
  ScreenRecord,
  ScreenReferenceSource,
  ScreenReferenceSources,
} from './types.js';

export function screenReferenceTarget(
  definition: ScreenCollectionDefinition,
  field: Pick<ScreenField, 'name'>,
  references: ScreenReferenceSources,
): ScreenReferenceSource | undefined {
  const edge = definition.relationships?.find(
    (edge) =>
      edge.field === field.name &&
      (edge.kind === 'foreignKey' || edge.kind === 'crossPackageRef'),
  );
  if (!edge) return undefined;
  return targetOf(references, edge.relatedCollection);
}

/** No screen-specific name/title heuristics: the manifest has already resolved the label. */
export function screenRecordLabel(
  definition: ScreenCollectionDefinition,
  record: ScreenRecord,
): string | undefined {
  const field = definition.displayLabelField;
  if (!field || !Object.hasOwn(definition.fields, field)) return undefined;
  const value = record[field];
  return (typeof value === 'string' || typeof value === 'number') &&
    String(value).trim()
    ? String(value)
    : undefined;
}

export function screenReferenceId(value: unknown): string | undefined {
  return (typeof value === 'string' || typeof value === 'number') &&
    String(value) !== ''
    ? String(value)
    : undefined;
}
