/**
 * The planner's catalog models as the generated record screens take them
 * (`@happyvertical/smrt-svelte/screens`, smrt#3718): a
 * `ScreenCollectionDefinition` is the browser-safe collection definition a
 * SMRT build emits, and the planner has the same facts in `catalog.json`. The
 * applied recipe options (which fields a view shows, their labels and help)
 * travel as the `ScreenPolicy`, so a field renders only when the policy lists
 * it, as on a generated screen.
 *
 * The facts the catalog has beyond a generated definition travel as the
 * field roles' hints: `enum` (a status select, a badge), `format` (`money`
 * by the planner's `isMoneyField`, `date` for business dates), `display`
 * (the field a record is named by) and `role: 'items'` on the relationship
 * edges of line items, so the record page shows them as its line-items table.
 */
import type {
  ScreenCollectionDefinition,
  ScreenFieldDefinition,
  ScreenFieldType,
  ScreenPolicy,
  ScreenRelationshipDefinition,
} from '@happyvertical/smrt-svelte/screens';
import { catalog, getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import { isLineModel } from '../data/derived.ts';
import { labelFields } from '../data/display.ts';
import { isMoneyField } from '../data/fakes.ts';
import { itemModels } from '../recipes/plumbing.ts';
import type { ViewField } from '../recipes/policy.ts';

const FIELD_TYPES: readonly ScreenFieldType[] = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'datetime',
  'json',
  'foreignKey',
  'crossPackageRef',
];

function fieldType(type: string): ScreenFieldType {
  return (FIELD_TYPES as readonly string[]).includes(type)
    ? (type as ScreenFieldType)
    : 'text';
}

/**
 * A business date is a day, not a moment: `issueDate`, `dueDate`,
 * `periodStart`. A model that books a time of day (`allDay`: events) keeps
 * its dates as datetimes, as do `...At` timestamps.
 */
const DATE_NAME = /(Date|^date|period(Start|End))$/;

function dateFormat(model: CatalogModel, field: CatalogField) {
  return field.type === 'datetime' &&
    !field.system &&
    DATE_NAME.test(field.name) &&
    !model.fields.some((f) => f.name === 'allDay')
    ? 'date'
    : undefined;
}

/**
 * The field a record of the model is named by (see `recordName`), when it
 * has a name of its own: the framework's `title` role. A document (an order)
 * has none; the field roles find its identifier and the header leads with it.
 */
export function displayFieldOf(model: CatalogModel): string | undefined {
  return labelFields(model)[0];
}

function fieldDefinition(
  model: CatalogModel,
  field: CatalogField,
): ScreenFieldDefinition {
  const ui = field.ui ? { ...field.ui } : undefined;
  const format = isMoneyField(field) ? 'money' : dateFormat(model, field);
  return {
    type: fieldType(field.type),
    required: field.required,
    nullable: !field.required,
    ...(field.default !== undefined ? { default: field.default } : {}),
    ...(field.description ? { description: field.description } : {}),
    ...(ui ? { ui } : {}),
    ...(field.enum?.length ? { enum: [...field.enum] } : {}),
    ...(format ? { format } : {}),
    ...(displayFieldOf(model) === field.name ? { display: true } : {}),
  };
}

/** A field's `related` as a qualified name, given the model it is declared on. */
function qualify(related: string, ownerId: string): string {
  return related.includes(':')
    ? related
    : `${ownerId.slice(0, ownerId.lastIndexOf(':'))}:${related}`;
}

/**
 * Does `model` hold the line items of what `field` points at? A priced child
 * record (`ContractLineItem`, `InvoiceLineItem`: quantity, unit price,
 * amount) named after its target (`itemModels`): a line's `contractId` is
 * its document, its `productId` only what it sells.
 */
function isItemsEdge(model: CatalogModel, field: CatalogField): boolean {
  if (!field.related) return false;
  const target = qualify(field.related, model.id);
  return itemModels(catalog, target, isLineModel).some(
    (child) => child.id === model.id,
  );
}

/** The model's reference fields as the definition's relationship edges. */
function relationships(model: CatalogModel): ScreenRelationshipDefinition[] {
  return model.fields.flatMap((field) => {
    if (
      (field.type !== 'foreignKey' && field.type !== 'crossPackageRef') ||
      !field.related
    ) {
      return [];
    }
    const target = getModelByQualifiedName(qualify(field.related, model.id));
    return target
      ? [
          {
            field: field.name,
            kind:
              field.type === 'crossPackageRef'
                ? 'crossPackageRef'
                : 'foreignKey',
            relatedCollection: target.model.collection,
            ...(isItemsEdge(model, field) ? { role: 'items' as const } : {}),
          },
        ]
      : [];
  });
}

/**
 * The model's own fields (and reference edges) as a screen collection
 * definition, keyed by its collection name like a generated one.
 */
export function screenDefinition(
  model: CatalogModel,
): ScreenCollectionDefinition {
  const edges = relationships(model);
  return {
    name: model.collection,
    objectRef: model.id,
    className: model.name,
    idField: 'id',
    fields: Object.fromEntries(
      model.fields.map((field) => [field.name, fieldDefinition(model, field)]),
    ),
    ...(edges.length ? { relationships: edges } : {}),
  };
}

/**
 * The fields a view shows, with the recipe options' labels and help, as the
 * screens' resolved policy: everything listed is `basic`, in list order, and
 * a field the applied options hide is simply not in it.
 */
export function screenPolicy(
  model: CatalogModel,
  fields: readonly ViewField[],
): ScreenPolicy {
  return {
    objectRef: model.id,
    fields: Object.fromEntries(
      fields.map((field, order) => [
        field.name,
        {
          visibility: 'basic' as const,
          label: field.label,
          help: field.help ?? null,
          order,
          required: field.required,
        },
      ]),
    ),
  };
}
