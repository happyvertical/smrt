// The shell's own first-run schema.
//
// DEPENDENCY (pending): smrt#4835 adds a first-run schema hook to
// app-runtime. Until it lands the shell is a plain consumer of the existing
// `prepareDatabase` option, which app-runtime calls before identity access on
// every start. Keep everything behind `prepareShellSchema` so switching to the
// new hook is a one-line change in `smrt.ts`.
//
// Additive only: for every registered model's table that does not exist yet,
// run core's DDL (create table, indexes, triggers) for the database's engine.
// Existing tables are never dropped; the user app's tables live in app.db and
// are the worker's business, not this function's. The one alteration is the
// desktop's: a database made before the shell models became tenant-scoped gets
// its `tenant_id` column added, and its rows given the installation's one
// tenant, so the owner's app is still the owner's app (`adoptTenantScope`).
// This function is the local runtime's; a deployed database is migrated by
// `smrt db:migrate` and never reaches it.
import {
  detectEngine,
  ObjectRegistry,
  planForeignKeyCreation,
} from '@happyvertical/smrt-core';
import {
  createSchemaManager,
  getDDLStrategy,
} from '@happyvertical/smrt-core/schema';
import type { DatabaseInterface } from '@happyvertical/sql';

type Query = { rows?: unknown[] } | unknown[];

async function tableExists(
  db: DatabaseInterface,
  engine: string,
  table: string,
): Promise<boolean> {
  const sql =
    engine === 'postgres'
      ? 'SELECT 1 AS ok FROM information_schema.tables WHERE table_name = $1'
      : "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?";
  const res = (await db.query(sql, table)) as Query;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.length > 0;
}

/**
 * Create the tables of every model registered in the shell process (App,
 * AppVersion, Approval, and the smrt-users, tenancy and profiles tables the
 * runtime needs). Idempotent. Returns the tables it created.
 */
export async function prepareShellSchema(
  db: DatabaseInterface,
): Promise<string[]> {
  const created = await createMissingTables(db);
  await adoptTenantScope(db);
  return created;
}

/** The shell's own tables that hold one owner's data (tenant-scoped). */
export const TENANT_SCOPED_TABLES = [
  'apps',
  'app_versions',
  'app_drafts',
  'app_draft_versions',
  'approvals',
  'assistant_threads',
  'assistant_messages',
] as const;

/**
 * SQLite (the desktop): give an older database the tenant column its models
 * now carry, and the installation's one tenant to every row without one.
 * Idempotent; with zero or several tenants it adds the column and leaves the
 * rows alone (no guess about whose they are).
 */
async function adoptTenantScope(db: DatabaseInterface): Promise<void> {
  const engine = detectEngine(
    (db as { url?: string }).url ?? '',
    (db as { type?: string }).type,
  );
  if (engine !== 'sqlite') return;
  let sole: string | null | undefined;
  for (const table of TENANT_SCOPED_TABLES) {
    if (!(await tableExists(db, engine, table))) continue;
    // The model declares the column; the schema manager adds it to the
    // existing table (no hand-written DDL here).
    const schema = Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ).find((candidate) => candidate.tableName === table);
    if (schema) await createSchemaManager(db).ensureTable(schema);
    if (sole === undefined) {
      const res = (await db
        .query('SELECT id FROM tenants LIMIT 2')
        .catch(() => ({ rows: [] }))) as Query;
      const rows = (Array.isArray(res) ? res : (res.rows ?? [])) as {
        id: string;
      }[];
      sole = rows.length === 1 ? rows[0].id : null;
    }
    if (sole)
      await db.query(
        `UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`,
        sole,
      );
  }
}

async function createMissingTables(db: DatabaseInterface): Promise<string[]> {
  const engine = detectEngine(
    (db as { url?: string }).url ?? '',
    (db as { type?: string }).type,
  );
  const strategy = getDDLStrategy(engine);
  const schemas = Object.values(ObjectRegistry.getAllSchemasAsDefinitions());
  const missing = [];
  for (const schema of schemas)
    if (!(await tableExists(db, engine, schema.tableName)))
      missing.push(schema);
  if (missing.length === 0) return [];
  const plan = planForeignKeyCreation(missing, strategy.engine);
  const statements: string[] = [];
  for (const schema of plan.schemas) {
    statements.push(strategy.generateCreateTable(schema));
    statements.push(...strategy.generateIndexes(schema));
    statements.push(...strategy.generateTriggers(schema));
  }
  statements.push(...plan.deferredStatements);
  const run = async (q: Pick<DatabaseInterface, 'query'>) => {
    for (const sql of statements) if (sql.trim()) await q.query(sql);
  };
  // One transaction where the engine allows it (SQLite DDL is transactional),
  // so a failure leaves no half-created schema.
  if (typeof db.transaction === 'function')
    await db.transaction(async (tx) => run(tx as never));
  else await run(db);
  return missing.map((s) => s.tableName);
}
