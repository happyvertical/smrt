/**
 * Run-time models stored in the database, as declarers of tables (#5005).
 *
 * An app model editor keeps its lists in `_smrt_app_model_changes` and
 * registers their models only in the process that serves the app. `smrt
 * db:migrate` never loads them, so a list's table looks undeclared to a
 * whole-schema migrate. A retirement whose table a stored list uses must stop
 * (`table.retire-declared`), never drop the list's rows. Every list of every
 * stored document counts, before and after each change: a deleted list keeps
 * its table and rows.
 *
 * A stored list's table is the one the model editor registers it under: its
 * snake-cased plural (`runtimeListTableName`). A list document cannot state a
 * table (the document check refuses any other key); one that does anyway is
 * counted under both names. Run-time models app code registers directly
 * (`registerRuntimeModel`) are not in the journal: only a process that
 * registered them knows them, so in any other process only the retirement's
 * definition match protects their tables.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { runtimeListTableName } from '../runtime-list-table.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import { quoteIdentifier } from '../schema/sql-identifiers.js';

/**
 * `APP_MODEL_CHANGES_TABLE` of `system/app-model-changes.ts`, spelled here:
 * that module loads the migration generator (and Node's crypto), which the
 * browser entry of the differ must not.
 */
const APP_MODEL_CHANGES_TABLE = '_smrt_app_model_changes';

export interface StoredRuntimeModelTables {
  /** Lower-cased table name to the stored run-time models that use it. */
  tables: Map<string, string[]>;
  /** Set when a stored document could not be read: nothing may be retired. */
  unreadable?: string;
}

type Row = Record<string, unknown>;
function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

/** Each stored list: its name, package and the tables it may use. */
function listsOf(
  doc: unknown,
): Array<{ name: string; pkg: string; tables: string[] }> {
  const models = (doc as { models?: unknown } | null)?.models as
    | { packageName?: unknown; lists?: unknown }
    | undefined;
  if (!models || typeof models !== 'object') return [];
  const lists = models.lists as Record<string, unknown> | null | undefined;
  if (!lists || typeof lists !== 'object') return [];
  const pkg = typeof models.packageName === 'string' ? models.packageName : '';
  return Object.entries(lists).map(([name, list]) => {
    const stated = (list as { tableName?: unknown } | null)?.tableName;
    return {
      name,
      pkg,
      tables: [
        runtimeListTableName(name),
        ...(typeof stated === 'string' && stated ? [stated] : []),
      ],
    };
  });
}

/** The tables stored run-time lists use. Empty when there is no journal. */
export async function readStoredRuntimeModelTables(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  liveTables: ReadonlySet<string>,
): Promise<StoredRuntimeModelTables> {
  const tables = new Map<string, string[]>();
  const journal = [...liveTables].some(
    (name) => name.toLowerCase() === APP_MODEL_CHANGES_TABLE,
  );
  if (!journal || engine === 'json') return { tables };
  let rows: Row[];
  // The schema the retire step reads live tables from, whatever the
  // search_path (retire-plan.ts).
  const journalTable =
    engine === 'postgres'
      ? `${quoteIdentifier('public')}.${quoteIdentifier(APP_MODEL_CHANGES_TABLE)}`
      : quoteIdentifier(APP_MODEL_CHANGES_TABLE);
  try {
    rows = rowsOf(
      await db.query(
        `SELECT application, before_doc, after_doc FROM ${journalTable}`,
      ),
    );
  } catch (error) {
    return {
      tables,
      unreadable: `the app model journal ${APP_MODEL_CHANGES_TABLE} could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  for (const row of rows) {
    for (const column of ['before_doc', 'after_doc'] as const) {
      let doc: unknown;
      try {
        doc = JSON.parse(String(row[column]));
      } catch {
        return {
          tables,
          unreadable: `a stored app model document in ${APP_MODEL_CHANGES_TABLE} (application ${String(row.application)}) is not valid JSON`,
        };
      }
      for (const { name, pkg, tables: used } of listsOf(doc)) {
        const owner = `run-time model ${pkg ? `${pkg}:` : ''}${name} (application ${String(row.application)})`;
        for (const usedTable of used) {
          const table = usedTable.toLowerCase();
          const owners = tables.get(table) ?? [];
          if (!owners.includes(owner)) owners.push(owner);
          tables.set(table, owners);
        }
      }
    }
  }
  return { tables };
}
