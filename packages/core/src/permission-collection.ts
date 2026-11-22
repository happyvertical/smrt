/**
 * The collection segment of a model's operation permission slugs
 * (`<collection>.<action>`).
 *
 * One source for every path that checks an operation permission: the
 * generated SvelteKit CRUD, action and sync-apply routes (from the scanned
 * manifest) and the runtime REST server (from the registry). Pure: it reads
 * only the definition it is given.
 */

import type { SmartObjectDefinition } from './scanner/types.js';

/** The parts of a model definition the permission collection is read from. */
export type PermissionCollectionSource = Pick<
  SmartObjectDefinition,
  'collection' | 'permissionCollection'
> & { decoratorConfig?: unknown };

/**
 * The collection segment of generated operation permission slugs. Mirrors the
 * smrt-users `PermissionCatalogService` derivation: an explicit
 * `@smrt({ collection })` wins, then the manifest collection. A hosted STI
 * subclass moved to its own route collection keeps the STI base's slugs through
 * `permissionCollection` (#3770).
 */
export function resolvePermissionCollection(
  objectDef: PermissionCollectionSource,
): string {
  if (objectDef.permissionCollection) return objectDef.permissionCollection;
  const configured = (
    objectDef.decoratorConfig as { collection?: unknown } | undefined
  )?.collection;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : objectDef.collection;
}
