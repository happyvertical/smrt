import { quoteIdentifier, quoteStringLiteral } from '../sql-identifiers.js';
import type { IndexDefinition } from '../types.js';

/** Identifies version-gated, transaction-only framework index DDL to the planner. */
export const NULL_EQUAL_INDEX_MARKER = '-- smrt:null-equal-conflict-index';

export function renderNullEqualConflictIndex(
  tableName: string,
  index: IndexDefinition,
): string {
  if (
    !index.nullsNotDistinct ||
    !index.unique ||
    index.where ||
    index.jsonPath ||
    !index.columns.length
  ) {
    throw new Error(
      `Invalid NULL-equal conflict index ${index.name}: requires a full unique column index.`,
    );
  }
  const create = `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${quoteIdentifier(tableName)} (${index.columns.map(quoteIdentifier).join(', ')})`;
  // Dynamic SQL ensures PostgreSQL <15 never parses the unsupported clause.
  const body = `BEGIN\n  IF current_setting('server_version_num')::integer >= 150000 THEN\n    EXECUTE ${quoteStringLiteral(`${create} NULLS NOT DISTINCT`)};\n  ELSE\n    EXECUTE ${quoteStringLiteral(create)};\n  END IF;\nEND;`;
  let suffix = 0;
  let delimiter = '$smrt_null_equal$';
  while (body.includes(delimiter)) delimiter = `$smrt_null_equal_${++suffix}$`;
  return `${NULL_EQUAL_INDEX_MARKER}\nDO ${delimiter}\n${body}\n${delimiter};`;
}
