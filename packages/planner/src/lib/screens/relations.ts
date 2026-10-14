/**
 * What a record's view page relates it to, from the catalog's foreign keys
 * (smrt#3718 record view): `children` are the models whose rows point at the
 * record (a customer's orders, quotes and invoices), `items` the priced
 * child records that make up the record itself (an order's line items, from
 * the plumbing rules' `childModels`), `reference` the records the record
 * itself points at (an order's customer).
 * Children count only from models in the visitor's app (an added recipe's
 * models and the added features); references list every target the catalog
 * has, so a field pointing outside the app (a customer's Profile) still
 * shows its record's name. Whether a reference links is the view's call
 * (`RecordView` links only targets in the app). Generic for every model;
 * nothing here names one.
 *
 * The planner derives these from the catalog rather than through the
 * framework's `deriveScreenRelations`, which reads a definition's
 * `relationships` by collection name: the catalog also knows a model's STI
 * parent (`Order` extends `Contract`), so an order's line items
 * (`ContractLineItem.contractId`) are its children too, as `childLinks`
 * already treats them. The shape is the framework's `ScreenRelation`.
 */
import {
  lineItemColumns,
  relatedColumns,
} from '@happyvertical/smrt-svelte/overview';
import {
  deriveFieldRoles,
  type ScreenRelation,
} from '@happyvertical/smrt-svelte/screens';
import type { Catalog, CatalogModel } from '../catalog/types.ts';
import { isLineModel } from '../data/derived.ts';
import { humanize } from '../data/format.ts';
import {
  childTitle,
  forwardLinks,
  itemModels,
  lineageNames,
  reverseLinks,
} from '../recipes/plumbing.ts';
import type { Recipe } from '../recipes/types.ts';
import { screenDefinition } from './definition.ts';

export type { ScreenRelation };

/** The models the visitor's app has: the added recipes' and the features. */
export function appModels(
  added: readonly Recipe[],
  features: readonly string[],
): Set<string> {
  const ids = new Set<string>(features);
  for (const recipe of added) for (const id of recipe.models) ids.add(id);
  return ids;
}

/** "Customer" for `customerId`, "From location" for `fromLocationId`. */
export function referenceLabel(field: string): string {
  return humanize(field.replace(/_?id$/i, '') || field);
}

/**
 * The record screen's relations for `modelId`, children first (catalog
 * order, confined to `inApp`), then references (every catalog target). A
 * child pointing at the model through several fields gets one relation per
 * field, told apart by the field's name.
 */
export function screenRelations(
  catalog: Catalog,
  modelId: string,
  inApp: ReadonlySet<string>,
): ScreenRelation[] {
  const parents = lineageNames(catalog, modelId);
  const children = reverseLinks(catalog, modelId).filter(
    (link) => link.model.exposed && inApp.has(link.model.id),
  );
  // Line items live inside the record: its line-items table, not a tab.
  const items = new Set(
    itemModels(catalog, modelId, isLineModel).map((m) => m.id),
  );
  const perModel = new Map<string, number>();
  for (const link of children) {
    perModel.set(link.model.id, (perModel.get(link.model.id) ?? 0) + 1);
  }
  const relations: ScreenRelation[] = children.map((link) => {
    const kind = items.has(link.model.id) ? 'items' : 'children';
    // The table columns by role, as the framework's `deriveScreenRelations`
    // attaches them: a line-items table, or a related-records tab.
    const definition = screenDefinition(link.model);
    const roles = deriveFieldRoles(definition);
    const exclude = [link.fk];
    return {
      model: link.model.id,
      field: link.fk,
      label:
        (perModel.get(link.model.id) ?? 0) > 1
          ? `${childTitle(link.model.name, parents)} (${referenceLabel(link.fk).toLowerCase()})`
          : childTitle(link.model.name, parents),
      kind,
      columns:
        kind === 'items'
          ? lineItemColumns(definition, roles, { exclude })
          : // Identifier, status, date, party and the amount: the framework's
            // default four would drop the amount for a second party.
            relatedColumns(definition, roles, { exclude, max: 5 }),
      // Lines keep the order they were entered in.
      ...(kind === 'items' && 'sortOrder' in definition.fields
        ? { sort: 'sortOrder' }
        : {}),
    };
  });
  for (const link of forwardLinks(catalog, modelId)) {
    relations.push({
      model: link.model.id,
      field: link.fk,
      label: referenceLabel(link.fk),
      kind: 'reference',
    });
  }
  return relations;
}

/** The catalog model a relation names, when the catalog has it. */
export function relationModel(
  catalog: Catalog,
  relation: ScreenRelation,
): CatalogModel | undefined {
  for (const pkg of catalog.packages) {
    const model = pkg.models.find((m) => m.id === relation.model);
    if (model) return model;
  }
  return undefined;
}
