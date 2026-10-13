/**
 * Pure derivation of a model's relations from the generated web collection
 * definitions (#3718 record view).
 *
 * A `children` relation is another collection whose `foreignKey` /
 * `crossPackageRef` edge targets this model (a tab of the record page's
 * related records); an `items` relation is a `children` one whose rows are
 * this record's line items (the line-items table); a `reference` relation is one of this model's
 * own FK fields (rendered as a link on the detail). Edges whose target or
 * source is not in `definitions` are skipped: an unexposed model has neither
 * a definition nor a route, so nothing could be linked.
 */
import type { RecordListColumn } from '../overview/widgets/data.js';
import { lineItemColumns, relatedColumns } from './columns.js';
import { humanizeLabel, screenTitles } from './fields.js';
import { deriveFieldRoles, hasLineItemRoles } from './roles.js';
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
  /**
   * `items` is a `children` relation whose children are this record's line
   * items: the edge says so (`relationships[].role: 'items'`), or the child
   * has line-item roles (a quantity and a money field).
   */
  kind: 'children' | 'reference' | 'items';
  /**
   * `children` / `items` only: the table columns for the child model, chosen
   * by role (`relatedColumns`; `lineItemColumns` for items), the FK back to
   * this model excluded.
   */
  columns?: readonly RecordListColumn[];
  /** `items` only: the child field lines are ordered by (`sortOrder`, ..., else `createdAt`). */
  sort?: string;
}

const LINE_ORDER_FIELDS = ['sortOrder', 'position', 'lineNumber', 'sequence'];

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
 * `items` come first, then `children`, each sorted by label; `reference`
 * relations follow in declaration order. A child with two FKs to the same
 * parent yields two relations, labelled `Orders (Owner)` /
 * `Orders (Approver)` (and is only `items` when an edge says so).
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
    const lineLike = hasLineItemRoles(roles);
    const list: ScreenRelation[] = edges.map((edge) => {
      const label =
        edges.length > 1
          ? `${titles.plural} (${fieldLabel(edge.field, child)})`
          : titles.plural;
      if (edge.role === 'items' || (lineLike && edges.length === 1)) {
        return {
          model: child.objectRef,
          field: edge.field,
          label,
          kind: 'items',
          columns: lineItemColumns(child, roles, { exclude: [edge.field] }),
          sort:
            LINE_ORDER_FIELDS.find((name) => name in child.fields) ??
            'createdAt',
        };
      }
      return {
        model: child.objectRef,
        field: edge.field,
        label,
        kind: 'children',
        columns: relatedColumns(child, roles, { exclude: [edge.field] }),
      };
    });
    if (list.length > 0) perChild.set(child.objectRef, list);
  }
  for (const list of perChild.values()) children.push(...list);
  children.sort(
    (a, b) =>
      Number(b.kind === 'items') - Number(a.kind === 'items') ||
      a.label.localeCompare(b.label),
  );

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
