/**
 * System-table shape parsing (#2368)
 *
 * `_smrt_*` tables are created from hand-written DDL in `src/system/schema.ts`
 * rather than from decorated classes, so they never enter the manifest and the
 * manifest-driven differ has never compared them against a live database.
 *
 * This module parses that DDL back into a structural description — columns,
 * declared indexes, and inline `UNIQUE (...)` constraints — so the live-schema
 * parity check can hold system tables to the same standard as application
 * tables. The DDL is the source of truth for these tables; parsing it (rather
 * than duplicating a hand-maintained expectation table) keeps the two from
 * drifting apart.
 *
 * The parser is deliberately narrow: it understands the portable subset SMRT
 * actually writes (`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT
 * EXISTS`, simple column definitions, inline `UNIQUE`/`PRIMARY KEY` table
 * constraints) and ignores anything else rather than guessing.
 */

import { getSystemTableDDL } from '../system/schema.js';
import type { DatabaseEngine } from './ddl/types.js';

/** One column as declared by hand-written system-table DDL. */
export interface SystemTableColumnShape {
  name: string;
  /**
   * The engine-materialized type text exactly as declared (`TEXT`, `BIGINT`,
   * `TIMESTAMPTZ`, …). System DDL is materialized per engine by
   * `getSystemTableDDL()`, so no abstract-type mapping is involved.
   */
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  hasDefault: boolean;
}

/** One index as declared by hand-written system-table DDL. */
export interface SystemTableIndexShape {
  name: string;
  columns: string[];
  unique: boolean;
  where?: string;
}

/** The complete declared shape of one `_smrt_*` table. */
export interface SystemTableShape {
  tableName: string;
  columns: SystemTableColumnShape[];
  indexes: SystemTableIndexShape[];
  /**
   * Column sets declared by inline `UNIQUE (...)` table constraints. These
   * back framework upserts but materialize as implicit indexes
   * (`sqlite_autoindex_*` / `<table>_key`) that name-based introspection
   * misses, so they are tracked separately from {@link indexes}.
   */
  uniqueConstraints: string[][];
}

const CREATE_TABLE_RE =
  /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)([A-Za-z_][\w$]*)\1\s*\(/i;

const CREATE_INDEX_RE =
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)([A-Za-z_][\w$]*)\2\s+ON\s+("?)([A-Za-z_][\w$]*)\4\s*\(([^)]*)\)\s*(?:WHERE\s+([\s\S]+))?$/i;

/**
 * Table-level constraint clauses that carry no column-shape information.
 *
 * Anchored on a following delimiter rather than a bare prefix so a column
 * legitimately named `checksum` is not mistaken for a `CHECK` constraint.
 */
const IGNORED_CONSTRAINT_PATTERNS = [
  /^CHECK\s*\(/i,
  /^FOREIGN\s+KEY\b/i,
  /^CONSTRAINT\s+/i,
  /^EXCLUDE\b/i,
];

/**
 * Parse the complete system-table DDL for an engine into table shapes.
 *
 * @param engine - Target engine; selects the materialized DDL variant
 *   (PostgreSQL uses TIMESTAMPTZ where the portable DDL says TIMESTAMP).
 * @returns One shape per declared `_smrt_*` table, keyed by table name.
 */
export function getSystemTableShapes(
  engine: DatabaseEngine,
): Map<string, SystemTableShape> {
  return parseTableShapes(getSystemTableDDL(engine).join('\n'));
}

/**
 * Parse an arbitrary DDL script into table shapes.
 *
 * Exported for tests and for callers that materialize system DDL themselves.
 * Statements the parser does not understand are skipped silently — this is a
 * diagnostic input, never an execution path.
 */
export function parseTableShapes(ddl: string): Map<string, SystemTableShape> {
  const shapes = new Map<string, SystemTableShape>();

  for (const statement of splitStatements(stripComments(ddl))) {
    const tableMatch = statement.match(CREATE_TABLE_RE);
    if (tableMatch) {
      const shape = parseCreateTable(statement, tableMatch[2]);
      if (shape) {
        shapes.set(shape.tableName, shape);
      }
      continue;
    }

    const indexMatch = statement.match(CREATE_INDEX_RE);
    if (!indexMatch) continue;

    const [, uniqueKeyword, , indexName, , tableName, columnList, where] =
      indexMatch;
    const shape = shapes.get(tableName);
    if (!shape) continue;

    shape.indexes.push({
      name: indexName,
      columns: splitColumnList(columnList),
      unique: Boolean(uniqueKeyword),
      ...(where ? { where: where.trim() } : {}),
    });
  }

  return shapes;
}

/** Remove `--` line comments so they cannot be mistaken for statements. */
function stripComments(ddl: string): string {
  return ddl.replace(/--[^\n]*/g, '');
}

/** Split a DDL script on statement terminators, dropping empty fragments. */
function splitStatements(ddl: string): string[] {
  return ddl
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function parseCreateTable(
  statement: string,
  tableName: string,
): SystemTableShape | null {
  const open = statement.indexOf('(');
  const close = statement.lastIndexOf(')');
  if (open === -1 || close === -1 || close <= open) {
    return null;
  }

  const shape: SystemTableShape = {
    tableName,
    columns: [],
    indexes: [],
    uniqueConstraints: [],
  };

  for (const item of splitTopLevel(statement.slice(open + 1, close))) {
    const uniqueConstraint = item.match(/^UNIQUE\s*\(([^)]*)\)$/i);
    if (uniqueConstraint) {
      shape.uniqueConstraints.push(splitColumnList(uniqueConstraint[1]));
      continue;
    }

    if (/^PRIMARY\s+KEY\s*\(/i.test(item)) {
      const primaryKeyColumns = item.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)$/i);
      if (primaryKeyColumns) {
        const columnNames = new Set(splitColumnList(primaryKeyColumns[1]));
        for (const column of shape.columns) {
          if (columnNames.has(column.name)) {
            column.primaryKey = true;
          }
        }
      }
      continue;
    }

    if (IGNORED_CONSTRAINT_PATTERNS.some((pattern) => pattern.test(item))) {
      continue;
    }

    const column = parseColumnDefinition(item);
    if (column) {
      shape.columns.push(column);
    }
  }

  return shape;
}

/**
 * Multi-word type tails SMRT's portable DDL can produce. Kept explicit so a
 * trailing constraint keyword is never absorbed into the type text.
 */
const MULTI_WORD_TYPE_TAILS = [
  'WITH TIME ZONE',
  'WITHOUT TIME ZONE',
  'PRECISION',
  'VARYING',
];

function parseColumnDefinition(item: string): SystemTableColumnShape | null {
  const tokens = item.split(/\s+/);
  if (tokens.length < 2) return null;

  const name = unquoteIdentifier(tokens[0]);
  if (!/^[A-Za-z_][\w$]*$/.test(name)) return null;

  let type = tokens[1];
  let rest = tokens.slice(2).join(' ');
  for (const tail of MULTI_WORD_TYPE_TAILS) {
    if (rest.toUpperCase().startsWith(tail)) {
      type = `${type} ${rest.slice(0, tail.length)}`;
      rest = rest.slice(tail.length).trim();
      break;
    }
  }

  const restUpper = rest.toUpperCase();
  return {
    name,
    type,
    primaryKey: /\bPRIMARY\s+KEY\b/.test(restUpper),
    notNull: /\bNOT\s+NULL\b/.test(restUpper),
    unique: /\bUNIQUE\b/.test(restUpper),
    hasDefault: /\bDEFAULT\b/.test(restUpper),
  };
}

/** Split a parenthesized column list into bare column names. */
function splitColumnList(columnList: string): string[] {
  return columnList
    .split(',')
    .map((column) => unquoteIdentifier(column.trim()))
    .filter((column) => column.length > 0);
}

/** Split on commas that sit outside any parenthesis nesting. */
function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of body) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim().length > 0) {
    items.push(current.trim());
  }

  return items
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length > 0);
}

function unquoteIdentifier(identifier: string): string {
  return identifier.replace(/^["`[]|["`\]]$/g, '');
}

/**
 * Names of every table the hand-written system DDL creates.
 *
 * This is the framework's definition of "a system table" — bookkeeping DDL
 * replayed by `bootstrapSystemTables()` — as opposed to the ~25
 * `_smrt_`-prefixed *domain* tables that belong to `@smrt()` models and are
 * created by `db:migrate` from the manifest. Derived from the same parse the
 * parity check uses so the two can never disagree (issue #2376).
 *
 * Declared last in the module because it evaluates the parser at load time,
 * which needs every helper above to be initialized.
 */
export const SYSTEM_TABLE_NAMES: readonly string[] = Object.freeze([
  ...getSystemTableShapes('sqlite').keys(),
]);
