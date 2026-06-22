/**
 * Unit tests for the shared SQL identifier / literal / default-value
 * formatters (schema/sql-identifiers.ts) and their adoption by the DDL
 * strategies, index-utils, and the schema generator.
 *
 * These are the regression tests for issue #1378's "Divergent SQL formatters"
 * majors: identifier/literal injection safety, the allowlist-based default
 * formatter (no "contains `(`" pass-through), and the literal-"null" fold bug.
 */

import { describe, expect, it } from 'vitest';
import { getDDLStrategy } from './ddl/index.js';
import { renderIndexTarget } from './index-utils.js';
import {
  formatDefaultValue,
  isSafeIdentifier,
  isSafeIdentifierPath,
  isSafeSqlFunctionDefault,
  quoteIdentifier,
  quoteStringLiteral,
} from './sql-identifiers.js';
import type { SchemaDefinition } from './types.js';

describe('quoteIdentifier', () => {
  it('wraps plain identifiers in double quotes', () => {
    expect(quoteIdentifier('users')).toBe('"users"');
    expect(quoteIdentifier('created_at')).toBe('"created_at"');
  });

  it('escapes embedded double quotes so the token cannot break out', () => {
    // A name containing a `"` must double the quote, producing ONE valid token.
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    // The classic injection: name tries to close the identifier and inject DDL.
    const malicious = 'x" ); DROP TABLE users; --';
    const quoted = quoteIdentifier(malicious);
    expect(quoted).toBe('"x"" ); DROP TABLE users; --"');
    // The only unescaped quotes are the wrapping pair (start + end).
    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
    // Every interior `"` is doubled (no lone quote that would terminate early).
    const interior = quoted.slice(1, -1);
    expect(interior.replace(/""/g, '')).not.toContain('"');
  });
});

describe('quoteStringLiteral', () => {
  it('wraps strings in single quotes and escapes embedded single quotes', () => {
    expect(quoteStringLiteral('hello')).toBe("'hello'");
    expect(quoteStringLiteral("O'Hara")).toBe("'O''Hara'");
  });

  it('neutralizes a single-quote breakout attempt', () => {
    expect(quoteStringLiteral("'); DROP TABLE t; --")).toBe(
      "'''); DROP TABLE t; --'",
    );
  });
});

describe('isSafeIdentifierPath', () => {
  it('accepts simple and dotted identifier paths', () => {
    expect(isSafeIdentifierPath('a')).toBe(true);
    expect(isSafeIdentifierPath('a.b.c')).toBe(true);
    expect(isSafeIdentifierPath('_meta_data')).toBe(true);
  });

  it('rejects paths with quotes, spaces, or punctuation', () => {
    expect(isSafeIdentifierPath("x'); DROP TABLE t; --")).toBe(false);
    expect(isSafeIdentifierPath('a b')).toBe(false);
    expect(isSafeIdentifierPath('a-b')).toBe(false);
    expect(isSafeIdentifierPath('')).toBe(false);
    expect(isSafeIdentifierPath('.a')).toBe(false);
  });
});

describe('isSafeIdentifier (no dots — for column names)', () => {
  it('accepts a simple identifier', () => {
    expect(isSafeIdentifier('a')).toBe(true);
    expect(isSafeIdentifier('_meta_data')).toBe(true);
  });
  it('rejects a dotted identifier (unlike isSafeIdentifierPath)', () => {
    // A JSON-path index *column* is a real column name and must be simple;
    // only the *path* segment may be dotted.
    expect(isSafeIdentifier('a.b')).toBe(false);
    expect(isSafeIdentifierPath('a.b')).toBe(true);
  });
  it('rejects injection / malformed input', () => {
    expect(isSafeIdentifier("x'); DROP TABLE t; --")).toBe(false);
    expect(isSafeIdentifier('')).toBe(false);
  });
});

describe('isSafeSqlFunctionDefault', () => {
  it('accepts well-formed function-call defaults', () => {
    expect(isSafeSqlFunctionDefault("datetime('now')")).toBe(true);
    expect(isSafeSqlFunctionDefault('now()')).toBe(true);
    expect(isSafeSqlFunctionDefault('uuid_generate_v4()')).toBe(true);
    expect(isSafeSqlFunctionDefault('coalesce(0, 1)')).toBe(true);
    expect(isSafeSqlFunctionDefault("date('now', '-1 day')")).toBe(true);
  });

  it('rejects strings that merely contain a parenthesis or inject SQL', () => {
    // The old "contains `(`" heuristic accepted ALL of these.
    expect(isSafeSqlFunctionDefault('Acme (Inc)')).toBe(false);
    expect(isSafeSqlFunctionDefault('Smith (Jr.)')).toBe(false);
    expect(isSafeSqlFunctionDefault("f(x') ; DROP TABLE t; --")).toBe(false);
    expect(isSafeSqlFunctionDefault('evil() ; DROP TABLE t')).toBe(false);
    expect(isSafeSqlFunctionDefault('fn()extra')).toBe(false);
  });
});

describe('formatDefaultValue (shared)', () => {
  it('passes through allowlisted keyword/function defaults verbatim', () => {
    expect(formatDefaultValue('current_timestamp', 'TIMESTAMP')).toBe(
      'current_timestamp',
    );
    expect(formatDefaultValue('CURRENT_TIMESTAMP', 'TIMESTAMP')).toBe(
      'CURRENT_TIMESTAMP',
    );
    expect(formatDefaultValue('uuid_generate_v4()', 'TEXT')).toBe(
      'uuid_generate_v4()',
    );
    expect(formatDefaultValue("datetime('now')", 'TEXT')).toBe(
      "datetime('now')",
    );
  });

  it('quotes a TEXT default that contains parentheses instead of passing it raw', () => {
    // Regression: "contains `(`" used to emit this raw, producing broken DDL.
    expect(formatDefaultValue('Acme (Inc)', 'TEXT')).toBe("'Acme (Inc)'");
    expect(formatDefaultValue('Smith (Jr.)', 'TEXT')).toBe("'Smith (Jr.)'");
  });

  it('does NOT fold a literal string "null"/"NULL" for TEXT into SQL NULL', () => {
    // Regression: the keyword allowlist used to include `null`, so a TEXT
    // column defaulting to the *string* "null" silently became SQL NULL.
    expect(formatDefaultValue('null', 'TEXT')).toBe("'null'");
    expect(formatDefaultValue('NULL', 'TEXT')).toBe("'NULL'");
  });

  it('still maps JS null/undefined to the SQL NULL keyword', () => {
    expect(formatDefaultValue(null, 'TEXT')).toBe('NULL');
    expect(formatDefaultValue(undefined, 'INTEGER')).toBe('NULL');
  });

  it('formats numeric, boolean and JSON defaults by type', () => {
    expect(formatDefaultValue(42, 'INTEGER')).toBe('42');
    expect(formatDefaultValue(3.14, 'REAL')).toBe('3.14');
    expect(formatDefaultValue(true, 'BOOLEAN')).toBe('TRUE');
    expect(formatDefaultValue(false, 'BOOLEAN')).toBe('FALSE');
    expect(formatDefaultValue('', 'JSON')).toBe("'null'");
    expect(formatDefaultValue({ a: 1 }, 'JSON')).toBe(`'{"a":1}'`);
  });

  it('honours engine-specific boolean literals and timestamp fallback', () => {
    expect(
      formatDefaultValue(true, 'BOOLEAN', { booleanLiterals: ['1', '0'] }),
    ).toBe('1');
    expect(
      formatDefaultValue(123, 'TIMESTAMP', {
        nonStringTimestampDefault: 'current_timestamp',
      }),
    ).toBe('current_timestamp');
  });
});

function baseSchema(overrides: Partial<SchemaDefinition>): SchemaDefinition {
  return {
    tableName: 'widgets',
    columns: { id: { type: 'TEXT', primaryKey: true } },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    version: '1.0.0',
    dependencies: [],
    ...overrides,
  };
}

describe('DDL strategy identifier safety (CREATE TABLE / INDEX)', () => {
  it('renders a table name containing a double quote as a single valid token', () => {
    const sql = getDDLStrategy('sqlite').generateCreateTable(
      baseSchema({ tableName: 'we"ird' }),
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "we""ird"');
    // No statement-terminating lone quote leaked into the DDL.
    expect(sql).not.toContain('"we"ird"');
  });

  it('quotes a malicious column name rather than letting it break out', () => {
    const sql = getDDLStrategy('postgres').generateCreateTable(
      baseSchema({
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          'evil" ); DROP TABLE x; --': { type: 'TEXT' },
        },
      }),
    );
    expect(sql).toContain('"evil"" ); DROP TABLE x; --"');
  });

  it('quotes a TEXT default that contains parentheses in CREATE TABLE', () => {
    const sql = getDDLStrategy('sqlite').generateCreateTable(
      baseSchema({
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          vendor: { type: 'TEXT', defaultValue: 'Acme (Inc)' },
        },
      }),
    );
    expect(sql).toContain("DEFAULT 'Acme (Inc)'");
    expect(sql).not.toContain('DEFAULT Acme (Inc)');
  });

  it('keeps a literal string "null" TEXT default as a quoted string', () => {
    const sql = getDDLStrategy('sqlite').generateCreateTable(
      baseSchema({
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          note: { type: 'TEXT', defaultValue: 'null' },
        },
      }),
    );
    expect(sql).toContain("DEFAULT 'null'");
    // Must NOT collapse to the SQL NULL keyword.
    expect(sql).not.toMatch(/"note"\s+TEXT\s+DEFAULT NULL/);
  });

  it('passes known function/keyword defaults through unquoted', () => {
    const sql = getDDLStrategy('postgres').generateCreateTable(
      baseSchema({
        columns: {
          id: {
            type: 'TEXT',
            primaryKey: true,
            defaultValue: 'uuid_generate_v4()',
          },
          ts: { type: 'TIMESTAMP', defaultValue: 'current_timestamp' },
        },
      }),
    );
    expect(sql).toContain('DEFAULT uuid_generate_v4()');
    expect(sql).toContain('DEFAULT current_timestamp');
  });

  it('escapes the JSON path literal in a jsonPath index expression', () => {
    // Valid dotted path renders escaped; the column is a delimited identifier.
    const sqlite = renderIndexTarget(
      { columns: [], jsonPath: { column: '_meta_data', path: 'a.b' } },
      'sqlite',
    );
    expect(sqlite).toBe(`json_extract("_meta_data", '$.a.b')`);
    const pg = renderIndexTarget(
      { columns: [], jsonPath: { column: '_meta_data', path: 'a' } },
      'postgres',
    );
    expect(pg).toBe(`("_meta_data"->>'a')`);
  });

  it('rejects a jsonPath path that tries to inject SQL', () => {
    expect(() =>
      renderIndexTarget(
        {
          columns: [],
          jsonPath: { column: '_meta_data', path: "x'); DROP TABLE t; --" },
        },
        'sqlite',
      ),
    ).toThrow(/Unsafe JSON-path index path/);
  });

  it('rejects a dotted jsonPath column (must be a simple identifier)', () => {
    expect(() =>
      renderIndexTarget(
        { columns: [], jsonPath: { column: 'a.b', path: 'x' } },
        'sqlite',
      ),
    ).toThrow(/Unsafe JSON-path index column/);
  });
});
