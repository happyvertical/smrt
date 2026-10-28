/**
 * #4424 — a foreign key to a parent planned in the same run is safe to add
 * when no child row can reference it: the FK column is entirely NULL (or is
 * new with no/NULL default). Only a non-NULL value, or a new column whose
 * default could create references, keeps the advisory.
 */

import { describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../schema/types.js';
import { SchemaComparer } from './differ.js';

const base = { indexes: [], triggers: [], dependencies: [], version: '4424' };

function manifest(defaultValue?: unknown): Record<string, SchemaDefinition> {
  return {
    customers: {
      ...base,
      tableName: 'customers',
      columns: {
        id: { type: 'UUID', primaryKey: true },
        default_tax_code_id: {
          type: 'UUID',
          ...(defaultValue === undefined ? {} : { defaultValue }),
        },
      },
      foreignKeys: [
        {
          column: 'default_tax_code_id',
          referencesTable: 'tax_codes',
          referencesColumn: 'id',
        },
      ],
      dependencies: ['tax_codes'],
    },
    tax_codes: {
      ...base,
      tableName: 'tax_codes',
      columns: { id: { type: 'UUID', primaryKey: true } },
      foreignKeys: [],
    },
  };
}

/** Postgres-shaped in-process fake: `rows` are the child table's contents. */
function postgresFake(options: {
  columnExists: boolean;
  rows: Array<{ default_tax_code_id: string | null }>;
}) {
  const columns: Record<string, unknown> = {
    id: { name: 'id', type: 'uuid', primaryKey: true },
  };
  if (options.columnExists) {
    columns.default_tax_code_id = { name: 'default_tax_code_id', type: 'uuid' };
  }
  return {
    url: 'postgres://fixture/issue4424',
    query: async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ table_name: 'customers' }] };
      }
      if (/^SELECT 1 FROM "customers"/.test(sql)) {
        const filtered = sql.includes('IS NOT NULL')
          ? options.rows.filter((row) => row.default_tax_code_id !== null)
          : options.rows;
        return { rows: filtered.slice(0, 1).map(() => ({ '?column?': 1 })) };
      }
      return { rows: [] };
    },
    getTableSchema: async (name: string) =>
      name === 'customers'
        ? { columns, indexes: [], foreignKeys: [] }
        : undefined,
  };
}

async function fkChange(
  db: ReturnType<typeof postgresFake>,
  defaultValue?: unknown,
) {
  const diff = await new SchemaComparer(db as never, {
    engineHint: 'postgres',
  }).compare(manifest(defaultValue));
  return diff.changes.find((change) => change.type === 'add_foreign_key');
}

describe('planned-parent foreign key with NULL-only child column (#4424)', () => {
  const threeNulls = [
    { default_tax_code_id: null },
    { default_tax_code_id: null },
    { default_tax_code_id: null },
  ];

  it('adds the FK when the existing column is NULL in every row', async () => {
    const fk = await fkChange(
      postgresFake({ columnExists: true, rows: threeNulls }),
    );
    expect(fk?.advisory).toBeUndefined();
    expect(fk?.sqlStatements?.length).toBeGreaterThan(0);
  });

  it('keeps the advisory when the existing column holds a non-NULL value', async () => {
    const fk = await fkChange(
      postgresFake({
        columnExists: true,
        rows: [...threeNulls, { default_tax_code_id: 'abc' }],
      }),
    );
    expect(fk?.advisory?.message).toMatch(/not empty/);
    expect(fk?.sqlStatements).toBeUndefined();
  });

  it('adds the FK for a new column without a default on a populated table', async () => {
    const fk = await fkChange(
      postgresFake({ columnExists: false, rows: threeNulls }),
    );
    expect(fk?.advisory).toBeUndefined();
    expect(fk?.sqlStatements?.length).toBeGreaterThan(0);
  });

  it('keeps the whole-table check for a new column with a non-NULL default', async () => {
    const fk = await fkChange(
      postgresFake({ columnExists: false, rows: threeNulls }),
      '00000000-0000-0000-0000-000000000001',
    );
    expect(fk?.advisory?.message).toMatch(/not empty/);
    expect(fk?.sqlStatements).toBeUndefined();
  });
});
