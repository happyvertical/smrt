/** One policy for every schema-change producer and migration consumer (#4925). */
import type { DatabaseEngine } from '../schema/ddl/types.js';
import type { SchemaChange } from '../schema/types.js';
import { isSqliteRebuildPlaceholder } from './sqlite-rebuild.js';

export type SchemaChangeEngine = 'postgres' | 'sqlite' | 'duckdb';
export type SchemaChangeDecision = 'apply' | 'stop' | 'report';
export type SchemaChangeStopReason = 'loses-data' | 'invents-data';
export interface SchemaChangePolicy {
  decision: SchemaChangeDecision;
  reason?: SchemaChangeStopReason;
  why: string;
  /** An explicitly unresolved engine/adapter limitation, never a data rule. */
  exception?: string;
}
export interface SchemaChangeKind {
  type: SchemaChange['type'];
  engines: Record<SchemaChangeEngine, SchemaChangePolicy>;
}
const engines = (policy: SchemaChangePolicy) => ({
  postgres: policy,
  sqlite: policy,
  duckdb: policy,
});
const apply = (why: string) => engines({ decision: 'apply', why });
const report = (why: string) => engines({ decision: 'report', why });
const stop = (reason: SchemaChangeStopReason, why: string) =>
  engines({ decision: 'stop', reason, why });
const unresolved = (exception: string) =>
  engines({ decision: 'stop', exception, why: exception });

/**
 * Migrate makes the database match the code whenever that is safe.
 * It stops only when it would lose or invent data; unresolved exceptions below
 * preserve existing refusals until their engine/adapter support is implemented.
 */
export const SCHEMA_CHANGE_KINDS = {
  'table.add': {
    type: 'add_table',
    engines: apply('Create the declared table.'),
  },
  'table.drop': {
    type: 'drop_table',
    engines: stop('loses-data', 'Dropping the table discards its stored rows.'),
  },
  'column.add': {
    type: 'add_column',
    engines: apply(
      'Add the declared column using the proven default or backfill when needed.',
    ),
  },
  'column.drop': {
    type: 'drop_column',
    engines: apply(
      'Drop the undeclared column; the differ emits this only when the operator asked for it (--drop-columns).',
    ),
  },
  'column.required-missing': {
    type: 'alter_column',
    engines: stop(
      'invents-data',
      'Existing rows need a required value with no usable default or backfill.',
    ),
  },
  'column.required-nulls': {
    type: 'alter_column',
    engines: stop(
      'invents-data',
      'Existing NULLs need a required value with no usable default or backfill.',
    ),
  },
  'column.set-not-null': {
    type: 'alter_column',
    engines: apply(
      'Enforce NOT NULL after the declared backfill or a successful NULL check.',
    ),
  },
  'column.drop-not-null': {
    type: 'alter_column',
    engines: apply('Remove NOT NULL while preserving every stored value.'),
  },
  'column.set-default': {
    type: 'alter_column',
    engines: apply('Set the declared default without replacing stored values.'),
  },
  'column.drop-default': {
    type: 'alter_column',
    engines: apply('Remove the stale default without replacing stored values.'),
  },
  'check.set': {
    type: 'alter_column',
    engines: apply(
      'Add the declared shared-table rule once no live row breaks it.',
    ),
  },
  'check.rows-violate': {
    type: 'alter_column',
    engines: stop(
      'invents-data',
      'Live rows of a class that requires this column hold NULL.',
    ),
  },
  'check.drop': {
    type: 'alter_column',
    engines: apply('Remove the undeclared smrt-owned CHECK constraint.'),
  },
  'column.relaxation-report': {
    type: 'alter_column',
    engines: report(
      'The relaxation has not been opted into; existing values stay unchanged.',
    ),
  },
  'column.rebuild-covered': {
    type: 'alter_column',
    engines: report(
      'Another change rebuilds this column with the declared constraints.',
    ),
  },
  'column.alter-unsupported': {
    type: 'alter_column',
    engines: unresolved(
      'The engine cannot alter this column in place and the rebuild planner does not support this alteration.',
    ),
  },
  'column.rebuild-unavailable': {
    type: 'alter_column',
    engines: unresolved(
      'The SQLite rebuild planner cannot safely read or rewrite this column while preserving the live table.',
    ),
  },
  'column.rebuild-data-loss': {
    type: 'alter_column',
    engines: stop(
      'loses-data',
      'Dropping the rebuild target with foreign keys enabled can delete referencing rows.',
    ),
  },
  'column.orphan': {
    type: 'orphan_column',
    engines: report(
      'The undeclared column is retained with its stored values.',
    ),
  },
  'column.orphan-not-null': {
    type: 'orphan_column',
    engines: report(
      'The undeclared NOT NULL column can break inserts; retaining it loses or invents no data.',
    ),
  },
  'index.add': {
    type: 'add_index',
    engines: apply(
      'Create or rename the declared index without changing stored rows.',
    ),
  },
  'index.drop': {
    type: 'drop_index',
    engines: apply('Remove the index without removing stored rows.'),
  },
  'index.orphan': {
    type: 'orphan_index',
    engines: report(
      'The undeclared index or unique constraint is retained without changing stored rows.',
    ),
  },
  'rename.pending': {
    type: 'rename_data_pending',
    engines: report(
      'The possible rename is reported while both columns and their values are retained.',
    ),
  },
  'type.incompatible': {
    type: 'type_mismatch',
    engines: stop(
      'loses-data',
      'The incompatible conversion cannot preserve the existing values.',
    ),
  },
  'type.convert': {
    type: 'type_upgrade',
    engines: apply(
      'Run the value-preserving conversion and its validation statements.',
    ),
  },
  'type.noop': {
    type: 'type_upgrade',
    engines: report(
      'The engine already stores this shape or another change rebuilds this column.',
    ),
  },
  'type.uuid-blocked': {
    type: 'type_upgrade',
    engines: stop(
      'loses-data',
      'The mixed UUID and text values cannot be converted together without replacing existing values.',
    ),
  },
  'type.uuid-constraints-unavailable': {
    type: 'type_upgrade',
    engines: unresolved(
      'Live foreign keys depend on the UUID conversion targets, but the SQL adapter does not expose their constraint names for replacement.',
    ),
  },
  'type.uuid-probe-unavailable': {
    type: 'type_upgrade',
    engines: unresolved(
      'The UUID value probe could not run, so a value-preserving conversion has not been proven.',
    ),
  },
  'type.narrow-float': {
    type: 'type_upgrade',
    engines: stop(
      'loses-data',
      'Narrowing the floating-point type can discard stored precision.',
    ),
  },
  'type.invalid-json': {
    type: 'type_upgrade',
    engines: stop(
      'loses-data',
      'The JSON conversion would discard invalid values or duplicate object keys.',
    ),
  },
  'type.invalid-timestamp': {
    type: 'type_upgrade',
    engines: stop(
      'loses-data',
      'The timestamp conversion cannot preserve invalid or ambiguous stored values.',
    ),
  },
  'type.default-relaxation-report': {
    type: 'type_upgrade',
    engines: report(
      'Conversion needs a stale default removed, but that relaxation has not been opted into.',
    ),
  },
  'type.preservation-unverified': {
    type: 'type_upgrade',
    engines: unresolved(
      'The JSON duplicate-key preservation probe did not finish, so a safe conversion has not been proven.',
    ),
  },
  'type.rebuild-data-loss': {
    type: 'type_upgrade',
    engines: stop(
      'loses-data',
      'Dropping the rebuild target with foreign keys enabled can delete referencing rows.',
    ),
  },
  'type.rebuild-unavailable': {
    type: 'type_upgrade',
    engines: unresolved(
      'The SQLite rebuild planner cannot read or rewrite the live table definition safely.',
    ),
  },
  'foreign-key.add': {
    type: 'add_foreign_key',
    engines: apply(
      'Add or replace the foreign key after checking existing references.',
    ),
  },
  'foreign-key.orphans': {
    type: 'add_foreign_key',
    engines: stop(
      'loses-data',
      'Enforcing the foreign key requires deleting rows or clearing existing references that have no parent.',
    ),
  },
  'foreign-key.incompatible-types': {
    type: 'add_foreign_key',
    engines: stop(
      'loses-data',
      'The child and parent types cannot be aligned while preserving the existing values.',
    ),
  },
  'foreign-key.type-convergence-unavailable': {
    type: 'add_foreign_key',
    engines: unresolved(
      'The required UUID conversion is blocked by unavailable constraint names or an unfinished value probe.',
    ),
  },
  'foreign-key.parent-data-missing': {
    type: 'add_foreign_key',
    engines: stop(
      'invents-data',
      'Existing child references need parent rows that do not exist.',
    ),
  },
  'foreign-key.parent-column-missing': {
    type: 'add_foreign_key',
    engines: unresolved(
      'The planned parent has no referenced column; the manifest must be corrected before SQL can be generated.',
    ),
  },
  'foreign-key.conflicting': {
    type: 'add_foreign_key',
    engines: unresolved(
      'A foreign key exists with a different target or action and the planner cannot safely identify and replace it.',
    ),
  },
  'foreign-key.add-unsupported': {
    type: 'add_foreign_key',
    engines: unresolved(
      'SQLite needs a foreign-key table rebuild that is not implemented here; DuckDB cannot ADD CONSTRAINT in place.',
    ),
  },
  'foreign-key.drop': {
    type: 'drop_foreign_key',
    engines: apply(
      'Remove the disabled foreign key without changing stored rows.',
    ),
  },
  'foreign-key.drop-unavailable': {
    type: 'drop_foreign_key',
    engines: {
      postgres: {
        decision: 'stop',
        why: 'The SQL adapter does not expose the live PostgreSQL constraint name.',
        exception:
          'The SQL adapter does not expose the live PostgreSQL constraint name.',
      },
      sqlite: {
        decision: 'stop',
        why: 'Removing the foreign key needs a table rebuild that is not implemented here.',
        exception:
          'Removing the foreign key needs a table rebuild that is not implemented here.',
      },
      duckdb: {
        decision: 'stop',
        why: 'DuckDB cannot drop this foreign key in place and no rebuild is implemented here.',
        exception:
          'DuckDB cannot drop this foreign key in place and no rebuild is implemented here.',
      },
    },
  },
} as const satisfies Record<string, SchemaChangeKind>;

export type SchemaChangeKindId = keyof typeof SCHEMA_CHANGE_KINDS;

/** Explicit exceptions to the two data rules, with their implementation gap. */
export const UNRESOLVED_NON_DATA_STOPS = Object.entries(
  SCHEMA_CHANGE_KINDS,
).flatMap(([kind, entry]) =>
  Object.entries(entry.engines).flatMap(([engine, policy]) =>
    'exception' in policy
      ? [
          {
            kind: kind as SchemaChangeKindId,
            engine: engine as SchemaChangeEngine,
            reason: policy.exception,
          },
        ]
      : [],
  ),
);

/** Structural input also accepts the CLI's lightweight schema projection. */
export type SchemaChangeInput = Pick<
  SchemaChange,
  | 'table'
  | 'name'
  | 'advisory'
  | 'mismatch'
  | 'phase'
  | 'sql'
  | 'sqlStatements'
  | 'foreignKey'
  | 'orphanBlocked'
  | 'engineUnsupported'
  | 'kindHint'
> & { type: string; alteration?: string };

/** The single comment-only SQL definition, shared by all migration consumers. */
export function isCommentOnlySql(sql: string): boolean {
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
      .trim().length === 0
  );
}
export function hasExecutableSchemaSql(
  change: Pick<SchemaChangeInput, 'sql' | 'sqlStatements'>,
): boolean {
  return (change.sqlStatements ?? (change.sql ? [change.sql] : [])).some(
    (sql) => !isCommentOnlySql(sql),
  );
}
/** Only call this for comment-only SQL, never for executable literals. */
export function isNoOpAdvisorySql(sql: string): boolean {
  return (
    isCommentOnlySql(sql) &&
    (/no change needed/i.test(sql) || /already stores .* as /i.test(sql))
  );
}

export function classifySchemaChange(
  change: SchemaChangeInput,
): SchemaChangeKindId | 'unlisted' {
  if (change.kindHint) {
    const hinted = SCHEMA_CHANGE_KINDS[change.kindHint];
    return hinted?.type === change.type ? change.kindHint : 'unlisted';
  }
  const executable = hasExecutableSchemaSql(change);
  const statements = change.sqlStatements ?? (change.sql ? [change.sql] : []);
  const noop = statements.length > 0 && statements.every(isNoOpAdvisorySql);
  switch (change.type) {
    case 'add_table':
      return 'table.add';
    case 'drop_table':
      return 'table.drop';
    case 'add_column':
      return executable ? 'column.add' : 'unlisted';
    case 'drop_column':
      return 'column.drop';
    case 'orphan_column':
      return change.advisory?.severity === 'warning'
        ? 'column.orphan-not-null'
        : 'column.orphan';
    case 'orphan_index':
      return 'index.orphan';
    case 'rename_data_pending':
      return 'rename.pending';
    case 'add_index':
      return executable ? 'index.add' : 'unlisted';
    case 'drop_index':
      return executable ? 'index.drop' : 'unlisted';
    case 'type_mismatch':
      return 'type.incompatible';
    case 'type_upgrade':
      if (executable) return 'type.convert';
      if (noop) return 'type.noop';
      if (
        change.phase === 'pre_foreign_key' ||
        change.mismatch?.actual === 'mixed uuid/text'
      )
        return 'type.uuid-blocked';
      if (statements.some(isSqliteRebuildPlaceholder))
        return 'type.rebuild-unavailable';
      return 'unlisted';
    case 'alter_column':
      if (change.mismatch?.actual === '(column not added)')
        return 'column.required-missing';
      if (noop) return 'column.rebuild-covered';
      if (!executable) {
        if (change.alteration === 'set_check' && change.advisory)
          return 'check.rows-violate';
        if (change.alteration === 'set_not_null' && change.advisory)
          return 'column.required-nulls';
        if (
          (change.alteration === 'drop_default' ||
            change.alteration === 'drop_not_null') &&
          change.advisory
        )
          return 'column.relaxation-report';
        return [
          'set_not_null',
          'drop_not_null',
          'set_default',
          'drop_default',
        ].includes(change.alteration ?? '')
          ? 'column.alter-unsupported'
          : 'unlisted';
      }
      switch (change.alteration) {
        case 'set_not_null':
          return 'column.set-not-null';
        case 'drop_not_null':
          return 'column.drop-not-null';
        case 'set_default':
          return 'column.set-default';
        case 'drop_default':
          return 'column.drop-default';
        case 'set_check':
          return 'check.set';
        case 'drop_check':
          return 'check.drop';
        default:
          return 'unlisted';
      }
    case 'add_foreign_key':
      if (change.orphanBlocked) return 'foreign-key.orphans';
      if (change.engineUnsupported) return 'foreign-key.add-unsupported';
      return executable
        ? 'foreign-key.add'
        : change.advisory
          ? 'foreign-key.conflicting'
          : 'unlisted';
    case 'drop_foreign_key':
      return executable ? 'foreign-key.drop' : 'foreign-key.drop-unavailable';
    default:
      return 'unlisted';
  }
}

export interface SchemaChangeVerdict {
  kind: SchemaChangeKindId | 'unlisted';
  decision: SchemaChangeDecision;
  stop?: {
    reason: SchemaChangeStopReason | 'unlisted' | 'unresolved-non-data-stop';
    why: string;
  };
  message: string;
}
export function decideSchemaChange(
  change: SchemaChangeInput,
  engine: DatabaseEngine,
): SchemaChangeVerdict {
  const kind = classifySchemaChange(change);
  const subject = `${change.table}${change.foreignKey?.column || change.name ? `.${change.foreignKey?.column ?? change.name}` : ''}`;
  if (kind === 'unlisted') {
    const why =
      'This schema change is unlisted; safe execution has not been proven.';
    return {
      kind,
      decision: 'stop',
      stop: { reason: 'unlisted', why },
      message: `${subject}: ${why}`,
    };
  }
  const policy: SchemaChangePolicy =
    SCHEMA_CHANGE_KINDS[kind].engines[engine === 'json' ? 'duckdb' : engine];
  const dataReason =
    policy.reason === 'loses-data' ? 'would lose data' : 'would invent data';
  return {
    kind,
    decision: policy.decision,
    ...(policy.decision === 'stop'
      ? {
          stop: {
            reason: policy.reason ?? 'unresolved-non-data-stop',
            why: policy.why,
          },
        }
      : {}),
    message: `${subject}: ${policy.decision === 'stop' ? (policy.reason ? `${dataReason}. ` : 'unresolved non-data stop: ') : ''}${policy.why}${change.advisory ? ` ${change.advisory.message}` : ''}`,
  };
}

/** Runtime validator accepts synthetic tables so tests can prove it rejects bad policy. */
export function validateChangeKindTable(
  table: Record<string, SchemaChangeKind>,
): string[] {
  const problems: string[] = [];
  for (const [kind, entry] of Object.entries(table)) {
    for (const engine of ['postgres', 'sqlite', 'duckdb'] as const) {
      const policy = entry.engines[engine];
      if (!policy?.why?.trim()) problems.push(`${kind}/${engine}: missing why`);
      if (policy?.decision !== 'stop') continue;
      const exception = UNRESOLVED_NON_DATA_STOPS.find(
        (item) =>
          item.kind === kind &&
          item.engine === engine &&
          item.reason.trim() &&
          item.reason === policy.exception,
      );
      if (
        policy.reason !== 'loses-data' &&
        policy.reason !== 'invents-data' &&
        !exception
      )
        problems.push(
          `${kind}/${engine}: stop must lose or invent data or name a recorded exception`,
        );
    }
  }
  return problems;
}
