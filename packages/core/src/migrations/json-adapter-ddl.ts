/**
 * Changes to existing tables on the JSON adapter are reported, not executed.
 *
 * The JSON adapter (`@happyvertical/sql`) keeps each table in DuckDB memory and
 * persists it to `<table>.json` and `<table>.schema.sql` only from its own
 * writes and `exportTable()`. DDL run through `query()` changes the in-memory
 * table and nothing on disk, so the next open replays the old `.schema.sql`,
 * and a table rebuild has no post-pass on this engine. Since 0.116.8 the
 * adapter can describe its tables, so the differ sees drift there; it reports
 * every change to an existing table under one kind, `json.ddl-not-durable`,
 * with the statements it would have run as suggested SQL, and runs none.
 */
import type { SchemaChange } from '../schema/types.js';
import { decideSchemaChange, hasExecutableSchemaSql } from './change-kinds.js';

const statementsOf = (change: SchemaChange): string[] =>
  change.sqlStatements ?? (change.sql ? [change.sql] : []);

/**
 * The report-only form of a change the differ planned for an existing table
 * on the JSON adapter. A change that is already report-only keeps its kind.
 */
export function reportJsonTableChange(change: SchemaChange): SchemaChange {
  if (
    !hasExecutableSchemaSql(change) &&
    decideSchemaChange(change, 'json').decision === 'report'
  )
    return change;
  const planned = statementsOf(change).filter(
    (sql) => !sql.trim().startsWith('--'),
  );
  const subject = `${change.table}${change.name ? `.${change.name}` : ''}`;
  const { sql: _sql, sqlStatements: _statements, ...rest } = change;
  return {
    ...rest,
    kindHint: 'json.ddl-not-durable',
    advisory: {
      severity: 'warning',
      message: `${subject}: the JSON adapter keeps DDL run through query() in memory only until its next write to the table, so this change was not executed${change.advisory ? ` (${change.advisory.message})` : ''}. To apply it, convert the table: create it again in the new shape, copy its rows, and export it with exportTable(); for 4-byte decimal columns, convertJsonDecimalColumns() does this with checks.`,
      ...(planned.length > 0
        ? { suggestedSql: planned }
        : change.advisory?.suggestedSql
          ? { suggestedSql: change.advisory.suggestedSql }
          : {}),
    },
  };
}
