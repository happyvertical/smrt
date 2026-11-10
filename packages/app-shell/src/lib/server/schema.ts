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
// Existing tables are never altered or dropped; the user app's tables live in
// app.db and are the worker's business, not this function's.
import {
  detectEngine,
  ObjectRegistry,
  planForeignKeyCreation,
} from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
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
