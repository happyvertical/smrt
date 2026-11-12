/** Database-owned columns using the SQL SDK's closed row-expression grammar. */
import {
  type AggregateOperand,
  buildAggregate,
  escapeSqlValue,
} from '@happyvertical/sql';
import type { FieldDefinition } from './scanner/types.js';
import type { DatabaseEngine } from './schema/ddl/types.js';
import { SmrtError } from './smrt-error.js';
import { toSnakeCase } from './utils/naming.js';

export type GeneratedExpression = AggregateOperand;

export class GeneratedFieldError extends SmrtError {
  readonly status = 400;
  constructor(
    message: string,
    code = 'VALIDATION_GENERATED_EXPRESSION',
    field?: string,
  ) {
    super(message, code, 'validation', field ? { field } : undefined);
  }
}

export function generatedExpression(
  field: { generated?: unknown; _meta?: { generated?: unknown } } | undefined,
): GeneratedExpression | undefined {
  const value =
    field?.generated !== undefined ? field.generated : field?._meta?.generated;
  return value === true &&
    (field?._meta as { source?: string })?.source === 'tenantScoped_decorator'
    ? undefined
    : (value as GeneratedExpression | undefined);
}

type ResultType =
  | 'integer'
  | 'decimal'
  | 'text'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'null';
const numeric = (type: ResultType) => type === 'integer' || type === 'decimal';

/** Validate before publishing metadata; references use model field names. */
export function validateGeneratedFields(
  fields: Map<string, FieldDefinition>,
): void {
  for (const [name, field] of fields) {
    const expression = generatedExpression(field);
    if (expression === undefined) continue;
    const fail = (message: string): never => {
      throw new GeneratedFieldError(`${name}: ${message}`, undefined, name);
    };
    if (
      field.transient ||
      field._meta?.transient ||
      !['text', 'integer', 'decimal', 'boolean', 'datetime', 'json'].includes(
        field.type,
      )
    )
      fail('generated fields must be scalar persisted columns');
    if (
      [
        'id',
        'slug',
        'context',
        'createdAt',
        'updatedAt',
        'created_at',
        'updated_at',
      ].includes(name) ||
      name.startsWith('_') ||
      field._meta?.primaryKey ||
      field._meta?.__tenancy?.isTenantIdField
    )
      fail('framework identity and ownership columns cannot be generated');
    let count = 0;
    const inputs = new Set<FieldDefinition>();
    const walk = (node: unknown, depth = 0): ResultType => {
      if (++count > 1024 || depth > 24)
        fail('expression exceeds 1024 nodes or depth 24');
      if (!node || typeof node !== 'object' || Array.isArray(node))
        return fail('node must be an object');
      const n = node as Record<string, unknown>;
      const keys = (...expected: string[]) => {
        if (
          Object.keys(n).length !== expected.length ||
          Object.keys(n).some((k) => !expected.includes(k))
        )
          fail('unexpected or missing node keys');
      };
      const child = (value: unknown) => walk(value, depth + 1);
      if ('col' in n) {
        keys('col');
        if (typeof n.col !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(n.col))
          return fail('column must be a same-row field name');
        const input = fields.get(n.col);
        if (
          !input ||
          generatedExpression(input) !== undefined ||
          input.transient ||
          input._meta?.transient ||
          ![
            'text',
            'integer',
            'decimal',
            'boolean',
            'datetime',
            'json',
            'foreignKey',
            'crossPackageRef',
          ].includes(input.type)
        )
          return fail(
            `invalid dependency ${n.col}: expected an existing non-generated scalar column`,
          );
        inputs.add(input);
        return input.type === 'foreignKey' || input.type === 'crossPackageRef'
          ? 'text'
          : (input.type as ResultType);
      }
      if ('value' in n) {
        keys('value');
        if (n.value === null) return 'null';
        if (typeof n.value === 'string' && !n.value.includes('\0'))
          return 'text';
        if (typeof n.value === 'boolean') return 'boolean';
        if (typeof n.value === 'number' && Number.isFinite(n.value))
          return Number.isSafeInteger(n.value) ? 'integer' : 'decimal';
        // Definitions must survive JSON manifests; Date objects do not.
        return fail('literal must be a finite JSON scalar without NUL');
      }
      const op = n.op;
      if (
        [
          'add',
          'sub',
          'mul',
          'div',
          'eq',
          'ne',
          'lt',
          'lte',
          'gt',
          'gte',
        ].includes(String(op))
      ) {
        keys('op', 'left', 'right');
        const left = child(n.left),
          right = child(n.right);
        if (['add', 'sub', 'mul', 'div'].includes(String(op))) {
          if (![left, right].every((t) => numeric(t) || t === 'null'))
            return fail('arithmetic requires numbers');
          return op === 'div' || left === 'decimal' || right === 'decimal'
            ? 'decimal'
            : 'integer';
        }
        if (
          left !== 'null' &&
          right !== 'null' &&
          left !== right &&
          !(numeric(left) && numeric(right))
        )
          fail('comparison requires compatible operands');
        return 'boolean';
      }
      if (op === 'and' || op === 'or' || op === 'coalesce') {
        keys('op', 'operands');
        if (
          !Array.isArray(n.operands) ||
          n.operands.length < (op === 'coalesce' ? 2 : 1)
        )
          return fail('invalid operand list');
        const types = n.operands.map(child).filter((t) => t !== 'null');
        if (op !== 'coalesce') {
          if (types.some((t) => t !== 'boolean'))
            fail('logical operands must be booleans');
          return 'boolean';
        }
        if (types.length === 0) return 'null';
        if (types.every(numeric))
          return types.includes('decimal') ? 'decimal' : 'integer';
        if (types.some((t) => t !== types[0]))
          fail('coalesce requires compatible operands');
        return types[0] ?? 'null';
      }
      if (
        op === 'not' ||
        op === 'isNull' ||
        op === 'isNotNull' ||
        op === 'asText'
      ) {
        keys('op', 'operand');
        const type = child(n.operand);
        if (op === 'not' && type !== 'boolean' && type !== 'null')
          fail('not requires a boolean');
        return op === 'asText' ? 'text' : 'boolean';
      }
      if (op === 'secondsBetween') {
        keys('op', 'later', 'earlier');
        if (
          ![child(n.later), child(n.earlier)].every(
            (t) => t === 'datetime' || t === 'null',
          )
        )
          fail('secondsBetween requires datetime fields');
        return 'decimal';
      }
      return fail(`unsupported SQL SDK expression operator ${String(op)}`);
    };
    const type = walk(expression);
    if (JSON.stringify(expression).length > 65_536)
      fail('expression exceeds 65536 serialized characters');
    if (
      type !== 'null' &&
      type !== field.type &&
      !(field.type === 'decimal' && type === 'integer')
    )
      fail(`expression result ${type} is incompatible with ${field.type}`);
    const permissions = new Set<string>();
    for (const input of [field, ...inputs]) {
      if (input.sensitive || input._meta?.sensitive) field.sensitive = true;
      const permission = input.readPermission ?? input._meta?.readPermission;
      if (typeof permission === 'string') permissions.add(permission);
    }
    // Existing field policy represents one permission. Refuse combinations
    // it cannot faithfully represent rather than weaken either permission.
    if (permissions.size > 1)
      fail(
        'dependencies require distinct readPermissions; the field policy supports one permission',
      );
    const ownedExpression = structuredClone(expression);
    const freeze = (node: object): void => {
      for (const child of Object.values(node))
        if (child && typeof child === 'object') freeze(child);
      Object.freeze(node);
    };
    freeze(ownedExpression);
    if (field.generated !== undefined) field.generated = ownedExpression;
    field.readonly = true;
    field.readPermission = [...permissions][0];
    field._meta = {
      ...field._meta,
      generated: ownedExpression,
      readonly: true,
      ...(field.sensitive ? { sensitive: true } : {}),
      ...(field.readPermission ? { readPermission: field.readPermission } : {}),
    };
  }
}

/** Map only validated col nodes; the SDK remains the sole expression compiler. */
export function generatedColumnExpression(
  expression: GeneratedExpression,
): GeneratedExpression {
  const map = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(map);
    if (!value || typeof value !== 'object') return value;
    if ('col' in value)
      return { col: toSnakeCase((value as { col: string }).col) };
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, map(child)]),
    );
  };
  return map(expression) as GeneratedExpression;
}

/** DDL cannot bind parameters. Extract SDK SQL and inline its validated literals. */
export function compileGeneratedExpression(
  expression: GeneratedExpression,
  engine: DatabaseEngine,
): string {
  if (engine === 'json')
    throw new GeneratedFieldError(
      'JSON databases do not support generated columns',
      'VALIDATION_GENERATED_DIALECT',
    );
  try {
    const { sql, values } = buildAggregate(
      { from: '_smrt_generated', select: [{ expr: expression, as: '_value' }] },
      1,
      engine,
    );
    const prefix = 'SELECT ',
      suffix = ' AS _value FROM _smrt_generated GROUP BY 1';
    if (!sql.startsWith(prefix) || !sql.endsWith(suffix))
      throw new Error('SQL SDK expression projection shape changed');
    // Replace before inserting strings, so literal "$1" text stays literal.
    return sql
      .slice(prefix.length, -suffix.length)
      .replace(/\$(\d+)/g, (_, index: string) => {
        const value = values[Number(index) - 1];
        if (typeof value !== 'string' || value.includes('\0'))
          throw new Error('Invalid DDL literal');
        // PostgreSQL E strings make backslashes independent of session settings.
        return engine === 'postgres'
          ? `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
          : escapeSqlValue(value);
      });
  } catch (error) {
    throw new GeneratedFieldError(
      `Cannot compile generated expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function generatedColumnClause(
  expression: GeneratedExpression,
  engine: DatabaseEngine,
): string {
  return `GENERATED ALWAYS AS (${compileGeneratedExpression(expression, engine)}) ${engine === 'postgres' ? 'STORED' : 'VIRTUAL'}`;
}

export function rejectGeneratedInput(
  fields: Map<string, FieldDefinition>,
  data: object,
): void {
  for (const [name, field] of fields)
    if (
      generatedExpression(field) !== undefined &&
      (Object.hasOwn(data, name) || Object.hasOwn(data, toSnakeCase(name)))
    ) {
      throw new GeneratedFieldError(
        `Cannot assign database-generated field '${name}'`,
        'VALIDATION_GENERATED_FIELD_WRITE',
        name,
      );
    }
}

/** Introspect generated expressions missing from the SQL SDK's schema metadata. */
export async function readGeneratedColumns(
  db: {
    query(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  },
  table: string,
  engine: DatabaseEngine,
): Promise<Map<string, string>> {
  if (engine === 'postgres') {
    const { rows } = await db.query(
      "SELECT column_name, generation_expression FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'ALWAYS'",
      [table],
    );
    return new Map(
      rows.map((r) => [String(r.column_name), String(r.generation_expression)]),
    );
  }
  if (engine === 'json') return new Map();
  const { rows } =
    engine === 'duckdb'
      ? await db.query(
          'SELECT sql FROM duckdb_tables() WHERE schema_name = current_schema() AND table_name = $1',
          [table],
        )
      : await db.query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $1",
          [table],
        );
  const ddl = String(rows[0]?.sql ?? '');
  const result = new Map<string, string>();
  // Match a generated clause by balanced parentheses, respecting SQL quotes.
  const pattern =
    /(?:"((?:[^"]|"")+)"|\b([A-Za-z_]\w*))\s+\w+\s+(?:NOT NULL\s+)?GENERATED\s+ALWAYS\s+AS\s*\(/gi;
  for (let match = pattern.exec(ddl); match; match = pattern.exec(ddl)) {
    let depth = 1,
      quote = '',
      i = pattern.lastIndex;
    const start = i;
    for (; i < ddl.length && depth; i++) {
      const ch = ddl[i];
      if (quote) {
        if (ch === quote) {
          if (ddl[i + 1] === quote) i++;
          else quote = '';
        }
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth)
      throw new GeneratedFieldError(
        'Cannot introspect generated SQLite expression',
      );
    result.set(
      (match[1] ?? match[2]).replace(/""/g, '"'),
      ddl.slice(start, i - 1),
    );
    pattern.lastIndex = i;
  }
  return result;
}

/** Ignore formatting only, preserving parentheses and literal contents. */
export function generatedExpressionsEqual(
  actual: string,
  expression: GeneratedExpression,
  engine: DatabaseEngine,
): boolean {
  const normalize = (sql: string) =>
    sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+/g, (token) =>
      token.startsWith("'")
        ? token
        : token.startsWith('"')
          ? token.slice(1, -1).replace(/""/g, '"')
          : '',
    );
  return (
    normalize(actual) ===
    normalize(compileGeneratedExpression(expression, engine))
  );
}

/** PostgreSQL deparses implicit casts. EXPLAIN normalizes both sides without running rows. */
export async function generatedExpressionsMatch(
  db: {
    query(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  },
  table: string,
  actual: string,
  expression: GeneratedExpression,
  engine: DatabaseEngine,
): Promise<boolean> {
  if (generatedExpressionsEqual(actual, expression, engine)) return true;
  if (engine !== 'postgres') return false;
  const output = async (sql: string): Promise<string> => {
    const result = await db.query(
      `EXPLAIN (VERBOSE, FORMAT JSON) SELECT ${sql} FROM "${table.replace(/"/g, '""')}"`,
    );
    const plan = result.rows[0]?.['QUERY PLAN'] as
      | Array<{ Plan?: { Output?: string[] } }>
      | undefined;
    const expressions = plan?.[0]?.Plan?.Output;
    if (!expressions)
      throw new GeneratedFieldError(
        'PostgreSQL cannot describe generated expression parity',
      );
    return JSON.stringify(expressions);
  };
  return (
    (await output(actual)) ===
    (await output(compileGeneratedExpression(expression, engine)))
  );
}
