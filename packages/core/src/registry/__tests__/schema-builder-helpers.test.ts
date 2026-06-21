/**
 * Coverage tests for the pure exported helpers in registry/schema-builder.ts:
 *   - formatDefaultValue (NULL, SQL-keyword/function passthrough, per-type
 *     quoting, JSON edge cases)
 *   - mapFieldTypeToSQL (every field-type → SQL-type mapping + default)
 *   - generateDDLFromColumns (primaryKey/notNull/unique/default, STI vs non-STI
 *     UNIQUE constraint, empty)
 *   - fieldsToColumns (system-field skip, transient skip, relationship skip,
 *     meta skip, foreignKey expansion, crossPackageRef text idType, sqlType
 *     override, nullable/unique flags)
 *
 * These are pure functions over plain column/field maps — no DB or registry
 * state needed, so we import them straight from the module.
 *
 * @see src/registry/schema-builder.ts (issue #1500 coverage, ORM group)
 */

import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../../scanner/types.js';
import type { ColumnDefinition } from '../../schema/types.js';
import {
  fieldsToColumns,
  formatDefaultValue,
  generateDDLFromColumns,
  mapFieldTypeToSQL,
} from '../schema-builder';

describe('schema-builder: formatDefaultValue', () => {
  it('renders NULL for null/undefined', () => {
    expect(formatDefaultValue(null, 'TEXT')).toBe('NULL');
    expect(formatDefaultValue(undefined, 'TEXT')).toBe('NULL');
  });

  it('passes through SQL function calls (anything containing "(")', () => {
    expect(formatDefaultValue('uuid_generate_v4()', 'UUID')).toBe(
      'uuid_generate_v4()',
    );
    expect(formatDefaultValue('coalesce(a, b)', 'TEXT')).toBe('coalesce(a, b)');
  });

  it('passes through recognized SQL keywords case-insensitively', () => {
    expect(formatDefaultValue('CURRENT_TIMESTAMP', 'TIMESTAMP')).toBe(
      'CURRENT_TIMESTAMP',
    );
    expect(formatDefaultValue('current_date', 'TIMESTAMP')).toBe(
      'current_date',
    );
    expect(formatDefaultValue('NULL', 'TEXT')).toBe('NULL');
  });

  it('single-quotes and escapes TEXT/VARCHAR values', () => {
    expect(formatDefaultValue('hello', 'TEXT')).toBe("'hello'");
    expect(formatDefaultValue("O'Brien", 'VARCHAR')).toBe("'O''Brien'");
  });

  it('renders INTEGER/REAL numerics unquoted', () => {
    expect(formatDefaultValue(42, 'INTEGER')).toBe('42');
    expect(formatDefaultValue(3.14, 'REAL')).toBe('3.14');
  });

  it('renders BOOLEAN as TRUE/FALSE', () => {
    expect(formatDefaultValue(true, 'BOOLEAN')).toBe('TRUE');
    expect(formatDefaultValue(false, 'BOOLEAN')).toBe('FALSE');
  });

  describe('JSON type', () => {
    it('renders empty string as JSON null', () => {
      expect(formatDefaultValue('', 'JSON')).toBe("'null'");
    });

    it('renders the stringified-object sentinel as empty object', () => {
      expect(formatDefaultValue('[object Object]', 'JSON')).toBe("'{}'");
    });

    it('passes through already-valid JSON strings (escaping quotes)', () => {
      expect(formatDefaultValue('{"k":"v"}', 'JSON')).toBe(`'{"k":"v"}'`);
    });

    it('JSON-encodes a non-JSON string', () => {
      // 'hello world' is not valid JSON → gets JSON.stringify'd into a quoted string
      expect(formatDefaultValue('hello world', 'JSON')).toBe(`'"hello world"'`);
    });

    it('JSON-encodes a non-string value (object)', () => {
      expect(formatDefaultValue({ a: 1 }, 'JSON')).toBe(`'{"a":1}'`);
    });
  });

  it('falls back to quoted string for unknown types', () => {
    expect(formatDefaultValue('x', 'SOMETHING_ELSE')).toBe("'x'");
  });
});

describe('schema-builder: mapFieldTypeToSQL', () => {
  it('maps each known field type to its SQL type', () => {
    expect(mapFieldTypeToSQL('text')).toBe('TEXT');
    expect(mapFieldTypeToSQL('integer')).toBe('INTEGER');
    expect(mapFieldTypeToSQL('decimal')).toBe('REAL');
    expect(mapFieldTypeToSQL('boolean')).toBe('BOOLEAN');
    expect(mapFieldTypeToSQL('datetime')).toBe('TIMESTAMP');
    expect(mapFieldTypeToSQL('json')).toBe('JSON');
    expect(mapFieldTypeToSQL('foreignKey')).toBe('UUID');
    expect(mapFieldTypeToSQL('crossPackageRef')).toBe('UUID');
  });

  it('defaults unknown types to TEXT', () => {
    expect(mapFieldTypeToSQL('mysteryType' as FieldDefinition['type'])).toBe(
      'TEXT',
    );
  });
});

describe('schema-builder: generateDDLFromColumns', () => {
  it('emits PRIMARY KEY, NOT NULL, UNIQUE, and DEFAULT clauses', () => {
    const columns: Record<string, ColumnDefinition> = {
      id: { type: 'UUID', primaryKey: true },
      name: { type: 'TEXT', notNull: true, unique: true },
      count: { type: 'INTEGER', defaultValue: 0 },
    };
    const ddl = generateDDLFromColumns('widgets', columns);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "widgets"');
    expect(ddl).toContain('"id" UUID PRIMARY KEY');
    expect(ddl).toContain('"name" TEXT NOT NULL UNIQUE');
    expect(ddl).toContain('"count" INTEGER DEFAULT 0');
  });

  it('omits UNIQUE on a primary-key column even when unique is set', () => {
    const columns: Record<string, ColumnDefinition> = {
      id: { type: 'UUID', primaryKey: true, unique: true },
    };
    const ddl = generateDDLFromColumns('t', columns);
    // primaryKey already implies uniqueness → no standalone UNIQUE token
    expect(ddl).toContain('"id" UUID PRIMARY KEY');
    expect(ddl).not.toMatch(/"id" UUID PRIMARY KEY UNIQUE/);
  });

  it('adds UNIQUE(slug, context) for non-STI tables with slug+context', () => {
    const columns: Record<string, ColumnDefinition> = {
      slug: { type: 'TEXT', notNull: true },
      context: { type: 'TEXT' },
    };
    const ddl = generateDDLFromColumns('articles', columns, false);
    expect(ddl).toContain('UNIQUE(slug, context)');
    expect(ddl).not.toContain('_meta_type');
  });

  it('adds UNIQUE(slug, context, _meta_type) for STI tables', () => {
    const columns: Record<string, ColumnDefinition> = {
      slug: { type: 'TEXT', notNull: true },
      context: { type: 'TEXT' },
      _meta_type: { type: 'TEXT', notNull: true },
    };
    const ddl = generateDDLFromColumns('contents', columns, true);
    expect(ddl).toContain('UNIQUE(slug, context, _meta_type)');
  });
});

describe('schema-builder: fieldsToColumns', () => {
  function fieldMap(
    entries: Record<string, any>,
  ): Map<string, FieldDefinition> {
    return new Map(Object.entries(entries)) as Map<string, FieldDefinition>;
  }

  it('skips system fields (id, slug, context, timestamps)', () => {
    const columns = fieldsToColumns(
      fieldMap({
        id: { type: 'text' },
        slug: { type: 'text' },
        context: { type: 'text' },
        created_at: { type: 'datetime' },
        updated_at: { type: 'datetime' },
        realField: { type: 'text' },
      }),
    );
    expect(Object.keys(columns)).toEqual(['real_field']);
  });

  it('skips transient fields (top-level and _meta)', () => {
    const columns = fieldsToColumns(
      fieldMap({
        a: { type: 'text', transient: true },
        b: { type: 'text', _meta: { transient: true } },
        c: { type: 'text' },
      }),
    );
    expect(Object.keys(columns)).toEqual(['c']);
  });

  it('skips oneToMany / manyToMany relationship fields', () => {
    const columns = fieldsToColumns(
      fieldMap({
        children: { type: 'oneToMany' },
        tags: { type: 'manyToMany' },
        keep: { type: 'text' },
      }),
    );
    expect(Object.keys(columns)).toEqual(['keep']);
  });

  it('skips meta fields (stored in _meta_data)', () => {
    const columns = fieldsToColumns(
      fieldMap({
        extra: { type: 'meta' },
        keep: { type: 'integer' },
      }),
    );
    expect(Object.keys(columns)).toEqual(['keep']);
  });

  it('expands a foreignKey field into a column with FK metadata + snake_case', () => {
    const columns = fieldsToColumns(
      fieldMap({
        authorId: {
          type: 'foreignKey',
          related: 'Author',
          required: true,
          _meta: { onDelete: 'SET NULL' },
        },
      }),
    );
    const col = columns.author_id;
    expect(col).toBeDefined();
    expect(col.type).toBe('UUID');
    expect(col.referenceKind).toBe('foreignKey');
    expect(col.notNull).toBe(true);
    expect(col.foreignKey?.table).toBe('authors');
    expect(col.foreignKey?.column).toBe('id');
    expect(col.foreignKey?.onDelete).toBe('SET NULL');
    expect(col.foreignKey?.onUpdate).toBe('CASCADE'); // defaulted
  });

  it('honors an explicit related column in "Table.col" form', () => {
    const columns = fieldsToColumns(
      fieldMap({
        ownerRef: { type: 'foreignKey', related: 'Owner.code' },
      }),
    );
    expect(columns.owner_ref.foreignKey?.column).toBe('code');
  });

  it('maps crossPackageRef with text idType to TEXT', () => {
    const columns = fieldsToColumns(
      fieldMap({
        remoteId: { type: 'crossPackageRef', _meta: { idType: 'text' } },
      }),
    );
    expect(columns.remote_id.type).toBe('TEXT');
    expect(columns.remote_id.referenceKind).toBe('crossPackageRef');
  });

  it('applies an explicit _meta.sqlType override (uppercased)', () => {
    const columns = fieldsToColumns(
      fieldMap({
        amount: { type: 'integer', _meta: { sqlType: 'numeric' } },
      }),
    );
    expect(columns.amount.type).toBe('NUMERIC');
  });

  it('marks nullable fields as notNull:false and carries unique flag', () => {
    const columns = fieldsToColumns(
      fieldMap({
        optional: { type: 'text', required: true, _meta: { nullable: true } },
        handle: { type: 'text', _meta: { unique: true } },
      }),
    );
    // nullable wins over required → notNull false
    expect(columns.optional.notNull).toBe(false);
    expect(columns.handle.unique).toBe(true);
  });

  it('emits a default value when one is set', () => {
    const columns = fieldsToColumns(
      fieldMap({
        status: { type: 'text', default: 'active' },
      }),
    );
    expect(columns.status.defaultValue).toBe('active');
  });
});
