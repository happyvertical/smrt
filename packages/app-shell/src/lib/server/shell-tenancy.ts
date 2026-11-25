// The shell's own tables in the cloud profile: `required` tenancy and
// row-level security (#5191, epic #5183).
//
// Two layers hold one owner's rows apart from another's in one deployment:
//
// 1. The application layer: every shell model runs in `required` tenancy mode
//    (a core runtime override, so the decorators stay `optional` and the
//    desktop is untouched). A read or write with no tenant context throws; it
//    never reads "everything".
// 2. The database layer (PostgreSQL only): every shell table has row-level
//    security enabled AND forced, with the policies `smrt-users` generates for
//    `required` models: a row is visible to a tenant when its `tenant_id`
//    equals `smrt.tenant_id` and `smrt.permissions` holds the store's slug.
//
// The shell's stores are long-lived (they outlive the request that made them)
// and run in the engine's queues, so they cannot use the request's RLS
// transaction. `tenantBoundDb` is the reviewed alternative: a handle whose
// every operation runs in its own short transaction that first publishes the
// ambient tenant (and the store slug) as the transaction-local `smrt.*`
// settings. With no tenant context it REFUSES; it never falls back to a
// context-free read. There is no system path: no shell code reads across
// tenants (a restart adopts one holder's draft inside that tenant), so a
// future one has to be added here, named and reviewed, not worked around.
import { AsyncLocalStorage } from 'node:async_hooks';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { postgresPrincipalSettings } from '@happyvertical/smrt-users/postgres-settings';
import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * The shell models that hold one owner's data (tenant-scoped, one table each).
 * `AppImport` is not here: it declares no tenancy (its `tenantId` is a plain
 * column the import code filters on) and workbook import is refused in cloud,
 * so its table stays empty there.
 */
export const SHELL_TENANT_MODELS = [
  'App',
  'AppVersion',
  'AppDraft',
  'AppDraftVersion',
  'Approval',
  'AssistantThread',
  'AssistantMessage',
  'ChangeBatch',
  'ChangeCard',
] as const;

/** Qualified-name prefix of the shell's own classes (a same-named class elsewhere is not ours). */
const SHELL_PACKAGE = '@happyvertical/smrt-app-shell:';

/**
 * The one permission slug the shell's policies check. It is not an owner's
 * permission (owner-only is `assertOwner`, in code); it marks a connection the
 * shell's stores opened for a tenant, so a connection that only carries a tenant
 * (another package's, a generated route's) sees nothing of these tables.
 */
export const SHELL_STORE_PERMISSION = 'smrt-app-shell.store';

let tenancyRequired = false;

/**
 * Put every shell model in `required` mode for this process (cloud only; the
 * desktop never calls it). Monotonic and process-wide by core's design. Throws
 * when a shell model is not registered, so a renamed class cannot leave a table
 * quietly outside the rule.
 */
export function requireShellTenancy(): void {
  if (tenancyRequired) return;
  for (const name of SHELL_TENANT_MODELS) {
    const registered = ObjectRegistry.getClass(name);
    const qualified = registered?.qualifiedName;
    if (!qualified?.startsWith(SHELL_PACKAGE))
      throw new Error(
        `the shell model ${name} is not registered, so its tenancy cannot be required`,
      );
    ObjectRegistry.registerOverride(qualified, {
      tenancy: { mode: 'required' },
    });
  }
  tenancyRequired = true;
}

/** Test seam: forget that the override was installed (the registry itself is reset by its own clear). */
export function resetShellTenancy(): void {
  tenancyRequired = false;
}

type Queryable = {
  query(sql: string, ...params: unknown[]): Promise<unknown>;
};
type TxDatabase = DatabaseInterface & Queryable;

/** Is `db` a PostgreSQL handle (a server or PGlite)? Every sdk adapter sets `engine`. */
export function isPostgresHandle(db: unknown): boolean {
  const engine = (db as { engine?: string } | null)?.engine;
  return engine === 'postgres' || engine === 'pglite';
}

interface Scope {
  tenantId: string | null;
  system: boolean;
}

function currentScope(): Scope {
  const tenantId = getCurrentTenant()?.tenantId ?? null;
  if (!tenantId)
    throw new Error(
      'the shell database was used with no tenant context (sign in first)',
    );
  return { tenantId, system: false };
}

/**
 * Publish a tenant (or the system context) to the transaction `tx` is, the way
 * every policy reads it. Transaction-local: gone at commit or rollback.
 */
export async function bindShellScope(
  tx: Queryable,
  scope: { tenantId: string | null; system?: boolean },
): Promise<void> {
  const settings = postgresPrincipalSettings({
    tenantId: scope.system ? null : scope.tenantId,
    userId: null,
    session: null,
    sessionId: null,
    permissions: [SHELL_STORE_PERMISSION],
    superAdminBypass: false,
    systemContext: scope.system === true,
  });
  for (const [name, value] of settings)
    await tx.query('SELECT set_config(?, ?, true)', [name, value]);
}

/** Bind the ambient tenant to a transaction the shell did not open (the hosted claim's). */
export async function bindAmbientShellScope(tx: unknown): Promise<void> {
  await bindShellScope(tx as Queryable, currentScope());
}

/** The calls that read or write rows through the handle. */
const DATA_METHODS = new Set<string>([
  'insert',
  'get',
  'list',
  'update',
  'upsert',
  'getOrInsert',
  'delete',
  'count',
  'many',
  'single',
  'pluck',
  'execute',
  'oo',
  'oO',
  'ox',
  'xx',
  'query',
  'tableExists',
]);

/** Handles that would reach rows outside a transaction that carries the tenant. */
const REFUSED_METHODS = new Set<string>([
  'table',
  'acquireSession',
  'beginTransaction',
]);

const inside = new AsyncLocalStorage<{ tx: DatabaseInterface; key: string }>();

const scopeKey = (scope: Scope) =>
  scope.system ? 'system' : `tenant:${scope.tenantId}`;

const bound = new WeakMap<object, DatabaseInterface>();

/**
 * The shell's database handle in the cloud profile on PostgreSQL: each
 * operation (or each `transaction()`) runs in a transaction that carries the
 * ambient tenant, resolved when the operation runs and not when the handle was
 * made, so a store that holds it for its whole life stays right. Inside such a
 * transaction the handle reuses it (no second connection, no deadlock on a
 * single-connection server); a different tenant inside is a new transaction.
 */
export function tenantBoundDb(base: DatabaseInterface): DatabaseInterface {
  const cached = bound.get(base);
  if (cached) return cached;
  const run = async <T>(
    fn: (tx: DatabaseInterface) => Promise<T>,
  ): Promise<T> => {
    const scope = currentScope();
    const key = scopeKey(scope);
    const active = inside.getStore();
    if (active && active.key === key) return fn(active.tx);
    const transaction = base.transaction;
    if (!transaction)
      throw new Error('the shell database cannot open a transaction');
    return (await transaction.call(base, async (tx) => {
      await bindShellScope(tx as TxDatabase, scope);
      return inside.run({ tx, key }, () => fn(tx));
    })) as T;
  };
  const handle = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        if (prop === 'transaction')
          return <T>(fn: (tx: DatabaseInterface) => Promise<T>) => run(fn);
        if (DATA_METHODS.has(prop))
          return (...args: unknown[]) =>
            run(
              (tx) =>
                (
                  tx as never as Record<
                    string,
                    (...a: unknown[]) => Promise<unknown>
                  >
                )[prop](...args) as Promise<never>,
            );
        if (REFUSED_METHODS.has(prop))
          return () => {
            throw new Error(
              `${prop}() is not available on the shell's tenant-bound database`,
            );
          };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DatabaseInterface;
  bound.set(base, handle);
  return handle;
}

/** What the catalog says about one shell table. */
export interface ShellRlsState {
  table: string;
  rls: boolean;
  forced: boolean;
  policies: number;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The rows of a raw result (adapters return `{ rows }` or the rows themselves). */
const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  ((Array.isArray(r) ? r : (r as { rows?: unknown[] })?.rows) ?? []) as Array<
    Record<string, unknown>
  >;

/** The schema the connection resolves unqualified names in (where the shell's tables are). */
async function currentSchema(db: Queryable): Promise<string> {
  const row = rowsOf(await db.query('SELECT current_schema() AS schema'))[0];
  const schema = String(row?.schema ?? '');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
    throw new Error('the shell database has no usable current schema');
  return schema;
}

/**
 * The state of every shell table read from the catalog: row-level security on,
 * forced, and the number of commands (select, insert, update, delete) that
 * have a policy. A table that does not exist is not listed.
 */
export async function shellRlsState(db: Queryable): Promise<ShellRlsState[]> {
  const schema = await currentSchema(db);
  const tables = shellTables();
  const found = rowsOf(
    await db.query(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(DISTINCT p.polcmd) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd IN ('r', 'a', 'w', 'd')) AS commands
         FROM pg_class c
        WHERE c.relnamespace = to_regnamespace(${quote(schema)}) AND c.relkind IN ('r', 'p')
          AND c.relname IN (${[...tables.keys()].map(quote).join(', ')})`,
    ),
  );
  return found.map((r) => ({
    table: String(r.name),
    rls: r.rls === true,
    forced: r.forced === true,
    policies: Number(r.commands),
  }));
}

/** The tables of the shell models, from the registry (never a list kept in step by hand). */
function shellTables(): Map<string, string> {
  const tables = new Map<string, string>();
  for (const name of SHELL_TENANT_MODELS) {
    const registered = ObjectRegistry.getClass(name);
    const table = registered?.schema?.tableName;
    if (!table)
      throw new Error(`the shell model ${name} has no table to protect`);
    tables.set(table, name);
  }
  return tables;
}

/**
 * Enable and force row-level security on every shell table and (re)create the
 * policies, as the table owner (the deployment's admin login), then read the
 * catalog back: a table still without them, or a login that bypasses them,
 * is reported. Idempotent; run at every cloud start after `smrt db:migrate`
 * made the tables. PostgreSQL only.
 *
 * Returns the problems found (empty when every table is protected and the
 * login is subject to the policies).
 */
export async function applyShellRls(db: Queryable): Promise<string[]> {
  requireShellTenancy();
  const schemaName = await currentSchema(db);
  const { applyScopedPostgresPermissionPolicies } = await import(
    '@happyvertical/smrt-users/postgres-policies'
  );
  const result = await applyScopedPostgresPermissionPolicies(db, {
    schemaName,
    includeClass: (c) =>
      c.qualifiedName?.startsWith(SHELL_PACKAGE) === true &&
      (SHELL_TENANT_MODELS as readonly string[]).includes(c.className),
    permissionsFor: () => ({
      SELECT: [SHELL_STORE_PERMISSION],
      INSERT: [SHELL_STORE_PERMISSION],
      UPDATE: [SHELL_STORE_PERMISSION],
      DELETE: [SHELL_STORE_PERMISSION],
    }),
  });
  const problems: string[] = [];
  const covered = new Set(result.targets.map((t) => t.tableName));
  for (const [table, model] of shellTables())
    if (!covered.has(table))
      problems.push(
        `no policy was generated for ${table} (${model}: ${
          result.skipped
            .filter((s) => s.className === model)
            .map((s) => s.reason)
            .join('; ') || 'not registered as tenant-scoped'
        })`,
      );
  const state = new Map((await shellRlsState(db)).map((s) => [s.table, s]));
  for (const table of shellTables().keys()) {
    const s = state.get(table);
    if (!s?.rls || !s.forced || s.policies !== 4)
      problems.push(`${table} is not under forced row-level security`);
  }
  const role = rowsOf(
    await db.query(
      'SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
    ),
  )[0];
  if (role?.bypass === true)
    problems.push(
      'the database login is a superuser or has BYPASSRLS, so the shell policies do not apply to it',
    );
  return problems;
}

/** The named opt-out for a login that bypasses row-level security (tests, local development). */
export const ALLOW_RLS_BYPASS_ENV = 'SMRT_UNSAFE_ALLOW_RLS_BYPASS';

/**
 * Cloud start-up: put the shell's tables under forced row-level security. A
 * table that cannot be protected refuses the start (reason on stderr first: the
 * runtime reports a failed start generically). So does a login that bypasses the
 * policies (a superuser, BYPASSRLS): many owners share this database, and such a
 * login silently removes every boundary between them. Only
 * `SMRT_UNSAFE_ALLOW_RLS_BYPASS=1` lets it start, and it says so loudly.
 */
export async function protectShellTables(
  db: unknown,
  options: {
    env?: Record<string, string | undefined>;
    warn?: (entry: Record<string, unknown>) => void;
  } = {},
): Promise<void> {
  if (!isPostgresHandle(db)) return;
  const warn =
    options.warn ??
    ((entry) => void process.stderr.write(`${JSON.stringify(entry)}\n`));
  const env = options.env ?? process.env;
  const problems = await applyShellRls(db as Queryable);
  const bypass = problems.filter((p) => /BYPASSRLS/.test(p));
  const broken = problems.filter((p) => !/BYPASSRLS/.test(p));
  if (bypass.length) {
    const allowed = env[ALLOW_RLS_BYPASS_ENV] === '1';
    warn({
      level: allowed ? 'warn' : 'error',
      event: allowed
        ? 'app-shell.database.rls-bypass-allowed'
        : 'app-shell.database.rls-bypass',
      message: allowed
        ? `${bypass.join('; ')}. Allowed by ${ALLOW_RLS_BYPASS_ENV}=1: NO owner is isolated from another. Never set this in a deployment.`
        : `${bypass.join('; ')}. Use a login with neither, or (tests, local development only) set ${ALLOW_RLS_BYPASS_ENV}=1.`,
    });
    if (!allowed)
      throw new Error('the shell database login bypasses row-level security');
  }
  if (broken.length) {
    warn({
      level: 'error',
      event: 'app-shell.database.rls-incomplete',
      message: broken.join('; '),
    });
    throw new Error('the shell tables are not under row-level security');
  }
}
