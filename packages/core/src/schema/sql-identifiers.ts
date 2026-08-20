/**
 * Shared SQL identifier / literal / default-value formatters.
 *
 * SMRT's schema + migration layers previously re-implemented identifier
 * quoting and default-value formatting in several places, and a few of those
 * copies interpolated values raw (`"${name}"`, `'${path}'`) or treated any
 * string containing `(` as raw SQL. Those unsafe copies allowed a developer
 * free-string (a `tableName`, a `@meta` field name used as a JSON path, a
 * column default) that happened to contain a `"` or `'` to break out of the
 * intended token and inject arbitrary DDL.
 *
 * This module is the single safe implementation that every DDL strategy,
 * the schema generator/aggregator, the registry schema-builder, and the
 * migration generator route through. It matches the escaping semantics that
 * `migrations/differ.ts` and `schema/schema-manager.ts` already used
 * correctly, so the codebase converges on one behaviour.
 *
 * IMPORTANT: keep this a pure, dependency-free utility (no runtime imports of
 * registry/collection/object). It is imported by `schema/ddl/*`,
 * `schema/index-utils.ts`, `schema/schema-aggregator.ts`,
 * `schema/generator.ts`, `registry/schema-builder.ts`, and
 * `migrations/generator.ts`.
 */

/**
 * Quote a SQL identifier (table/column/index/trigger name) by wrapping it in
 * double quotes and escaping any embedded double quote as `""`.
 *
 * This is the ANSI / PostgreSQL / SQLite / DuckDB delimited-identifier rule.
 * A name containing a `"` is rendered as a single valid token rather than
 * closing the identifier early and leaking the remainder into the statement.
 *
 * @example
 * quoteIdentifier('users')        // => "users"
 * quoteIdentifier('we"ird')       // => "we""ird"   (single valid token)
 */
export function quoteIdentifier(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Quote a SQL string literal by wrapping it in single quotes and escaping any
 * embedded single quote as `''`.
 *
 * @example
 * quoteStringLiteral("O'Hara")    // => 'O''Hara'
 */
export function quoteStringLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * SQL keyword / niladic-function defaults that are passed through verbatim.
 *
 * Compared case-insensitively against the *entire* trimmed value. This is an
 * explicit allowlist — unlike the old "value contains `(`" heuristic, an
 * arbitrary string that merely contains a parenthesis is NOT treated as raw
 * SQL.
 *
 * Deliberately excludes `null`/`NULL`: a literal string `"null"` used as a
 * default for a TEXT column must be stored as the string, not folded into the
 * SQL NULL keyword. Real SQL NULL is produced from a JS `null`/`undefined`
 * value (see formatDefaultValue), not from the string `"null"`.
 */
const SQL_DEFAULT_KEYWORDS = new Set<string>([
  'current_timestamp',
  'current_date',
  'current_time',
  'localtime',
  'localtimestamp',
  'now()',
  'uuid_generate_v4()',
  'gen_random_uuid()',
  "datetime('now')",
  "date('now')",
  "time('now')",
]);

/**
 * Validate that a string is a well-formed, injection-safe SQL scalar
 * function-call default, e.g. `datetime('now')` or `coalesce(0, 1)`.
 *
 * The old formatters treated ANY string containing `(` as raw SQL, so a
 * "default" like `f(x') ; DROP TABLE t; --` was passed through untouched and
 * injected. This validator instead requires the value to be *only* a function
 * call whose arguments are themselves safe literals (numbers, properly-quoted
 * string literals, the NULL keyword, or nested function calls). Anything that
 * doesn't parse cleanly — stray quotes, statement terminators, trailing
 * tokens — is rejected and the caller falls back to quoting it as data.
 *
 * @internal exported for testing
 */
export function isSafeSqlFunctionDefault(value: string): boolean {
  const trimmed = value.trim();
  // Fast structural pre-check: identifier ... ( ... ) and nothing after.
  if (!/^[A-Za-z_][A-Za-z0-9_.]*\s*\(.*\)$/s.test(trimmed)) {
    return false;
  }

  let pos = 0;
  const n = trimmed.length;

  const skipWs = () => {
    while (pos < n && /\s/.test(trimmed[pos])) pos++;
  };

  // Parse a single argument: a number, a single-quoted string literal, the
  // NULL keyword, or a nested function call. Returns true on success and
  // advances `pos`.
  const parseArgument = (): boolean => {
    skipWs();
    if (pos >= n) return false;
    const ch = trimmed[pos];

    // Single-quoted string literal with doubled-quote escaping.
    if (ch === "'") {
      pos++; // opening quote
      while (pos < n) {
        if (trimmed[pos] === "'") {
          if (trimmed[pos + 1] === "'") {
            pos += 2; // escaped quote
            continue;
          }
          pos++; // closing quote
          return true;
        }
        pos++;
      }
      return false; // unterminated string
    }

    // Number (integer or decimal, optional sign).
    if (ch === '+' || ch === '-' || /[0-9]/.test(ch)) {
      const numMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(trimmed.slice(pos));
      if (!numMatch) return false;
      pos += numMatch[0].length;
      return true;
    }

    // Identifier-led: either the NULL/TRUE/FALSE keyword or a nested call.
    if (/[A-Za-z_]/.test(ch)) {
      const identMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(trimmed.slice(pos));
      if (!identMatch) return false;
      pos += identMatch[0].length;
      skipWs();
      if (trimmed[pos] === '(') {
        return parseCall();
      }
      // Bare identifier is only allowed for a small set of literal keywords.
      const kw = identMatch[0].toLowerCase();
      return kw === 'null' || kw === 'true' || kw === 'false';
    }

    return false;
  };

  // Parse `( arg, arg, ... )` starting at the current `(`. Advances `pos`.
  const parseCall = (): boolean => {
    skipWs();
    if (trimmed[pos] !== '(') return false;
    pos++; // consume '('
    skipWs();
    if (trimmed[pos] === ')') {
      pos++;
      return true; // empty arg list, e.g. now()
    }
    while (true) {
      if (!parseArgument()) return false;
      skipWs();
      if (trimmed[pos] === ',') {
        pos++;
        continue;
      }
      if (trimmed[pos] === ')') {
        pos++;
        return true;
      }
      return false; // unexpected token between args
    }
  };

  // Top-level: identifier then a call, consuming the whole string.
  const topIdent = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(trimmed);
  if (!topIdent) return false;
  pos = topIdent[0].length;
  skipWs();
  if (!parseCall()) return false;
  skipWs();
  return pos === n; // no trailing tokens
}

/**
 * Format a column default value into a safe SQL fragment for a `DEFAULT`
 * clause.
 *
 * Behaviour (converging the previously-divergent copies):
 * - JS `null`/`undefined` => the SQL `NULL` keyword.
 * - A string that exactly matches a known SQL keyword/niladic-function default
 *   (case-insensitive, e.g. `current_timestamp`, `uuid_generate_v4()`) =>
 *   passed through verbatim.
 * - A string that is a well-formed, injection-safe SQL function call
 *   (e.g. `datetime('now')`) => passed through verbatim.
 * - Everything else is formatted *by column type* and always quoted/escaped
 *   as data. A literal string `"null"`/`"NULL"` is therefore stored as the
 *   string for a TEXT column, NOT folded to SQL NULL.
 *
 * @param value - The raw default value (any JS value).
 * @param type - The column's SQL type (case-insensitive). Controls literal
 *   formatting (TEXT/VARCHAR quote, INTEGER/REAL numeric, BOOLEAN, JSON, ...).
 * @param options - Engine-specific overrides:
 *   - `booleanLiterals`: how to render boolean true/false (default `TRUE`/`FALSE`;
 *     SQLite passes `['1','0']`).
 *   - `nonStringTimestampDefault`: what a non-string TIMESTAMP default falls
 *     back to (default `CURRENT_TIMESTAMP`).
 */
export function formatDefaultValue(
  value: unknown,
  type: string,
  options: {
    booleanLiterals?: [trueLiteral: string, falseLiteral: string];
    nonStringTimestampDefault?: string;
  } = {},
): string {
  const [trueLiteral, falseLiteral] = options.booleanLiterals ?? [
    'TRUE',
    'FALSE',
  ];
  const nonStringTimestampDefault =
    options.nonStringTimestampDefault ?? 'CURRENT_TIMESTAMP';

  const upperTypeEarly = type.toUpperCase();
  const isJsonType = upperTypeEarly === 'JSON' || upperTypeEarly === 'JSONB';

  // JS null/undefined => SQL NULL — EXCEPT for JSON columns, where a null
  // default means the JSON `null` literal (`'null'`), not the SQL NULL keyword.
  // (formatJsonDefault handles the null/undefined case.)
  if ((value === null || value === undefined) && !isJsonType) {
    return 'NULL';
  }

  // Allowlisted SQL keyword / niladic-function defaults, plus well-formed,
  // injection-safe function calls (e.g. datetime('now')) — passed through.
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (SQL_DEFAULT_KEYWORDS.has(candidate.toLowerCase())) {
      return value;
    }
    if (isSafeSqlFunctionDefault(value)) {
      return value;
    }
  }

  switch (upperTypeEarly) {
    case 'TEXT':
    case 'VARCHAR':
    case 'CHAR':
    case 'CLOB':
    case 'STRING':
      return quoteStringLiteral(String(value));
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'SMALLINT':
      return String(Math.floor(Number(value) || 0));
    case 'REAL':
    case 'FLOAT':
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'DECIMAL':
    case 'NUMERIC':
      return String(Number(value) || 0);
    case 'BOOLEAN':
    case 'BOOL':
      return value ? trueLiteral : falseLiteral;
    case 'TIMESTAMP':
    case 'DATETIME':
    case 'DATE':
    case 'TIME':
      if (typeof value === 'string') {
        return quoteStringLiteral(value);
      }
      return nonStringTimestampDefault;
    case 'JSON':
    case 'JSONB':
      return formatJsonDefault(value);
    default:
      return quoteStringLiteral(String(value));
  }
}

/**
 * Format a JSON column default, ensuring the emitted literal is valid JSON.
 *
 * Mirrors the long-standing behaviour from base-strategy/generator/
 * schema-builder (issue #735): empty string and `[object Object]` are
 * sanitised, valid JSON strings are used as-is, and anything else is
 * JSON.stringify'd. The result is always a single-quoted, escaped SQL literal.
 */
function formatJsonDefault(value: unknown): string {
  if (value === null || value === undefined) {
    return "'null'";
  }

  if (typeof value === 'string') {
    if (value === '') {
      return "'null'";
    }
    if (value === '[object Object]') {
      return "'{}'";
    }
    try {
      JSON.parse(value);
      return quoteStringLiteral(value);
    } catch {
      return quoteStringLiteral(JSON.stringify(value));
    }
  }

  return quoteStringLiteral(JSON.stringify(value));
}

/**
 * Conservative identifier allowlist for values that will be interpolated into
 * SQL contexts where quoting is not sufficient — specifically the JSON-path
 * segment of a JSON-path index expression, which is embedded as a *string
 * literal* into a dialect function/operator (`json_extract("col", '$.path')`,
 * `"col"->>'path'`).
 *
 * Allows a dotted path of simple identifier segments (e.g. `a`, `a.b.c`).
 * A JSON path / column that doesn't match is rejected so it can be quoted as
 * a plain literal instead of being interpolated raw.
 */
export function isSafeIdentifierPath(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value);
}

/**
 * Allowlist for a single SQL identifier with no dots (e.g. a column name).
 * Stricter than {@link isSafeIdentifierPath}: use this for the *column* of a
 * JSON-path index (a real column name is always a simple identifier), and
 * {@link isSafeIdentifierPath} for the dotted *path* segment.
 */
export function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
