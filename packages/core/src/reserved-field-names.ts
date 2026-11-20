/**
 * Field names a model instance keeps for its own state.
 *
 * `options` holds an instance's service options (database, AI client,
 * configuration). A registered field of that name can never be row data on the
 * instance: it is not applied by the constructor or row hydration, not saved,
 * not returned as a field value by `getFields()`, and not assigned by
 * `collection.update()` or `getOrUpsert()`. Registration still accepts the name
 * (rejecting it there would break builds that declare it), so each model that
 * declares it is told once.
 *
 * Internal: not re-exported from the package entry points.
 */
import { createLogger } from '@happyvertical/logger';

const logger = createLogger({ level: 'info' });

/** The reserved field name. */
export const RESERVED_INSTANCE_FIELD = 'options';

/** Whether a field name is reserved for the instance's own state. */
export function isReservedInstanceField(name: string): boolean {
  return name === RESERVED_INSTANCE_FIELD;
}

/** Models already told; keyed by constructor so same-named classes differ. */
const warnedModels = new WeakSet<object>();

/**
 * Say once per model class that its field named `options` is never treated as
 * row data. `model` names the class by its qualified name.
 */
export function warnReservedInstanceField(
  modelClass: object,
  model: string,
): void {
  if (warnedModels.has(modelClass)) return;
  warnedModels.add(modelClass);
  logger.warn(
    `${model} declares a field named "${RESERVED_INSTANCE_FIELD}". That name is reserved for the instance's service options, so the field is neither saved, loaded, returned as a field value nor assigned by an update. Rename the field.`,
  );
}
