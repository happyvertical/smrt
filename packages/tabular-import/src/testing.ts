/**
 * Node-only reference target for tests: real in-process SQLite through
 * `@happyvertical/sql`, so calculated fields are generated columns evaluated
 * with database semantics. Never imported by the root entry.
 */
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { renderExpression } from '@happyvertical/sql/query';
import type { LoadBatch } from './load.js';
import {
  type ImportFieldType,
  type ImportPlan,
  loadOrder,
  type PlanField,
  type PlanReport,
  type PlanTable,
} from './plan.js';
import type { ImportTarget, TargetRow, TargetStructure } from './target.js';

export interface SqliteReferenceTarget extends ImportTarget {
  /** The database the target writes to. */
  readonly db: DatabaseInterface;
  /** Reports handed over by the plan, exactly as given. */
  appliedReports(): PlanReport[];
  close(): Promise<void>;
}

export interface SqliteReferenceTargetOptions {
  /** An existing database to write into; the caller closes it. */
  db?: DatabaseInterface;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Hidden columns start with an underscore; plan keys cannot. */
const ROW_ID = '_row_id';
const SOURCE_ROW = '_source_row';

const COLUMN_TYPE: Record<ImportFieldType, string> = {
  text: 'TEXT',
  choice: 'TEXT',
  date: 'TEXT',
  number: 'REAL',
  integer: 'INTEGER',
  money: 'INTEGER',
  boolean: 'INTEGER',
  reference: 'INTEGER',
};

const EXPRESSION_TYPE: Record<
  ImportFieldType,
  'number' | 'text' | 'boolean' | 'date' | 'unknown'
> = {
  text: 'text',
  choice: 'text',
  number: 'number',
  integer: 'number',
  money: 'number',
  boolean: 'boolean',
  date: 'date',
  reference: 'unknown',
};

function toStored(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value ?? null;
}

function fromStored(field: PlanField | undefined, value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (field?.type === 'boolean' && (value === 0 || value === 1)) {
    return value === 1;
  }
  return value ?? null;
}

interface TableDefinition {
  table: PlanTable;
  fields: Map<string, PlanField>;
}

export async function createSqliteReferenceTarget(
  options: SqliteReferenceTargetOptions = {},
): Promise<SqliteReferenceTarget> {
  const owned = options.db === undefined;
  const db =
    options.db ?? (await getDatabase({ type: 'sqlite', url: ':memory:' }));
  const definitions = new Map<string, TableDefinition>();
  const reports: PlanReport[] = [];
  /** table -> JSON of the lookup key -> hidden row id, for reference resolution. */
  const keyIndex = new Map<string, Map<string, number>>();

  const definition = (key: string): TableDefinition => {
    const found = definitions.get(key);
    if (!found) throw new Error(`The target has no table "${key}".`);
    return found;
  };

  const columnSql = (field: PlanField, table: PlanTable): string => {
    const name = quote(field.key);
    if (field.calculated !== undefined) {
      const siblings = new Map(table.fields.map((f) => [f.key, f]));
      const rendered = renderExpression(field.calculated, {
        dialect: 'sqlite',
        mode: 'ddl',
        resolveColumn: (column) => ({
          name: column,
          type: EXPRESSION_TYPE[siblings.get(column)?.type ?? 'text'],
        }),
      });
      if (rendered.values.length > 0) {
        throw new Error('A generated column cannot bind parameters.');
      }
      return `${name} ${COLUMN_TYPE[field.type]} GENERATED ALWAYS AS (${rendered.sql}) STORED`;
    }
    if (field.reference) {
      return `${name} INTEGER REFERENCES ${quote(field.reference.table)}(${quote(ROW_ID)})${field.required ? ' NOT NULL' : ''}`;
    }
    return `${name} ${COLUMN_TYPE[field.type]}${field.required ? ' NOT NULL' : ''}`;
  };

  const target: SqliteReferenceTarget = {
    db,
    appliedReports: () => [...reports],

    async close() {
      if (owned) await db.close?.();
    },

    async describe(): Promise<TargetStructure> {
      const tables = await db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const out: TargetStructure['tables'] = [];
      for (const row of tables.rows) {
        const key = String(row.name);
        const columns = await db.query(
          `SELECT name, type FROM pragma_table_xinfo('${key.replace(/'/g, "''")}') ORDER BY cid`,
        );
        out.push({
          key,
          fields: columns.rows
            .filter((column) => !String(column.name).startsWith('_'))
            .map((column) => ({
              key: String(column.name),
              type: String(column.type),
            })),
          ...(definitions.get(key)?.table.lookupKey
            ? { lookupKey: definitions.get(key)?.table.lookupKey }
            : {}),
        });
      }
      return { tables: out };
    },

    async applyStructure(plan: ImportPlan): Promise<void> {
      const byKey = new Map(plan.tables.map((table) => [table.key, table]));
      for (const key of loadOrder(plan)) {
        const table = byKey.get(key) as PlanTable;
        const columns = [
          `${quote(ROW_ID)} INTEGER PRIMARY KEY AUTOINCREMENT`,
          `${quote(SOURCE_ROW)} INTEGER NOT NULL`,
          ...table.fields.map((field) => columnSql(field, table)),
        ];
        await db.query(`CREATE TABLE ${quote(key)} (${columns.join(', ')})`);
        if (table.lookupKey) {
          await db.query(
            `CREATE UNIQUE INDEX ${quote(`ux_${key}_lookup`)} ON ${quote(key)} (${table.lookupKey.map(quote).join(', ')})`,
          );
        }
        definitions.set(key, {
          table,
          fields: new Map(table.fields.map((field) => [field.key, field])),
        });
      }
      for (const report of plan.reports ?? []) reports.push(report);
    },

    async load(batch: LoadBatch): Promise<{ loaded: number }> {
      const def = definition(batch.table);
      if (!db.transaction) {
        throw new Error('The database does not support transactions.');
      }
      const added: Array<[string, number]> = [];
      await db.transaction(async (tx) => {
        for (const record of batch.records) {
          const columns = [SOURCE_ROW];
          const values: unknown[] = [record.sourceRow];
          for (const field of def.table.fields) {
            if (field.calculated !== undefined) continue;
            columns.push(field.key);
            if (field.reference) {
              const ref = record.references[field.key];
              if (!ref) {
                values.push(null);
                continue;
              }
              const id = keyIndex.get(ref.table)?.get(JSON.stringify(ref.key));
              if (id === undefined) {
                throw new Error(
                  `"${batch.table}" row ${record.sourceRow}: no "${ref.table}" row has key ${JSON.stringify(ref.key)}.`,
                );
              }
              values.push(id);
              continue;
            }
            values.push(toStored(record.values[field.key]));
          }
          const result = await tx.query(
            `INSERT INTO ${quote(batch.table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${quote(ROW_ID)} AS id`,
            values,
          );
          if (def.table.lookupKey) {
            const key = def.table.lookupKey.map(
              (name) => record.values[name] ?? null,
            );
            added.push([JSON.stringify(key), Number(result.rows[0].id)]);
          }
        }
      });
      if (added.length > 0) {
        const index = keyIndex.get(batch.table) ?? new Map<string, number>();
        for (const [key, id] of added) index.set(key, id);
        keyIndex.set(batch.table, index);
      }
      return { loaded: batch.records.length };
    },

    async count(table: string): Promise<number> {
      definition(table);
      const result = await db.query(
        `SELECT COUNT(*) AS n FROM ${quote(table)}`,
      );
      return Number(result.rows[0].n);
    },

    async sum(table: string, field: string): Promise<number> {
      const def = definition(table);
      if (!def.fields.has(field)) {
        throw new Error(`"${table}" has no field "${field}".`);
      }
      const result = await db.query(
        `SELECT SUM(${quote(field)}) AS total FROM ${quote(table)}`,
      );
      return Number(result.rows[0].total ?? 0);
    },

    async *values(
      table: string,
      fields: string[],
      sourceRows?: number[],
    ): AsyncIterable<TargetRow> {
      const def = definition(table);
      for (const field of fields) {
        if (!def.fields.has(field)) {
          throw new Error(`"${table}" has no field "${field}".`);
        }
      }
      const wanted = sourceRows
        ? [...new Set(sourceRows)].sort((a, b) => a - b)
        : undefined;
      const chunks: Array<number[] | undefined> = [];
      if (wanted) {
        for (let at = 0; at < wanted.length; at += 500) {
          chunks.push(wanted.slice(at, at + 500));
        }
      } else chunks.push(undefined);
      const select = [SOURCE_ROW, ...fields].map(quote).join(', ');
      for (const chunk of chunks) {
        const where = chunk
          ? ` WHERE ${quote(SOURCE_ROW)} IN (${chunk.map((_, i) => `$${i + 1}`).join(', ')})`
          : '';
        const result = await db.query(
          `SELECT ${select} FROM ${quote(table)}${where} ORDER BY ${quote(SOURCE_ROW)}, ${quote(ROW_ID)}`,
          chunk ?? [],
        );
        for (const row of result.rows) {
          const values: Record<string, unknown> = {};
          for (const field of fields) {
            values[field] = fromStored(def.fields.get(field), row[field]);
          }
          yield { sourceRow: Number(row[SOURCE_ROW]), values };
        }
      }
    },
  };
  return target;
}
