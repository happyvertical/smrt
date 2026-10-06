/**
 * Which input a field gets. Pure so the choice is testable without rendering:
 * `FieldInput.svelte` switches on the result and owns nothing else about it.
 *
 * Order matters: a field that references another model is a relation however
 * it is typed; a declared enum beats a widget hint; a hint beats the plain
 * type; money is an integer field whose name says so (`isMoneyField`).
 */
import type { CatalogField } from '../catalog/types.ts';
import { isMoneyField } from '../data/fakes.ts';
import { ADDRESS_FIELDS } from '../upstream/widgets.ts';

export type FieldRenderer =
  | 'boolean'
  | 'relation'
  | 'enum'
  | 'textarea'
  | 'currency'
  | 'email'
  | 'url'
  | 'phone'
  | 'address'
  | 'money'
  | 'datetime'
  | 'integer'
  | 'decimal'
  | 'json'
  | 'text';

/** A field that references another model, by manifest type or `related`. */
export function isRelation(field: CatalogField): boolean {
  return (
    (field.type === 'foreignKey' || field.type === 'crossPackageRef') &&
    typeof field.related === 'string'
  );
}

/**
 * @param modelId the qualified name of the model that owns the field, which
 *   the address hint is keyed by (see `upstream/widgets.ts`).
 */
export function chooseRenderer(
  field: CatalogField,
  modelId?: string,
): FieldRenderer {
  if (field.type === 'boolean') return 'boolean';
  if (isRelation(field)) return 'relation';
  if (field.enum && field.enum.length > 0) return 'enum';
  if (field.ui?.widget) return field.ui.widget;
  if (
    field.type === 'json' &&
    modelId !== undefined &&
    (ADDRESS_FIELDS[modelId] ?? []).includes(field.name)
  ) {
    return 'address';
  }
  if (isMoneyField(field)) return 'money';
  switch (field.type) {
    case 'datetime':
      return 'datetime';
    case 'integer':
      return 'integer';
    case 'decimal':
      return 'decimal';
    case 'json':
      return 'json';
    default:
      return 'text';
  }
}
