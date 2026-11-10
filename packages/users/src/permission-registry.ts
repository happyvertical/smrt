/** Portable permission metadata declarations. Registration describes a catalog entry; it never grants authority. */
import { getRuntimePermissionRegistrations } from './permission-registry-state.js';

export type PermissionCatalogSource = 'manifest' | 'config' | 'runtime';

export type PostgresPermissionAction =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE';

export interface PostgresPermissionBinding {
  action: Lowercase<PostgresPermissionAction> | PostgresPermissionAction;
  permission?: string;
  schemaName?: string;
  tableName: string;
  tenantField?: string;
}

export interface PermissionDefinition {
  category?: string;
  className?: string;
  collection?: string;
  description?: string;
  name?: string;
  postgres?: {
    bindings?: PostgresPermissionBinding[];
  };
  qualifiedName?: string;
  slug: string;
  source?: PermissionCatalogSource;
}

export function registerPermissionDefinitions(
  definitions: PermissionDefinition[],
): () => void {
  globalThis.__smrtUsersPermissionRegistrationCounter =
    (globalThis.__smrtUsersPermissionRegistrationCounter ?? 0) + 1;
  const registrationId = globalThis.__smrtUsersPermissionRegistrationCounter;
  getRuntimePermissionRegistrations().set(registrationId, definitions);

  return () => {
    getRuntimePermissionRegistrations().delete(registrationId);
  };
}
