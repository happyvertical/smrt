// Without a registered table authorizer, the generated `_changes` / `_events`
// routes serve every signed-in principal the tables of the models a list
// route would serve. The shell has one person: only the owner reads the
// change feed, and this authorizer replaces that default.
import {
  ObjectRegistry,
  setChangeFeedAuthorizer,
} from '@happyvertical/smrt-core';
import { shellProfile } from './host.ts';
import { isOwner, principalFromLocals } from './owner.ts';
import { hostedOnlyTables, TENANT_SCOPED_TABLES } from './schema.ts';

export async function authorizeChangeFeedForOwner(request: {
  locals: unknown;
  tables: string[] | undefined;
}): Promise<string[]> {
  const principal = principalFromLocals((request.locals ?? {}) as never);
  if (!(await isOwner(principal))) return [];
  // Hosted: one owner owns one tenant, not the deployment. The registry also
  // holds the deployment-wide tables (accounts, tenants, memberships, every
  // tenant's inference overrides, secrets metadata), which are no tenant's to
  // read; only the shell's own tenant-scoped tables are offered.
  const hosted = (await shellProfile()) === 'cloud';
  const all = hosted
    ? [...TENANT_SCOPED_TABLES]
    : // The desktop has none of the hosted-only tables (plans, subscriptions,
      // feature overrides): never offer them.
      Object.values(ObjectRegistry.getAllSchemasAsDefinitions())
        .map((s) => s.tableName)
        .filter((t) => !hostedOnlyTables().has(t));
  return request.tables ? all.filter((t) => request.tables?.includes(t)) : all;
}

export function installChangeFeedPolicy(): void {
  setChangeFeedAuthorizer(authorizeChangeFeedForOwner);
}
