import type { ForeignKeyAction } from './types.js';

const FOREIGN_KEY_ACTIONS = new Set<ForeignKeyAction>([
  'CASCADE',
  'SET NULL',
  'RESTRICT',
  'NO ACTION',
]);

/** Normalize decorator action spelling into the SQL vocabulary. */
export function normalizeForeignKeyAction(
  value: unknown,
): ForeignKeyAction | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase().replace(/_/g, ' ');
  return FOREIGN_KEY_ACTIONS.has(normalized as ForeignKeyAction)
    ? (normalized as ForeignKeyAction)
    : undefined;
}

/** Validate an externally supplied action rather than interpolating raw SQL. */
export function requireForeignKeyAction(
  value: unknown,
  context: string,
): ForeignKeyAction {
  const normalized = normalizeForeignKeyAction(value);
  if (!normalized) {
    throw new Error(
      `Invalid foreign-key action ${JSON.stringify(value)} for ${context}. Expected CASCADE, SET NULL, RESTRICT, or NO ACTION.`,
    );
  }
  return normalized;
}

/**
 * Resolve the one delete policy shared by app-side cascade and database DDL.
 *
 * A same-package reference that identifies the referencing row defaults to
 * CASCADE. Tenant ids are scope markers rather than ownership edges, and all
 * other references default to SQL NO ACTION.
 */
export function resolveForeignKeyDeleteAction(options: {
  declared?: unknown;
  isConflictColumn: boolean;
  isTenantIdField: boolean;
}): { action: ForeignKeyAction; declared: boolean } {
  const declaredAction =
    options.declared === undefined
      ? undefined
      : requireForeignKeyAction(options.declared, 'ON DELETE');
  if (declaredAction) {
    return { action: declaredAction, declared: true };
  }
  return {
    action:
      !options.isTenantIdField && options.isConflictColumn
        ? 'CASCADE'
        : 'NO ACTION',
    declared: false,
  };
}
