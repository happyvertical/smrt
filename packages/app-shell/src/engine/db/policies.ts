// Row-level security for the tables of an app's run-time models (#5189).
// PostgreSQL only; nothing outside `engine/db/` may contain PostgreSQL SQL.
//
// The policies come from `@happyvertical/smrt-users` (its generator reads the
// worker's own registry, so models registered at run time are found), scoped to
// the app's schema: tables and helper functions are created in it and policies
// call the helpers through the transaction's `search_path`, so a schema that is
// copied or swapped whole keeps its own. Row-level security is both enabled and
// FORCED on every table, so it holds for the table owner too (the
// single-login profile runs user operations as the owner of the tables); a
// superuser or a BYPASSRLS role still bypasses it, which `assertRuntimeLogin`
// refuses for the runtime login of the split profile.
//
// Policies are generated whenever tables are created or structurally changed,
// in the same transaction as that DDL, and again at any boot that finds a table
// without them in the catalog, so a table that predates this, or one a restore,
// an import or a copy made without them, is brought up to date.

type Runner = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
};

/** One run-time model's table, and the permission slugs that gate its actions. */
export interface PolicyModel {
  className: string;
  table: string;
  slugs: {
    select: string[];
    insert: string[];
    update: string[];
    delete: string[];
  };
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Whether every table already has row-level security enabled and forced, one
 * policy per command, and the helper functions exist: what the schema looks
 * like after `applyRuntimeModelPolicies`. Read from the catalog, not from a
 * note the schema carries about itself, so a table made by a restore, an
 * import or a copy that lost its policies is found and brought up to date.
 */
async function isCurrent(
  h: Runner,
  schema: string,
  models: PolicyModel[],
): Promise<boolean> {
  if (!models.length) return true;
  const found = (
    await h.query(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(DISTINCT p.polcmd) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd IN ('r', 'a', 'w', 'd')) AS commands
         FROM pg_class c
        WHERE c.relnamespace = to_regnamespace(${lit(schema)}) AND c.relkind IN ('r', 'p')
          AND c.relname IN (${models.map((m) => lit(m.table)).join(', ')})`,
    )
  ).rows as Array<{
    name: string;
    rls: boolean;
    forced: boolean;
    commands: number | string;
  }>;
  const ok = new Set(
    found
      .filter((r) => r.rls && r.forced && Number(r.commands) === 4)
      .map((r) => r.name),
  );
  if (!models.every((m) => ok.has(m.table))) return false;
  const functions = (
    await h.query(
      `SELECT count(*) AS n FROM pg_proc p WHERE p.pronamespace = to_regnamespace(${lit(schema)}) AND p.proname IN ('smrt_rls_bypass', 'smrt_current_tenant_id', 'smrt_has_permission')`,
    )
  ).rows[0]?.n;
  return Number(functions) === 3;
}

/**
 * Enable and force row-level security on every table of `models` in `schema`
 * and (re)create its policies. Skipped when nothing changed (`force` false and
 * the catalog already shows them). Returns whether it applied.
 */
export async function applyRuntimeModelPolicies(
  h: Runner,
  options: {
    schema: string;
    packageName: string;
    models: PolicyModel[];
    force: boolean;
  },
): Promise<boolean> {
  const { schema, packageName, models, force } = options;
  if (!force && (await isCurrent(h, schema, models))) return false;
  const byClass = new Map(models.map((m) => [m.className, m]));
  const { generatePostgresPermissionSql } = await import(
    '@happyvertical/smrt-users/postgres-policies'
  );
  const scope = {
    schemaName: schema,
    includeClass: (c: { className: string; qualifiedName?: string }) =>
      c.qualifiedName?.startsWith(`${packageName}:`) === true &&
      byClass.has(c.className),
    permissionsFor: (c: { className: string }) => {
      const m = byClass.get(c.className);
      return m
        ? {
            SELECT: m.slugs.select,
            INSERT: m.slugs.insert,
            UPDATE: m.slugs.update,
            DELETE: m.slugs.delete,
          }
        : undefined;
    },
  };
  const generated = generatePostgresPermissionSql({}, scope);
  // Every table of the app must be covered: a model the generator skipped
  // (a class it could not see, a table shared by two classes) would be left
  // without a policy, silently. Refuse instead.
  const covered = new Set(generated.targets.map((t) => t.tableName));
  for (const m of models)
    if (!covered.has(m.table))
      throw new Error(
        `no row-level security policy was generated for table ${m.table} (${
          generated.skipped
            .filter((s) => s.className === m.className)
            .map((s) => s.reason)
            .join('; ') || 'its class is not registered tenant-scoped'
        })`,
      );
  for (const statement of generated.statements) {
    try {
      await h.query(statement);
    } catch (error) {
      throw new Error(
        `could not apply row-level security to ${schema}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  return true;
}

/**
 * Tables that predate their tenant column (an app made before its tables were
 * tenant-scoped, or a SQLite app just moved in, #5193) get it here, before the
 * planner would add it as NOT NULL to rows that have none: added nullable,
 * every row given the app's tenant, then made NOT NULL as the planner makes it
 * on a new table. Run as the engine (system context), before row-level
 * security is on them. Returns the tables it changed.
 */
export async function backfillTenantColumn(
  h: Runner,
  options: { schema: string; tables: string[]; tenantId: string },
): Promise<string[]> {
  const { schema, tables, tenantId } = options;
  const done: string[] = [];
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  for (const table of tables) {
    const found = (
      await h.query(
        `SELECT to_regclass(${lit(`${q(schema)}.${q(table)}`)}) IS NOT NULL AS has_table,
                EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)} AND column_name = 'tenant_id') AS has_column`,
      )
    ).rows[0] as { has_table: boolean; has_column: boolean };
    if (!found.has_table || found.has_column) continue;
    await h.query(`ALTER TABLE ${q(table)} ADD COLUMN tenant_id UUID`);
    await h.query(`UPDATE ${q(table)} SET tenant_id = CAST(? AS UUID)`, [
      tenantId,
    ]);
    await h.query(
      `ALTER TABLE ${q(table)} ALTER COLUMN tenant_id SET NOT NULL`,
    );
    done.push(table);
  }
  return done;
}
