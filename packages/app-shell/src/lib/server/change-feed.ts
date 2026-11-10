// The generated `_changes` / `_events` routes serve any signed-in principal
// unless a table authorizer is registered. The shell has one person; make
// that explicit: only the owner reads the change feed.
import {
  ObjectRegistry,
  setChangeFeedAuthorizer,
} from '@happyvertical/smrt-core';
import { isOwner, principalFromLocals } from './owner.ts';

export async function authorizeChangeFeedForOwner(request: {
  locals: unknown;
  tables: string[] | undefined;
}): Promise<string[]> {
  const principal = principalFromLocals((request.locals ?? {}) as never);
  if (!(await isOwner(principal))) return [];
  const all = Object.values(ObjectRegistry.getAllSchemasAsDefinitions()).map(
    (s) => s.tableName,
  );
  return request.tables ? all.filter((t) => request.tables?.includes(t)) : all;
}

export function installChangeFeedPolicy(): void {
  setChangeFeedAuthorizer(authorizeChangeFeedForOwner);
}
