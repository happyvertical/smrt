/**
 * Pure derivation of a model's relations from the generated web collection
 * definitions (#3718 record view).
 *
 * A `children` relation is another collection whose `foreignKey` /
 * `crossPackageRef` edge targets this model (its newest records make one
 * panel on the record view); a `reference` relation is one of this model's
 * own FK fields (rendered as a link on the detail). Edges whose target or
 * source is not in `definitions` are skipped: an unexposed model has neither
 * a definition nor a route, so nothing could be linked.
 */
import type { RecordListColumn } from '../overview/widgets/data.js';
import { relatedColumns } from './columns.js';
import { humanizeLabel, screenTitles } from './fields.js';
import { deriveFieldRoles } from './roles.js';
import type {
  ScreenCollectionDefinition,
  ScreenRelationshipDefinition,
} from './types.js';

export interface ScreenRelation {
  /** Qualified model id (`objectRef`) of the child (`children`) or target (`reference`). */
  model: string;
  /** FK field name on the child (`children`) or on this model (`reference`). */
  field: string;
  label: string;
  kind: 'children' | 'reference';
  /**
   * `children` only: the columns a related-records table shows for the child
   * model, chosen by role (`relatedColumns`, the FK back to this model
   * excluded).
   */
  columns?: readonly RecordListColumn[];
}

/**
 * A relation's stable key, `<Class>-<field>` (`Order-customerId`): what the
 * `related` widget's `relations` option lists and default widget ids end in.
 */
export function relationKey(
  relation: Pick<ScreenRelation, 'model' | 'field'>,
): string {
  const className = relation.model.split(/[:/]/).pop() ?? relation.model;
  return `${className}-${relation.field}`
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .slice(0, 64);
}

const FK_KINDS: ReadonlySet<ScreenRelationshipDefinition['kind']> = new Set([
  'foreignKey',
  'crossPackageRef',
]);

function fieldLabel(
  field: string,
  definition: ScreenCollectionDefinition,
): string {
  return humanizeLabel(field, definition.fields[field]);
}

/** Resolve a relationship target by `definitions` key, then by `name`. */
function targetOf(
  definitions: Readonly<Record<string, ScreenCollectionDefinition>>,
  collection: string,
): ScreenCollectionDefinition | undefined {
  return (
    definitions[collection] ??
    Object.values(definitions).find((d) => d.name === collection)
  );
}

/**
 * Relations of `model` (a qualified `objectRef`, or a key of `definitions`).
 * `children` come first, sorted by label; `reference` relations follow in
 * declaration order. A child with two FKs to the same parent yields two
 * relations, labelled `Orders (Owner)` / `Orders (Approver)`.
 */
export function deriveScreenRelations(
  definitions: Readonly<Record<string, ScreenCollectionDefinition>>,
  model: string,
): ScreenRelation[] {
  const self =
    Object.values(definitions).find((d) => d.objectRef === model) ??
    definitions[model];
  if (!self) return [];

  const children: ScreenRelation[] = [];
  const perChild = new Map<string, ScreenRelation[]>();
  for (const child of Object.values(definitions)) {
    const edges = (child.relationships ?? []).filter(
      (edge) =>
        FK_KINDS.has(edge.kind) &&
        edge.field in child.fields &&
        targetOf(definitions, edge.relatedCollection)?.objectRef ===
          self.objectRef,
    );
    const titles = screenTitles(child);
    const roles = edges.length > 0 ? deriveFieldRoles(child) : {};
    const list: ScreenRelation[] = edges.map((edge) => ({
      model: child.objectRef,
      field: edge.field,
      label:
        edges.length > 1
          ? `${titles.plural} (${fieldLabel(edge.field, child)})`
          : titles.plural,
      kind: 'children',
      columns: relatedColumns(child, roles, { exclude: [edge.field] }),
    }));
    if (list.length > 0) perChild.set(child.objectRef, list);
  }
  for (const list of perChild.values()) children.push(...list);
  children.sort((a, b) => a.label.localeCompare(b.label));

  const references: ScreenRelation[] = [];
  const seen = new Set<string>();
  for (const edge of self.relationships ?? []) {
    if (!FK_KINDS.has(edge.kind) || seen.has(edge.field)) continue;
    if (!(edge.field in self.fields)) continue;
    const target = targetOf(definitions, edge.relatedCollection);
    if (!target) continue;
    seen.add(edge.field);
    references.push({
      model: target.objectRef,
      field: edge.field,
      label: fieldLabel(edge.field, self),
      kind: 'reference',
    });
  }
  return [...children, ...references];
}
