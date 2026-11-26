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
import { createHash } from 'node:crypto';
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
 * The permission slugs each shell table's policy admits, per command. Every
 * table admits the store marker. `Approval` also admits `approvals.read` for
 * SELECT: its generated `POST /api/approvals/[id]/decide` route loads the row
 * through the request's own RLS database (the session's permissions, never the
 * store marker) before `assertOwner()` runs, so without it the owner's decision
 * would be a 404. The route's only other gate is `assertOwner()`, and no other
 * generated surface of `Approval` reads a row (`api`/`mcp` list only `decide`
 * and the static `pending`); `shell-routes.test.ts` pins that set.
 */
export function shellPolicySlugs(
  className: string,
): Record<'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE', string[]> {
  const marker = [SHELL_STORE_PERMISSION];
  return {
    SELECT: className === 'Approval' ? [...marker, 'approvals.read'] : marker,
    INSERT: marker,
    UPDATE: marker,
    DELETE: marker,
  };
}

const POLICY_HELPERS = [
  'smrt_rls_bypass',
  'smrt_current_tenant_id',
  'smrt_has_permission',
];

/** The policy scope the generator is run with, for a schema. */
function policyScope(schemaName: string) {
  return {
    schemaName,
    includeClass: (c: { className: string; qualifiedName?: string }) =>
      c.qualifiedName?.startsWith(SHELL_PACKAGE) === true &&
      (SHELL_TENANT_MODELS as readonly string[]).includes(c.className),
    permissionsFor: (c: { className: string }) => shellPolicySlugs(c.className),
  };
}

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The digest of what the generator would run: the code's whole expected policy set. */
export async function shellPolicyDigest(schemaName: string): Promise<string> {
  return expectedDigest(schemaName);
}

async function expectedDigest(schemaName: string): Promise<string> {
  const { generatePostgresPermissionSql } = await import(
    '@happyvertical/smrt-users/postgres-policies'
  );
  return digest(
    generatePostgresPermissionSql({}, policyScope(schemaName)).statements,
  );
}

const qualified = (schema: string, table: string) =>
  `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;

/**
 * The digest of what the catalog holds for one table right now: row-level
 * security flags, EVERY policy on it (name, command, permissive, roles, the
 * normalized USING and WITH CHECK expressions) and the bodies of the helper
 * functions the policies call. An extra, missing or edited policy, or a helper
 * rewritten behind the policies' back, changes it.
 */
async function liveDigest(
  db: Queryable,
  schema: string,
  table: string,
): Promise<string> {
  const row = rowsOf(
    await db.query(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT coalesce(json_agg(json_build_array(p.polname, p.polcmd, p.polpermissive, p.polroles::text, pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) ORDER BY p.polname), '[]'::json)::text
                 FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
              (SELECT coalesce(json_agg(json_build_array(f.proname, f.prosrc) ORDER BY f.proname), '[]'::json)::text
                 FROM pg_proc f WHERE f.pronamespace = to_regnamespace(${quote(schema)})
                  AND f.proname IN (${POLICY_HELPERS.map(quote).join(', ')})) AS helpers
         FROM pg_class c WHERE c.oid = to_regclass(${quote(qualified(schema, table))})`,
    ),
  )[0];
  return digest([row?.rls, row?.forced, row?.policies, row?.helpers]);
}

const STAMP_PREFIX = 'smrt-app-shell:rls:';

/**
 * The ordered version of the shell's policy set. BUMP IT whenever the policy
 * text changes (a predicate, a slug, a helper body): the stamp carries it, so
 * a host only re-applies when its version is newer than, or equal to, the one
 * in the database, and an old-release replica restarting mid-rollout leaves a
 * newer set alone instead of putting the older one back. A unit test pins the
 * expected policy digest to this number, so changing the text without bumping
 * it fails.
 */
export const SHELL_RLS_POLICY_VERSION = 1;

const STAMP_PATTERN =
  /^smrt-app-shell:rls:(?:v(\d+):)?([0-9a-f]{64}):([0-9a-f]{64})$/;

/** What the stamps say about the database's policies, relative to this host. */
export type ShellPolicyStatus = 'current' | 'stale' | 'newer';

/**
 * Whether every shell table is exactly what applying the policies would leave:
 * the table's stamp (written with the policies, in the same transaction) names
 * the policy version, the digest of the expected policy set AND the digest of
 * what the catalog held when it was written, and the catalog still digests the
 * same. Any difference (a changed predicate, a removed slug, an extra or
 * missing policy, a rewritten helper, an older version) is `stale`: the
 * policies are re-applied. A stamp from a NEWER version on any table is
 * `newer`: this host is an older release and must not put its policies back.
 * A stamp with no version (written before versioning) is version 0.
 */
export async function shellPolicyStatus(
  db: Queryable,
  version: number = SHELL_RLS_POLICY_VERSION,
): Promise<ShellPolicyStatus> {
  const schema = await currentSchema(db);
  const expected = await expectedDigest(schema);
  let status: ShellPolicyStatus = 'current';
  for (const table of shellTables().keys()) {
    const stamp = String(
      rowsOf(
        await db.query(
          `SELECT obj_description(to_regclass(${quote(qualified(schema, table))}), 'pg_class') AS stamp`,
        ),
      )[0]?.stamp ?? '',
    );
    const m = STAMP_PATTERN.exec(stamp);
    const stamped = m ? Number(m[1] ?? 0) : -1;
    if (stamped > version) return 'newer';
    if (!m || stamped !== version) {
      status = 'stale';
      continue;
    }
    const live = await liveDigest(db, schema, table);
    if (m[2] !== expected || m[3] !== live) status = 'stale';
  }
  return status;
}

/** Whether the policies are exactly the current version's, as applied. */
export async function shellPoliciesCurrent(
  db: Queryable,
  version: number = SHELL_RLS_POLICY_VERSION,
): Promise<boolean> {
  return (await shellPolicyStatus(db, version)) === 'current';
}

/** Write the stamp of the policies just applied (inside the same transaction). */
async function stampPolicies(
  db: Queryable,
  schema: string,
  version: number,
): Promise<void> {
  const expected = await expectedDigest(schema);
  for (const table of shellTables().keys()) {
    const live = await liveDigest(db, schema, table);
    await db.query(
      `COMMENT ON TABLE ${qualified(schema, table)} IS ${quote(`${STAMP_PREFIX}v${version}:${expected}:${live}`)}`,
    );
  }
}

/** Take the apply's lock, so two starting replicas never interleave their DDL. */
const APPLY_LOCK = "hashtext('smrt-app-shell:shell-rls')";

/** Drop any policy on a shell table that the expected statements do not create. */
async function dropUnexpectedPolicies(
  db: Queryable,
  schema: string,
  statements: string[],
): Promise<void> {
  const expected = new Set(
    statements
      .map((sql) => /^CREATE POLICY "([^"]+)" ON/.exec(sql)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  for (const table of shellTables().keys()) {
    const found = rowsOf(
      await db.query(
        `SELECT p.polname AS name FROM pg_policy p WHERE p.polrelid = to_regclass(${quote(qualified(schema, table))})`,
      ),
    );
    for (const { name } of found)
      if (!expected.has(String(name)))
        await db.query(
          `DROP POLICY "${String(name).replace(/"/g, '""')}" ON ${qualified(schema, table)}`,
        );
  }
}

/**
 * Enable and force row-level security on every shell table and (re)create the
 * policies, as the table owner (the deployment's admin login), then read the
 * catalog back: a table still without them, or a login that bypasses them,
 * is reported. Run at every cloud start after `smrt db:migrate` made the
 * tables; PostgreSQL only.
 *
 * Live traffic is never touched when nothing changed: the catalog is read
 * first and the DDL runs only when a table lacks the current policies. When it
 * does run it is ONE transaction under an advisory lock with a lock timeout
 * (a rolling deploy's second replica waits, re-checks and finds it done; no
 * reader ever sees a table between DROP and CREATE POLICY).
 *
 * Throws when a shell table does not exist (run `smrt db:migrate`). Returns the
 * problems found (empty when every table is protected and the login is subject
 * to the policies).
 */
export async function applyShellRls(
  db: Queryable,
  options: {
    /** Override the policy version (tests simulate another release). */
    version?: number;
    warn?: (entry: Record<string, unknown>) => void;
  } = {},
): Promise<string[]> {
  requireShellTenancy();
  const version = options.version ?? SHELL_RLS_POLICY_VERSION;
  const schemaName = await currentSchema(db);
  const tables = shellTables();
  const present = new Set((await shellRlsState(db)).map((s) => s.table));
  const absent = [...tables.keys()].filter((t) => !present.has(t));
  if (absent.length)
    throw new Error(
      `the shell tables ${absent.join(', ')} do not exist: run smrt db:migrate first`,
    );
  const { applyScopedPostgresPermissionPolicies } = await import(
    '@happyvertical/smrt-users/postgres-policies'
  );
  const scope = policyScope(schemaName);
  let result:
    | Awaited<ReturnType<typeof applyScopedPostgresPermissionPolicies>>
    | undefined;
  const initial = await shellPolicyStatus(db, version);
  if (initial === 'newer') warnNewer(options.warn, version);
  if (initial === 'stale') {
    const transaction = (
      db as {
        transaction?: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;
      }
    ).transaction;
    const apply = async (tx: Queryable) => {
      await tx.query("SELECT set_config('lock_timeout', '10s', true)");
      await tx.query(`SELECT pg_advisory_xact_lock(${APPLY_LOCK})`);
      // Another replica may have applied while this one waited.
      const again = await shellPolicyStatus(tx, version);
      if (again === 'current') return undefined;
      if (again === 'newer') {
        warnNewer(options.warn, version);
        return undefined;
      }
      const applied = await applyScopedPostgresPermissionPolicies(tx, scope);
      // Policies not in the expected set (an extra one) are dropped: the stamp
      // is only true of a table that holds exactly the expected policies.
      await dropUnexpectedPolicies(tx, schemaName, applied.statements);
      await stampPolicies(tx, schemaName, version);
      return applied;
    };
    result = (
      transaction ? await transaction.call(db, apply) : await apply(db)
    ) as typeof result;
  }
  const problems: string[] = [];
  const covered = new Set((result?.targets ?? []).map((t) => t.tableName));
  for (const [table, model] of shellTables())
    if (result && !covered.has(table))
      problems.push(
        `no policy was generated for ${table} (${model}: ${
          (result?.skipped ?? [])
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

function warnNewer(
  warn: ((entry: Record<string, unknown>) => void) | undefined,
  version: number,
): void {
  (warn ?? ((e) => void process.stderr.write(`${JSON.stringify(e)}\n`)))({
    level: 'warn',
    event: 'shell-rls-policies-newer',
    message: `the database holds a newer shell policy set than this release (version ${version}); leaving it in place`,
    version,
  });
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
  let problems: string[];
  try {
    problems = await applyShellRls(db as Queryable, { warn });
  } catch (error) {
    // The runtime reports a failed start generically: say why here.
    warn({
      level: 'error',
      event: 'app-shell.database.rls-incomplete',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
