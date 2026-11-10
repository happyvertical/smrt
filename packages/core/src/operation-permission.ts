/** Server-authored custom-action permission aliases shared by every transport. */
export interface OperationPermissionAlias {
  /** Existing CRUD permission in the same collection; never a permission bypass. */
  action: 'read' | 'create' | 'update' | 'delete';
  /** Additional SQL policy actions this permission needs for the custom method. */
  databaseActions?: ('SELECT' | 'INSERT' | 'UPDATE' | 'DELETE')[];
}

/** Resolve one explicit action alias; malformed declarations fail closed. */
export function resolveOperationPermissionAlias(
  config: unknown,
  action: string,
): OperationPermissionAlias | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const aliases = (config as { operationPermissions?: unknown })
    .operationPermissions;
  if (aliases === undefined) return undefined;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new Error('operationPermissions must be an action map');
  }
  if (!Object.hasOwn(aliases, action)) return undefined;
  if (['list', 'get', 'read', 'create', 'update', 'delete'].includes(action)) {
    throw new Error('CRUD permissions cannot be aliased');
  }
  const alias = (aliases as Record<string, unknown>)[action];
  if (!alias || typeof alias !== 'object' || Array.isArray(alias)) {
    throw new Error('Invalid operation permission alias');
  }
  const value = alias as OperationPermissionAlias;
  if (
    !['read', 'create', 'update', 'delete'].includes(value.action) ||
    Object.keys(alias).some(
      (key) => key !== 'action' && key !== 'databaseActions',
    ) ||
    (value.databaseActions !== undefined &&
      (!Array.isArray(value.databaseActions) ||
        value.databaseActions.some(
          (entry) => !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(entry),
        )))
  ) {
    throw new Error('Invalid operation permission alias');
  }
  return value;
}
