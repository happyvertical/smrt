/**
 * Durable list-table ownership across app model journals. Internal: not
 * re-exported. Every journal row's documents name its lists; a list's table
 * is its runtime list table name. Used by editors (a startup cookbook or a
 * new list may not take another journal's table) and by the activation
 * coordinator (a recipe may not load onto a journalled list's table),
 * independent of what this process has registered.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { runtimeListTableName } from '../runtime-list-table.js';
import { getDatabaseEngine } from '../system/compatibility.js';

/** Tables of lists declared by any journal other than `exclude`, by table. */
export async function journalListTables(
  db: DatabaseInterface,
  exclude?: { application: string; tenantId: string },
): Promise<Map<string, string>> {
  const engine = getDatabaseEngine(db);
  const present = await db.query(
    engine === 'postgres'
      ? "SELECT 1 AS live FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = '_smrt_app_model_changes'"
      : "SELECT 1 AS live FROM sqlite_master WHERE type = 'table' AND name = '_smrt_app_model_changes'",
  );
  const tables = new Map<string, string>();
  if (!present.rows.length) return tables;
  const { rows } = await db.query(
    'SELECT application, tenant_id, before_doc, after_doc FROM _smrt_app_model_changes',
  );
  for (const row of rows) {
    if (
      exclude &&
      String(row.application) === exclude.application &&
      String(row.tenant_id) === exclude.tenantId
    )
      continue;
    for (const raw of [row.before_doc, row.after_doc]) {
      let lists: Record<string, unknown> | undefined;
      let packageName = '';
      try {
        const parsed = JSON.parse(String(raw)) as {
          models?: { packageName?: string; lists?: Record<string, unknown> };
        };
        lists = parsed.models?.lists;
        packageName = parsed.models?.packageName ?? '';
      } catch {
        continue;
      }
      for (const name of Object.keys(lists ?? {}))
        tables.set(runtimeListTableName(name), `${packageName}:${name}`);
    }
  }
  return tables;
}
