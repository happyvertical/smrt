/**
 * Migrate and PostgreSQL row-level security (#5452).
 *
 * Migrate decides from the rows it reads: whether a retired table is empty,
 * whether a column holds NULLs or values a conversion would change, whether a
 * foreign key has orphans. Row-level security that applies to the migrating
 * role filters those reads without an error, so a check can see no rows where
 * there are some and let a change through that loses data. It applies when the
 * table has row-level security enabled and the role is neither a superuser nor
 * `BYPASSRLS`, and either does not own the table or owns it under
 * `FORCE ROW LEVEL SECURITY` (the shape the users package's generated
 * policies take).
 *
 * Migrate therefore never reads a table under row-level security:
 *
 * - Before anything runs, {@link assertMigrationSeesEveryRow} asks the catalog
 *   (`row_security_active`) about every table the plan reads and throws
 *   {@link MigrationRowSecurityError} naming them. A change on a table is
 *   always planned, whatever its rows hold; only its verdict depends on them,
 *   so the tables of the planned changes are the tables whose reads matter.
 * - Each transaction the tracker runs migration statements in on PostgreSQL
 *   sets `row_security = off` for itself ({@link withRowSecurityOff}).
 *   PostgreSQL then raises instead of filtering on a table row-level security
 *   would apply to (a policy turned on after planning, a statement of a
 *   package migration), and {@link rowSecurityFailure} turns that error into
 *   the same named error.
 *
 * The concurrent-index phase reads no rows: an index build reads the table
 * directly, not through policies, and its checks are `EXPLAIN` only (see
 * `schema-paths.md`, "Concurrent index statements").
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import {
  quoteIdentifier,
  quoteStringLiteral,
} from '../schema/sql-identifiers.js';
import type { SchemaChange } from '../schema/types.js';
import { decideSchemaChange } from './change-kinds.js';
import { RETIRE_POSTGRES_SCHEMA } from './retire-plan.js';

/** The run-time model journal the retire step reads (`stored-runtime-models.ts`). */
const APP_MODEL_CHANGES_TABLE = '_smrt_app_model_changes';

/**
 * Row-level security applies to the migrating role on tables the migration
 * reads, so it cannot see every row. Nothing was changed.
 */
export class MigrationRowSecurityError extends Error {
  /** The tables row-level security applies to, as the catalog names them. */
  readonly tables: string[];

  constructor(tables: readonly string[], options?: { cause?: unknown }) {
    const named = tables.length
      ? tables.map((table) => `"${table}"`).join(', ')
      : 'a table the migration reads';
    super(
      `Row-level security applies to the migrating role on ${named}, so the migration cannot read every row its checks need. Nothing was changed. Run the migration as a role with BYPASSRLS, or as the owner of each table without FORCE ROW LEVEL SECURITY, then migrate again.`,
      options,
    );
    this.name = 'MigrationRowSecurityError';
    this.tables = [...tables];
  }
}

/**
 * The live tables a plan reads rows of: the table of every change migrate
 * applies or stops on (reports read nothing they act on), and the parent of
 * every foreign key it adds or checks. Tables it creates have no rows yet.
 */
export function tablesMigrateReads(
  changes: readonly SchemaChange[],
  engine: DatabaseEngine,
): RowSecurityTarget[] {
  const tables = new Map<string, RowSecurityTarget>();
  const add = (target: RowSecurityTarget) =>
    tables.set(`${target.schema ?? ''}\u0000${target.table}`, target);
  for (const change of changes) {
    if (change.type === 'add_table') continue;
    if (decideSchemaChange(change, engine).decision === 'report') continue;
    if (change.type === 'retire_table') {
      // The retire step reads the table it drops, schema-qualified, and the
      // run-time model journal that says whether a stored model still
      // declares it (`retire-plan.ts`).
      add({ schema: RETIRE_POSTGRES_SCHEMA, table: change.table });
      add({ schema: RETIRE_POSTGRES_SCHEMA, table: APP_MODEL_CHANGES_TABLE });
      continue;
    }
    add({ table: change.table });
    if (change.foreignKey?.referencesTable)
      add({ table: change.foreignKey.referencesTable });
  }
  return [...tables.values()];
}

/**
 * A table a migration reads: unqualified (resolved through the search path,
 * as the migration's own statements resolve it) or in a named schema.
 */
export interface RowSecurityTarget {
  table: string;
  schema?: string;
}

/**
 * Of `tables`, those row-level security applies to for the current role on
 * PostgreSQL. Each is resolved to the one relation the migration's statements
 * would read (`to_regclass`: the search path for an unqualified name, the
 * named schema otherwise), so a same-named table elsewhere does not count.
 * Empty on every other engine.
 */
export async function findRowSecurityTables(
  db: DatabaseInterface,
  tables: Iterable<string | RowSecurityTarget>,
  engine: DatabaseEngine,
): Promise<string[]> {
  if (engine !== 'postgres') return [];
  const regclasses = [
    ...new Set(
      [...tables].map((entry) => {
        const target = typeof entry === 'string' ? { table: entry } : entry;
        const name =
          target.schema === undefined
            ? quoteIdentifier(target.table)
            : `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)}`;
        return `(to_regclass(${quoteStringLiteral(name)}))`;
      }),
    ),
  ];
  if (regclasses.length === 0) return [];
  const result = await db.query(
    `SELECT DISTINCT c.relname AS name FROM (VALUES ${regclasses.join(', ')}) AS r(oid) JOIN pg_class c ON c.oid = r.oid WHERE c.relrowsecurity AND row_security_active(c.oid) ORDER BY 1`,
  );
  return namesOf(result);
}

/**
 * Every table in the search path or `public` that row-level security applies
 * to for the current role on PostgreSQL. Used to read a SQLSTATE 42501 without
 * relying on the (possibly translated) server message.
 */
async function findAnyRowSecurityTables(
  db: DatabaseInterface,
): Promise<string[]> {
  const result = await db.query(
    `SELECT DISTINCT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity AND row_security_active(c.oid) AND (n.nspname = 'public' OR n.nspname = ANY (current_schemas(false))) ORDER BY 1`,
  );
  return namesOf(result);
}

function namesOf(result: { rows?: unknown }): string[] {
  return ((result.rows ?? []) as Array<{ name?: unknown }>).flatMap((row) =>
    typeof row.name === 'string' ? [row.name] : [],
  );
}

/**
 * Throw {@link MigrationRowSecurityError} when row-level security applies to
 * the current role on any of `tables`. For reads outside a schema plan: the
 * migrate record, `--repair-data` targets, the money rescale.
 */
export async function assertTablesReadable(
  db: DatabaseInterface,
  tables: Iterable<string | RowSecurityTarget>,
  engine: DatabaseEngine,
): Promise<void> {
  const hidden = await findRowSecurityTables(db, tables, engine);
  if (hidden.length > 0) throw new MigrationRowSecurityError(hidden);
}

/**
 * Throw {@link MigrationRowSecurityError} when row-level security applies to
 * the current role on a table the planned `changes` read. Call it after
 * planning and before running anything.
 */
export async function assertMigrationSeesEveryRow(
  db: DatabaseInterface,
  changes: readonly SchemaChange[],
  engine: DatabaseEngine,
): Promise<void> {
  const hidden = await findRowSecurityTables(
    db,
    tablesMigrateReads(changes, engine),
    engine,
  );
  if (hidden.length > 0) throw new MigrationRowSecurityError(hidden);
}

/**
 * Run `work` in the PostgreSQL transaction `tx` with `row_security = off`, so
 * a read row-level security would filter raises instead. The setting is local
 * to the transaction and set back to what it was when `work` succeeds, so a
 * caller-owned transaction goes on as before; on failure the transaction rolls
 * back and takes the setting with it.
 */
export async function withRowSecurityOff<T>(
  tx: Pick<DatabaseInterface, 'query'>,
  work: () => Promise<T>,
): Promise<T> {
  const before = await tx.query(
    `SELECT current_setting('row_security') AS value`,
  );
  const previous = String(
    (before.rows as Array<{ value?: unknown }>)[0]?.value ?? 'on',
  );
  await tx.query('SET LOCAL row_security = off');
  const result = await work();
  await tx.query(
    `SELECT set_config('row_security', ${quoteStringLiteral(previous)}, true)`,
  );
  return result;
}

/**
 * Run `work` on a pinned PostgreSQL session outside any transaction with
 * `row_security = off`, setting the previous value back afterwards whether
 * `work` succeeds or fails, so the pooled connection is returned unchanged.
 */
export async function withSessionRowSecurityOff<T>(
  session: { query(sql: string): Promise<{ rows: unknown[] }> },
  work: () => Promise<T>,
): Promise<T> {
  const before = await session.query(
    `SELECT current_setting('row_security') AS value`,
  );
  const previous = String(
    (before.rows as Array<{ value?: unknown }>)[0]?.value ?? 'on',
  );
  await session.query('SET row_security = off');
  try {
    return await work();
  } finally {
    await session.query(
      `SELECT set_config('row_security', ${quoteStringLiteral(previous)}, false)`,
    );
  }
}

const ROW_SECURITY_MESSAGE =
  /row-level security policy for table "((?:[^"]|"")+)"/;

/** Every error in `error`'s cause chain, outermost first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current && chain.length < 10 && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * The named error for a migration that failed because PostgreSQL refused a
 * read under `row_security = off`, or `undefined` when `error` is something
 * else. The refusal is SQLSTATE 42501, which also means other missing
 * privileges, so it counts only when the server message says so or the
 * catalog shows row-level security for this role on a table the planned
 * `changes` read.
 */
export async function rowSecurityFailure(
  db: DatabaseInterface,
  error: unknown,
  changes: readonly SchemaChange[],
  engine: DatabaseEngine,
): Promise<MigrationRowSecurityError | undefined> {
  if (engine !== 'postgres') return undefined;
  if (error instanceof MigrationRowSecurityError) return error;
  const chain = causeChain(error);
  const refused = chain.some(
    (item) =>
      (item as { code?: unknown }).code === '42501' ||
      /\bcode=42501\b/.test(String((item as Error)?.message ?? '')),
  );
  if (!refused) return undefined;
  const named = chain.flatMap((item) => {
    const match = ROW_SECURITY_MESSAGE.exec(
      String((item as Error)?.message ?? ''),
    );
    return match ? [match[1].replace(/""/g, '"')] : [];
  });
  let hidden: string[] = [];
  try {
    // A failed caller-owned transaction refuses every query until it ends;
    // the server message then names the table on its own. The catalog is
    // asked first about the tables the plan reads, then about every table
    // the role can reach: a package statement can read one the plan does
    // not, and the message may be translated.
    hidden = await findRowSecurityTables(
      db,
      tablesMigrateReads(changes, engine),
      engine,
    );
    if (hidden.length === 0 && named.length === 0)
      hidden = await findAnyRowSecurityTables(db);
  } catch {
    hidden = [];
  }
  const all = [...new Set([...hidden, ...named])];
  return all.length > 0
    ? new MigrationRowSecurityError(all, { cause: error })
    : undefined;
}
