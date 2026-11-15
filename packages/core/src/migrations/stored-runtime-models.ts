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
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { runtimeListTableName } from '../runtime-list-table.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import { APP_MODEL_CHANGES_TABLE } from '../system/app-model-changes.js';

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

function listsOf(doc: unknown): Array<[string, string]> {
  const models = (doc as { models?: unknown } | null)?.models as
    | { packageName?: unknown; lists?: unknown }
    | undefined;
  if (!models || typeof models !== 'object') return [];
  const lists = models.lists;
  if (!lists || typeof lists !== 'object') return [];
  const pkg = typeof models.packageName === 'string' ? models.packageName : '';
  return Object.keys(lists).map((name) => [name, pkg]);
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
  try {
    rows = rowsOf(
      await db.query(
        `SELECT application, before_doc, after_doc FROM ${APP_MODEL_CHANGES_TABLE}`,
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
      for (const [name, pkg] of listsOf(doc)) {
        const table = runtimeListTableName(name).toLowerCase();
        const owner = `run-time model ${pkg ? `${pkg}:` : ''}${name} (application ${String(row.application)})`;
        const owners = tables.get(table) ?? [];
        if (!owners.includes(owner)) owners.push(owner);
        tables.set(table, owners);
      }
    }
  }
  return { tables };
}
